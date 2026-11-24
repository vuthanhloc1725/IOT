const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SENSOR_THRESHOLD_RULES, desiredDirection, normalizeRule } = require('../src/services/sensor-threshold.policy');
const { recoveryBlockReason } = require('../src/services/device-lifecycle.policy');
const fs = require('node:fs');
const path = require('node:path');

test('sensor threshold rules use hysteresis to avoid alert flapping', () => {
  const rule = DEFAULT_SENSOR_THRESHOLD_RULES.SOIL_MOISTURE;
  assert.equal(desiredDirection(24, rule, []), 'LOW');
  assert.equal(desiredDirection(27, rule, ['LOW']), 'LOW'); // stays open until recovery at 30
  assert.equal(desiredDirection(30, rule, ['LOW']), null);
  assert.equal(desiredDirection(86, rule, []), 'HIGH');
  assert.equal(desiredDirection(82, rule, ['HIGH']), 'HIGH'); // stays open until <=80
  assert.equal(desiredDirection(80, rule, ['HIGH']), null);
  assert.equal(normalizeRule({ low: 30, lowRecovery: 20 }), null);
});

test('recovery to ACTIVE requires fresh evidence after the lifecycle transition and current config ACK', () => {
  const now = Date.now();
  const device = {
    lifecycle: 'FAULT', type: 'SENSOR', lifecycleChangedAt: new Date(now - 60_000), stateChangedAt: new Date(now - 1_000),
    readinessVerifiedAt: new Date(now - 30_000), readinessType: 'SENSOR_TELEMETRY',
    configVersion: 3, configAppliedVersion: 3, isOn: false,
  };
  const node = { isOnline: true, isRevoked: false, mqttAccountEnabled: true, lastHeartbeatAt: new Date(now - 1000), heartbeatTimeoutSec: 60 };
  assert.equal(recoveryBlockReason(device, node, now), null);
  assert.match(recoveryBlockReason({ ...device, readinessVerifiedAt: new Date(now - 90_000) }, node, now), /mới hơn thời điểm/);
  assert.match(recoveryBlockReason({ ...device, configAppliedVersion: 2 }, node, now), /chưa được Node ACK/);
  assert.match(recoveryBlockReason({ ...device, configVersion: 2, configAppliedVersion: 3 }, node, now), /chưa được Node ACK/);
  assert.match(recoveryBlockReason(device, { ...node, isOnline: false }, now), /đang online/);
});

test('pump recovery requires new feedback proof and pump confirmed off', () => {
  const now = Date.now();
  const device = {
    lifecycle: 'MAINTENANCE', type: 'PUMP', lifecycleChangedAt: new Date(now - 60_000), stateChangedAt: new Date(now - 1_000),
    readinessVerifiedAt: new Date(now - 10_000), readinessType: 'FLOW_SENSOR',
    config: { hardwareFeedback: { type: 'FLOW_SENSOR' } },
    configVersion: 2, configAppliedVersion: 2, isOn: true,
  };
  const node = { isOnline: true, isRevoked: false, mqttAccountEnabled: true, lastHeartbeatAt: new Date(now - 1000), heartbeatTimeoutSec: 60 };
  assert.match(recoveryBlockReason(device, node, now), /vẫn đang bật/);
  assert.equal(recoveryBlockReason({ ...device, isOn: false }, node, now), null);
  assert.match(recoveryBlockReason({ ...device, readinessType: 'GPIO_ONLY' , isOn: false }, node, now), /phải khớp/);
});

