const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { normalizeMac, issueToken, matchesToken } = require('../src/services/node-claim.service');

test('normalizes unicast MAC; rejects multicast and malformed addresses', () => {
    assert.equal(normalizeMac('24-6f-28-aa-bb-cc'), '24:6F:28:AA:BB:CC');
    assert.equal(normalizeMac('01:00:5e:00:00:01'), null);
    assert.equal(normalizeMac('00:00:00:00:00:00'), null);
    assert.equal(normalizeMac('24:6f:28:aa:bb'), null);
});

test('claim token is random, hashed, not matched by alternatives', () => {
    const a = issueToken();
    const b = issueToken();
    assert.notEqual(a.token, b.token);
    assert.notEqual(a.token, a.hash);
    assert.equal(matchesToken(a.token, a.hash), true);
    assert.equal(matchesToken(b.token, a.hash), false);
    assert.equal(matchesToken('x', a.hash), false);
    assert.ok(a.expiresAt.getTime() > Date.now());
});

test('routes and firmware keep MQTT topic contract independent of claim', () => {
    const root = path.resolve(__dirname, '..');
    const claims = fs.readFileSync(path.join(root, 'src/controllers/node.controller.js'), 'utf8');
    const firmware = fs.readFileSync(path.join(root, '../firmware/arduino/SoilPumpNode/SoilPumpNode.ino'), 'utf8');
    assert.match(claims, /lock: transaction\.LOCK\.UPDATE/);
    assert.match(claims, /matchesToken\(token, node\.claimTokenHash\)/);
    assert.match(firmware, /String\(MQTT_TOPIC_PREFIX\) \+ "\/" \+ NODE_CODE/);
    assert.match(firmware, /Registered MAC mismatch; pump remains OFF/);
});

const BASE_DEVICES = [
    { deviceCode: 'SOIL', type: 'SENSOR', gpioPin: 34, config: { metrics: ['SOIL_MOISTURE'] } },
    { deviceCode: 'DHT', type: 'SENSOR', gpioPin: 4, config: { metrics: ['AIR_TEMPERATURE', 'AIR_HUMIDITY'] } },
    { deviceCode: 'PUMP', type: 'PUMP', gpioPin: 26 },
];
const notFound = (brokerError) => Object.assign(new Error(brokerError), { brokerError });

