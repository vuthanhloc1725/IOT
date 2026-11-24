'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCommandAck, authorizeCommandAck } = require('../src/services/command-ack-security');

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const NOW = new Date('2026-10-26T10:00:10.000Z');

function validPayload(overrides = {}) {
  return { commandUuid: UUID, deviceCode: 'PUMP-01', success: true, ...overrides };
}
function validContext(overrides = {}) {
  const ack = normalizeCommandAck(validPayload()).ack;
  return {
    cmd: { id: 7, commandUuid: UUID, deviceId: 12, status: 'SENT', sentAt: new Date('2026-10-26T10:00:00.000Z') },
    device: { id: 12, nodeId: 3, deviceCode: 'PUMP-01' },
    node: { id: 3, nodeCode: 'NODE-01', isRevoked: false },
    ack,
    now: NOW,
    timeoutSec: 15,
    ...overrides,
  };
}

test('accepts a well-formed ACK with matching device identity fields', () => {
  const parsed = normalizeCommandAck(validPayload());
  assert.equal(parsed.ok, true);
  assert.deepEqual(authorizeCommandAck(validContext()), { ok: true });
});

test('accepts a valid failure ACK; success=false must remain a boolean', () => {
  const parsed = normalizeCommandAck(validPayload({ success: false, message: 'GPIO error' }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ack.success, false);
});

test('rejects ACK without commandUuid', () => {
  assert.equal(normalizeCommandAck({ deviceCode: 'PUMP-01', success: true }).reason, 'missing_or_invalid_command_uuid');
});

test('rejects malformed commandUuid', () => {
  assert.equal(normalizeCommandAck(validPayload({ commandUuid: 'not-a-uuid' })).reason, 'missing_or_invalid_command_uuid');
});

test('rejects ACK without deviceCode', () => {
  assert.equal(normalizeCommandAck({ commandUuid: UUID, success: true }).reason, 'missing_device_code');
});

test('rejects conflicting legacy and camelCase identifiers', () => {
  assert.equal(normalizeCommandAck(validPayload({ command_uuid: '650e8400-e29b-41d4-a716-446655440000' })).reason, 'conflicting_commandUuid_aliases');
  assert.equal(normalizeCommandAck(validPayload({ device_code: 'PUMP-02' })).reason, 'conflicting_deviceCode_aliases');
});

test('rejects string success values such as "true"', () => {
  assert.equal(normalizeCommandAck(validPayload({ success: 'true' })).reason, 'success_must_be_boolean');
});

test('rejects ACK from a different Node', () => {
  assert.equal(authorizeCommandAck(validContext({ node: { id: 4, isRevoked: false } })).reason, 'wrong_node_for_device');
});

test('rejects a mismatched deviceCode even when commandUuid is correct', () => {
  const ack = normalizeCommandAck(validPayload({ deviceCode: 'PUMP-02' })).ack;
  assert.equal(authorizeCommandAck(validContext({ ack })).reason, 'device_code_mismatch');
});

test('rejects a command that is already terminal or not awaiting ACK', () => {
  assert.equal(authorizeCommandAck(validContext({ cmd: { ...validContext().cmd, status: 'TIMEOUT' } })).reason, 'command_not_waiting_for_ack');
});

test('rejects ACK after the configured deadline', () => {
  const lateNow = new Date('2026-10-26T10:00:20.001Z');
  const result = authorizeCommandAck(validContext({ now: lateNow, timeoutSec: 15 }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ack_too_late');
  assert.equal(result.late, true);
});

test('rejects ACK when its command has no trustworthy sentAt', () => {
  assert.equal(authorizeCommandAck(validContext({ cmd: { ...validContext().cmd, sentAt: null } })).reason, 'missing_or_invalid_sent_at');
});

test('Firmware v1.2 ACK aliases ok/reason and may omit child deviceCode when command UUID is present', () => {
  const result = normalizeCommandAck({
    commandId: '550e8400-e29b-41d4-a716-446655440000',
    action: 'fan',
    ok: true,
    reason: 'fan enabled',
  }, { firmwareCompat: true });
  assert.equal(result.ok, true);
  assert.equal(result.ack.commandUuid, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(result.ack.deviceCode, null);
  assert.equal(result.ack.success, true);
  assert.equal(result.ack.message, 'fan enabled');
});
