const { Op } = require('sequelize');
const { Device, Node, DeviceCommand, User, UserDevice, Alert } = require('../models');
const { DEVICE_TYPES, ACTUATOR_TYPES, AUTO_ACTUATORS, METRICS, LIFECYCLE, LIFECYCLE_TRANSITIONS } = require('../constants');
const ApiError = require('../utils/apiError');
const { pick } = require('../utils/helpers');
const { paging, meta } = require('../utils/pagination');
const audit = require('../services/audit.service');
const socket = require('../services/socket.service');
const nodeService = require('../services/node.service');
const commandService = require('../services/command.service');
const lifecycleCommandService = require('../services/device-lifecycle-command.service');
const deviceProbeService = require('../services/device-probe.service');
const alertService = require('../services/alert.service');
const { accessibleDeviceIds, scopeWhere, getDeviceForUser } = require('../services/access.service');
const { recoveryBlockReason } = require('../services/device-lifecycle.policy');
const { DEFAULT_SENSOR_THRESHOLD_RULES, normalizeRule: normalizeThresholdRule } = require('../services/sensor-threshold.policy');
const { createWithSequentialCode } = require('../services/code-generator');

const nodeInclude = { model: Node, as: 'node', attributes: ['id', 'name', 'isOnline', 'lastHeartbeatAt', 'isRevoked'] };
const OPS = ['lt', 'lte', 'gt', 'gte'];

