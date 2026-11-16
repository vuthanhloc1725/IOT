const mqtt = require('mqtt');
const env = require('../config/env');
const mqttTlsOptions = require('../config/mqtt-tls');

const P = env.mqtt.firmwarePrefix;
const AI_RESULT_TOPIC = `${env.mqtt.prefix}/ai/result`;
let client = null;
// 5 MiB ảnh Base64 chiếm khoảng 6.7 MiB; chừa thêm dung lượng cho metadata JSON.
const MAX_MQTT_PAYLOAD_BYTES = Math.max(
    8 * 1024 * 1024,
    Math.ceil(env.ai.imageMaxBytes * 4 / 3) + 256 * 1024
);
const ALLOWED_KINDS = new Set(['telemetry', 'telemetry/backfill', 'heartbeat', 'status', 'config', 'cmd/ack', 'command/ack', 'config/ack', 'device/probe/ack']);

// Topic quy ước:
// Dịch vụ AI bên thứ ba → backend: {P}/ai/result (JSON + ảnh Base64)
// Firmware v1.2: Node → server {P}/{nodeCode}/telemetry, telemetry/backfill, heartbeat, status, config, cmd/ack
// Server → Node {P}/{nodeCode}/cmd
exports.topics = {
    aiResult: AI_RESULT_TOPIC,
    command: (nodeCode) => `${P}/${nodeCode}/cmd`,
    config: (nodeCode) => `${P}/${nodeCode}/config`,
    deviceProbe: (nodeCode) => `${P}/${nodeCode}/device/probe`,
};

exports.start = (onMessage, onConnected = null) => {
    if (!env.mqtt.enabled) {
        console.warn('[mqtt] MQTT_ENABLED=false → bỏ qua kết nối broker');
        return;
    }

    if (!env.mqtt.username || !env.mqtt.password) {
        console.warn('[mqtt] MQTT_USERNAME/MQTT_PASSWORD chưa được cấu hình; hãy giới hạn quyền publish/subscribe bằng ACL của broker.');
    }

    client = mqtt.connect(env.mqtt.url, {
        username: env.mqtt.username || undefined,
        password: env.mqtt.password || undefined,
        clientId: `iot-backend-${process.pid}`,
        reconnectPeriod: 3000,
        clean: true,
        // When MQTT_URL uses mqtts://, do not accept an untrusted broker certificate.
        ...mqttTlsOptions(env.mqtt.caFile),
    });

    client.on('connect', () => {
        console.log('[mqtt] đã kết nối', env.mqtt.url);
        client.subscribe(
            [
                `${P}/+/telemetry`,
                `${P}/+/telemetry/backfill`,
                `${P}/+/config`,
                `${P}/+/heartbeat`,
                `${P}/+/status`,
                `${P}/+/cmd/ack`,
                `${P}/+/command/ack`,
                `${P}/+/config/ack`,
                `${P}/+/device/probe/ack`,
                AI_RESULT_TOPIC,
            ],
            { qos: 1 },
            (err) => {
                if (err) console.error('[mqtt] subscribe lỗi:', err.message);
                else {
                    console.log(`[mqtt] đã subscribe telemetry/heartbeat/status/config/ACK và kết quả AI: ${AI_RESULT_TOPIC}`);
                    if (typeof onConnected === 'function') {
                        Promise.resolve(onConnected()).catch((e) => console.error('[mqtt] lỗi đồng bộ config đang chờ:', e.message || e));
                    }
                }
            }
        );
    });

    client.on('error', (e) => console.error('[mqtt] lỗi:', e.message));
    client.on('offline', () => console.warn('[mqtt] mất kết nối broker, đang thử lại...'));

    client.on('message', (topic, buf) => {
        const isAiResult = topic === AI_RESULT_TOPIC;
        let nodeCode = null;
        let kind = 'ai/result';

        if (!isAiResult) {
            const prefix = `${P}/`;
            if (typeof topic !== 'string' || !topic.startsWith(prefix)) return;
            const rest = topic.slice(prefix.length);
            const slash = rest.indexOf('/');
            if (slash <= 0) return;
            nodeCode = rest.slice(0, slash);
            kind = rest.slice(slash + 1);
            if (!/^[A-Za-z0-9._-]{1,50}$/.test(nodeCode) || !ALLOWED_KINDS.has(kind)) return;
        }

        if (!Buffer.isBuffer(buf) || buf.length > MAX_MQTT_PAYLOAD_BYTES) {
            console.warn(`[mqtt] từ chối payload quá lớn/không hợp lệ trên ${isAiResult ? 'ai/result' : `${nodeCode}/${kind}`} (${Buffer.isBuffer(buf) ? buf.length : 'non-buffer'} bytes)`);
            return;
        }

        const text = buf.toString('utf8');
        let payload;
        try {
            payload = JSON.parse(text);
        } catch {
            // Retained/LWT online/offline cho topic status của Node.
            const rawStatus = text.trim().toLowerCase();
            if (!isAiResult && kind === 'status' && ['online', 'offline'].includes(rawStatus)) {
                payload = { raw: rawStatus };
            } else {
                console.warn(`[mqtt] từ chối JSON không hợp lệ trên ${isAiResult ? 'ai/result' : `${nodeCode}/${kind}`}`);
                return;
            }
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            if (!isAiResult && kind === 'status' && typeof payload === 'string' && ['online', 'offline'].includes(payload.toLowerCase())) {
                payload = { raw: payload.toLowerCase() };
            } else {
                console.warn(`[mqtt] từ chối payload không phải object trên ${isAiResult ? 'ai/result' : `${nodeCode}/${kind}`}`);
                return;
            }
        }

        Promise.resolve(onMessage(nodeCode, kind, payload)).catch((e) => {
            console.error(`[mqtt] lỗi xử lý ${isAiResult ? 'ai/result' : `${nodeCode}/${kind}`}:`, e.message || e);
        });
    });
};

exports.isConnected = () => !!client && client.connected;

exports.publish = (topic, obj, opts = { qos: 1 }) =>
    new Promise((resolve, reject) => {
        if (!client || !client.connected) return reject(new Error('MQTT chưa kết nối'));
        client.publish(topic, JSON.stringify(obj), opts, (e) => (e ? reject(e) : resolve()));
    });

exports.stop = () => new Promise((resolve) => {
    if (client) client.end(false, {}, resolve);
    else resolve();
});