function claimHarness({
    brokerFails = false, cleanupFails = false, markerFails = false, commitFails = false, registration = false,
    nodeMissing = false, disableError = null, enableError = null, afterReservation = null,
    mqttUrl = 'mqtts://broker.test', deviceUrl = '', claimRequireTls = true, devices = BASE_DEVICES,
} = {}) {
    const mac = '24:6F:28:AA:BB:CC';
    const claim = issueToken();
    const node = {
        id: 1, nodeCode: 'NODE-123', macAddress: mac, claimTokenHash: claim.hash,
        claimTokenExpiresAt: claim.expiresAt, claimConsumedAt: null, claimFailedAt: null,
        claimedAt: null, isRevoked: false, revokedAt: null, mqttUsername: null, mqttRoleName: null,
        async save() {}, async update(changes) { Object.assign(this, changes); },
    };
    const faults = { brokerFails };
    const calls = { create: 0, delete: 0, marker: 0, provision: 0, disable: 0, enable: 0, rotate: 0 };
    let transactions = 0;
    let transactionActive = false;
    let lockedNodeRead = false;
    const findByPk = async (_id, options) => { lockedNodeRead = options?.lock === 'UPDATE' && Boolean(options.transaction); return node; };
    const Node = {
        async create(values) {
            calls.create += 1;
            return { id: 2, ...values, toJSON() {
                const { claimTokenHash, ...publicValues } = values;
                return { id: 2, ...publicValues };
            } };
        },
        unscoped() { return { findOne: async () => nodeMissing ? null : node, findByPk }; },
        findOne: async () => registration ? null : node,
        findByPk,
        update: async (changes) => {
            calls.marker += 1;
            if (markerFails) throw new Error('DB unavailable');
            Object.assign(node, changes);
        },
    };
    const sequelize = { transaction: async (fn) => {
        transactions += 1;
        const current = transactions;
        const before = { ...node };
        transactionActive = true;
        try {
            const result = await fn({ LOCK: { UPDATE: 'UPDATE' } });
            if (commitFails && current === 2) throw new Error('DB commit failed');
            if (current === 1 && afterReservation) afterReservation(node);
            return result;
        } catch (error) {
            Object.assign(node, before);
            throw error;
        } finally { transactionActive = false; }
    } };
    const dynsec = {
        assertConfigured() {},
        buildNodeRole: () => ({ roleName: 'role_NODE-123' }),
        async createAccount({ username }) {
            calls.provision += 1;
            assert.ok(node.claimConsumedAt || !node.macAddress || node.claimedAt, 'reservation must be committed before broker creation');
            assert.equal(username, 'node_node_123');
            if (faults.brokerFails) throw new Error('broker unavailable');
        },
        async rotatePassword(username) { calls.rotate += 1; assert.equal(username, node.mqttUsername); },
        async disableAccount(username) {
            assert.equal(transactionActive, true, 'broker revocation must hold the node lock');
            assert.equal(lockedNodeRead, true);
            assert.equal(username, node.mqttUsername);
            calls.disable += 1;
            if (disableError) throw disableError;
        },
        async enableAccount() { calls.enable += 1; if (enableError) throw enableError; },
        async deleteAccount() { calls.delete += 1; if (cleanupFails) throw new Error('cleanup unavailable'); },
    };
    const env = { mqtt: { url: mqttUrl, deviceUrl, firmwarePrefix: 'sf' }, nodeEnv: 'test', claimTrustedProxyIps: [], claimRequireTls };
    const controllerPath = require.resolve('../src/controllers/node.controller');
    const provisioningPath = require.resolve('../src/services/node-provisioning.service');
    const mocks = {
        [controllerPath]: {
            '../models': { Node, Device: { findAll: async () => devices }, sequelize },
            '../services/audit.service': { log: async () => {} },
            '../services/node.service': { markOffline: async () => {} },
            '../services/command.service': { issue: async () => { throw new Error('safe-stop không được gọi khi không có PUMP/FAN đang bật'); } },
            '../services/mqtt-dynsec.service': dynsec,
            // Mã tuần tự thật cần Model.sequelize + transaction; test chỉ cần mã cố định NODE-123.
            '../services/code-generator': {
                createWithSequentialCode: async ({ Model, field, values }) => {
                    const record = await Model.create({ ...values, [field]: 'NODE-123' });
                    return { record, code: 'NODE-123' };
                },
            },
            '../config/env': env,
        },
        [provisioningPath]: { './mqtt-dynsec.service': dynsec, '../config/env': env },
    };
    const originalLoad = Module._load;
    let controller;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'sequelize') return { Op: {} };
            const scoped = mocks[parent?.filename];
            if (scoped && Object.hasOwn(scoped, request)) return scoped[request];
            return originalLoad.call(this, request, parent, isMain);
        };
        delete require.cache[controllerPath];
        delete require.cache[provisioningPath];
        controller = require(controllerPath);
    } finally {
        Module._load = originalLoad;
        delete require.cache[controllerPath];
        delete require.cache[provisioningPath];
    }
    const req = { body: { macAddress: mac, claimToken: claim.token }, socket: { remoteAddress: '127.0.0.1' }, headers: {}, params: { id: 1 } };
    const res = { set() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
    return { node, controller, req, res, calls, claim, faults };
}

const quiet = (t) => { t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {}); };

test('claim commits reservation before broker account and returns scoped credentials', async () => {
    const h = claimHarness();
    await h.controller.claim(h.req, h.res);
    assert.equal(h.res.body.nodeCode, h.node.nodeCode);
    assert.equal(h.res.body.replay, false);
    assert.deepEqual(
        { host: h.res.body.mqttCredentials.host, port: h.res.body.mqttCredentials.port, tls: h.res.body.mqttCredentials.tls, topicPrefix: h.res.body.mqttCredentials.topicPrefix, username: h.res.body.mqttCredentials.username },
        { host: 'broker.test', port: 8883, tls: true, topicPrefix: 'sf', username: 'node_node_123' },
    );
    assert.ok(h.node.claimedAt);
    assert.equal(h.calls.provision, 1);
    assert.equal(h.calls.marker, 0);
});