// Validate and normalize config. New configs use sourceDeviceCode; numeric sourceDeviceId is accepted
// only as a backward-compatible input and converted before saving.
async function validateConfig(type, config, user = null) {
    if (config === null || config === undefined || typeof config !== 'object' || Array.isArray(config)) {
        throw ApiError.badRequest('config phải là object JSON');
    }

    const normalized = JSON.parse(JSON.stringify(config));
    if (type === 'FAN' && normalized.fanThresholds !== undefined) {
        const t = normalized.fanThresholds;
        if (!t || typeof t !== 'object' || Array.isArray(t)) throw ApiError.badRequest('config.fanThresholds phải là object');
        for (const key of ['onTempC', 'offTempC', 'onHumidityPct', 'offHumidityPct']) {
            if (t[key] === undefined || t[key] === null || t[key] === '' || !Number.isFinite(Number(t[key]))) throw ApiError.badRequest(`config.fanThresholds.${key} phải là số`);
            t[key] = Number(t[key]);
        }
        if (t.onTempC <= t.offTempC) throw ApiError.badRequest('fanThresholds.onTempC phải lớn hơn offTempC để tạo vùng trễ');
        if (t.onHumidityPct <= t.offHumidityPct || t.onHumidityPct > 100 || t.offHumidityPct < 0) throw ApiError.badRequest('fanThresholds.onHumidityPct phải lớn hơn offHumidityPct và trong khoảng 0–100');
        if (t.onTempC < -10 || t.onTempC > 80 || t.offTempC < -10 || t.offTempC > 80) throw ApiError.badRequest('Ngưỡng nhiệt độ quạt phải trong khoảng -10..80°C');
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'alertThresholds')) {
        const thresholdOverrides = normalized.alertThresholds;
        if (!thresholdOverrides || typeof thresholdOverrides !== 'object' || Array.isArray(thresholdOverrides)) {
            throw ApiError.badRequest('config.alertThresholds phải là object JSON theo metric');
        }
        for (const [metric, rule] of Object.entries(thresholdOverrides)) {
            if (!Object.prototype.hasOwnProperty.call(DEFAULT_SENSOR_THRESHOLD_RULES, metric)) {
                throw ApiError.badRequest(`Metric trong config.alertThresholds không hỗ trợ: ${metric}`);
            }
            if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
                throw ApiError.badRequest(`config.alertThresholds.${metric} phải là object`);
            }
            if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') {
                throw ApiError.badRequest(`config.alertThresholds.${metric}.enabled phải là true/false`);
            }
            if (rule.enabled !== false && !normalizeThresholdRule({ ...DEFAULT_SENSOR_THRESHOLD_RULES[metric], ...rule })) {
                throw ApiError.badRequest(`Ngưỡng ${metric} không hợp lệ; cần lowRecovery >= low và highRecovery <= high`);
            }
        }
    }

    if (!Object.prototype.hasOwnProperty.call(normalized, 'auto')) return normalized;

    const auto = normalized.auto;
    if (!auto || typeof auto !== 'object' || Array.isArray(auto)) {
        throw ApiError.badRequest('config.auto phải là object JSON');
    }
    if (auto.enabled !== undefined && typeof auto.enabled !== 'boolean') {
        throw ApiError.badRequest('config.auto.enabled phải là true/false');
    }
    if (type === 'FAN' && auto.preset === 'FAN_HYSTERESIS') {
        auto.enabled = auto.enabled !== false;
        delete auto.sourceDeviceCode;
        delete auto.sourceDeviceId;
        return normalized;
    }

    if (typeof auto.sourceDeviceCode === 'number' && Number.isInteger(auto.sourceDeviceCode)) {
        // Compatibility with an older draft that stored the DB ID in sourceDeviceCode.
        const legacySensor = await Device.findByPk(auto.sourceDeviceCode);
        if (!legacySensor || legacySensor.type !== 'SENSOR') {
            throw ApiError.badRequest(`sourceDeviceCode số cũ không trỏ đến SENSOR (ID=${auto.sourceDeviceCode})`);
        }
        auto.sourceDeviceCode = legacySensor.deviceCode;
    }
    if (!auto.sourceDeviceCode && auto.sourceDeviceId !== undefined && auto.sourceDeviceId !== null) {
        const legacyId = Number(auto.sourceDeviceId);
        if (!Number.isInteger(legacyId) || legacyId <= 0) {
            throw ApiError.badRequest('sourceDeviceId cũ phải là ID số hợp lệ');
        }
        const legacySensor = await Device.findByPk(legacyId);
        if (!legacySensor || legacySensor.type !== 'SENSOR') throw ApiError.badRequest(`Không tìm thấy SENSOR cho sourceDeviceId=${legacyId}`);
        auto.sourceDeviceCode = legacySensor.deviceCode;
    }
    delete auto.sourceDeviceId;

    if (auto.sourceDeviceCode !== undefined && auto.sourceDeviceCode !== null) {
        auto.sourceDeviceCode = String(auto.sourceDeviceCode).trim();
        if (!auto.sourceDeviceCode) throw ApiError.badRequest('sourceDeviceCode không được rỗng');
    }

    // Disabled rules may be saved incomplete, but if a source is supplied it must be a sensor.
    let sourceSensor = null;
    if (auto.sourceDeviceCode) {
        sourceSensor = await Device.findOne({ where: { deviceCode: auto.sourceDeviceCode } });
        if (!sourceSensor) throw ApiError.badRequest(`Không tìm thấy deviceCode cảm biến "${auto.sourceDeviceCode}"`);
        if (sourceSensor.type !== 'SENSOR') throw ApiError.badRequest('sourceDeviceCode phải trỏ đến thiết bị SENSOR');
        if (user && user.role !== 'admin') await getDeviceForUser(user, sourceSensor.id);
    }

    if (auto.enabled === true) {
        if (!AUTO_ACTUATORS.includes(type)) throw ApiError.badRequest('Chỉ actuator được hỗ trợ mới có quy tắc config.auto');
        const bad = [];
        if (!auto.sourceDeviceCode || !sourceSensor) bad.push('sourceDeviceCode');
        if (!METRICS.includes(String(auto.metric || '').toUpperCase())) bad.push('metric');
        else auto.metric = String(auto.metric).toUpperCase();
        auto.onOp = String(auto.onOp || '').toLowerCase();
        auto.offOp = String(auto.offOp || '').toLowerCase();
        if (!OPS.includes(auto.onOp)) bad.push('onOp');
        if (!OPS.includes(auto.offOp)) bad.push('offOp');
        const onValue = Number(auto.onValue);
        const offValue = Number(auto.offValue);
        if (auto.onValue === undefined || auto.onValue === null || auto.onValue === '' || !Number.isFinite(onValue)) bad.push('onValue');
        else auto.onValue = onValue;
        if (auto.offValue === undefined || auto.offValue === null || auto.offValue === '' || !Number.isFinite(offValue)) bad.push('offValue');
        else auto.offValue = offValue;
        if (auto.cooldownSec !== undefined) {
            const cooldown = Number(auto.cooldownSec);
            if (!Number.isFinite(cooldown) || cooldown < 0 || cooldown > 86400) bad.push('cooldownSec');
            else auto.cooldownSec = cooldown;
        }
        if (bad.length) throw ApiError.badRequest(`config.auto thiếu/sai: ${bad.join(', ')}`);
    }

    return normalized;
}

