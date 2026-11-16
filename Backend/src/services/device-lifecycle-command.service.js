const { randomUUID } = require('crypto');
const { Device } = require('../models');
const env = require('../config/env');
const mqtt = require('./mqtt.client');
const socket = require('./socket.service');
const audit = require('./audit.service');
const { normalizeCommandAck } = require('./command-ack-security');

exports.requestActivation = async (device, node, userId) => {
    if (!node || node.isRevoked || !node.isOnline) throw new Error('Node phải chưa bị thu hồi và đang trực tuyến để nhận lệnh kích hoạt.');
    if (!node.mqttUsername || !node.mqttAccountEnabled) throw new Error('Node chưa có tài khoản MQTT riêng đang được bật. Hãy cấp tài khoản MQTT cho Node trước.');
    const now = new Date();
    if (device.pendingLifecycleCommandUuid && device.pendingLifecycleCommandSentAt) {
        const age = now.getTime() - new Date(device.pendingLifecycleCommandSentAt).getTime();
        if (Number.isFinite(age) && age <= env.commandAckTimeoutSec * 1000) throw new Error('Thiết bị đang chờ Firmware xác nhận lệnh kích hoạt.');
    }
    const commandUuid = randomUUID();
    device.pendingLifecycleCommandUuid = commandUuid;
    device.pendingLifecycleCommandTo = 'ACTIVE';
    device.pendingLifecycleCommandSentAt = now;
    await device.save();
    try {
        await mqtt.publish(mqtt.topics.command(node.nodeCode), {
            commandUuid,
            commandId: commandUuid,
            action: 'lifecycle',
            deviceCode: device.deviceCode,
            type: device.type,
            gpioPin: device.gpioPin,
            lifecycle: 'ACTIVE',
            state: 'ACTIVE',
        });
    } catch (error) {
        device.pendingLifecycleCommandUuid = null;
        device.pendingLifecycleCommandTo = null;
        device.pendingLifecycleCommandSentAt = null;
        await device.save();
        throw error;
    }
    await audit.log({ user: { id: userId, role: 'admin' } }, {
        action: 'device.lifecycle_activation_requested', entityType: 'device', entityId: device.id,
        detail: { deviceCode: device.deviceCode, nodeCode: node.nodeCode, commandUuid },
    });
    socket.emitDevice(device.id, 'device:update', device);
    return { commandUuid, pending: true };
};

exports.handleAck = async (node, payload) => {
    const parsed = normalizeCommandAck(payload, { firmwareCompat: true });
    if (!parsed.ok) return false;
    const ack = parsed.ack;
    const device = await Device.findOne({ where: { pendingLifecycleCommandUuid: ack.commandUuid } });
    if (!device) return false; // commandService may own this ACK instead
    if (!node || node.isRevoked || Number(device.nodeId) !== Number(node.id)) return false;
    if (ack.deviceCode && ack.deviceCode !== device.deviceCode) return false;
    const sentAt = device.pendingLifecycleCommandSentAt ? new Date(device.pendingLifecycleCommandSentAt).getTime() : NaN;
    const now = Date.now();
    if (!Number.isFinite(sentAt) || now < sentAt || now - sentAt > env.commandAckTimeoutSec * 1000) {
        device.pendingLifecycleCommandUuid = null;
        device.pendingLifecycleCommandTo = null;
        device.pendingLifecycleCommandSentAt = null;
        await device.save();
        await audit.log(null, { action: 'device.lifecycle_activation_ack_rejected', entityType: 'device', entityId: device.id, success: false, detail: { nodeCode: node.nodeCode, reason: 'late_ack', commandUuid: ack.commandUuid } });
        return false;
    }
    const previousLifecycle = device.lifecycle;
    if (ack.success && device.pendingLifecycleCommandTo === 'ACTIVE' && ['PROVISIONED', 'FAULT', 'MAINTENANCE'].includes(device.lifecycle)) {
        device.lifecycle = 'ACTIVE';
        device.lifecycleChangedAt = new Date();
    }
    device.pendingLifecycleCommandUuid = null;
    device.pendingLifecycleCommandTo = null;
    device.pendingLifecycleCommandSentAt = null;
    await device.save();
    await audit.log(null, {
        action: 'device.lifecycle_activation_ack', entityType: 'device', entityId: device.id, success: ack.success,
        detail: { deviceCode: device.deviceCode, nodeCode: node.nodeCode, commandUuid: ack.commandUuid, lifecycle: device.lifecycle, message: ack.message },
    });
    if (ack.success && previousLifecycle !== 'ACTIVE' && device.lifecycle === 'ACTIVE' && ['FAULT', 'MAINTENANCE'].includes(previousLifecycle)) {
        const { Alert } = require('../models');
        const alertService = require('./alert.service');
        const { Op } = require('sequelize');
        const faultAlerts = await Alert.findAll({ where: { deviceId: device.id, type: 'fault', status: { [Op.ne]: 'RESOLVED' } } });
        for (const alert of faultAlerts) await alertService.autoResolve(alert, 'Thiết bị đã được Admin kích hoạt lại và Firmware xác nhận');
    }
    socket.emitDevice(device.id, 'device:update', device);
    return true;
};

exports.expirePending = async () => {
    const cutoff = new Date(Date.now() - env.commandAckTimeoutSec * 1000);
    const pending = await Device.findAll({ where: { pendingLifecycleCommandUuid: { [require('sequelize').Op.ne]: null }, pendingLifecycleCommandSentAt: { [require('sequelize').Op.lt]: cutoff } } });
    for (const device of pending) {
        device.pendingLifecycleCommandUuid = null;
        device.pendingLifecycleCommandTo = null;
        device.pendingLifecycleCommandSentAt = null;
        await device.save();
        await audit.log(null, { action: 'device.lifecycle_activation_timeout', entityType: 'device', entityId: device.id, success: false, detail: { deviceCode: device.deviceCode } });
        socket.emitDevice(device.id, 'device:update', device);
    }
};
