const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

function harness(onCommand, { grantedQos = 1, noGrant = false } = {}) {
    const requests = [];
    const client = new EventEmitter();
    client.connected = true;
    client.subscribe = (topic, _opts, callback) => callback(null, noGrant ? [] : [{ topic, qos: grantedQos }]);
    client.end = () => {};
    const respond = (command, extra = {}) => client.emit('message', '$CONTROL/dynamic-security/v1/response',
        Buffer.from(JSON.stringify({ responses: [{ command: command.command, correlationData: command.correlationData, ...extra }] })));
    client.publish = (_topic, payload, options, callback) => {
        assert.deepEqual(options, { qos: 1, retain: false });
        const command = JSON.parse(payload).commands[0];
        assert.match(command.correlationData, /^[0-9a-f-]{36}$/);
        requests.push(command);
        callback(null);
        queueMicrotask(() => onCommand(command, respond, client));
    };
    const servicePath = require.resolve('../src/services/mqtt-dynsec.service');
    const originalLoad = Module._load;
    const mocks = {
        mqtt: { connect() { queueMicrotask(() => client.emit('connect')); return client; } },
        '../config/env': { mqtt: { dynsecEnabled: true, dynsecAdminUsername: 'admin', dynsecAdminPassword: 'test-only', firmwarePrefix: 'sf', url: 'mqtts://broker.test', dynsecRequestTimeoutMs: 1000 } },
        '../config/mqtt-tls': () => ({}),
    };
    let service;
    try {
        Module._load = function(request, parent, isMain) {
            if (parent?.filename === servicePath && Object.hasOwn(mocks, request)) return mocks[request];
            return originalLoad.call(this, request, parent, isMain);
        };
        delete require.cache[servicePath];
        service = require(servicePath);
    } finally {
        Module._load = originalLoad;
        delete require.cache[servicePath];
    }
    return { service, requests };
}

function missing(command) {
    return command.command.endsWith('Client') ? 'Client not found' : 'Role not found';
}

test('broker absence requires explicit, correlated not-found for both objects', async () => {
    const h = harness((command, respond) => respond(command, { error: missing(command) }));
    assert.deepEqual(await h.service.inspectAccount('node_test', 'role_TEST'), { clientExists: false, roleExists: false });
    assert.deepEqual(h.requests.map((c) => c.command), ['getClient', 'getRole']);
    assert.equal(h.requests[0].username, 'node_test');
    assert.equal(h.requests[1].rolename, 'role_TEST');
    assert.notEqual(h.requests[0].correlationData, h.requests[1].correlationData);
});

test('broker presence stays visible and permissions failures never mean absence', async () => {
    const present = harness((command, respond) => respond(command));
    assert.deepEqual(await present.service.inspectAccount('node_test', 'role_TEST'), { clientExists: true, roleExists: true });
    for (const error of ['Not authorized', 'Internal error', 'Role not found']) {
        const h = harness((command, respond) => respond(command, { error }));
        await assert.rejects(h.service.inspectAccount('node_test', 'role_TEST'), { brokerError: error });
    }
});

test('malformed, foreign, and wrong-command replies cannot satisfy a broker request', async () => {
    const h = harness((command, respond, client) => {
        for (const payload of ['invalid', '{}', '{"responses":{}}', '{"responses":[null]}']) {
            client.emit('message', '$CONTROL/dynamic-security/v1/response', Buffer.from(payload));
        }
        respond({ ...command, correlationData: 'unrelated-request' }, { error: missing(command) });
        respond({ ...command, command: 'wrongCommand' }, { error: missing(command) });
        setImmediate(() => respond(command));
    });
    assert.deepEqual(await h.service.inspectAccount('node_test', 'role_TEST'), { clientExists: true, roleExists: true });
});

test('late timed-out reply cannot falsely unlock the next request', async () => {
    let late;
    const h = harness((command, respond) => {
        if (!late) { late = command; return; }
        respond(late, { error: 'Client not found' });
        setImmediate(() => respond(command));
    });
    await assert.rejects(h.service.inspectAccount('node_test', 'role_TEST'), /không phản hồi/);
    assert.deepEqual(await h.service.inspectAccount('node_test', 'role_TEST'), { clientExists: true, roleExists: true });
});

test('cleanup is idempotent for exact not-found, but preserves other broker failures', async () => {
    const h = harness((command, respond) => respond(command, { error: missing(command) }));
    await h.service.deleteAccount('node_test', 'role_TEST');
    const failed = harness((command, respond) => respond(command, { error: 'Not authorized' }));
    await assert.rejects(failed.service.deleteAccount('node_test', 'role_TEST'), { brokerError: 'Not authorized' });
    assert.deepEqual(failed.requests.map((c) => c.command), ['deleteClient', 'deleteRole']);
});


test('refused or missing SUBACK stops admin commands before publish', async () => {
    for (const options of [{ grantedQos: 128 }, { noGrant: true }]) {
        const h = harness(() => assert.fail('No admin command may be sent without a response subscription'), options);
        await assert.rejects(h.service.inspectAccount('node_test', 'role_TEST'), /không cấp quyền subscribe/);
        assert.equal(h.requests.length, 0);
    }
});

test('timeout distinguishes no broker replies from unmatched or malformed replies', async () => {
    const silent = harness(() => {});
    await assert.rejects(silent.service.inspectAccount('node_test', 'role_TEST'), /không nhận tin.*plugin Dynamic Security/);
    const unmatched = harness((command, respond, client) => {
        client.emit('message', '$CONTROL/dynamic-security/v1/response', Buffer.from('invalid'));
        respond({ ...command, correlationData: 'foreign-request' });
    });
    await assert.rejects(unmatched.service.inspectAccount('node_test', 'role_TEST'), /đã nhận 2 tin, 1 tin không khớp.*1 tin không phải JSON/);
});