async function bumpAndPushConfig(device) {
    device.configVersion = Number(device.configVersion || 0) + 1;
    if (device.type === 'SENSOR') device.configAppliedVersion = device.configVersion; // threshold rules are evaluated by Backend, not ESP32
    await device.save();
    if (device.type === 'SENSOR') return true;
    // Always refresh Node from DB so a stale included association cannot bypass isRevoked checks.
    const node = device.nodeId ? await Node.findByPk(device.nodeId) : null;
    return nodeService.pushDeviceConfig(device, node);
}

exports.list = async (req, res) => {
    const { page, limit, offset } = paging(req);
    const ids = await accessibleDeviceIds(req.user);
    const where = { ...scopeWhere(ids, 'id') };
    for (const k of ['type', 'lifecycle', 'nodeId', 'deviceCode']) {
        if (req.query[k] !== undefined && req.query[k] !== '') where[k] = req.query[k];
    }
    const { rows, count } = await Device.findAndCountAll({ where, include: [nodeInclude], limit, offset, order: [['id', 'ASC']] });
    res.json({ data: rows, meta: meta(page, limit, count) });
};

exports.get = async (req, res) => {
    const device = await getDeviceForUser(req.user, req.params.id, { include: [nodeInclude] });
    res.json({ data: device });
};

// POST /devices/probe: the backend generates deviceCode only after a positive hardware probe ACK.
exports.probeAndRegister = async (req, res) => {
    const { name, type, location, nodeId, gpioPin, config } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || !type) {
        throw ApiError.badRequest('Cần name và type hợp lệ; deviceCode sẽ do backend tự sinh sau khi probe thành công');
    }
    if (!DEVICE_TYPES.includes(type)) throw ApiError.badRequest(`type phải thuộc: ${DEVICE_TYPES.join(', ')}`);

    const normalizedNodeId = Number(nodeId);
    if (!Number.isInteger(normalizedNodeId) || normalizedNodeId <= 0) throw ApiError.badRequest('Phải chọn Node ESP32 hợp lệ');
    const node = await Node.findByPk(normalizedNodeId);
    if (!node) throw ApiError.badRequest('nodeId không tồn tại');
    if (node.isRevoked) throw ApiError.conflict('Không thể gán thiết bị vào Node đã bị thu hồi');
    if (!node.isOnline) throw ApiError.conflict('Node phải online trước khi xác minh thiết bị');

    const normalizedGpioPin = Number(gpioPin);
    if (gpioPin === undefined || gpioPin === null || gpioPin === '' || !Number.isInteger(normalizedGpioPin) || normalizedGpioPin < 0) {
        throw ApiError.badRequest('gpioPin phải là số nguyên không âm');
    }

    const normalizedConfig = config === undefined ? {} : await validateConfig(type, config, req.user);
    let hardwareFeedback = null;
    if (type === 'PUMP') {
        const feedbackType = String(req.body?.feedbackType || '').toUpperCase();
        const feedbackPin = Number(req.body?.feedbackGpioPin);
        if (!['CURRENT_SENSOR', 'FLOW_SENSOR'].includes(feedbackType)) {
            throw ApiError.badRequest('Để xác minh bơm vật lý, chọn CURRENT_SENSOR hoặc FLOW_SENSOR làm tín hiệu phản hồi');
        }
        if (req.body?.feedbackGpioPin === undefined || req.body?.feedbackGpioPin === '' || !Number.isInteger(feedbackPin) || feedbackPin < 0) {
            throw ApiError.badRequest('Cần feedbackGpioPin hợp lệ để đọc phản hồi dòng điện/lưu lượng của bơm');
        }
        if (feedbackPin === normalizedGpioPin) throw ApiError.badRequest('GPIO điều khiển bơm và GPIO phản hồi phải khác nhau');
        if (req.body?.allowActuatorTest !== true) {
            throw ApiError.badRequest('Để xác minh bơm vật lý, cần xác nhận cho phép chạy phép thử có kiểm soát tối đa 1 giây.');
        }
        hardwareFeedback = { type: feedbackType, gpioPin: feedbackPin, readinessTestConsent: true, maxTestDurationMs: 1000 };
        normalizedConfig.hardwareFeedback = hardwareFeedback;
    }

    const assertPinsAvailable = async () => {
        const assignedDevices = await Device.findAll({ where: { nodeId: normalizedNodeId, lifecycle: { [Op.ne]: 'DECOMMISSIONED' } } });
        for (const existing of assignedDevices) {
            const usedPins = [existing.gpioPin, existing.config?.hardwareFeedback?.gpioPin]
                .filter((pin) => pin !== null && pin !== undefined).map(Number);
            const requestedPins = [normalizedGpioPin, hardwareFeedback?.gpioPin].filter((pin) => pin !== null && pin !== undefined).map(Number);
            if (requestedPins.some((pin) => usedPins.includes(pin))) {
                throw ApiError.conflict(`GPIO trùng với thiết bị ${existing.deviceCode}; hãy chọn GPIO chưa được sử dụng`);
            }
        }
    };
    await assertPinsAvailable();

    await audit.log(req, {
        action: 'device.probe_requested', entityType: 'device', success: true,
        detail: { type, nodeCode: node.nodeCode, gpioPin: normalizedGpioPin },
    });
    let probe;
    try {
        probe = await deviceProbeService.request({
            node, type, gpioPin: normalizedGpioPin, hardwareFeedback,
            allowActuatorTest: req.body?.allowActuatorTest === true,
        });
    } catch (error) {
        await audit.log(req, { action: 'device.probe_failed', entityType: 'device', success: false, detail: { type, nodeCode: node.nodeCode, gpioPin: normalizedGpioPin, reason: String(error.message || 'probe failed').slice(0, 500) } });
        throw error;
    }

    // A second request may probe the same GPIO while this request awaits MQTT.
    await assertPinsAvailable();

    const registeredAt = new Date();
    let created;
    try {
        created = await createWithSequentialCode({
            prefix: 'DEV', Model: Device, field: 'deviceCode',
            values: {
                name: String(name).trim(),
                type,
                location: location ?? null,
                nodeId: normalizedNodeId,
                gpioPin: normalizedGpioPin,
                config: normalizedConfig,
                configVersion: 0,
                configAppliedVersion: 0,
                lifecycle: 'REGISTERED',
                lifecycleChangedAt: registeredAt,
                presenceVerifiedAt: registeredAt,
            },
        });
    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') throw ApiError.conflict('Mã thiết bị tuần tự đã tồn tại. Hãy kiểm tra dữ liệu thiết bị cũ trước khi tạo tiếp.');
        throw error;
    }
    const device = created.record;
    await audit.log(req, {
        action: 'device.create', entityType: 'device', entityId: device.id,
        detail: { deviceCode: device.deviceCode, codeGeneratedBy: 'backend', type, nodeCode: node.nodeCode, requestId: probe.requestId, probeMetric: probe.metric },
    });
    socket.emitAdmin('device:registered', device);
    res.status(201).json({
        data: device,
        meta: { deviceCodeGenerated: true },
        probe: { requestId: probe.requestId, metric: probe.metric, value: probe.value },
    });
};

