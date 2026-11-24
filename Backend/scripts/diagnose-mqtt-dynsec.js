#!/usr/bin/env node
// Read-only broker probe. Never prints passwords, hashes, tokens or response bodies.
const mqtt = require('mqtt');
const { randomUUID } = require('node:crypto');
const env = require('../src/config/env');
const mqttTlsOptions = require('../src/config/mqtt-tls');

const nodeCode = process.argv[2];
if (!/^[A-Za-z0-9._-]{1,50}$/.test(nodeCode || '')) {
    console.error('Usage: node scripts/diagnose-mqtt-dynsec.js NODE-CODE');
    process.exit(2);
}
const topic = '$CONTROL/dynamic-security/v1';
const responseTopic = `${topic}/response`;
const username = `node_${nodeCode.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
const roleName = `role_${nodeCode.replace(/[^A-Za-z0-9._-]/g, '_')}`;
let connection;
let waiter;
let finished = false;
const overall = setTimeout(() => finish(1, 'Probe timed out: no complete broker response.'), 25000);
function finish(code, message) {
    if (finished) return;
    finished = true;
    clearTimeout(overall);
    if (waiter) clearTimeout(waiter.timer);
    console.log(message);
    if (connection) connection.end(true);
    process.exitCode = code;
}
try {
    if (!env.mqtt.dynsecAdminUsername || !env.mqtt.dynsecAdminPassword) throw new Error('Missing DynSec admin credentials');
    const endpoint = new URL(env.mqtt.url);
    console.log(JSON.stringify({ broker: `${endpoint.protocol}//${endpoint.host}`, adminConfigured: true }));
    connection = mqtt.connect(env.mqtt.url, {
        username: env.mqtt.dynsecAdminUsername,
        password: env.mqtt.dynsecAdminPassword,
        clientId: `iot-dynsec-probe-${randomUUID()}`,
        clean: true, reconnectPeriod: 0, connectTimeout: 8000,
        ...mqttTlsOptions(env.mqtt.caFile),
    });
    connection.on('error', (error) => finish(1, `MQTT connection error: ${error.code || error.name}`));
    connection.on('close', () => { if (!finished) finish(1, 'MQTT connection closed before probe completed'); });
    connection.on('message', (_topic, buffer) => {
        if (!waiter) return;
        let response;
        try { response = JSON.parse(buffer.toString('utf8')); }
        catch { console.log('Response is not JSON (body omitted)'); return; }
        const entries = Array.isArray(response?.responses) ? response.responses : [];
        for (const result of entries) {
            if (!result || typeof result !== 'object') continue;
            // Log only classification, never raw broker/user-controlled strings or data.
            const errorKind = !result.error ? 'none' :
                ['Client not found', 'Role not found', 'Not authorized', 'Invalid/missing command'].includes(result.error) ? result.error : 'other broker error';
            console.log(JSON.stringify({
                response: true,
                commandMatches: result.command === waiter.command.command,
                correlationMatches: result.correlationData === waiter.command.correlationData,
                hasCorrelation: typeof result.correlationData === 'string',
                error: errorKind,
            }));
            if (result.command === waiter.command.command && result.correlationData === waiter.command.correlationData) {
                const done = waiter;
                waiter = null;
                clearTimeout(done.timer);
                done.resolve(result);
                return;
            }
        }
        if (!entries.length) console.log(JSON.stringify({ response: true, responseArray: false, hasRootError: Boolean(response?.error) }));
    });
    connection.once('connect', () => {
        console.log('MQTT TLS/auth connected');
        connection.subscribe(responseTopic, { qos: 1 }, async (error, granted) => {
            console.log(JSON.stringify({ subscribeError: Boolean(error), granted: (granted || []).map((entry) => ({ topicMatches: entry.topic === responseTopic, qos: entry.qos })) }));
            if (error || !granted?.some((entry) => entry.topic === responseTopic && [0, 1, 2].includes(entry.qos))) {
                return finish(1, 'Broker did not grant the Dynamic Security response subscription');
            }
            try {
                for (const request of [{ command: 'getClient', username }, { command: 'getRole', rolename: roleName }]) {
                    const result = await new Promise((resolve, reject) => {
                        const command = { ...request, correlationData: randomUUID() };
                        const timer = setTimeout(() => { waiter = null; reject(new Error(`No matching response for ${request.command}`)); }, 8000);
                        waiter = { command, resolve, timer };
                        console.log(`Sending read-only ${request.command}`);
                        connection.publish(topic, JSON.stringify({ commands: [command] }), { qos: 1, retain: false }, (publishError) => {
                            console.log(JSON.stringify({ published: request.command, publishError: Boolean(publishError) }));
                            if (publishError) { clearTimeout(timer); waiter = null; reject(new Error('Publish failed')); }
                        });
                    });
                    const expectedMissing = request.command === 'getClient' ? 'Client not found' : 'Role not found';
                    if (result.error && result.error !== expectedMissing) throw new Error(`Broker rejected ${request.command} (details omitted)`);
                    console.log(`${request.command}: ${result.error ? 'absent' : 'exists'}`);
                }
                finish(0, 'Probe completed: broker management requests received matching responses.');
            } catch (probeError) { finish(1, probeError.message); }
        });
    });
} catch (error) {
    finish(1, `Cannot start probe: ${error.code || error.name}`);
}
