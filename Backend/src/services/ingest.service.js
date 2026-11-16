const { Op } = require('sequelize');
const { Device, Node, SensorReading, Alert } = require('../models');
const { METRICS, LIFECYCLE_TRANSITIONS } = require('../constants');
const nodeService = require('./node.service');
const commandService = require('./command.service');
const lifecycleCommandService = require('./device-lifecycle-command.service');
const automation = require('./automation.service');
const socket = require('./socket.service');
const alertService = require('./alert.service');
const audit = require('./audit.service');
const deviceProbeService = require('./device-probe.service');
const deviceReadinessService = require('./device-readiness.service');
const sensorThresholdService = require('./sensor-threshold.service');
/**
 * telemetry payload (node → server):
 * { "ts": "2026-10-06T08:00:00Z", "backfilled": false,
 *   "readings": [ { "deviceCode": "SOIL-01", "metric": "SOIL_MOISTURE", "value": 28.4, "ts": "..." } ] }
 * Khi mạng khôi phục, node gửi bù các bản ghi cũ với "backfilled": true.
 */
async function updateActuatorStates(node, payload) {
  const devices = await Device.findAll({ where: { nodeId: node.id, type: { [Op.in]: ['PUMP', 'FAN'] }, lifecycle: { [Op.ne]: 'DECOMMISSIONED' } } });
  const stateFor = (device) => {
    const keys = device.type === 'PUMP' ? ['pumpOn', 'pump', 'pumpState'] : ['fanOn', 'fan', 'fanState'];
    for (const key of keys) {
      if (typeof payload[key] === 'boolean') return payload[key];
      if (typeof payload[key] === 'string' && ['on', 'off', 'true', 'false', '1', '0'].includes(payload[key].toLowerCase())) return ['on', 'true', '1'].includes(payload[key].toLowerCase());
      if (payload[key] && typeof payload[key] === 'object' && typeof payload[key].on === 'boolean') return payload[key].on;
    }
    return undefined;
  };
  for (const device of devices) {
    const state = stateFor(device);
    if (state === undefined || device.isOn === state) continue;
    device.isOn = state;
    device.stateChangedAt = new Date();
    await device.save();
    socket.emitDevice(device.id, 'device:update', device);
  }
}

async function findFirmwareEventDevice(node, event, payload) {
  const eventText = `${event} ${payload.sensor || ''} ${payload.fault || ''}`.toLowerCase();
  if (eventText.includes('pump') || eventText.includes('water_low') || eventText.includes('water low') || eventText.includes('water_ok')) {
    return Device.findOne({ where: { nodeId: node.id, type: 'PUMP', lifecycle: { [Op.ne]: 'DECOMMISSIONED' } } });
  }
  if (eventText.includes('soil') || eventText.includes('đất')) {
    const sensors = await Device.findAll({ where: { nodeId: node.id, type: 'SENSOR', lifecycle: { [Op.ne]: 'DECOMMISSIONED' } } });
    return sensors.find((d) => Array.isArray(d.config?.metrics) && d.config.metrics.includes('SOIL_MOISTURE'))
      || sensors.find((d) => /soil|đất/i.test(`${d.name} ${d.deviceCode}`))
      || (sensors.length === 1 ? sensors[0] : null);
  }
  if (eventText.includes('dht') || eventText.includes('humidity') || eventText.includes('temperature')) {
    const sensors = await Device.findAll({ where: { nodeId: node.id, type: 'SENSOR', lifecycle: { [Op.ne]: 'DECOMMISSIONED' } } });
    return sensors.find((d) => Array.isArray(d.config?.metrics) && d.config.metrics.some((m) => ['AIR_TEMPERATURE', 'AIR_HUMIDITY'].includes(m)))
      || sensors.find((d) => /dht|temp|nhiệt|humid|ẩm không khí/i.test(`${d.name} ${d.deviceCode}`))
      || null;
  }
  if (event === 'sensor_fault' || event === 'sensor_recovered') {
    const sensors = await Device.findAll({ where: { nodeId: node.id, type: 'SENSOR', lifecycle: { [Op.ne]: 'DECOMMISSIONED' } } });
    return sensors.length === 1 ? sensors[0] : null;
  }
  return null;
}
async function onFirmwareHeartbeatFaults(node, payload) {
  if (!Array.isArray(payload.faults)) return;
  const faults = payload.faults.map((f) => String(f).toLowerCase());
  if (faults.includes('soil')) await onFirmwareStatusEvent(node, { event: 'sensor_fault', sensor: 'soil', message: 'Heartbeat faults chứa soil' });
  if (faults.includes('dht22') || faults.includes('dht11') || faults.includes('dht')) await onFirmwareStatusEvent(node, { event: 'sensor_fault', sensor: 'dht22', message: 'Heartbeat faults chứa lỗi DHT' });
  if (faults.includes('pump')) await onFirmwareStatusEvent(node, { event: 'pump_locked', fault: 'pump', message: 'Heartbeat faults chứa pump' });
}