// POST /devices — đăng ký cấu hình phần cứng đã được nhóm Firmware xác nhận.
// Firmware v1.2 không có device/probe; chân GPIO/loại thiết bị lấy theo cấu hình lắp ráp đã bàn giao.
exports.create = async (req, res) => {
    const { name, type, location, nodeId, gpioPin } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || !type) throw ApiError.badRequest('Cần name và type');
    if (!DEVICE_TYPES.includes(type)) throw ApiError.badRequest(`type phải thuộc: ${DEVICE_TYPES.join(', ')}`);
    const normalizedNodeId = Number(nodeId);
    if (!Number.isInteger(normalizedNodeId) || normalizedNodeId <= 0) throw ApiError.badRequest('Phải chọn Node ESP32 hợp lệ');
    const node = await Node.findByPk(normalizedNodeId);
    if (!node) throw ApiError.badRequest('nodeId không tồn tại');
    if (node.isRevoked) throw ApiError.conflict('Không thể gán thiết bị vào Node đã bị thu hồi');
    const pin = Number(gpioPin);
    if (gpioPin === undefined || gpioPin === null || gpioPin === '' || !Number.isInteger(pin) || pin < 0) {
        throw ApiError.badRequest('gpioPin phải là số nguyên không âm');
    }
    const metrics = type === 'SENSOR' ? [...new Set((Array.isArray(req.body.metrics) ? req.body.metrics : []).map((m) => String(m).toUpperCase()))] : [];
    if (type === 'SENSOR' && (!metrics.length || metrics.some((m) => !METRICS.includes(m)))) {
        throw ApiError.badRequest(`SENSOR cần metrics là mảng không rỗng gồm: ${METRICS.join(', ')}`);
    }
    if (type === 'SENSOR' && metrics.includes('SOIL_MOISTURE') && metrics.some((m) => ['AIR_TEMPERATURE', 'AIR_HUMIDITY'].includes(m))) {
        throw ApiError.badRequest('Cảm biến đất GPIO34 và DHT11 GPIO4 là hai linh kiện vật lý riêng; hãy đăng ký thành hai SENSOR khác nhau.');
    }
    const assigned = await Device.findAll({ where: { nodeId: normalizedNodeId, lifecycle: { [Op.ne]: 'DECOMMISSIONED' } } });
    const pinOwner = assigned.find((d) => d.gpioPin !== null && d.gpioPin !== undefined && Number(d.gpioPin) === pin);
    if (pinOwner) throw ApiError.conflict(`GPIO ${pin} đã được gán cho ${pinOwner.deviceCode}; một thiết bị vật lý chỉ nên đăng ký một lần.`);
    let created;
    try {
        created = await createWithSequentialCode({
            prefix: 'DEV', Model: Device, field: 'deviceCode',
            values: {
                name: name.trim(), type, location: location ?? null,
                nodeId: normalizedNodeId, gpioPin: pin,
                config: type === 'SENSOR' ? { metrics } : (type === 'FAN' ? { localAutomation: true, fanThresholds: { onTempC: 32, offTempC: 30, onHumidityPct: 85, offHumidityPct: 80 }, auto: { enabled: true, preset: 'FAN_HYSTERESIS' } } : { localAutomation: true, auto: { enabled: true, metric: 'SOIL_MOISTURE', onOp: 'lt', onValue: 35, offOp: 'gte', offValue: 60 } }),
                configVersion: 0, configAppliedVersion: 0,
                lifecycle: 'REGISTERED', lifecycleChangedAt: new Date(), presenceVerifiedAt: null,
            },
        });
    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') throw ApiError.conflict('Mã thiết bị tuần tự đã tồn tại. Hãy kiểm tra dữ liệu thiết bị cũ trước khi tạo tiếp.');
        throw error;
    }
    const device = created.record;
    await audit.log(req, { action: 'device.create_from_firmware_inventory', entityType: 'device', entityId: device.id, detail: { deviceCode: device.deviceCode, type, nodeCode: node.nodeCode, gpioPin: pin, metrics } });
    socket.emitAdmin('device:registered', device);
    res.status(201).json({ data: device, meta: { deviceCodeGenerated: true, registrationMode: 'firmware-inventory' }, message: 'Đã đăng ký theo danh sách phần cứng Firmware. Việc tạo bản ghi không thay thế kiểm thử phần cứng thực tế.' });
};

