const { Op } = require('sequelize');
const { Node, Device, Alert } = require('../models');
const mqtt = require('./mqtt.client');
const socket = require('./socket.service');
const alertService = require('./alert.service');
const commandService = require('./command.service');
const audit = require('./audit.service');

// Rate-limit retries per device. Config updates are idempotent when keyed by version.
const lastConfigPublishAt = new Map();
const CONFIG_RETRY_INTERVAL_MS = 30_000;

// Convert old stored config.auto.sourceDeviceId to deviceCode for the firmware contract.
// The persisted legacy JSON is not mutated as a side effect of publishing.
async function configForWire(config) {
    const copy = JSON.parse(JSON.stringify(config || {}));
    const auto = copy.auto;
    if (auto && typeof auto.sourceDeviceCode === 'number' && Number.isInteger(auto.sourceDeviceCode)) {
        const legacySensor = await Device.findByPk(auto.sourceDeviceCode);
        if (!legacySensor || legacySensor.type !== 'SENSOR') throw new Error(`Không thể chuyển sourceDeviceCode số cũ (ID=${auto.sourceDeviceCode}) sang mã SENSOR`);
        auto.sourceDeviceCode = legacySensor.deviceCode;
    }
    if (auto && !auto.sourceDeviceCode && auto.sourceDeviceId !== undefined && auto.sourceDeviceId !== null) {
        const legacyId = Number(auto.sourceDeviceId);
        if (!Number.isInteger(legacyId) || legacyId <= 0) throw new Error('config.auto.sourceDeviceId cũ không hợp lệ');
        const source = await Device.findByPk(legacyId);
        if (!source || source.type !== 'SENSOR') throw new Error(`Không thể chuyển sourceDeviceId=${legacyId} sang deviceCode SENSOR`);
        auto.sourceDeviceCode = source.deviceCode;
    }
    if (auto) delete auto.sourceDeviceId;
    return copy;
}

// Send configuration to the node that currently owns this device.
exports.pushDeviceConfig = async (device, node) => {
    if (device?.type === 'SENSOR') return false; // sensor alert-threshold rules are server-side; firmware only receives pump/fan settings
    if (!node || !node.isOnline || node.isRevoked || !node.mqttAccountEnabled) return false;
    try {
        const storedConfig = await configForWire(device.config);
        let firmwareConfig = {};
        if (device.type === 'PUMP') {
            const auto = storedConfig.auto || {};
            firmwareConfig = {
                pumpAutoEnabled: auto.enabled !== false,
                soilOnPct: Number.isFinite(Number(auto.onValue)) ? Number(auto.onValue) : 35,
                soilOffPct: Number.isFinite(Number(auto.offValue)) ? Number(auto.offValue) : 60,
                pumpMaxRunSec: 30,
                pumpCooldownSec: 60,
            };
        } else if (device.type === 'FAN') {
            const t = storedConfig.fanThresholds || {};
            firmwareConfig = {
                fanAutoEnabled: storedConfig.auto?.enabled !== false,
                fanOnTempC: Number(t.onTempC ?? 32),
                fanOffTempC: Number(t.offTempC ?? 30),
                fanOnHumidityPct: Number(t.onHumidityPct ?? 85),
                fanOffHumidityPct: Number(t.offHumidityPct ?? 80),
            };
        }
        await mqtt.publish(mqtt.topics.command(node.nodeCode), {
            action: 'config',
            deviceCode: device.deviceCode,
            type: device.type,
            gpioPin: device.gpioPin,
            lifecycle: device.lifecycle,
            config: firmwareConfig,
            version: device.configVersion,
        });
        lastConfigPublishAt.set(Number(device.id), Date.now());
        return true;
    } catch (error) {
        console.warn('[node] Không gửi được config:', error.message);
        return false;
    }
};

async function pushPendingConfig(node, { force = false } = {}) {
    const devices = await Device.findAll({
        where: {
            nodeId: node.id,
            type: { [Op.in]: ['PUMP', 'FAN'] },
            lifecycle: { [Op.in]: ['PROVISIONED', 'ACTIVE', 'FAULT', 'MAINTENANCE'] },
        },
    });
    for (const device of devices) {
        if (Number(device.configVersion) <= Number(device.configAppliedVersion)) {
            lastConfigPublishAt.delete(Number(device.id));
            continue;
        }
        const lastAt = lastConfigPublishAt.get(Number(device.id)) || 0;
        if (!force && Date.now() - lastAt < CONFIG_RETRY_INTERVAL_MS) continue;
        // Mark the attempt even on a publish error so a failing broker is not hammered every sweep.
        lastConfigPublishAt.set(Number(device.id), Date.now());
        await exports.pushDeviceConfig(device, node);
    }
}

