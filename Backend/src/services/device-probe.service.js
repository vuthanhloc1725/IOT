const { randomUUID } = require('crypto');
const mqtt = require('./mqtt.client');
const audit = require('./audit.service');
const ApiError = require('../utils/apiError');
const env = require('../config/env');
const { normalizeProbeAck, PUMP_EVIDENCE } = require('./device-probe.protocol');

// In-flight probe requests are held only until an ACK arrives. A timeout never creates a DB record.
const pending = new Map();
const TIMEOUT_MS = Number(env.deviceProbeTimeoutSec || 8) * 1000;

exports.normalizeProbeAck = normalizeProbeAck;
exports.PUMP_EVIDENCE = PUMP_EVIDENCE;

exports.request = async ({ node, type, gpioPin, hardwareFeedback = null, allowActuatorTest = false }) => {
  if (!node || node.isRevoked || !node.mqttAccountEnabled) throw ApiError.conflict('Node không hợp lệ, đã bị thu hồi hoặc chưa có tài khoản MQTT đang bật');
  if (!node.isOnline) throw ApiError.conflict('Node phải đang online trước khi kiểm tra phần cứng');
  if (!mqtt.isConnected()) throw ApiError.conflict('MQTT broker chưa kết nối; chưa thể xác minh thiết bị');

  const requestId = randomUUID();
  const expected = { requestId, nodeId: node.id, nodeCode: node.nodeCode, type, gpioPin, hardwareFeedback, allowActuatorTest };
  const waitForAck = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(ApiError.conflict(`Hết thời gian chờ Node ${node.nodeCode} phản hồi probe. Không tạo thiết bị trong database.`));
    }, TIMEOUT_MS);
    pending.set(requestId, { expected, resolve, reject, timer });
  });

  try {
    await mqtt.publish(mqtt.topics.deviceProbe(node.nodeCode), {
      requestId,
      action: 'PROBE',
      // deviceCode is assigned by the backend only after a positive probe ACK.
      type,
      gpioPin,
      hardwareFeedback,
      allowActuatorTest: allowActuatorTest === true,
    });
  } catch (error) {
    const entry = pending.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(requestId);
      entry.reject(ApiError.conflict(`Không gửi được yêu cầu probe qua MQTT: ${error.message}`));
    }
  }

  const ack = await waitForAck;
  const normalized = normalizeProbeAck(ack, expected);
  if (!normalized.ok) {
    await audit.log(null, {
      action: 'device.probe_rejected', entityType: 'device', success: false,
      detail: { requestId, nodeCode: node.nodeCode, type, gpioPin, reason: normalized.reason },
    });
    throw ApiError.conflict(`${normalized.reason}. Không tạo thiết bị trong database.`);
  }
  return { requestId, ack, ...normalized };
};

exports.handleAck = async (node, payload) => {
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
  const entry = pending.get(requestId);
  if (!entry) return false;
  if (entry.expected.nodeId !== Number(node.id) || entry.expected.nodeCode !== node.nodeCode) {
    await audit.log(null, {
      action: 'device.probe_ack_rejected', entityType: 'device', success: false,
      detail: { requestId, receivedNodeCode: node.nodeCode, expectedNodeCode: entry.expected.nodeCode, reason: 'node_mismatch' },
    });
    return false;
  }
  const gpioPin = payload.gpioPin === null || payload.gpioPin === undefined ? null : Number(payload.gpioPin);
  const reportedType = String(payload.detectedType || payload.type || '').toUpperCase();
  if (reportedType !== entry.expected.type || gpioPin !== entry.expected.gpioPin) {
    clearTimeout(entry.timer);
    pending.delete(requestId);
    entry.reject(ApiError.conflict('ACK probe sai loại/GPIO. Không đăng ký thiết bị.'));
    return false;
  }
  // Resolve the current HTTP request only when this ACK belongs to the expected Node and probe ID.
  // The full hardware/device checks happen in normalizeProbeAck before any DB insert.
  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.resolve(payload);
  return true;
};