exports.update = async (req, res) => {
    const device = await getDeviceForUser(req.user, req.params.id, { include: [nodeInclude] });
    const body = req.body || {};
    if (Object.prototype.hasOwnProperty.call(body, 'deviceCode')) {
        throw ApiError.badRequest('deviceCode là định danh phần cứng dùng trong MQTT và không thể đổi qua PATCH thông thường');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'config')) {
        throw ApiError.badRequest('Dùng PATCH /devices/:id/config để cập nhật config');
    }

    const previousNodeId = device.nodeId == null ? null : Number(device.nodeId);
    const previousGpioPin = device.gpioPin == null ? null : Number(device.gpioPin);
    const changes = pick(body, ['name', 'location', 'nodeId', 'gpioPin']);
    if (device.lifecycle === 'DECOMMISSIONED' && (Object.prototype.hasOwnProperty.call(body, 'nodeId') || Object.prototype.hasOwnProperty.call(body, 'gpioPin'))) {
        throw ApiError.conflict('Thiết bị đã DECOMMISSIONED; không được gán lại Node/GPIO. Hãy đăng ký thiết bị mới bằng deviceCode mới.');
    }
    if (device.presenceVerifiedAt && (Object.prototype.hasOwnProperty.call(body, 'nodeId') || Object.prototype.hasOwnProperty.call(body, 'gpioPin'))) {
        const requestedNodeId = body.nodeId === '' || body.nodeId === null || body.nodeId === undefined ? null : Number(body.nodeId);
        const requestedGpioPin = body.gpioPin === '' || body.gpioPin === null || body.gpioPin === undefined ? null : Number(body.gpioPin);
        const changesHardware = (Object.prototype.hasOwnProperty.call(body, 'nodeId') && requestedNodeId !== previousNodeId) || (Object.prototype.hasOwnProperty.call(body, 'gpioPin') && requestedGpioPin !== previousGpioPin);
        if (changesHardware) throw ApiError.conflict('Thiết bị đã xác minh phần cứng; không thể đổi Node/GPIO trực tiếp. Chuyển bản ghi cũ sang DECOMMISSIONED rồi đăng ký phần cứng thay thế bằng deviceCode mới.');
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'nodeId')) {
        if (changes.nodeId === '' || changes.nodeId === null) {
            if (!['REGISTERED', 'DECOMMISSIONED'].includes(device.lifecycle)) {
                throw ApiError.conflict('Không thể bỏ nodeId khi thiết bị đã qua trạng thái REGISTERED');
            }
            changes.nodeId = null;
        } else {
            changes.nodeId = Number(changes.nodeId);
            if (!Number.isInteger(changes.nodeId) || changes.nodeId <= 0) throw ApiError.badRequest('nodeId không hợp lệ');
            const targetNode = await Node.findByPk(changes.nodeId);
            if (!targetNode) throw ApiError.badRequest('nodeId không tồn tại');
            if (targetNode.isRevoked) throw ApiError.conflict('Không thể gán thiết bị vào Node đã bị thu hồi');
        }
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'gpioPin')) {
        if (changes.gpioPin === '' || changes.gpioPin === null) changes.gpioPin = null;
        else {
            changes.gpioPin = Number(changes.gpioPin);
            if (!Number.isInteger(changes.gpioPin) || changes.gpioPin < 0) throw ApiError.badRequest('gpioPin phải là số nguyên không âm');
        }
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'name')) {
        changes.name = String(changes.name).trim();
        if (!changes.name) throw ApiError.badRequest('name không được rỗng');
    }

    Object.assign(device, changes);
    const nextNodeId = device.nodeId == null ? null : Number(device.nodeId);
    const nextGpioPin = device.gpioPin == null ? null : Number(device.gpioPin);
    const hardwareChanged = previousNodeId !== nextNodeId || previousGpioPin !== nextGpioPin;
    let pushed = false;
    if (hardwareChanged) pushed = await bumpAndPushConfig(device);
    else await device.save();

    await audit.log(req, { action: 'device.update', entityType: 'device', entityId: device.id, detail: { fields: Object.keys(changes), hardwareChanged, configPublishedNow: pushed } });
    socket.emitDevice(device.id, 'device:update', device);
    res.json({ data: device, ...(hardwareChanged ? { configPublishedNow: pushed, pendingUntilAcknowledged: device.configAppliedVersion < device.configVersion } : {}) });
};