test('claim rejection returns a specific code, logs the reason without secrets and keeps the token', async (t) => {
    const warnings = t.mock.method(console, 'warn', () => {});
    const cases = [
        ['NODE_NOT_FOUND', 403, 'CLAIM_INVALID', { nodeMissing: true }, () => {}],
        ['NODE_REVOKED', 403, 'NODE_REVOKED', {}, (h) => { h.node.isRevoked = true; }],
        ['ALREADY_CLAIMED', 409, 'NODE_ALREADY_CLAIMED', {}, (h) => { h.node.claimedAt = new Date(); h.req.body.claimToken = issueToken().token; }],
        ['TOKEN_USED', 409, 'CLAIM_TOKEN_USED', {}, (h) => { h.node.claimedAt = new Date(); h.node.claimTokenExpiresAt = new Date(Date.now() - 1000); }],
        ['CLAIM_IN_PROGRESS', 409, 'CLAIM_IN_PROGRESS', {}, (h) => { h.node.claimConsumedAt = new Date(); }],
        ['TOKEN_NOT_ISSUED', 403, 'CLAIM_INVALID', {}, (h) => { h.node.claimTokenHash = null; h.node.claimTokenExpiresAt = null; }],
        ['TOKEN_EXPIRED', 403, 'CLAIM_TOKEN_EXPIRED', {}, (h) => { h.node.claimTokenExpiresAt = new Date(Date.now() - 1000); }],
        ['TOKEN_MISMATCH', 403, 'CLAIM_INVALID', {}, (h) => { h.req.body.claimToken = issueToken().token; }],
    ];
    for (const [reason, status, code, options, setup] of cases) {
        const h = claimHarness(options);
        setup(h);
        const hash = h.node.claimTokenHash;
        const consumedAt = h.node.claimConsumedAt;
        await assert.rejects(h.controller.claim(h.req, h.res), { status, code });
        const entry = warnings.mock.calls.at(-1).arguments;
        assert.deepEqual(entry, ['[claim] rejected', {
            macAddress: h.req.body.macAddress,
            nodeCode: options.nodeMissing ? null : h.node.nodeCode,
            reason,
        }]);
        assert.equal(JSON.stringify(entry).includes(h.req.body.claimToken), false);
        if (hash) assert.equal(JSON.stringify(entry).includes(hash), false);
        assert.equal(h.node.claimTokenHash, hash);
        assert.equal(h.node.claimConsumedAt, consumedAt);
        assert.equal(h.calls.delete + h.calls.provision + h.calls.marker, 0);
    }
});

test('claim in progress tells the ESP32 when to retry', async (t) => {
    quiet(t);
    const h = claimHarness();
    h.node.claimConsumedAt = new Date(Date.now() - 20 * 1000);
    await assert.rejects(h.controller.claim(h.req, h.res), (error) => {
        assert.equal(error.code, 'CLAIM_IN_PROGRESS');
        assert.ok(error.details.retryAfterSec >= 39 && error.details.retryAfterSec <= 41);
        return true;
    });
});

test('malformed claim body is a 400, not a misleading 403', async () => {
    const h = claimHarness();
    h.req.body = { macAddress: 'nope', claimToken: h.claim.token };
    await assert.rejects(h.controller.claim(h.req, h.res), { status: 400, code: 'CLAIM_BAD_REQUEST' });
});

test('inventory: extra devices (fan GPIO27) are allowed, missing/duplicate roles and shared GPIOs are rejected', async (t) => {
    quiet(t);
    const fan = { deviceCode: 'FAN', type: 'FAN', gpioPin: 27 };
    const ok = claimHarness({ devices: [...BASE_DEVICES, fan, { deviceCode: 'OLD', type: 'PUMP', gpioPin: 26, lifecycle: 'DECOMMISSIONED' }] });
    await ok.controller.claim(ok.req, ok.res);
    assert.ok(ok.node.claimedAt);

    for (const devices of [
        BASE_DEVICES.slice(0, 2),
        [...BASE_DEVICES, { deviceCode: 'PUMP2', type: 'PUMP', gpioPin: 26 }],
        [...BASE_DEVICES, { deviceCode: 'FAN', type: 'FAN', gpioPin: 4 }],
    ]) {
        const h = claimHarness({ devices });
        await assert.rejects(h.controller.claim(h.req, h.res), (error) => {
            assert.equal(error.code, 'INVENTORY_MISMATCH');
            assert.ok(error.details.problems.length > 0);
            return true;
        });
        assert.equal(h.node.claimConsumedAt, null, 'inventory mismatch must not consume the token');
    }
});

