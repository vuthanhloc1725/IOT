const { randomUUID } = require('crypto');
const { Op } = require('sequelize');
const env = require('../config/env');
const { Device, DeviceCommand, Node } = require('../models');
const ApiError = require('../utils/apiError');
const mqtt = require('./mqtt.client');
const socket = require('./socket.service');
const audit = require('./audit.service');
const { normalizeCommandAck, authorizeCommandAck } = require('./command-ack-security');

// Prevent overlapping issue() calls for the same device within this backend process.
const issuingDevices = new Set();

async function finishFailed(cmd, message) {
  // Do not overwrite a fast ACK or terminal result with a publish error.
  await cmd.reload();
  if (['ACKED', 'FAILED', 'TIMEOUT'].includes(cmd.status)) return cmd;
  cmd.status = 'FAILED';
  cmd.resultMessage = String(message).slice(0, 255);
  await cmd.save();
  socket.emitDevice(cmd.deviceId, 'command:update', cmd);
  return cmd;
}

async function rejectAck(node, reason, cmd = null) {
  await audit.log(null, {
    action: 'device.command_ack_rejected',
    entityType: 'deviceCommand',
    entityId: cmd?.id ?? null,
    success: false,
    detail: { nodeId: node?.id ?? null, reason },
  });
  return false;
}

// Create command → persist SENT before publishing to avoid a fast ACK being overwritten as SENT.
exports.issue = async (options) => {
  const deviceId = options?.device?.id;
  if (!deviceId) throw ApiError.badRequest('Thiếu device hợp lệ khi tạo command');
  if (issuingDevices.has(Number(deviceId))) throw ApiError.conflict('Thiết bị đang được tạo command khác; hãy thử lại sau');
  issuingDevices.add(Number(deviceId));
  try {
    return await issueOne(options);
  } finally {
    issuingDevices.delete(Number(deviceId));
  }
};

async function issueOne({ device, turnOn, source, userId = null, alertId = null, sensorValue = null }) {
  if (await exports.hasInFlight(device.id)) {
    throw ApiError.conflict('Thiết bị đang có command chờ ACK; hãy chờ command hoàn tất trước khi gửi lệnh mới');
  }

  // Read Node fresh; an included association may not contain the latest revoked/online status.
  const node = device.nodeId ? await Node.findByPk(device.nodeId) : null;
  const cmd = await DeviceCommand.create({
    commandUuid: randomUUID(),
    deviceId: device.id,
    turnOn,
    source,
    issuedBy: userId,
    alertId,
    sensorValue,
    status: 'PENDING',
  });

  if (!node || !node.isOnline || node.isRevoked || !node.mqttAccountEnabled) return finishFailed(cmd, 'Node offline, chưa có tài khoản MQTT đang bật hoặc đã bị thu hồi');

  cmd.status = 'SENT';
  cmd.sentAt = new Date();
  await cmd.save();
  socket.emitDevice(cmd.deviceId, 'command:update', cmd);

  try {
    const action = device.type === 'FAN' ? 'fan' : 'pump';
    // Firmware v1.2 command contract: action "pump"/"fan" with a boolean on/turnOn.
    // commandUuid/deviceCode are extra correlation fields; firmware may echo them in cmd/ack.
    await mqtt.publish(mqtt.topics.command(node.nodeCode), {
      commandUuid: cmd.commandUuid,
      commandId: cmd.commandUuid,
      deviceCode: device.deviceCode,
      action,
      type: device.type,
      gpioPin: device.gpioPin,
      on: turnOn,
      turnOn,
      ...(device.type === 'PUMP' && turnOn ? { seconds: 10 } : {}),
    });
  } catch (error) {
    return finishFailed(cmd, error.message);
  }

  // Do not save SENT again here; an ACK could already have changed the row to ACKED/FAILED.
  await cmd.reload();
  return cmd;
}