// PATCH /devices/:id/config - update operational config, version and push over MQTT.
exports.updateConfig = async (req, res) => {
    const device = await getDeviceForUser(req.user, req.params.id, { include: [nodeInclude] });
    if (device.lifecycle === 'DECOMMISSIONED') throw ApiError.conflict('Thiết bị đã DECOMMISSIONED; không thể cập nhật cấu hình. Hãy đăng ký thiết bị thay thế bằng deviceCode mới.');
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'config')) throw ApiError.badRequest('Cần trường config');
    const normalizedConfig = await validateConfig(device.type, req.body.config, req.user);
    if (device.presenceVerifiedAt && JSON.stringify(normalizedConfig.hardwareFeedback || null) !== JSON.stringify(device.config?.hardwareFeedback || null)) {
        throw ApiError.conflict('Không thể đổi cấu hình GPIO phản hồi phần cứng sau khi xác minh. Hãy decommission bản ghi này và đăng ký thiết bị phần cứng thay thế bằng deviceCode mới.');
    }
    device.config = normalizedConfig;
    const pushed = await bumpAndPushConfig(device);
    await audit.log(req, {
        action: 'device.config_update', entityType: 'device', entityId: device.id,
        detail: { configVersion: device.configVersion, pushed },
    });
    socket.emitDevice(device.id, 'device:update', device);
    res.json({
        data: device,
        configPublishedNow: pushed,
        pendingUntilAcknowledged: device.configAppliedVersion < device.configVersion,
    });
};

