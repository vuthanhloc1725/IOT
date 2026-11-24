// Tạo/cập nhật tài khoản MQTT của Backend (MQTT_USERNAME/MQTT_PASSWORD) trong Dynamic Security
// của broker đang chạy (MQTT_URL), đăng nhập bằng MQTT_DYNSEC_ADMIN_*. Chạy lại nhiều lần vẫn an toàn.
// Không in mật khẩu. Dùng sau khi bật plugin: scripts/enable-system-dynsec.sh
const mqtt = require('mqtt');
const { randomUUID } = require('node:crypto');
const env = require('../src/config/env');
const mqttTlsOptions = require('../src/config/mqtt-tls');

const CONTROL_TOPIC = '$CONTROL/dynamic-security/v1';
const RESPONSE_TOPIC = `${CONTROL_TOPIC}/response`;
const ROLE = 'iot_backend_role';

function connect(username, password) {
    return new Promise((resolve, reject) => {
        const client = mqtt.connect(env.mqtt.url, {
            username, password, clientId: `iot-setup-${process.pid}-${username}`,
            reconnectPeriod: 0, connectTimeout: 8000, ...mqttTlsOptions(env.mqtt.caFile),
        });
        client.once('connect', () => resolve(client));
        client.once('error', (error) => { client.end(true); reject(error); });
    });
}

function command(connection, payload) {
    return new Promise((resolve, reject) => {
        const correlationData = randomUUID();
        const timer = setTimeout(() => finish(new Error(`Dynamic Security không phản hồi ${payload.command}`)), 8000);
        const onMessage = (topic, buffer) => {
            if (topic !== RESPONSE_TOPIC) return;
            let body;
            try { body = JSON.parse(buffer.toString('utf8')); } catch { return; }
            if (body.error) return finish(new Error(`Broker: ${body.error} (plugin Dynamic Security chưa được nạp?)`));
            const reply = body.responses?.find((entry) => entry.correlationData === correlationData);
            if (!reply) return;
            if (reply.error) finish(new Error(`${payload.command}: ${reply.error}`));
            else finish(null, reply.data);
        };
        function finish(error, data) {
            clearTimeout(timer);
            connection.removeListener('message', onMessage);
            if (error) reject(error); else resolve(data);
        }
        connection.on('message', onMessage);
        connection.publish(CONTROL_TOPIC, JSON.stringify({ commands: [{ ...payload, correlationData }] }), { qos: 1 });
    });
}

async function ignoreExisting(promise) {
    try { await promise; }
    catch (error) { if (!/already/i.test(error.message)) throw error; }
}

async function main() {
    const { username, password, dynsecAdminUsername, dynsecAdminPassword } = env.mqtt;
    if (!username || !password) throw new Error('Thiếu MQTT_USERNAME/MQTT_PASSWORD trong Backend/.env');
    if (!dynsecAdminUsername || !dynsecAdminPassword) throw new Error('Thiếu MQTT_DYNSEC_ADMIN_USERNAME/PASSWORD trong Backend/.env');

    const admin = await connect(dynsecAdminUsername, dynsecAdminPassword);
    try {
        await new Promise((resolve, reject) => admin.subscribe(RESPONSE_TOPIC, { qos: 1 }, (error, granted) => (
            error || granted.some((item) => item.qos === 128)
                ? reject(error || new Error('Tài khoản admin không được subscribe topic phản hồi Dynamic Security'))
                : resolve())));

        // Mặc định cấm hết; mỗi Node chỉ được topic của chính nó qua role Backend cấp khi claim.
        await command(admin, { command: 'setDefaultACLAccess', acls: ['publishClientSend', 'publishClientReceive', 'subscribe', 'unsubscribe']
            .map((acltype) => ({ acltype, allow: false })) });

        await ignoreExisting(command(admin, { command: 'createRole', rolename: ROLE }));
        const prefix = env.mqtt.firmwarePrefix;
        const inbound = ['telemetry', 'telemetry/backfill', 'heartbeat', 'status', 'config', 'cmd/ack', 'command/ack', 'config/ack', 'device/probe/ack'];
        const acls = inbound.flatMap((suffix) => ['publishClientReceive', 'subscribePattern'].map((acltype) => ({ acltype, topic: `${prefix}/+/${suffix}` })));
        acls.push(...['publishClientReceive', 'subscribeLiteral'].map((acltype) => ({ acltype, topic: `${env.mqtt.prefix}/ai/result` })));
        acls.push(...['cmd', 'config', 'device/probe'].map((suffix) => ({ acltype: 'publishClientSend', topic: `${prefix}/+/${suffix}` })));
        for (const acl of acls) await ignoreExisting(command(admin, { command: 'addRoleACL', rolename: ROLE, ...acl, allow: true, priority: 1 }));

        try {
            await command(admin, { command: 'createClient', username, password });
            console.log(`[mqtt] Đã tạo tài khoản Backend "${username}"`);
        } catch (error) {
            if (!/already/i.test(error.message)) throw error;
            await command(admin, { command: 'setClientPassword', username, password });
            console.log(`[mqtt] Tài khoản Backend "${username}" đã có -> đồng bộ lại mật khẩu theo .env`);
        }
        const info = await command(admin, { command: 'getClient', username });
        if (!info.client.roles?.some((role) => role.rolename === ROLE)) {
            await command(admin, { command: 'addClientRole', username, rolename: ROLE, priority: 1 });
        }
    } finally {
        admin.end(true);
    }

    const backend = await connect(username, password);
    backend.end(true);
    console.log('[mqtt] OK: Backend đăng nhập broker được, Dynamic Security đang hoạt động');
}

main().catch((error) => {
    console.error(`[mqtt] LỖI: ${error.message}`);
    process.exit(1);
});
