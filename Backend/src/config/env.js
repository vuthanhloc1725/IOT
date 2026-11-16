require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : v === 'true');
const defaultSensorThresholdRules = {
    SOIL_MOISTURE: { low: 25, lowRecovery: 30, high: 85, highRecovery: 80 },
    AIR_TEMPERATURE: { low: 5, lowRecovery: 8, high: 38, highRecovery: 35 },
    AIR_HUMIDITY: { low: 25, lowRecovery: 30, high: 90, highRecovery: 85 },
};
function parseSensorThresholdRules(raw) {
    if (!raw) return defaultSensorThresholdRules;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('SENSOR_THRESHOLD_RULES_JSON phải là JSON hợp lệ'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('SENSOR_THRESHOLD_RULES_JSON phải là object JSON');
    const result = { ...defaultSensorThresholdRules };
    for (const [metric, rule] of Object.entries(parsed)) {
        if (!Object.prototype.hasOwnProperty.call(defaultSensorThresholdRules, metric)) throw new Error(`Metric ngưỡng không hỗ trợ: ${metric}`);
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`Ngưỡng ${metric} phải là object`);
        const merged = { ...defaultSensorThresholdRules[metric], ...rule };
        for (const key of ['low', 'lowRecovery', 'high', 'highRecovery']) {
            if (merged[key] !== undefined && (typeof merged[key] !== 'number' || !Number.isFinite(merged[key]))) throw new Error(`${metric}.${key} phải là số hữu hạn`);
        }
        if (merged.low !== undefined && merged.lowRecovery < merged.low) throw new Error(`${metric}.lowRecovery phải >= low`);
        if (merged.high !== undefined && merged.highRecovery > merged.high) throw new Error(`${metric}.highRecovery phải <= high`);
        if (merged.low !== undefined && merged.high !== undefined && merged.low >= merged.high) throw new Error(`${metric}.low phải nhỏ hơn high`);
        result[metric] = merged;
    }
    return result;
}

const env = {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: num(process.env.PORT, 3000),
    corsOrigin: process.env.CORS_ORIGIN || '*',
    db: {
        host: process.env.DB_HOST || 'localhost',
        port: num(process.env.DB_PORT, 3306),
        name: process.env.DB_NAME || 'iot',
        user: process.env.DB_USER || 'root',
        pass: process.env.DB_PASSWORD || process.env.DB_PASS || (process.env.NODE_ENV === 'production' ? '' : '123456'),
        sync: process.env.DB_SYNC || 'safe',
    },
    jwt: {
        secret: process.env.JWT_SECRET || 'dev-secret-change-me',
        expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    },
    mqtt: {
        enabled: bool(process.env.MQTT_ENABLED, true),
        url: process.env.MQTT_URL || 'mqtt://localhost:1883',
        // URL mà ESP32 dùng để kết nối Broker (Backend có thể dùng localhost, thiết bị thì không).
        deviceUrl: process.env.MQTT_DEVICE_URL || '',
        caFile: process.env.MQTT_CA_FILE || '',
        username: process.env.MQTT_USERNAME || '',
        password: process.env.MQTT_PASSWORD || '',
        prefix: process.env.MQTT_TOPIC_PREFIX || 'iot',
        firmwarePrefix: process.env.MQTT_FIRMWARE_TOPIC_PREFIX || 'sf',
        dynsecEnabled: bool(process.env.MQTT_DYNSEC_ENABLED, false),
        dynsecAdminUsername: process.env.MQTT_DYNSEC_ADMIN_USERNAME || '',
        dynsecAdminPassword: process.env.MQTT_DYNSEC_ADMIN_PASSWORD || '',
        dynsecRequestTimeoutMs: num(process.env.MQTT_DYNSEC_REQUEST_TIMEOUT_MS, 8000),
    },
    heartbeatSweepSec: num(process.env.HEARTBEAT_SWEEP_SEC, 10),
    commandAckTimeoutSec: num(process.env.COMMAND_ACK_TIMEOUT_SEC, 15),
    deviceProbeTimeoutSec: num(process.env.DEVICE_PROBE_TIMEOUT_SEC, 8),
    // Bắt buộc HTTPS cho claim/cấp token và mqtts:// cho thiết bị. Mặc định chỉ bật ở production;
    // khi phát triển trong LAN có thể để false để ESP32 claim qua http:// và MQTT 1883.
    claimRequireTls: bool(process.env.CLAIM_REQUIRE_TLS, (process.env.NODE_ENV || 'development') === 'production'),
    claimTrustedProxyIps: (process.env.CLAIM_TRUSTED_PROXY_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),
    sensorThresholdRules: parseSensorThresholdRules(process.env.SENSOR_THRESHOLD_RULES_JSON),
    camera: {
        imageMaxBytes: num(process.env.CAMERA_IMAGE_MAX_BYTES, 10 * 1024 * 1024),
        imageStorageDir: process.env.CAMERA_IMAGE_STORAGE_DIR || 'storage/camera-media',
    },
    ai: {
        minConfidence: num(process.env.AI_MIN_CONFIDENCE, 0.5),
        imageMaxBytes: num(process.env.AI_IMAGE_MAX_BYTES, 5 * 1024 * 1024),
        imageStorageDir: process.env.AI_IMAGE_STORAGE_DIR || 'storage/analysis-images',
    },
};

if (env.nodeEnv === 'production' && env.jwt.secret === 'dev-secret-change-me') {
    throw new Error('Phải đặt JWT_SECRET khi chạy production');
}
if (!Number.isFinite(env.ai.minConfidence) || env.ai.minConfidence < 0 || env.ai.minConfidence > 1) {
    throw new Error('AI_MIN_CONFIDENCE phải là số từ 0 đến 1');
}
if (!Number.isSafeInteger(env.ai.imageMaxBytes) || env.ai.imageMaxBytes < 1 || env.ai.imageMaxBytes > 50 * 1024 * 1024) {
    throw new Error('AI_IMAGE_MAX_BYTES phải là số nguyên từ 1 đến 52428800');
}

module.exports = env;