// POST /devices/:id/lifecycle { "to": "ACTIVE" }
exports.changeLifecycle = async (req, res) => {
    const device = await getDeviceForUser(req.user, req.params.id, { include: [nodeInclude] });
    const to = req.body?.to;
    const from = device.lifecycle;
    if (!LIFECYCLE.includes(to)) throw ApiError.badRequest(`to phải thuộc: ${LIFECYCLE.join(', ')}`);
    const allowed = LIFECYCLE_TRANSITIONS[device.lifecycle] || [];
    if (!allowed.includes(to)) {
        throw ApiError.conflict(`Không thể chuyển ${device.lifecycle} → ${to}. Cho phép: ${allowed.join(', ') || '(không có)'}`);
    }

    let targetNode = device.nodeId ? await Node.findByPk(device.nodeId) : null;
    if (to === 'PROVISIONED') {
        if (!device.nodeId) throw ApiError.conflict('Cần gán Node ESP32 trước khi Provisioned');
        if (device.gpioPin === null || device.gpioPin === undefined) throw ApiError.conflict('Cần cấu hình GPIO trước khi Provisioned');
        if (!targetNode || targetNode.isRevoked) throw ApiError.conflict('Node không hợp lệ hoặc đã bị thu hồi');
        if (!targetNode.mqttUsername || !targetNode.mqttAccountEnabled) throw ApiError.conflict('Node chưa được cấp tài khoản MQTT riêng hoặc tài khoản đang bị khóa.');
        const ownerCount = await UserDevice.count({ where: { deviceId: device.id } });
        if (ownerCount < 1) throw ApiError.conflict('Cần gán thiết bị cho ít nhất một người dùng quản lý trong mục Quản lý người dùng trước khi Provisioned.');
        if (device.type === 'SENSOR' && (!Array.isArray(device.config?.metrics) || device.config.metrics.length === 0)) {
            throw ApiError.conflict('Cảm biến cần cấu hình ít nhất một metric trước khi Provisioned.');
        }
    }

    if (to === 'ACTIVE') {
        if (req.user.role !== 'admin') throw ApiError.forbidden('Chỉ Admin mới được kích hoạt thiết bị.');
        if (!targetNode || targetNode.isRevoked || !targetNode.isOnline) throw ApiError.conflict('Cần Node hợp lệ, chưa bị thu hồi và đang online trước khi kích hoạt.');
        if (!targetNode.mqttUsername || !targetNode.mqttAccountEnabled) throw ApiError.conflict('Tài khoản MQTT riêng của Node chưa được cấp hoặc đang bị khóa.');
        if (Number(device.configAppliedVersion || 0) < Number(device.configVersion || 0)) {
            throw ApiError.conflict('Cấu hình mới nhất chưa được Firmware xác nhận qua MQTT. Hãy chờ config ACK rồi kích hoạt.');
        }
        if (['FAULT', 'MAINTENANCE'].includes(from)) {
            const reason = recoveryBlockReason(device, targetNode);
            if (reason) throw ApiError.conflict(reason);
        }
        try {
            const request = await lifecycleCommandService.requestActivation(device, targetNode, req.user.id);
            return res.status(202).json({
                data: device,
                pendingActivation: true,
                commandUuid: request.commandUuid,
                message: 'Đã gửi lệnh lifecycle ACTIVE tới Firmware. Thiết bị chỉ chuyển sang Active sau khi nhận ACK thành công.',
            });
        } catch (error) {
            throw ApiError.conflict(error.message || 'Không gửi được lệnh kích hoạt tới Firmware.');
        }
    }

    // Không chuyển trạng thái khi actuator đang chạy; phải xác nhận OFF trước.
    if (['FAULT', 'MAINTENANCE', 'DECOMMISSIONED'].includes(to) && ACTUATOR_TYPES.includes(device.type) && device.isOn) {
        const cmd = await commandService.issue({ device, turnOn: false, source: 'MANUAL', userId: req.user.id });
        await device.reload();
        if (cmd.status === 'FAILED') throw ApiError.conflict(`Không gửi được lệnh tắt cơ cấu chấp hành: ${cmd.resultMessage || 'lỗi không rõ'}`);
        if (device.isOn) {
            await audit.log(req, { action: 'device.lifecycle_shutdown_requested', entityType: 'device', entityId: device.id, detail: { targetLifecycle: to, commandUuid: cmd.commandUuid } });
            return res.status(202).json({ data: device, pendingShutdown: true, command: cmd, message: 'Đã gửi lệnh tắt; chờ ACK thành công rồi gửi lại yêu cầu chuyển lifecycle.' });
        }
    }

    device.lifecycle = to;
    device.lifecycleChangedAt = new Date();
    device.pendingLifecycleCommandUuid = null;
    device.pendingLifecycleCommandTo = null;
    device.pendingLifecycleCommandSentAt = null;
    if (['FAULT', 'MAINTENANCE', 'DECOMMISSIONED', 'PROVISIONED'].includes(to)) {
        device.readinessVerifiedAt = null;
        device.readinessType = null;
    }
    let configPublishedNow = false;
    if (to === 'PROVISIONED') {
        device.configVersion = Math.max(Number(device.configVersion || 0), Number(device.configAppliedVersion || 0)) + 1;
        if (device.type === 'SENSOR') device.configAppliedVersion = device.configVersion; // metric rules are evaluated by Backend
    }
    await device.save();
    if (to === 'PROVISIONED') {
        configPublishedNow = await nodeService.pushDeviceConfig(device, targetNode);
        if (targetNode?.isOnline && !targetNode.isRevoked) {
            try {
                await require('../services/mqtt.client').publish(require('../services/mqtt.client').topics.command(targetNode.nodeCode), {
                    action: 'lifecycle', deviceCode: device.deviceCode, type: device.type,
                    gpioPin: device.gpioPin, lifecycle: 'PROVISIONED', state: 'PROVISIONED',
                });
            } catch (error) {
                console.warn('[device] chưa đồng bộ được lifecycle PROVISIONED tới Firmware:', error.message);
            }
        }
    } else if (targetNode?.isOnline && !targetNode.isRevoked) {
        try {
            await require('../services/mqtt.client').publish(require('../services/mqtt.client').topics.command(targetNode.nodeCode), {
                action: 'lifecycle', deviceCode: device.deviceCode, type: device.type,
                gpioPin: device.gpioPin, lifecycle: to, state: to,
            });
        } catch (error) {
            console.warn(`[device] chưa đồng bộ được lifecycle ${to} tới Firmware:`, error.message);
        }
    }
    if (to === 'FAULT' && from !== 'FAULT') {
        const existingFault = await Alert.findOne({ where: { deviceId: device.id, type: 'fault', status: { [Op.ne]: 'RESOLVED' } } });
        if (!existingFault) {
            await alertService.create({ type: 'fault', severity: 'CRITICAL', title: `Thiết bị ${device.name} được đánh dấu lỗi`, message: 'Lifecycle được Admin chuyển sang FAULT.', deviceId: device.id });
        }
    }
    if (['FAULT', 'MAINTENANCE'].includes(from) && to === 'ACTIVE') {
        const faultAlerts = await Alert.findAll({ where: { deviceId: device.id, type: 'fault', status: { [Op.ne]: 'RESOLVED' } } });
        for (const alert of faultAlerts) await alertService.autoResolve(alert, 'Thiết bị đã được Admin kích hoạt lại và Firmware xác nhận');
    }
    await audit.log(req, { action: 'device.lifecycle', entityType: 'device', entityId: device.id, detail: { from, to } });
    socket.emitDevice(device.id, 'device:update', device);
    res.json({ data: device, ...(to === 'PROVISIONED' ? { configPublishedNow, pendingUntilAcknowledged: device.configAppliedVersion < device.configVersion } : {}) });
};

