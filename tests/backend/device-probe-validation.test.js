const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProbeAck } = require('../src/services/device-probe.protocol');

const expectedSensor = { requestId: 'probe-1', type: 'SENSOR', gpioPin: 34, hardwareFeedback: null, allowActuatorTest: false };
const validSensorAck = (overrides = {}) => ({
  requestId: 'probe-1', detectedType: 'SENSOR', gpioPin: 34,
  present: true, presenceEvidence: 'SENSOR_READ:SOIL_MOISTURE',
  selfTest: { ok: true, metric: 'SOIL_MOISTURE', value: 42.5 }, ...overrides,
});

test('accepts a sensor probe ACK without deviceCode because the backend generates it afterwards', () => {
  const out = normalizeProbeAck(validSensorAck(), expectedSensor);
  assert.equal(out.ok, true);
  assert.equal(out.metric, 'SOIL_MOISTURE');
  assert.equal(out.value, 42.5);
});

test('rejects absent devices and failed self-test', () => {
  assert.equal(normalizeProbeAck(validSensorAck({ present: false }), expectedSensor).ok, false);
  assert.equal(normalizeProbeAck(validSensorAck({ selfTest: { ok: false, message: 'not found' } }), expectedSensor).ok, false);
});

test('rejects mismatched request, type and GPIO', () => {
  assert.equal(normalizeProbeAck(validSensorAck({ requestId: 'other' }), expectedSensor).ok, false);
  assert.equal(normalizeProbeAck(validSensorAck({ detectedType: 'PUMP' }), expectedSensor).ok, false);
  assert.equal(normalizeProbeAck(validSensorAck({ gpioPin: 35 }), expectedSensor).ok, false);
});

test('rejects invalid sensor metrics and readings', () => {
  assert.equal(normalizeProbeAck(validSensorAck({ selfTest: { ok: true, metric: 'UNKNOWN', value: 1 } }), expectedSensor).ok, false);
  assert.equal(normalizeProbeAck(validSensorAck({ selfTest: { ok: true, metric: 'SOIL_MOISTURE', value: 101 } }), expectedSensor).ok, false);
});

test('pump requires a physical feedback signal and explicit short-test consent', () => {
  const expectedPump = { requestId: 'probe-2', type: 'PUMP', gpioPin: 26, hardwareFeedback: { type: 'CURRENT_SENSOR', gpioPin: 34 }, allowActuatorTest: true };
  const ack = { requestId: 'probe-2', detectedType: 'PUMP', gpioPin: 26, present: true, presenceEvidence: 'CURRENT_SENSOR', testDurationMs: 500, selfTest: { ok: true, metric: 'CURRENT_A', value: 0.42, evidence: 'CURRENT_SENSOR' } };
  assert.equal(normalizeProbeAck(ack, expectedPump).ok, true);
  assert.equal(normalizeProbeAck({ ...ack, presenceEvidence: 'RELAY_FEEDBACK' }, expectedPump).ok, false);
  assert.equal(normalizeProbeAck({ ...ack, testDurationMs: 5000 }, expectedPump).ok, false);
  assert.equal(normalizeProbeAck(ack, { ...expectedPump, allowActuatorTest: false }).ok, false);
  assert.equal(normalizeProbeAck({ ...ack, selfTest: { ...ack.selfTest, value: 0 } }, expectedPump).ok, false);
});

test('rejects a missing sensor reading instead of coercing null to zero', () => {
  assert.equal(normalizeProbeAck(validSensorAck({ selfTest: { ok: true, metric: 'SOIL_MOISTURE', value: null } }), expectedSensor).ok, false);
  assert.equal(normalizeProbeAck(validSensorAck({ selfTest: { ok: true, metric: 'SOIL_MOISTURE', value: '' } }), expectedSensor).ok, false);
});
