const { Op } = require('sequelize');
const { Device, DeviceCommand, SensorReading } = require('../models');
const { AUTO_ACTUATORS } = require('../constants');
const commandService = require('./command.service');

const OPS = {
  lt: (v, t) => v < t,
  lte: (v, t) => v <= t,
  gt: (v, t) => v > t,
  gte: (v, t) => v >= t,
};
const FRESH_MS = 5 * 60 * 1000;

async function latestMetricsForNode(nodeId) {
  const sensors = await Device.findAll({ where: { nodeId, type: 'SENSOR', lifecycle: 'ACTIVE' }, attributes: ['id'] });
  if (!sensors.length) return {};
  const rows = await SensorReading.findAll({
    where: { deviceId: { [Op.in]: sensors.map((s) => s.id) }, metric: { [Op.in]: ['AIR_TEMPERATURE', 'AIR_HUMIDITY', 'SOIL_MOISTURE'] }, isBackfilled: false },
    order: [['recordedAt', 'DESC']],
    limit: Math.max(20, sensors.length * 3),
  });
  const latest = {};
  const cutoff = Date.now() - FRESH_MS;
  for (const row of rows) {
    if (new Date(row.recordedAt).getTime() < cutoff || latest[row.metric] !== undefined) continue;
    latest[row.metric] = Number(row.value);
  }
  return latest;
}

async function maybeRunFanPreset(fan) {
  const auto = fan.config?.auto;
  if (fan.type !== 'FAN' || auto?.preset !== 'FAN_HYSTERESIS' || auto.enabled !== true || !fan.nodeId) return;
  const values = await latestMetricsForNode(fan.nodeId);
  const temp = values.AIR_TEMPERATURE;
  const humidity = values.AIR_HUMIDITY;
  if (!Number.isFinite(temp) || !Number.isFinite(humidity)) return;
  const thresholds = fan.config?.fanThresholds || {};
  const onTemp = Number(thresholds.onTempC ?? 32);
  const offTemp = Number(thresholds.offTempC ?? 30);
  const onHumidity = Number(thresholds.onHumidityPct ?? 85);
  const offHumidity = Number(thresholds.offHumidityPct ?? 80);
  const shouldTurnOn = temp >= onTemp || humidity >= onHumidity;
  const shouldTurnOff = temp <= offTemp && humidity < offHumidity;
  if ((!fan.isOn && !shouldTurnOn) || (fan.isOn && !shouldTurnOff)) return;
  if (await commandService.hasInFlight(fan.id)) return;
  const cooldown = await DeviceCommand.findOne({ where: { deviceId: fan.id, source: 'AUTO' }, order: [['id', 'DESC']] });
  if (cooldown && Date.now() - new Date(cooldown.createdAt).getTime() < 5000) return;
  await commandService.issue({ device: fan, turnOn: shouldTurnOn, source: 'AUTO', sensorValue: temp });
}

/**
 * Pump threshold rules use config.auto.sourceDeviceCode/metric/onOp/offOp/onValue/offValue.
 * Fan preset FAN_HYSTERESIS follows Firmware v1.2: ON at temp >= 32 C OR humidity >= 85%;
 * OFF at temp <= 30 C AND humidity < 80%. Firmware still runs its own local automation offline.
 */
exports.evaluate = async (reading) => {
  const actuators = await Device.findAll({ where: { type: { [Op.in]: AUTO_ACTUATORS }, lifecycle: 'ACTIVE' } });

  for (const actuator of actuators) {
    const auto = actuator.config && actuator.config.auto;
    if (actuator.config?.localAutomation === true) continue;
    if (!auto || auto.enabled !== true) continue;
    if (actuator.type === 'FAN' && auto.preset === 'FAN_HYSTERESIS') {
      await maybeRunFanPreset(actuator);
      continue;
    }

    const sourceMatches = typeof auto.sourceDeviceCode === 'number'
      ? Number(auto.sourceDeviceCode) === Number(reading.deviceId)
      : auto.sourceDeviceCode
        ? String(auto.sourceDeviceCode).trim() === String(reading.deviceCode || '').trim()
        : auto.sourceDeviceId !== undefined && auto.sourceDeviceId !== null
          ? Number(auto.sourceDeviceId) === Number(reading.deviceId)
          : false;
    if (!sourceMatches || auto.metric !== reading.metric) continue;

    const cooldownSec = Number(auto.cooldownSec ?? 30);
    const cooldown = (Number.isFinite(cooldownSec) && cooldownSec >= 0 ? cooldownSec : 30) * 1000;
    const last = await DeviceCommand.findOne({ where: { deviceId: actuator.id, source: 'AUTO' }, order: [['id', 'DESC']] });
    if (last && Date.now() - new Date(last.createdAt).getTime() < cooldown) continue;
    if (await commandService.hasInFlight(actuator.id)) continue;

    const value = Number(reading.value);
    if (!Number.isFinite(value)) continue;
    if (!actuator.isOn && OPS[String(auto.onOp || '').toLowerCase()]?.(value, Number(auto.onValue))) {
      await commandService.issue({ device: actuator, turnOn: true, source: 'AUTO', sensorValue: value });
    } else if (actuator.isOn && OPS[String(auto.offOp || '').toLowerCase()]?.(value, Number(auto.offValue))) {
      await commandService.issue({ device: actuator, turnOn: false, source: 'AUTO', sensorValue: value });
    }
  }
};
