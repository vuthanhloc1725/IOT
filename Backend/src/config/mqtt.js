const env = require('./env');

const PREFIX = env.mqtt.firmwarePrefix; // firmware mặc định "sf"

// ---- Tùy chọn kết nối tới broker (truyền vào mqtt.connect) ----
const connectOptions = {
    username: env.mqtt.username || undefined,
    password: env.mqtt.password || undefined,
    clientId: `iot-backend-${process.pid}`, // mỗi tiến trình một clientId, tránh bị broker đá nhau
    clean: true,
    keepalive: 30,
    reconnectPeriod: 3000,   // tự nối lại sau 3 giây
    connectTimeout: 10000,
    // Backend tự báo trạng thái để các bên khác biết khi nó chết bất thường (LWT)
    will: {
        topic: `${PREFIX}/_backend/status`,
        payload: 'offline',
        qos: 1,
        retain: true,
    },
};

// ---- Topic quy ước ----
// Firmware Telemetry v1.2: sf/<nodeCode>/telemetry, telemetry/backfill, heartbeat, status, config, cmd/ack
// Server → firmware: sf/<nodeCode>/cmd (action pump/fan/config/lifecycle/...)
const subscribeTopics = [
    `${PREFIX}/+/telemetry`,
    `${PREFIX}/+/telemetry/backfill`,
    `${PREFIX}/+/config`,
    `${PREFIX}/+/heartbeat`,
    `${PREFIX}/+/status`,
    `${PREFIX}/+/cmd/ack`,
    `${PREFIX}/+/command/ack`,
    `${PREFIX}/+/config/ack`,
    `${PREFIX}/+/device/probe/ack`,
];

const topics = {
    command: (nodeCode) => `${PREFIX}/${nodeCode}/cmd`,
    config: (nodeCode) => `${PREFIX}/${nodeCode}/config`,
    deviceProbe: (nodeCode) => `${PREFIX}/${nodeCode}/device/probe`,
    backendStatus: `${PREFIX}/_backend/status`,
};

// "sf/NODE-001/cmd/ack" → { nodeCode: "NODE-001", kind: "cmd/ack" }
const parseTopic = (topic) => {
    const [, nodeCode, ...rest] = topic.split('/');
    return { nodeCode, kind: rest.join('/') };
};

// ---- QoS & retain theo từng loại bản tin ----
const qos = {
    subscribe: 1,
    command: 1,    // lệnh bơm/quạt: không được mất
    config: 1,
};
const retain = {
    command: false, // lệnh cũ không được phát lại khi node nối lại
    config: false,  // server tự đẩy lại config khi node online (xem node.service)
};

module.exports = {
    enabled: env.mqtt.enabled,
    url: env.mqtt.url,
    prefix: PREFIX,
    connectOptions,
    subscribeTopics,
    topics,
    parseTopic,
    qos,
    retain,
};