test('lost claim response: same token replays and rotates the password instead of failing', async () => {
    const h = claimHarness();
    await h.controller.claim(h.req, h.res);
    const first = h.res.body.mqttCredentials.password;
    await h.controller.claim(h.req, h.res);
    assert.equal(h.res.body.replay, true);
    assert.equal(h.calls.provision, 1);
    assert.equal(h.calls.rotate, 1);
    assert.notEqual(h.res.body.mqttCredentials.password, first);
});

test('broker failure releases the reservation so the ESP32 can retry with the same token', async (t) => {
    quiet(t);
    const h = claimHarness({ brokerFails: true });
    await assert.rejects(h.controller.claim(h.req, h.res), { status: 503, code: 'BROKER_UNAVAILABLE' });
    assert.equal(h.node.claimConsumedAt, null);
    assert.ok(h.node.claimFailedAt);
    assert.equal(h.node.claimedAt, null);
    assert.ok(h.calls.delete >= 1, 'orphaned broker objects are cleaned up');
});

test('broker failure then retry with the same token succeeds without admin action', async (t) => {
    quiet(t);
    const h = claimHarness({ brokerFails: true });
    await assert.rejects(h.controller.claim(h.req, h.res), { status: 503 });
    h.faults.brokerFails = false;
    await h.controller.claim(h.req, h.res);
    assert.ok(h.node.claimedAt);
    assert.equal(h.res.body.replay, false);
});