// POST /devices/:id/commands { "turn_on": true }; `turnOn` is accepted for legacy clients.
exports.sendCommand = async (req, res) => {
    const device = await getDeviceForUser(req.user, req.params.id, { include: [nodeInclude] });
    if (!ACTUATOR_TYPES.includes(device.type)) throw ApiError.badRequest('Thiết bị này không phải cơ cấu chấp hành');
    if (device.lifecycle !== 'ACTIVE') throw ApiError.conflict(`Thiết bị đang ở trạng thái "${device.lifecycle}", chỉ điều khiển được khi ACTIVE`);
    const body = req.body || {};
    const turnOn = body.turn_on !== undefined ? body.turn_on : body.turnOn;
    if (typeof turnOn !== 'boolean') throw ApiError.badRequest('turn_on phải là true/false');
    let cmd;
    try {
        cmd = await commandService.issue({ device, turnOn, source: 'MANUAL', userId: req.user.id });
    } catch (error) {
        await audit.log(req, {
            action: 'device.command', entityType: 'device', entityId: device.id, success: false,
            detail: { turnOn, reason: String(error.message || 'command rejected').slice(0, 250) },
        });
        throw error;
    }
    await audit.log(req, {
        action: 'device.command', entityType: 'device', entityId: device.id, success: !['FAILED', 'TIMEOUT'].includes(cmd.status),
        detail: { turnOn, commandUuid: cmd.commandUuid, status: cmd.status },
    });
    res.status(['FAILED', 'TIMEOUT'].includes(cmd.status) ? 409 : 202).json({ data: cmd });
};

exports.listCommands = async (req, res) => {
    const device = await getDeviceForUser(req.user, req.params.id);
    const { page, limit, offset } = paging(req, 20);
    const where = { deviceId: device.id };
    if (req.query.status) where.status = req.query.status;
    if (req.query.source) where.source = req.query.source;
    const { rows, count } = await DeviceCommand.findAndCountAll({
        where, limit, offset, order: [['id', 'DESC']],
        include: [{ model: User, as: 'issuer', attributes: ['id', 'username', 'fullName'] }],
    });
    res.json({ data: rows, meta: meta(page, limit, count) });
};
