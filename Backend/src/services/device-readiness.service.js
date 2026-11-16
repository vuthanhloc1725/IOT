const { Op } = require('sequelize');
const { Device, Node, SensorReading } = require('../models');
const audit = require('./audit.service');
const socket = require('./socket.service');
const { PUMP_EVIDENCE } = require('./device-probe.service');

const FRESH_MS = 5 * 60 * 1000;

// Readiness telemetry is stored as diagnostic evidence only. It never changes lifecycle.
exports.tryActivate = async () => false; // compatibility: activation is now Admin-initiated and ACK-gated

exports.recordSensorReading = async (device, reading) => {
  if (!device || device.type !== 'SENSOR' || !['PROVISIONED', 'FAULT', 'MAINTENANCE'].includes(device.lifecycle) || reading?.isBackfilled) return false;
  const recordedAt = new Date(reading.recordedAt);
  const now = Date.now();
  const age = now - recordedAt.getTime();
  if (!Number.isFinite(age) || age < -5000 || age > FRESH_MS) return false;
  // All lifecycle readiness proof must be newer than the current lifecycle transition.
  // This prevents delayed/backfilled timestamps from activating freshly provisioned hardware.
  const lifecycleTimestamp = device.lifecycleChangedAt || device.stateChangedAt; // fallback for rows not yet migrated
  const changedAt = lifecycleTimestamp ? new Date(lifecycleTimestamp).getTime() : NaN;
  if (!Number.isFinite(changedAt) || recordedAt.getTime() <= changedAt) return false;
  device.readinessVerifiedAt = recordedAt;
  device.readinessType = 'SENSOR_TELEMETRY';
  await device.save();
  // Readiness is evidence only. ACTIVE is entered only after an Admin lifecycle command and Firmware ACK.
  return false;
};

exports.recordPumpReady = async (device, payload) => {
  if (!device || device.type !== 'PUMP' || !['PROVISIONED', 'FAULT', 'MAINTENANCE'].includes(device.lifecycle)) return false;
  const selfTest = payload?.selfTest;
  const evidence = String(payload?.presenceEvidence || selfTest?.evidence || '').toUpperCase();
  const feedback = device.config?.hardwareFeedback || {};
  const value = Number(selfTest?.value);
  const testedAt = new Date(payload?.testedAt || '');
  const testAge = Date.now() - testedAt.getTime();
  const testDurationMs = Number(payload?.testDurationMs);
  const lifecycleTimestamp = device.lifecycleChangedAt || device.stateChangedAt; // fallback for rows not yet migrated
  const changedAt = lifecycleTimestamp ? new Date(lifecycleTimestamp).getTime() : NaN;
  const recoveryProofIsFresh = Number.isFinite(changedAt)
    && Number.isFinite(testedAt.getTime())
    && testedAt.getTime() > changedAt;
  if (!recoveryProofIsFresh || payload?.ready !== true || selfTest?.ok !== true || !PUMP_EVIDENCE.includes(evidence) || evidence !== feedback.type || !Number.isFinite(value) || value <= 0 || !Number.isFinite(testAge) || testAge < -5000 || testAge > FRESH_MS || !Number.isInteger(testDurationMs) || testDurationMs < 1 || testDurationMs > Math.min(1000, Number(feedback.maxTestDurationMs || 1000))) {
    await audit.log(null, {
      action: 'device.readiness_rejected', entityType: 'device', entityId: device.id, success: false,
      detail: { deviceCode: device.deviceCode, evidence, expectedEvidence: feedback.type || null, reason: 'invalid_pump_readiness_proof' },
    });
    return false;
  }
  device.readinessVerifiedAt = testedAt;
  device.readinessType = evidence;
  await device.save();
  return false;
};

exports.checkExistingSensorEvidence = async (device) => {
  if (!device || device.type !== 'SENSOR' || !['PROVISIONED', 'FAULT', 'MAINTENANCE'].includes(device.lifecycle)) return false;
  const cutoff = new Date(Date.now() - FRESH_MS);
  const upperBound = new Date(Date.now() + 5000);
  const recordedAtRange = { [Op.gte]: cutoff, [Op.lte]: upperBound };
  const lifecycleTimestamp = device.lifecycleChangedAt || device.stateChangedAt; // fallback for rows not yet migrated
  if (!lifecycleTimestamp) return false;
  recordedAtRange[Op.gt] = new Date(lifecycleTimestamp);
  const latest = await SensorReading.findOne({
    where: { deviceId: device.id, isBackfilled: false, recordedAt: recordedAtRange },
    order: [['recordedAt', 'DESC']],
  });
  if (!latest) return false;
  device.readinessVerifiedAt = latest.recordedAt;
  device.readinessType = 'SENSOR_TELEMETRY';
  await device.save();
  return false;
};