test('commit or marker failure: claim becomes CLAIM_STUCK and is self-healed by reissue/reconcile', async (t) => {
    quiet(t);
    for (const options of [{ cleanupFails: true, commitFails: true }, { markerFails: true, commitFails: true }]) {
        const h = claimHarness(options);
        await assert.rejects(h.controller.claim(h.req, h.res), { status: 503 });
        if (options.markerFails) {
            assert.ok(h.node.claimConsumedAt);
            assert.equal(h.node.claimFailedAt, null);
            await assert.rejects(h.controller.reissueClaimToken(h.req, h.res), { status: 409, code: 'CLAIM_IN_PROGRESS' });
            h.node.claimConsumedAt = new Date(Date.now() - 2 * 60 * 1000);
        } else {
            assert.ok(h.node.claimFailedAt, 'marker still written even if broker cleanup failed');
        }
        const deletesBefore = h.calls.delete;
        h.req.body = {};
        await h.controller.reissueClaimToken(h.req, h.res);
        assert.match(h.res.body.claimToken, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(h.res.body.data.provisioningState, 'AWAITING_CLAIM');
        assert.equal(h.node.claimConsumedAt, null);
        if (options.markerFails) assert.ok(h.calls.delete > deletesBefore, 'stuck claim purges the broker before reissue');
    }
});

test('reconcile purges a stuck claim, then the same token can claim; other states are idempotent', async (t) => {
    quiet(t);
    const h = claimHarness();
    h.node.claimConsumedAt = new Date(Date.now() - 2 * 60 * 1000);
    h.req.body = {};
    await h.controller.reconcileClaim(h.req, h.res);
    assert.equal(h.res.body.reconciled, true);
    assert.ok(h.calls.delete >= 1);
    assert.equal(h.node.claimConsumedAt, null);
    assert.equal(h.res.body.data.provisioningState, 'AWAITING_CLAIM');

    const deletes = h.calls.delete;
    await h.controller.reconcileClaim(h.req, h.res);
    assert.equal(h.res.body.reconciled, false);
    assert.equal(h.calls.delete, deletes, 'no broker calls when nothing is stuck');

    h.req.body = { macAddress: h.node.macAddress, claimToken: h.claim.token };
    await h.controller.claim(h.req, h.res);
    assert.ok(h.node.claimedAt);

    const busy = claimHarness();
    busy.node.claimConsumedAt = new Date();
    await assert.rejects(busy.controller.reconcileClaim(busy.req, busy.res), { status: 409, code: 'CLAIM_IN_PROGRESS' });
});

test('stale claims cannot provision or clean up a newer or reconciled reservation', async (t) => {
    quiet(t);
    for (const afterReservation of [
        (node) => { node.claimFailedAt = new Date(); },
        (node) => { node.claimConsumedAt = new Date(node.claimConsumedAt.getTime() + 600000); },
    ]) {
        const h = claimHarness({ afterReservation });
        await assert.rejects(h.controller.claim(h.req, h.res), { status: 409, code: 'CLAIM_SUPERSEDED' });
        assert.equal(h.calls.provision, 0);
        assert.equal(h.calls.delete, 0);
        assert.equal(h.calls.marker, 0);
    }
    // Bị thu hồi giữa chừng: không chạm Broker, chỉ nhả giữ chỗ của chính yêu cầu này.
    const revoked = claimHarness({ afterReservation: (node) => { node.isRevoked = true; } });
    await assert.rejects(revoked.controller.claim(revoked.req, revoked.res), { status: 409, code: 'CLAIM_SUPERSEDED' });
    assert.equal(revoked.calls.provision + revoked.calls.delete, 0);
    assert.equal(revoked.node.claimConsumedAt, null);
});

test('reissue on an active node needs explicit reprovision and then purges the old account', async () => {
    const h = claimHarness();
    await h.controller.claim(h.req, h.res);
    h.req.body = {};
    await assert.rejects(h.controller.reissueClaimToken(h.req, h.res), { status: 409, code: 'REPROVISION_CONFIRM_REQUIRED' });
    const deletes = h.calls.delete;
    h.req.body = { reprovision: true };
    await h.controller.reissueClaimToken(h.req, h.res);
    assert.equal(h.res.body.brokerPurged, true);
    assert.equal(h.res.body.previousState, 'CLAIMED');
    assert.ok(h.calls.delete > deletes);
    assert.equal(h.node.mqttUsername, null);
    assert.equal(h.node.claimedAt, null);

    h.req.body = { macAddress: h.node.macAddress, claimToken: h.res.body.claimToken };
    await h.controller.claim(h.req, h.res);
    assert.equal(h.res.body.replay, false);
    assert.ok(h.node.claimedAt);
});

test('revoke then reissue a claim token works (no more 409) and the device can claim again', async () => {
    const h = claimHarness();
    await h.controller.claim(h.req, h.res);
    await h.controller.revoke(h.req, h.res);
    assert.equal(h.node.isRevoked, true);
    assert.equal(h.node.claimTokenHash, null);

    h.req.body = {};
    await h.controller.reissueClaimToken(h.req, h.res);
    assert.equal(h.res.body.previousState, 'REVOKED');
    assert.equal(h.node.isRevoked, false);
    h.req.body = { macAddress: h.node.macAddress, claimToken: h.res.body.claimToken };
    await h.controller.claim(h.req, h.res);
    assert.ok(h.node.claimedAt);
    assert.equal(h.node.isRevoked, false);
});

test('revocation disables the broker account first, is idempotent and tolerates a missing client', async () => {
    for (const disableError of [null, new Error('Broker unavailable'), notFound('Client not found')]) {
        const h = claimHarness({ disableError });
        await h.controller.claim(h.req, h.res);
        if (disableError && !disableError.brokerError) {
            await assert.rejects(h.controller.revoke(h.req, h.res), { status: 503, code: 'BROKER_UNAVAILABLE' });
            assert.equal(h.node.isRevoked, false);
            assert.equal(h.node.mqttAccountEnabled, true);
        } else {
            await h.controller.revoke(h.req, h.res);
            assert.equal(h.node.isRevoked, true);
            assert.equal(h.node.mqttAccountEnabled, false);
            await h.controller.revoke(h.req, h.res);
            assert.equal(h.calls.disable, 1, 'second revoke is a no-op');
        }
        assert.equal(h.calls.disable, 1);
    }
});

test('restore re-enables a claimed node, or issues a claim token when the account is gone', async () => {
    const claimed = claimHarness();
    await claimed.controller.claim(claimed.req, claimed.res);
    await claimed.controller.revoke(claimed.req, claimed.res);
    await claimed.controller.restore(claimed.req, claimed.res);
    assert.equal(claimed.calls.enable, 1);
    assert.equal(claimed.node.isRevoked, false);
    assert.equal(claimed.res.body.claimToken, undefined);

    const lost = claimHarness({ enableError: notFound('Client not found') });
    await lost.controller.claim(lost.req, lost.res);
    await lost.controller.revoke(lost.req, lost.res);
    await lost.controller.restore(lost.req, lost.res);
    assert.match(lost.res.body.claimToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(lost.node.isRevoked, false);
    assert.equal(lost.res.body.data.provisioningState, 'AWAITING_CLAIM');

    const unclaimed = claimHarness();
    await unclaimed.controller.revoke(unclaimed.req, unclaimed.res);
    await unclaimed.controller.restore(unclaimed.req, unclaimed.res);
    assert.ok(unclaimed.res.body.claimToken);

    const active = claimHarness();
    await active.controller.restore(active.req, active.res);
    assert.equal(active.node.isRevoked, false);
    assert.equal(active.res.body.claimToken, undefined);
});

test('MQTT credential rotation is refused for unclaimed MAC nodes and recreates a lost broker client', async () => {
    const h = claimHarness();
    await assert.rejects(h.controller.issueMqttCredentials(h.req, h.res), { status: 409, code: 'NODE_NOT_CLAIMED' });
    await h.controller.claim(h.req, h.res);
    await h.controller.issueMqttCredentials(h.req, h.res);
    assert.equal(h.calls.rotate, 1);
    assert.ok(h.res.body.mqttCredentials.password);
});

test('CLAIM_REQUIRE_TLS=true rejects plaintext broker and HTTP from the LAN without consuming the token', async () => {
    const plain = claimHarness({ mqttUrl: 'mqtt://broker.test:1883' });
    await assert.rejects(plain.controller.claim(plain.req, plain.res), { status: 503, code: 'BROKER_TLS_REQUIRED' });
    assert.equal(plain.node.claimConsumedAt, null);

    const lan = claimHarness();
    lan.req.socket = { remoteAddress: '192.168.1.50' };
    await assert.rejects(lan.controller.claim(lan.req, lan.res), { status: 403, code: 'INSECURE_TRANSPORT' });
    assert.equal(lan.node.claimConsumedAt, null);

    const reg = claimHarness({ registration: true, mqttUrl: 'mqtt://broker.test:1883' });
    reg.req.body = { name: 'TLS registration', macAddress: reg.node.macAddress };
    await assert.rejects(reg.controller.create(reg.req, reg.res), { status: 503, code: 'BROKER_TLS_REQUIRED' });
    assert.equal(reg.calls.create, 0);
});

test('CLAIM_REQUIRE_TLS=false allows LAN development over http:// and mqtt://1883', async () => {
    const h = claimHarness({ claimRequireTls: false, mqttUrl: 'mqtt://localhost:1883', deviceUrl: 'mqtt://192.168.1.10:1883' });
    h.req.socket = { remoteAddress: '192.168.1.50' };
    await h.controller.claim(h.req, h.res);
    const creds = h.res.body.mqttCredentials;
    assert.deepEqual({ host: creds.host, port: creds.port, tls: creds.tls }, { host: '192.168.1.10', port: 1883, tls: false });
});

test('MAC registration over MQTT TLS returns a claim token', async () => {
    const h = claimHarness({ registration: true });
    h.req.body = { name: 'TLS registration', macAddress: h.node.macAddress };
    await h.controller.create(h.req, h.res);
    assert.equal(h.calls.create, 1);
    assert.equal(h.res.statusCode, 201);
    assert.match(h.res.body.claimToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(h.res.body.mqttCredentials, null);
    assert.equal(h.res.body.data.claimTokenHash, undefined);
    assert.equal(h.res.body.data.provisioningState, 'AWAITING_CLAIM');
});