async function onFirmwareStatusEvent(node, payload) {
  const event = String(payload.event || payload.eventType || payload.eventName || payload.type || '').trim().toLowerCase();
  const supported = new Set(['sensor_fault', 'sensor_recovered', 'pump_no_effect', 'pump_locked', 'pump_unlocked', 'water_low', 'water_ok']);
  if (!supported.has(event)) return false;
  const device = await findFirmwareEventDevice(node, event, payload);
  if (!device) {
    await audit.log(null, { action: `firmware.${event}`, entityType: 'node', entityId: node.id, detail: { nodeCode: node.nodeCode, sensor: payload.sensor || null, message: String(payload.message || '').slice(0, 300) } });
    return true;
  }
  const isCritical = ['pump_locked', 'water_low', 'sensor_fault'].includes(event);
  const existing = await Alert.findOne({ where: { deviceId: device.id, type: 'fault', status: { [Op.ne]: 'RESOLVED' }, title: `Firmware event: ${event}` } });
  if (!existing && !['sensor_recovered', 'water_ok'].includes(event)) {
    await alertService.create({
      type: 'fault', severity: isCritical ? 'CRITICAL' : 'WARNING',
      title: `Firmware event: ${event}`,
      message: String(payload.message || payload.reason || event).slice(0, 2000),
      deviceId: device.id,
    });
  }
  if (['sensor_fault', 'pump_locked'].includes(event) && device.lifecycle !== 'FAULT'
      && device.lifecycle !== 'DECOMMISSIONED' && (LIFECYCLE_TRANSITIONS[device.lifecycle] || []).includes('FAULT')) {
    if (device.type === 'PUMP' && device.isOn && !(await commandService.hasInFlight(device.id))) {
      try { await commandService.issue({ device, turnOn: false, source: 'ALERT' }); } catch (_) { /* keep the firmware fault visible */ }
    }
    device.lifecycle = 'FAULT';
    device.lifecycleChangedAt = new Date();
    device.readinessVerifiedAt = null;
    device.readinessType = null;
    if (payload.pumpOn === false && device.type === 'PUMP') device.isOn = false;
    await device.save();
    socket.emitDevice(device.id, 'device:update', device);
  }
  if (event === 'water_ok' || event === 'pump_unlocked') {
    const previousEvent = event === 'water_ok' ? 'water_low' : 'pump_locked';
    const alerts = await Alert.findAll({ where: { deviceId: device.id, type: 'fault', status: { [Op.ne]: 'RESOLVED' }, title: `Firmware event: ${previousEvent}` } });
    for (const alert of alerts) await alertService.autoResolve(alert, `Firmware báo ${event}`);
  }
  if (['sensor_recovered', 'water_ok', 'pump_unlocked'].includes(event)) {
    await audit.log(null, { action: `firmware.${event}`, entityType: 'device', entityId: device.id, detail: { nodeCode: node.nodeCode, deviceCode: device.deviceCode, message: String(payload.message || '').slice(0, 300) } });
  }
  return true;
}

function firmwareRecordedAt(record, payload, node, now) {
  const raw = record?.ts ?? record?.timestamp ?? payload.ts ?? payload.timestamp ?? payload.time;
  if (raw !== undefined && raw !== null && raw !== '' && Number(raw) !== 0) {
    let date;
    if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw))) {
      const n = Number(raw);
      date = new Date(n > 1e12 ? n : n * 1000); // numeric Unix seconds or milliseconds
    } else date = new Date(raw);
    if (Number.isFinite(date.getTime())) return date;
  }
  const bc = Number(record?.bc ?? payload.bc);
  const up = Number(record?.up ?? payload.up);
  if (Number.isInteger(bc) && bc >= 0 && Number.isFinite(up) && up >= 0
      && Number(node.firmwareBootCount) === bc && node.firmwareBootStartedAt) {
    const inferred = new Date(new Date(node.firmwareBootStartedAt).getTime() + up);
    if (Number.isFinite(inferred.getTime()) && inferred.getTime() <= now.getTime() + 5000) return inferred;
  }
  return now;
}

