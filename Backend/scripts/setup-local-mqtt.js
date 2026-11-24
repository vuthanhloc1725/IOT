// Project-local development broker. Requires Mosquitto 2.x, mosquitto_ctrl and OpenSSL.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const mqtt = require('mqtt');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..');
const directory = path.join(root, '.mqtt');
const file = (name) => path.join(directory, name);
const envPath = path.join(root, '.env');
const originalEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const settings = dotenv.parse(originalEnv);
const lanAddress = Object.values(os.networkInterfaces()).flat().find((address) =>
    address.family === 'IPv4' && !address.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address)
)?.address;
const host = process.env.MQTT_DEV_HOST || lanAddress || 'localhost';
const port = Number(process.env.MQTT_DEV_PORT || 8883);
let connection;

function run(program, args) {
    const result = spawnSync(program, args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
        throw new Error(`${program}: ${result.error?.message || result.stderr || result.stdout || 'thất bại'}`);
    }
}
function write(name, contents) {
    fs.writeFileSync(file(name), contents, { mode: 0o600 });
}
async function connect(options) {
    return new Promise((resolve, reject) => {
        const client = mqtt.connect(`mqtts://${host}:${port}`, {
            ...options, rejectUnauthorized: true, reconnectPeriod: 0, connectTimeout: 5000,
        });
        client.once('connect', () => resolve(client));
        client.once('error', (error) => { client.end(true); reject(error); });
    });
}
async function command(payload) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`Dynamic Security timeout: ${payload.command}`)), 5000);
        const finish = (error, response) => {
            clearTimeout(timer);
            connection.removeListener('message', onMessage);
            if (error) reject(error); else resolve(response);
        };
        const onMessage = (topic, buffer) => {
            if (topic !== '$CONTROL/dynamic-security/v1/response') return;
            try {
                const response = JSON.parse(buffer.toString()).responses?.[0];
                if (!response || response.command !== payload.command) return;
                if (response.error) finish(new Error(`${payload.command}: ${response.error}`));
                else finish(null, response.data);
            } catch (error) { finish(error); }
        };
        connection.on('message', onMessage);
        connection.publish('$CONTROL/dynamic-security/v1', JSON.stringify({ commands: [payload] }), { qos: 1 }, (error) => {
            if (error) finish(error);
        });
    });
}
async function ensureCreated(payload) {
    try { await command(payload); }
    catch (error) { if (!/already exists|already in|already has/i.test(error.message)) throw error; }
}

