const { Alert } = require('../models');
const ApiError = require('../utils/apiError');
const socket = require('./socket.service');

function emitAlert(alert, event) {
  if (alert.deviceId) socket.emitDevice(alert.deviceId, event, alert);
  else socket.emitAdmin(event, alert);
}

exports.create = async ({ type, severity = 'WARNING', title, message = null, deviceId = null, analysisId = null }) => {
  const alert = await Alert.create({ type, severity, title, message, deviceId, analysisId, status: 'NEW' });
  emitAlert(alert, 'alert:new');
  return alert;
};

exports.acknowledge = async (alert, user) => {
  if (alert.status !== 'NEW') throw ApiError.conflict('Cảnh báo đã được xác nhận hoặc xử lý');
  alert.status = 'ACKNOWLEDGED';
  alert.acknowledgedBy = user.id;
  alert.acknowledgedAt = new Date();
  await alert.save();
  emitAlert(alert, 'alert:update');
  return alert;
};

exports.resolve = async (alert, user, note) => {
  if (alert.status === 'RESOLVED') throw ApiError.conflict('Cảnh báo đã được xử lý');
  const now = new Date();
  if (!alert.acknowledgedAt) {
    alert.acknowledgedBy = user.id;
    alert.acknowledgedAt = now;
  }
  alert.status = 'RESOLVED';
  alert.resolvedBy = user.id;
  alert.resolvedAt = now;
  alert.resolutionNote = note || null;
  await alert.save();
  emitAlert(alert, 'alert:update');
  return alert;
};

// System resolution (e.g. Node reconnects, or an Admin confirms a device recovered).
exports.autoResolve = async (alert, note) => {
  if (alert.status === 'RESOLVED') return alert;
  alert.status = 'RESOLVED';
  alert.resolvedAt = new Date();
  alert.resolutionNote = note || null;
  await alert.save();
  emitAlert(alert, 'alert:update');
  return alert;
};