async function onTelemetry(node, payload, forceBackfilled = false) {
  const devices = await Device.findAll({ where: { nodeId: node.id } });
  const byCode = Object.fromEntries(devices.map((d) => [d.deviceCode, d]));
  const codeById = new Map(devices.map((d) => [Number(d.id), d.deviceCode]));
  const activeSensorIds = new Set(devices.filter((d) => d.type === 'SENSOR' && d.lifecycle === 'ACTIVE').map((d) => Number(d.id)));
  let items = Array.isArray(payload.readings) ? payload.readings : [];
  const now = new Date();

  // Firmware Telemetry v1.2 can send flat fields instead of readings[]. Map those fields
  // to SENSOR rows using config.metrics (preferred), then sensible name/code hints, then a single sensor row.
  if (!items.length) {
    const aliases = {
      SOIL_MOISTURE: ['soilMoisture', 'soil_moisture', 'soilMoisturePct', 'soil_moisture_pct', 'soilPercent', 'soilPct', 'soil', 'soilHumidity'],
      AIR_TEMPERATURE: ['temperature', 'temp', 'airTemperature', 'air_temperature', 'temperatureC', 'tempC', 't'],
      AIR_HUMIDITY: ['humidity', 'airHumidity', 'air_humidity', 'humidityPct', 'humidityPercent', 'airHumidityPct', 'rh'] ,
    };
    const sensors = devices.filter((d) => d.type === 'SENSOR' && ['ACTIVE', 'PROVISIONED', 'FAULT', 'MAINTENANCE'].includes(d.lifecycle));
    const pickSensor = (metric) => {
      const explicit = sensors.find((d) => Array.isArray(d.config?.metrics) && d.config.metrics.includes(metric));
      if (explicit) return explicit;
      const hint = metric === 'SOIL_MOISTURE' ? /(soil|đất|soil)/i
        : metric === 'AIR_TEMPERATURE' ? /(temp|nhiệt|dht)/i : /(humid|ẩm không khí|humidity|dht)/i;
      const hinted = sensors.find((d) => hint.test(`${d.name} ${d.deviceCode}`));
      if (hinted) return hinted;
      return sensors.length === 1 ? sensors[0] : null;
    };
    for (const metric of METRICS) {
      const field = aliases[metric].find((key) => payload[key] !== undefined);
      if (!field) continue;
      const sensor = pickSensor(metric);
      if (sensor) items.push({ deviceCode: sensor.deviceCode, metric, value: payload[field], ts: payload.ts ?? payload.timestamp ?? payload.time, seq: payload.seq, bc: payload.bc, up: payload.up, backfilled: forceBackfilled || payload.backfilled === true || payload.backfill === true });
    }
  }
  if (!items.length) return;

  const rows = [];
  for (const r of items) {
    const reportedCode = typeof r.deviceCode === 'string' ? r.deviceCode.trim() : '';
    if (!reportedCode) continue; // MQTT payload phải dùng deviceCode, không dùng DB deviceId.
    const dev = byCode[reportedCode];
    // PROVISIONED sensors may send a fresh real reading as readiness proof, but do not run automation yet.
    if (!dev || dev.type !== 'SENSOR' || !['PROVISIONED', 'ACTIVE', 'FAULT', 'MAINTENANCE'].includes(dev.lifecycle)) continue;
    if (!METRICS.includes(r.metric)) continue;
    if (r.value === null || r.value === undefined || r.value === '') continue;
    const value = Number(r.value);
    if (!Number.isFinite(value)) continue;
    if (['SOIL_MOISTURE', 'AIR_HUMIDITY'].includes(r.metric) && (value < 0 || value > 100)) continue;
    const ts = firmwareRecordedAt(r, payload, node, now);
    if (isNaN(ts) || ts.getTime() > now.getTime() + 5 * 60 * 1000) continue;
    const rawSeq = r.seq ?? payload.seq;
    const rawBootCount = r.bc ?? payload.bc;
    const sourceSeq = rawSeq === undefined || rawSeq === null || rawSeq === '' ? null : Number(rawSeq);
    const sourceBootCount = rawBootCount === undefined || rawBootCount === null || rawBootCount === '' ? null : Number(rawBootCount);
    rows.push({
      deviceId: dev.id,
      metric: r.metric,
      recordedAt: ts,
      value,
      sourceSeq: Number.isSafeInteger(sourceSeq) && sourceSeq >= 0 ? sourceSeq : null,
      sourceBootCount: Number.isInteger(sourceBootCount) && sourceBootCount >= 0 ? sourceBootCount : null,
      isBackfilled: forceBackfilled || (r.backfilled ?? payload.backfilled ?? payload.backfill) === true,
      receivedAt: now,
    });
  }
  if (!rows.length) return;

  // MQTT QoS 1 can redeliver packets. De-duplicate both within the payload and against the DB
  // primary key so a replay does not emit duplicate UI events or retrigger automation.
  const seen = new Set();
  const candidates = rows.filter((row) => {
    const key = row.sourceSeq !== null && row.sourceBootCount !== null
      ? `seq|${row.deviceId}|${row.metric}|${row.sourceBootCount}|${row.sourceSeq}`
      : `ts|${row.deviceId}|${row.metric}|${new Date(row.recordedAt).getTime()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!candidates.length) return;
  const deviceIds = [...new Set(candidates.map((row) => row.deviceId))];
  const metrics = [...new Set(candidates.map((row) => row.metric))];
  const times = candidates.map((row) => new Date(row.recordedAt).getTime());
  const sourceConditions = candidates
    .filter((row) => row.sourceSeq !== null && row.sourceBootCount !== null)
    .map((row) => ({ deviceId: row.deviceId, metric: row.metric, sourceSeq: row.sourceSeq, sourceBootCount: row.sourceBootCount }));
  const existing = await SensorReading.findAll({
    where: {
      [Op.or]: [
        {
          deviceId: { [Op.in]: deviceIds },
          metric: { [Op.in]: metrics },
          recordedAt: { [Op.gte]: new Date(Math.min(...times)), [Op.lte]: new Date(Math.max(...times)) },
        },
        ...sourceConditions,
      ],
    },
    attributes: ['deviceId', 'metric', 'recordedAt', 'sourceSeq', 'sourceBootCount'],
    raw: true,
  });
  const existingKeys = new Set();
  for (const row of existing) {
    existingKeys.add(`ts|${row.deviceId}|${row.metric}|${new Date(row.recordedAt).getTime()}`);
    if (row.sourceSeq !== null && row.sourceSeq !== undefined && row.sourceBootCount !== null && row.sourceBootCount !== undefined) {
      existingKeys.add(`seq|${row.deviceId}|${row.metric}|${row.sourceBootCount}|${row.sourceSeq}`);
    }
  }
  const freshRows = candidates.filter((row) => {
    const tsKey = `ts|${row.deviceId}|${row.metric}|${new Date(row.recordedAt).getTime()}`;
    const seqKey = row.sourceSeq !== null && row.sourceBootCount !== null ? `seq|${row.deviceId}|${row.metric}|${row.sourceBootCount}|${row.sourceSeq}` : null;
    return !existingKeys.has(tsKey) && (!seqKey || !existingKeys.has(seqKey));
  });
  if (!freshRows.length) return;
  await SensorReading.bulkCreate(freshRows, { ignoreDuplicates: true });

  for (const row of freshRows) {
    const deviceCode = codeById.get(Number(row.deviceId));
    socket.emitDevice(row.deviceId, 'reading', {
      deviceId: row.deviceId, deviceCode, metric: row.metric, value: row.value,
      recordedAt: row.recordedAt, isBackfilled: row.isBackfilled,
    });
    const device = byCode[deviceCode];
    if (device && ['PROVISIONED', 'FAULT', 'MAINTENANCE'].includes(device.lifecycle)) {
      await deviceReadinessService.recordSensorReading(device, row);
    }
    // Chỉ xử lý cảnh báo/ngưỡng và tự động hóa với dữ liệu mới, không chạy lại dữ liệu gửi bù.
    // Cảnh báo chỉ chạy khi sensor đang ACTIVE; telemetry cũ không sinh cảnh báo hồi tố.
    // deviceId dùng cho DB; deviceCode dùng làm khóa thiết bị ổn định trong config.
    const ageMs = now.getTime() - new Date(row.recordedAt).getTime();
    if (!row.isBackfilled && activeSensorIds.has(Number(row.deviceId)) && ageMs >= 0 && ageMs < 5 * 60 * 1000) {
      await sensorThresholdService.evaluate({ device, reading: row, now });
      await automation.evaluate({ ...row, deviceCode });
    }
  }
}
exports.handle = async (nodeCode, kind, payload) => {
  const node = await Node.findOne({ where: { nodeCode: nodeCode } });
  if (!node || node.isRevoked || !node.mqttAccountEnabled) return; // node lạ, tài khoản bị khóa hoặc đã thu hồi: bỏ qua

  switch (kind) {
    case 'device/probe/ack': {
      const accepted = await deviceProbeService.handleAck(node, payload);
      if (accepted) await nodeService.markAlive(node, { firmwareVersion: payload.firmwareVersion, bootCount: payload.bc, uptimeMs: payload.up });
      return undefined;
    }
    case 'heartbeat': {
      await nodeService.markAlive(node, { firmwareVersion: payload.firmwareVersion || payload.firmware, bootCount: payload.bc, uptimeMs: payload.up });
      await onFirmwareHeartbeatFaults(node, payload);
      return undefined;
    }
    case 'telemetry':
      await nodeService.markAlive(node, { firmwareVersion: payload.firmwareVersion || payload.firmware, bootCount: payload.bc, uptimeMs: payload.up });
      await updateActuatorStates(node, payload);
      return onTelemetry(node, payload, false);
    case 'telemetry/backfill':
      await nodeService.markAlive(node, { firmwareVersion: payload.firmwareVersion || payload.firmware, bootCount: payload.bc, uptimeMs: payload.up });
      return onTelemetry(node, payload, true);
    case 'config': {
      // Firmware v1.2 publishes its complete effective configuration on sf/<id>/config.
      // Treat this as confirmation of the currently pending config versions for this Node.
      const version = Number(payload.version ?? payload.configVersion);
      if (Number.isInteger(version) && version >= 0) {
        const configWhere = { nodeId: node.id, type: { [Op.in]: ['PUMP', 'FAN'] }, lifecycle: { [Op.ne]: 'DECOMMISSIONED' } };
        if (typeof payload.deviceCode === 'string' && payload.deviceCode.trim()) configWhere.deviceCode = payload.deviceCode.trim();
        const devices = await Device.findAll({ where: configWhere });
        for (const device of devices) {
          if (version === Number(device.configVersion) && Number(device.configAppliedVersion) < version) {
            device.configAppliedVersion = version;
            await device.save();
            socket.emitDevice(device.id, 'device:update', device);
          }
        }
      }
      await nodeService.markAlive(node, { firmwareVersion: payload.firmwareVersion || payload.firmware, bootCount: payload.bc, uptimeMs: payload.up });
      return undefined;
    }
    case 'status': {
      if (await onFirmwareStatusEvent(node, payload)) {
        await nodeService.markAlive(node, { firmwareVersion: payload.firmwareVersion || payload.firmware, bootCount: payload.bc, uptimeMs: payload.up });
        return undefined;
      }
      // Device fault event: { deviceCode, deviceStatus: "FAULT", message }.
      // Also accepts { deviceCode, status: "FAULT" } for simpler firmware payloads.
      const deviceStatus = String(payload.deviceStatus || (payload.deviceCode ? payload.status : '') || '').toUpperCase();
      if (payload.deviceCode && deviceStatus) {
        await nodeService.markAlive(node);
        const deviceCode = String(payload.deviceCode).trim();
        const device = await Device.findOne({ where: { nodeId: node.id, deviceCode } });
        if (!device) return undefined;
        if (deviceStatus === 'READY') {
          if (device.type === 'PUMP' && ['PROVISIONED', 'FAULT', 'MAINTENANCE'].includes(device.lifecycle) && payload.ready === true) {
            await deviceReadinessService.recordPumpReady(device, payload);
          }
          return undefined;
        }
        if (deviceStatus !== 'FAULT') return undefined; // ACTIVE does not auto-clear a fault; recovery needs fresh proof.
        if (device.lifecycle === 'REGISTERED' || device.lifecycle === 'DECOMMISSIONED') return undefined;
        if (device.lifecycle !== 'FAULT' && !(LIFECYCLE_TRANSITIONS[device.lifecycle] || []).includes('FAULT')) {
          await audit.log(null, {
            action: 'device.lifecycle_transition_rejected', entityType: 'device', entityId: device.id, success: false,
            detail: { from: device.lifecycle, to: 'FAULT', nodeCode: node.nodeCode, reason: 'transition_not_allowed' },
          });
          return undefined;
        }
        const enteringFault = device.lifecycle !== 'FAULT';
        // If a fault report repeats, invalidate any readiness proof collected since the last report.
        // Do not flood OFF commands when one is already awaiting ACK.
        if (['PUMP', 'FAN'].includes(device.type) && device.isOn && (enteringFault || !(await commandService.hasInFlight(device.id)))) {
          try {
            await commandService.issue({ device, turnOn: false, source: 'ALERT' });
            // Keep isOn true until the Node sends a valid command ACK; never infer the pump stopped.
          } catch (error) {
            await audit.log(null, { action: 'device.fault_safe_off_failed', entityType: 'device', entityId: device.id, success: false, detail: { deviceCode: device.deviceCode, error: String(error.message || error).slice(0, 300) } });
          }
        }
        device.lifecycle = 'FAULT';
        device.lifecycleChangedAt = new Date();
        device.readinessVerifiedAt = null;
        device.readinessType = null;
        await device.save();
        socket.emitDevice(device.id, 'device:update', device);
        const existing = await Alert.findOne({ where: { deviceId: device.id, type: 'fault', status: { [Op.ne]: 'RESOLVED' } } });
        if (!existing) {
          await alertService.create({
            type: 'fault', severity: 'CRITICAL',
            title: `Thiết bị ${device.name} báo lỗi`,
            message: String(payload.message || 'Firmware báo trạng thái FAULT').slice(0, 2000),
            deviceId: device.id,
          });
        }
        await audit.log(null, {
          action: 'device.fault_report', entityType: 'device', entityId: device.id,
          detail: { nodeId: node.id, nodeCode: node.nodeCode, message: String(payload.message || '').slice(0, 500) },
        });
        return undefined;
      }
      // Retained/LWT: Node status "online" | "offline" (raw string or { status }).
      const nodeStatus = String(payload.status || payload.raw || '').toLowerCase();
      if (nodeStatus === 'offline') return nodeService.markOffline(node, 'node báo offline (LWT)');
      if (nodeStatus === 'online') return nodeService.markAlive(node);
      return undefined;
    }
    case 'cmd/ack':
    case 'command/ack': {
      // A malformed, mismatched, replayed or late ACK must not refresh the Node heartbeat.
      // Only an ACK correlated to a current command on this Node proves the exchange was valid.
      const lifecycleAccepted = await lifecycleCommandService.handleAck(node, payload);
      if (lifecycleAccepted) {
        await nodeService.markAlive(node, { firmwareVersion: payload.firmwareVersion || payload.firmware, bootCount: payload.bc, uptimeMs: payload.up });
        return undefined;
      }
      const accepted = await commandService.handleAck(node, payload);
      if (accepted) await nodeService.markAlive(node);
      return undefined;
    }
    case 'config/ack': {
      await nodeService.markAlive(node);
      const deviceCode = typeof payload.deviceCode === 'string' ? payload.deviceCode.trim() : '';
      if (!deviceCode) return undefined;
      const dev = await Device.findOne({ where: { nodeId: node.id, deviceCode } });
      const version = Number(payload.version);
      if (!dev || !Number.isInteger(version) || version !== dev.configVersion || version <= dev.configAppliedVersion) return undefined;
      if (payload.success !== true) {
        await audit.log(null, { action: 'device.config_apply_failed', entityType: 'device', entityId: dev.id, success: false, detail: { deviceCode, nodeCode: node.nodeCode, version, message: String(payload.message || 'Node không xác nhận áp dụng cấu hình').slice(0, 300) } });
        return undefined;
      }
      dev.configAppliedVersion = version;
      await dev.save();
      await audit.log(null, { action: 'device.config_applied', entityType: 'device', entityId: dev.id, detail: { deviceCode, nodeCode: node.nodeCode, version } });
      if (['PROVISIONED', 'FAULT', 'MAINTENANCE'].includes(dev.lifecycle) && dev.type === 'SENSOR') {
        await deviceReadinessService.checkExistingSensorEvidence(dev);
      }
      // Config ACK never activates a Device. Only the explicit Admin lifecycle command + Firmware ACK can do that.
      return undefined;
    }
    default:
  }
};