async function main() {
    if ((process.env.NODE_ENV || settings.NODE_ENV) === 'production') throw new Error('Lệnh này chỉ dành cho môi trường development.');
    if (!/^[a-zA-Z0-9.-]+$/.test(host) || !Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error('MQTT_DEV_HOST hoặc MQTT_DEV_PORT không hợp lệ (port 1024–65535).');
    }
    const plugin = process.env.MQTT_DYNSEC_PLUGIN || [
        '/usr/lib/mosquitto_dynamic_security.so',
        '/usr/lib/x86_64-linux-gnu/mosquitto_dynamic_security.so',
        '/usr/lib/aarch64-linux-gnu/mosquitto_dynamic_security.so',
    ].find((candidate) => fs.existsSync(candidate));
    if (!plugin || !fs.existsSync(plugin)) throw new Error('Không tìm thấy plugin Dynamic Security; đặt MQTT_DYNSEC_PLUGIN.');
    for (const program of ['openssl', 'mosquitto', 'mosquitto_ctrl']) {
        const result = spawnSync('which', [program]);
        if (result.status !== 0) throw new Error(`Cần cài ${program} trước khi chạy mqtt:setup.`);
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const statePath = file('credentials.json');
    let state;
    if (fs.existsSync(statePath)) {
        state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        // Initial local setup used these defaults without recording them.
        state.firmwarePrefix ||= 'sf';
        state.topicPrefix ||= 'iot';
        if (state.host !== host || state.port !== port) {
            throw new Error(`Broker đã cấu hình cho ${state.host}:${state.port}; đặt MQTT_DEV_HOST/MQTT_DEV_PORT tương ứng.`);
        }
        if (state.firmwarePrefix !== (settings.MQTT_FIRMWARE_TOPIC_PREFIX || 'sf') ||
            state.topicPrefix !== (settings.MQTT_TOPIC_PREFIX || 'iot')) {
            throw new Error('MQTT topic prefix đã thay đổi; không tự mở rộng ACL trên broker đã có. Cần cấu hình broker mới.');
        }
        write('credentials.json', JSON.stringify(state, null, 2));
    } else {
        state = {
            host, port, firmwarePrefix: settings.MQTT_FIRMWARE_TOPIC_PREFIX || 'sf',
            topicPrefix: settings.MQTT_TOPIC_PREFIX || 'iot',
            adminPassword: crypto.randomBytes(32).toString('hex'),
            backendPassword: crypto.randomBytes(32).toString('hex'),
        };
        write('credentials.json', JSON.stringify(state, null, 2));
    }
    if (!fs.existsSync(file('ca.crt'))) {
        run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-sha256',
            '-subj', '/CN=IoT Local Development CA', '-addext', 'basicConstraints=critical,CA:TRUE',
            '-keyout', file('ca.key'), '-out', file('ca.crt')]);
    }
    if (!fs.existsSync(file('server.crt'))) {
        const hostSan = `${net.isIP(host) ? 'IP' : 'DNS'}:${host}`;
        write('server.ext', `subjectAltName=DNS:localhost,IP:127.0.0.1,${hostSan}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n`);
        run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${host}`,
            '-keyout', file('server.key'), '-out', file('server.csr')]);
        run('openssl', ['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.crt'), '-CAkey', file('ca.key'),
            '-CAcreateserial', '-days', '365', '-sha256', '-extfile', file('server.ext'), '-out', file('server.crt')]);
    }
    if (!fs.existsSync(file('dynamic-security.json'))) {
        run('mosquitto_ctrl', ['dynsec', 'init', file('dynamic-security.json'), 'iot_dynsec_admin', state.adminPassword]);
    }
    write('mosquitto.conf', [
        'per_listener_settings false', 'allow_anonymous false', `plugin ${plugin}`,
        `plugin_opt_config_file ${file('dynamic-security.json')}`, `listener ${port}`,
        `certfile ${file('server.crt')}`, `keyfile ${file('server.key')}`, 'tls_version tlsv1.2',
        `pid_file ${file('mosquitto.pid')}`, `log_dest file ${file('mosquitto.log')}`, '',
    ].join('\n'));
    const listening = await new Promise((resolve) => {
        const socket = net.connect({ host, port });
        socket.setTimeout(2000);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
    });
    if (!listening) run('mosquitto', ['-c', file('mosquitto.conf'), '-d']);
    const ca = fs.readFileSync(file('ca.crt'));
    connection = await connect({ ca, username: 'iot_dynsec_admin', password: state.adminPassword });
    await new Promise((resolve, reject) => connection.subscribe('$CONTROL/dynamic-security/v1/response', { qos: 1 }, (error, granted) => {
        if (error || granted.some((item) => item.qos === 128)) reject(error || new Error('Không được subscribe Dynamic Security.'));
        else resolve();
    }));
    await command({ command: 'setDefaultACLAccess', acls: ['publishClientSend', 'publishClientReceive', 'subscribe', 'unsubscribe'].map((acltype) => ({ acltype, allow: false })) });
    await ensureCreated({ command: 'createRole', rolename: 'iot_backend_role' });
    const prefix = settings.MQTT_FIRMWARE_TOPIC_PREFIX || 'sf';
    const inbound = ['telemetry', 'telemetry/backfill', 'heartbeat', 'status', 'config', 'cmd/ack', 'command/ack', 'config/ack', 'device/probe/ack'];
    const acls = inbound.flatMap((suffix) => ['publishClientReceive', 'subscribePattern'].map((acltype) => ({ acltype, topic: `${prefix}/+/${suffix}` })));
    acls.push(...['publishClientReceive', 'subscribeLiteral'].map((acltype) => ({ acltype, topic: `${settings.MQTT_TOPIC_PREFIX || 'iot'}/ai/result` })));
    acls.push(...['cmd', 'config', 'device/probe'].map((suffix) => ({ acltype: 'publishClientSend', topic: `${prefix}/+/${suffix}` })));
    for (const acl of acls) await ensureCreated({ command: 'addRoleACL', rolename: 'iot_backend_role', ...acl, allow: true, priority: 1 });
    await ensureCreated({ command: 'createClient', username: 'agri_backend', password: state.backendPassword });
    const backendInfo = await command({ command: 'getClient', username: 'agri_backend' });
    if (!backendInfo.client.roles.some((role) => role.rolename === 'iot_backend_role')) {
        await command({ command: 'addClientRole', username: 'agri_backend', rolename: 'iot_backend_role', priority: 1 });
    }
    const backend = await connect({ ca, username: 'agri_backend', password: state.backendPassword });
    await new Promise((resolve) => backend.end(false, resolve));
    const updates = {
        MQTT_ENABLED: 'true', MQTT_URL: `mqtts://${host}:${port}`, MQTT_CA_FILE: '.mqtt/ca.crt',
        MQTT_USERNAME: 'agri_backend', MQTT_PASSWORD: state.backendPassword, MQTT_DYNSEC_ENABLED: 'true',
        MQTT_DYNSEC_ADMIN_USERNAME: 'iot_dynsec_admin', MQTT_DYNSEC_ADMIN_PASSWORD: state.adminPassword,
    };
    if (!fs.existsSync(file('env.before-local-mqtt'))) write('env.before-local-mqtt', originalEnv);
    let updated = originalEnv;
    for (const [key, value] of Object.entries(updates)) {
        const pattern = new RegExp(`^${key}=.*$`, 'm');
        const line = `${key}=${value}`;
        updated = pattern.test(updated) ? updated.replace(pattern, line) : `${updated.trimEnd()}\n${line}\n`;
    }
    fs.writeFileSync(envPath, updated, { mode: 0o600 });
    fs.chmodSync(envPath, 0o600);
    console.log(`MQTT TLS + Dynamic Security sẵn sàng: mqtts://${host}:${port}`);
    console.log('Đã cập nhật Backend/.env; khởi động lại backend. CA cho ESP32: Backend/.mqtt/ca.crt');
    console.log('Sau khi khởi động lại máy: cd Backend && npm run mqtt:start');
}
main().catch((error) => { console.error(`MQTT setup: ${error.message}`); process.exitCode = 1; })
    .finally(() => { if (connection) connection.end(true); });