test('JWT uses a stateless payload and logout clears the browser token locally', () => {
  const root = path.resolve(__dirname, '..');
  const authController = fs.readFileSync(path.join(root, 'src/controllers/auth.controller.js'), 'utf8');
  const authMiddleware = fs.readFileSync(path.join(root, 'src/middlewares/auth.js'), 'utf8');
  const authApi = fs.readFileSync(path.resolve(root, '../Frontend/src/api/auth.api.js'), 'utf8');
  assert.match(authController, /jwt\.sign\(\{ sub: u\.id, role: u\.role \}/);
  assert.doesNotMatch(authController, /tokenVersion|\btv:/);
  assert.doesNotMatch(authMiddleware, /tokenVersion|isCurrentTokenVersion/);
  assert.match(authApi, /setToken\(null\)/);
  assert.doesNotMatch(authApi.match(/export function logout\(\) \{[\s\S]*?\n\}/)?.[0] || '', /post\(['"]\/auth\/logout/);
});

const { LIFECYCLE_TRANSITIONS } = require('../src/constants');

test('lifecycle matrix allows explicit Admin activation from Provisioned; MQTT heartbeat cannot do it', () => {
  assert.ok(LIFECYCLE_TRANSITIONS.PROVISIONED.includes('ACTIVE'));
  assert.ok(LIFECYCLE_TRANSITIONS.PROVISIONED.includes('FAULT'));
  assert.ok(LIFECYCLE_TRANSITIONS.MAINTENANCE.includes('FAULT'));
  assert.deepEqual(LIFECYCLE_TRANSITIONS.DECOMMISSIONED, []);
  const root = path.resolve(__dirname, '..');
  const controller = fs.readFileSync(path.join(root, 'src/controllers/device.controller.js'), 'utf8');
  const lifecycleCommand = fs.readFileSync(path.join(root, 'src/services/device-lifecycle-command.service.js'), 'utf8');
  const ingest = fs.readFileSync(path.join(root, 'src/services/ingest.service.js'), 'utf8');
  assert.match(controller, /Chỉ Admin mới được kích hoạt thiết bị/);
  assert.match(controller, /requestActivation\(device, targetNode/);
  assert.match(lifecycleCommand, /device\.lifecycle = 'ACTIVE'/);
  assert.doesNotMatch(ingest, /tryActivate/);
  assert.doesNotMatch(ingest, /lifecycle\s*=\s*['\"]ACTIVE['\"]/);
});

test('lifecycle recovery compares proof to lifecycleChangedAt, not a newer output state change', () => {
  const now = Date.now();
  const device = {
    lifecycle: 'FAULT', type: 'SENSOR',
    lifecycleChangedAt: new Date(now - 60_000),
    stateChangedAt: new Date(now - 1_000), // e.g. later output/actuator state event
    readinessVerifiedAt: new Date(now - 30_000),
    readinessType: 'SENSOR_TELEMETRY',
    configVersion: 3, configAppliedVersion: 3, isOn: false,
  };
  const node = { isOnline: true, isRevoked: false, mqttAccountEnabled: true, lastHeartbeatAt: new Date(now - 1000), heartbeatTimeoutSec: 60 };
  assert.equal(recoveryBlockReason(device, node, now), null);
});


test('device model persists compact readinessType, not verbose evidence columns', () => {
  const root = path.resolve(__dirname, '..');
  const model = fs.readFileSync(path.join(root, 'src/models/device.model.js'), 'utf8');
  assert.match(model, /readinessType: \{ type: DataTypes\.ENUM\('SENSOR_TELEMETRY', 'CURRENT_SENSOR', 'FLOW_SENSOR'\)/);
  assert.match(model, /presenceVerifiedAt/);
  assert.match(model, /readinessVerifiedAt/);
  assert.match(model, /lifecycleChangedAt/);
  assert.doesNotMatch(model, /presenceEvidence|readinessEvidence/);

  const schema = fs.readFileSync(path.join(root, 'database/smart_agri_mysql_demo.sql'), 'utf8');
  const devicesTable = schema.match(/CREATE TABLE IF NOT EXISTS `devices` \(([\s\S]*?)\) ENGINE=/)?.[1] || '';
  assert.match(devicesTable, /`readinessType` ENUM\('SENSOR_TELEMETRY','CURRENT_SENSOR','FLOW_SENSOR'\)/);
  assert.doesNotMatch(devicesTable, /presenceEvidence|readinessEvidence/);

  const migration = fs.readFileSync(path.join(root, 'database/migrations/20261027_simplify_device_evidence.sql'), 'utf8');
  assert.match(migration, /INFORMATION_SCHEMA\.COLUMNS/);
  assert.match(migration, /DROP COLUMN `presenceEvidence`/);
  assert.match(migration, /DROP COLUMN `readinessEvidence`/);
});

test('fan recovery does not require pump current/flow feedback that Firmware v1.2 hardware does not have', () => {
  const { recoveryBlockReason } = require('../src/services/device-lifecycle.policy');
  const now = Date.now();
  const node = { isRevoked: false, mqttAccountEnabled: true, isOnline: true, lastHeartbeatAt: new Date(now), heartbeatTimeoutSec: 60 };
  const fan = {
    type: 'FAN', lifecycle: 'FAULT', lifecycleChangedAt: new Date(now - 1000),
    configVersion: 1, configAppliedVersion: 1,
  };
  assert.equal(recoveryBlockReason(fan, node, now), null);
});


test('inventory-mode pump recovery does not demand a current/flow sensor absent from Firmware v1.2', () => {
  const { recoveryBlockReason } = require('../src/services/device-lifecycle.policy');
  const now = Date.now();
  const node = { isRevoked: false, mqttAccountEnabled: true, isOnline: true, lastHeartbeatAt: new Date(now), heartbeatTimeoutSec: 60 };
  const pump = { type: 'PUMP', lifecycle: 'FAULT', lifecycleChangedAt: new Date(now - 1000), configVersion: 1, configAppliedVersion: 1, isOn: false, config: { localAutomation: true } };
  assert.equal(recoveryBlockReason(pump, node, now), null);
  pump.isOn = true;
  assert.match(recoveryBlockReason(pump, node, now), /OFF/);
});


test('Node MQTT account must be enabled before a Device can be recovered to Active', () => {
  const now = Date.now();
  const device = { lifecycle: 'FAULT', type: 'FAN', lifecycleChangedAt: new Date(now - 1000), configVersion: 1, configAppliedVersion: 1 };
  const node = { isRevoked: false, mqttAccountEnabled: false, isOnline: true, lastHeartbeatAt: new Date(now), heartbeatTimeoutSec: 60 };
  assert.match(recoveryBlockReason(device, node, now), /tài khoản MQTT đang bật/);
});
