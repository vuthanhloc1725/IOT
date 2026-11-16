const { Op } = require('sequelize');
const { Alert } = require('../models');
const env = require('../config/env');
const alertService = require('./alert.service');
const audit = require('./audit.service');
const { desiredDirection, normalizeRule } = require('./sensor-threshold.policy');

const METRIC_LABELS = {
  SOIL_MOISTURE: { label: 'Độ ẩm đất', unit: '%' },
  AIR_TEMPERATURE: { label: 'Nhiệt độ không khí', unit: '°C' },
  AIR_HUMIDITY: { label: 'Độ ẩm không khí', unit: '%' },
};
const FRESH_MS = 5 * 60 * 1000;
const locks = new Map();

function directionFromTitle(title) {
  const match = /^\[([A-Z_]+):(LOW|HIGH)\]/.exec(String(title || ''));
  return match ? { metric: match[1], direction: match[2] } : null;
}

function alertTitle(device, metric, direction) {
  const { label } = METRIC_LABELS[metric] || { label: metric };
  return `[${metric}:${direction}] ${label} ${direction === 'LOW' ? 'thấp' : 'cao'} — ${device.deviceCode}`;
}

function getEffectiveRule(device, metric) {
  const defaultRule = env.sensorThresholdRules[metric];
  const override = device?.config?.alertThresholds?.[metric];
  if (override?.enabled === false) return null;
  const candidate = { ...(defaultRule || {}), ...(override || {}) };
  return normalizeRule(candidate);
}

function getLimit(rule, direction) {
  return direction === 'LOW' ? rule.low : rule.high;
}

function severityFor(metric, direction, value, rule) {
  if (rule?.[direction === 'LOW' ? 'lowSeverity' : 'highSeverity']) {
    const configured = String(rule[direction === 'LOW' ? 'lowSeverity' : 'highSeverity']).toUpperCase();
    if (['CRITICAL', 'WARNING', 'INFO'].includes(configured)) return configured;
  }
  if (metric === 'AIR_TEMPERATURE' && direction === 'HIGH' && Number(value) >= 40) return 'CRITICAL';
  return 'WARNING';
}

async function evaluateLocked({ device, reading, now }) {
  const metric = String(reading.metric || '').toUpperCase();
  const meta = METRIC_LABELS[metric];
  if (!meta) return false;

  const openAlerts = await Alert.findAll({
    where: { deviceId: device.id, type: 'sensor_threshold', status: { [Op.ne]: 'RESOLVED' } },
    order: [['id', 'ASC']],
  });
  const metricAlerts = openAlerts.filter((alert) => directionFromTitle(alert.title)?.metric === metric);
  const override = device?.config?.alertThresholds?.[metric];
  if (override?.enabled === false) {
    for (const alert of metricAlerts) {
      await alertService.autoResolve(alert, `Quy tắc cảnh báo ${metric} đã được tắt trong cấu hình thiết bị.`);
      await audit.log(null, { action: 'alert.sensor_threshold_cleared', entityType: 'alert', entityId: alert.id, detail: { deviceCode: device.deviceCode, metric, reason: 'rule_disabled' } });
    }
    return false;
  }
  const rule = getEffectiveRule(device, metric);
  if (!rule) return false;
  const activeDirections = metricAlerts.map((alert) => directionFromTitle(alert.title)?.direction).filter(Boolean);
  const value = Number(reading.value);
  const direction = desiredDirection(value, rule, activeDirections);

  // Resolve old/other-side alerts first; an out-of-range reading should not leave a stale alert open.
  for (const alert of metricAlerts) {
    if (directionFromTitle(alert.title)?.direction !== direction) {
      await alertService.autoResolve(alert, `Giá trị ${metric} đã thay đổi; cảnh báo được hệ thống tự đóng.`);
      await audit.log(null, {
        action: 'alert.sensor_threshold_cleared', entityType: 'alert', entityId: alert.id,
        detail: { deviceCode: device.deviceCode, metric, value, reason: 'returned_to_safe_range_or_changed_direction' },
      });
    }
  }

  if (!direction) return metricAlerts.length > 0;
  const title = alertTitle(device, metric, direction);
  const matching = metricAlerts.find((alert) => alert.title === title);
  if (matching) return true; // keep one open alert until the hysteresis recovery range is reached

  const threshold = getLimit(rule, direction);
  const alert = await alertService.create({
    type: 'sensor_threshold',
    severity: severityFor(metric, direction, value, rule),
    title,
    message: `${device.name} (${device.deviceCode}) ghi nhận ${meta.label.toLowerCase()} ${direction === 'LOW' ? 'thấp hơn' : 'cao hơn'} ngưỡng. Giá trị hiện tại: ${value} ${meta.unit}; ngưỡng: ${threshold} ${meta.unit}. Cảnh báo chỉ tự đóng khi số đo quay về vùng phục hồi.`,
    deviceId: device.id,
  });
  await audit.log(null, {
    action: 'alert.sensor_threshold_triggered', entityType: 'alert', entityId: alert.id,
    detail: { deviceId: device.id, deviceCode: device.deviceCode, metric, value, threshold, direction, severity: alert.severity },
  });
  return true;
}

exports.evaluate = async ({ device, reading, now = new Date() }) => {
  if (!device || device.type !== 'SENSOR' || device.lifecycle !== 'ACTIVE' || !reading || reading.isBackfilled) return false;
  const age = now.getTime() - new Date(reading.recordedAt).getTime();
  if (!Number.isFinite(age) || age < -5000 || age > FRESH_MS) return false;
  const key = `${device.id}:${String(reading.metric || '').toUpperCase()}`;
  const prior = locks.get(key) || Promise.resolve();
  const work = prior.catch(() => undefined).then(() => evaluateLocked({ device, reading, now }));
  locks.set(key, work);
  try {
    return await work;
  } finally {
    if (locks.get(key) === work) locks.delete(key);
  }
};

exports.alertTitle = alertTitle;
exports.directionFromTitle = directionFromTitle;