// Security rules for ACK:
// - commandUuid must identify a command that is still SENT;
// - legacy ACKs must include deviceCode; Firmware v1.2 may omit it only when the command UUID matches;
// - the Node on the MQTT topic must own that device and not be revoked;
// - success must be a JSON boolean; terminal/late/duplicate ACKs never change isOn.
// Returns true only for a well-formed ACK accepted for the current command. A valid
// success:false ACK is accepted (the Node is alive) but marks the command FAILED.
exports.handleAck = async (node, payload) => {
  const parsed = normalizeCommandAck(payload, { firmwareCompat: true });
  if (!parsed.ok) return rejectAck(node, parsed.reason);
  const ack = parsed.ack;

  const cmd = await DeviceCommand.findOne({ where: { commandUuid: ack.commandUuid } });
  if (!cmd) return rejectAck(node, 'command_not_found');

  const device = await Device.findByPk(cmd.deviceId);
  const now = new Date();
  const auth = authorizeCommandAck({
    cmd,
    device,
    node,
    ack,
    now,
    timeoutSec: env.commandAckTimeoutSec,
  });

  if (!auth.ok) {
    if (auth.late && cmd.status === 'SENT') {
      const cutoff = new Date(now.getTime() - env.commandAckTimeoutSec * 1000);
      const [timedOut] = await DeviceCommand.update(
        { status: 'TIMEOUT', resultMessage: 'Không nhận được ACK đúng hạn từ node' },
        { where: { id: cmd.id, status: 'SENT', sentAt: { [Op.lt]: cutoff } } }
      );
      if (timedOut) {
        await cmd.reload();
        socket.emitDevice(cmd.deviceId, 'command:update', cmd);
      }
    }
    return rejectAck(node, auth.reason, cmd);
  }

  const ackedAt = new Date();
  const cutoff = new Date(ackedAt.getTime() - env.commandAckTimeoutSec * 1000);
  const nextStatus = ack.success ? 'ACKED' : 'FAILED';
  const resultMessage = ack.message;

  // Compare-and-set also checks the deadline. An ACK cannot win a race against timeout sweep.
  const [changed] = await DeviceCommand.update(
    { status: nextStatus, ackedAt, resultMessage },
    {
      where: {
        id: cmd.id,
        status: 'SENT',
        sentAt: { [Op.gte]: cutoff, [Op.lte]: ackedAt },
      },
    }
  );
  if (!changed) {
    const [timedOut] = await DeviceCommand.update(
      { status: 'TIMEOUT', resultMessage: 'Không nhận được ACK đúng hạn từ node' },
      { where: { id: cmd.id, status: 'SENT', sentAt: { [Op.lt]: cutoff } } }
    );
    if (timedOut) {
      await cmd.reload();
      socket.emitDevice(cmd.deviceId, 'command:update', cmd);
    }
    return rejectAck(node, 'ack_lost_race_or_command_expired', cmd);
  }

  await cmd.reload();
  await audit.log(null, {
    action: 'device.command_ack', entityType: 'deviceCommand', entityId: cmd.id, success: ack.success,
    detail: { deviceId: device.id, deviceCode: device.deviceCode, turnOn: cmd.turnOn, status: cmd.status, message: cmd.resultMessage, nodeId: node.id },
  });

  if (ack.success) {
    // An ACK may arrive after lifecycle changed to FAULT/MAINTENANCE/DECOMMISSIONED.
    // Record the physical output result, then re-read lifecycle and issue a safety OFF if needed.
    device.isOn = cmd.turnOn;
    device.stateChangedAt = ackedAt;
    await device.save();
    await device.reload();
    socket.emitDevice(device.id, 'device:update', device);
    if (cmd.turnOn && device.lifecycle !== 'ACTIVE') {
      try {
        const stopCommand = await exports.issue({ device, turnOn: false, source: 'ALERT' });
        await audit.log(null, {
          action: 'device.safety_shutdown_after_late_on_ack', entityType: 'device', entityId: device.id,
          success: !['FAILED', 'TIMEOUT'].includes(stopCommand.status),
          detail: { deviceCode: device.deviceCode, lifecycle: device.lifecycle, originalCommandUuid: cmd.commandUuid, stopCommandUuid: stopCommand.commandUuid, stopStatus: stopCommand.status },
        });
      } catch (error) {
        await audit.log(null, {
          action: 'device.safety_shutdown_after_late_on_ack', entityType: 'device', entityId: device.id, success: false,
          detail: { deviceCode: device.deviceCode, lifecycle: device.lifecycle, originalCommandUuid: cmd.commandUuid, reason: String(error.message || error).slice(0, 300) },
        });
      }
    }
  }
  socket.emitDevice(cmd.deviceId, 'command:update', cmd);
  return true;
};

exports.expireStale = async () => {
  const cutoff = new Date(Date.now() - env.commandAckTimeoutSec * 1000);
  const stale = await DeviceCommand.findAll({ where: { status: 'SENT', sentAt: { [Op.lt]: cutoff } } });
  for (const candidate of stale) {
    // Conditional update avoids racing an ACK received while sweep is running.
    const [changed] = await DeviceCommand.update(
      { status: 'TIMEOUT', resultMessage: 'Không nhận được ACK từ node' },
      { where: { id: candidate.id, status: 'SENT', sentAt: { [Op.lt]: cutoff } } }
    );
    if (changed) {
      await candidate.reload();
      socket.emitDevice(candidate.deviceId, 'command:update', candidate);
    }
  }
};

exports.hasInFlight = async (deviceId) => !!(await DeviceCommand.findOne({
  where: { deviceId, status: { [Op.in]: ['PENDING', 'SENT'] } },
}));