// Called after broker reconnect/start and periodically by sweep. Replays only pending versions.
exports.retryPendingConfigurations = async ({ force = false } = {}) => {
    if (!mqtt.isConnected()) return;
    const onlineNodes = await Node.findAll({ where: { isOnline: true, isRevoked: false, mqttAccountEnabled: true } });
    for (const node of onlineNodes) await pushPendingConfig(node, { force });
};

async function onBackOnline(node) {
    const devices = await Device.findAll({ where: { nodeId: node.id } });
    for (const device of devices) {
        // Device connectivity follows its parent Node; lifecycle is deliberately unchanged.
        socket.emitDevice(device.id, 'device:update', { ...device.toJSON(), isOnline: device.lifecycle !== 'DECOMMISSIONED' });
        const openAlerts = await Alert.findAll({
            where: { deviceId: device.id, type: 'offline', status: { [Op.ne]: 'RESOLVED' } },
        });
        for (const alert of openAlerts) {
            await alertService.autoResolve(alert, 'Tự động: Node đã kết nối lại');
            await audit.log(null, { action: 'alert.auto_resolve', entityType: 'alert', entityId: alert.id, detail: { reason: 'node_online', nodeCode: node.nodeCode } });
        }
    }
    socket.emitAdmin('node:status', { nodeId: node.id, isOnline: true });
    await pushPendingConfig(node);
}

exports.markAlive = async (node, { firmwareVersion, bootCount, uptimeMs } = {}) => {
    if (node.isRevoked || !node.mqttAccountEnabled) return false;
    const wasOnline = node.isOnline;
    const now = new Date();
    node.lastHeartbeatAt = now;
    if (firmwareVersion) node.firmwareVersion = String(firmwareVersion).slice(0, 30);
    const bc = Number(bootCount);
    const up = Number(uptimeMs);
    if (Number.isInteger(bc) && bc >= 0) {
        if (Number(node.firmwareBootCount) !== bc) {
            node.firmwareBootCount = bc;
            node.firmwareBootStartedAt = Number.isFinite(up) && up >= 0 ? new Date(now.getTime() - up) : null;
        } else if (!node.firmwareBootStartedAt && Number.isFinite(up) && up >= 0) {
            node.firmwareBootStartedAt = new Date(now.getTime() - up);
        }
    }
    if (!wasOnline) {
        node.isOnline = true;
        node.onlineSince = new Date();
    }
    await node.save();
    if (!wasOnline) {
        await audit.log(null, { action: 'node.online', entityType: 'node', entityId: node.id, detail: { nodeCode: node.nodeCode } });
        await onBackOnline(node);
    }
    return true;
};

exports.markOffline = async (node, reason = 'timeout') => {
    const wasOnline = Boolean(node.isOnline);
    if (wasOnline) {
        node.isOnline = false;
        await node.save();
        await audit.log(null, { action: 'node.offline', entityType: 'node', entityId: node.id, success: true, detail: { nodeCode: node.nodeCode, reason } });
    }
    // Notify every child Device, not only ACTIVE ones. This changes connection status,
    // not lifecycle; never claim a physical actuator is OFF merely because MQTT is lost.
    const devices = await Device.findAll({ where: { nodeId: node.id } });
    for (const device of devices) {
        socket.emitDevice(device.id, 'device:update', { ...device.toJSON(), isOnline: false, nodeOfflineReason: reason });
        if (device.lifecycle === 'DECOMMISSIONED') continue;
        const existing = await Alert.findOne({
            where: { deviceId: device.id, type: 'offline', status: { [Op.ne]: 'RESOLVED' } },
        });
        if (!existing) {
            await alertService.create({
                type: 'offline', severity: 'WARNING',
                title: `Thiết bị ${device.name} mất kết nối`,
                message: `Node ${node.nodeCode} không còn gửi heartbeat (${reason}).`,
                deviceId: device.id,
            });
        }
    }
    socket.emitAdmin('node:status', { nodeId: node.id, isOnline: false, reason });
};

exports.sweep = async () => {
    const nodes = await Node.findAll({ where: { isOnline: true, isRevoked: false, mqttAccountEnabled: true } });
    const now = Date.now();
    for (const node of nodes) {
        const last = node.lastHeartbeatAt ? new Date(node.lastHeartbeatAt).getTime() : 0;
        if (now - last > node.heartbeatTimeoutSec * 1000) await exports.markOffline(node, 'quá hạn heartbeat');
    }
    await commandService.expireStale();
    await require('./device-lifecycle-command.service').expirePending();
    // Recover a PROVISIONED device whose previous config publish was lost during broker outage.
    await exports.retryPendingConfigurations();
};
