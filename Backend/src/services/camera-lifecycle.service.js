/**
 * Vòng đời + online/offline cho Camera (Device type CAMERA, không gắn Node ESP32).
 *
 * Tương đương luồng ESP:
 *   REGISTERED  → Admin tạo Camera (POST /api/camera).
 *   PROVISIONED → Admin cấp token (tương đương cấp tài khoản MQTT cho Node).
 *   ACTIVE      → Camera dùng token gọi heartbeat/upload lần đầu (tương đương ACK của Firmware).
 *   FAULT / MAINTENANCE → Admin chuyển tay; Camera vẫn gửi heartbeat nhưng upload bị từ chối 403
 *                 (agent giữ file trong hàng đợi và thử lại sau).
 *   DECOMMISSIONED → token bị thu hồi, mọi request bị chặn.
 *
 * Online/offline: tính từ cameraTokens.lastUsedAt (mỗi request hợp lệ đều cập nhật) so với
 * 3 × heartbeatIntervalSeconds (mặc định 60s). Không cần cột mới trong bảng devices.
 */
const { Op } = require('sequelize');
const { Device, CameraToken, Alert, UserDevice } = require('../models');
const ApiError = require('../utils/apiError');
const alertService = require('./alert.service');
const socket = require('./socket.service');
const audit = require('./audit.service');

const DEFAULT_HEARTBEAT_SEC = 60;
const MIN_OFFLINE_SEC = 90;

// Camera không có MQTT ACK nên bảng chuyển trạng thái riêng, gọn hơn ESP.
const CAMERA_TRANSITIONS = {
    REGISTERED: ['DECOMMISSIONED'], // lên PROVISIONED bằng cách cấp token
    PROVISIONED: ['ACTIVE', 'FAULT', 'MAINTENANCE', 'DECOMMISSIONED'],
    ACTIVE: ['FAULT', 'MAINTENANCE', 'DECOMMISSIONED'],
    FAULT: ['ACTIVE', 'MAINTENANCE', 'DECOMMISSIONED'],
    MAINTENANCE: ['FAULT', 'ACTIVE', 'DECOMMISSIONED'],
    DECOMMISSIONED: [],
};
// Trạng thái được phép upload ảnh.
const UPLOAD_LIFECYCLES = new Set(['PROVISIONED', 'ACTIVE']);

function heartbeatIntervalSec(device) {
    const value = Number(device?.config?.heartbeatIntervalSeconds);
    return Number.isInteger(value) && value >= 10 && value <= 3600 ? value : DEFAULT_HEARTBEAT_SEC;
}

function offlineAfterSec(device) {
    return Math.max(MIN_OFFLINE_SEC, heartbeatIntervalSec(device) * 3);
}

function tokenUsable(token) {
    return Boolean(token && !token.revokedAt && (!token.expiresAt || new Date(token.expiresAt) > new Date()));
}

/** Trạng thái kết nối tính toán cho một Camera (token có thể null). */
function presence(device, token, now = Date.now()) {
    const lastSeenAt = token?.lastUsedAt ? new Date(token.lastUsedAt) : null;
    const usable = tokenUsable(token);
    const isOnline = Boolean(usable && lastSeenAt && now - lastSeenAt.getTime() <= offlineAfterSec(device) * 1000);
    return {
        isOnline,
        lastSeenAt,
        offlineAfterSec: offlineAfterSec(device),
        heartbeatIntervalSeconds: heartbeatIntervalSec(device),
        token: token
            ? {
                status: token.revokedAt ? 'REVOKED' : (usable ? 'ACTIVE' : 'EXPIRED'),
                createdAt: token.createdAt, expiresAt: token.expiresAt,
                revokedAt: token.revokedAt, lastUsedAt: token.lastUsedAt,
            }
            : { status: 'NONE' },
    };
}

/** JSON trả cho Frontend: Device + trạng thái kết nối, không bao giờ có tokenHash. */
exports.toView = (device, token = device.cameraToken, extra = {}) => {
    const json = typeof device.toJSON === 'function' ? device.toJSON() : { ...device };
    delete json.cameraToken;
    return { ...json, ...presence(device, token), ...extra };
};

exports.presence = presence;
exports.heartbeatIntervalSec = heartbeatIntervalSec;

async function resolveOfflineAlerts(device) {
    const alerts = await Alert.findAll({ where: { deviceId: device.id, type: 'offline', status: { [Op.ne]: 'RESOLVED' } } });
    for (const alert of alerts) await alertService.autoResolve(alert, 'Camera đã kết nối lại');
}

function emit(device, token) {
    try { socket.emitDevice(device.id, 'device:update', exports.toView(device, token)); } catch { /* socket chưa khởi tạo (test/CLI) */ }
}

/**
 * Gọi sau khi token Camera hợp lệ (middleware camera-auth).
 * - PROVISIONED → ACTIVE ở lần liên lạc đầu tiên.
 * - Đóng cảnh báo offline đang mở nếu Camera vừa quay lại.
 */
exports.onCameraContact = async (device, token, { wasOnline }) => {
    if (device.lifecycle === 'PROVISIONED') {
        // Static update chỉ dựng instance từ các field đang sửa (không có `type`), nên validator
        // nodeRequiredAfterRegistered không nhận ra CAMERA và chặn nhầm. Chỉ đổi lifecycle của
        // đúng một CAMERA (khóa bằng where), nên bỏ qua model validation ở đây.
        const [updated] = await Device.update(
            { lifecycle: 'ACTIVE', lifecycleChangedAt: new Date() },
            { where: { id: device.id, type: 'CAMERA', lifecycle: 'PROVISIONED' }, validate: false },
        );
        if (updated) {
            device.lifecycle = 'ACTIVE';
            device.lifecycleChangedAt = new Date();
            await audit.log(null, {
                action: 'camera.activated', entityType: 'device', entityId: device.id,
                detail: { cameraId: device.deviceCode, reason: 'first authenticated contact' },
            });
        }
    }
    if (!wasOnline) {
        await resolveOfflineAlerts(device);
        emit(device, token);
    }
};

/** Upload chỉ được nhận ở PROVISIONED/ACTIVE. 403 để agent giữ file và thử lại sau. */
exports.assertCanUpload = (device) => {
    if (!UPLOAD_LIFECYCLES.has(device.lifecycle)) {
        throw ApiError.coded(403, 'CAMERA_NOT_ACCEPTING', `Camera đang ở trạng thái ${device.lifecycle}, tạm không nhận ảnh`);
    }
};

/** Cấp token xong → REGISTERED lên PROVISIONED. */
exports.onTokenIssued = async (device) => {
    if (device.lifecycle !== 'REGISTERED') return device;
    device.lifecycle = 'PROVISIONED';
    device.lifecycleChangedAt = new Date();
    await device.save();
    return device;
};

/** Thu hồi token → PROVISIONED/ACTIVE quay về REGISTERED (chưa có credential). */
exports.onTokenRevoked = async (device) => {
    if (!['PROVISIONED', 'ACTIVE'].includes(device.lifecycle)) return device;
    device.lifecycle = 'REGISTERED';
    device.lifecycleChangedAt = new Date();
    await device.save();
    return device;
};

/** Đổi lifecycle thủ công cho Camera (gọi từ POST /devices/:id/lifecycle). */
exports.changeLifecycle = async (req, device, to) => {
    const from = device.lifecycle;
    const allowed = CAMERA_TRANSITIONS[from] || [];
    if (!allowed.includes(to)) {
        const hint = from === 'REGISTERED' ? ' Hãy cấp token Camera để chuyển sang PROVISIONED.' : '';
        throw ApiError.conflict(`Camera không thể chuyển ${from} → ${to}. Cho phép: ${allowed.join(', ') || '(không có)'}.${hint}`);
    }
    if (req.user.role !== 'admin') throw ApiError.forbidden('Chỉ Admin mới được đổi trạng thái Camera.');

    const token = await CameraToken.findOne({ where: { deviceId: device.id } });
    if (to === 'ACTIVE' && !presence(device, token).isOnline) {
        throw ApiError.conflict('Camera chưa gửi heartbeat gần đây. Hãy mở agent trên điện thoại rồi kích hoạt lại.');
    }

    device.lifecycle = to;
    device.lifecycleChangedAt = new Date();
    await device.save();

    if (to === 'DECOMMISSIONED' && token && !token.revokedAt) {
        await token.update({ revokedAt: new Date() });
    }
    if (to === 'FAULT' && from !== 'FAULT') {
        const open = await Alert.findOne({ where: { deviceId: device.id, type: 'fault', status: { [Op.ne]: 'RESOLVED' } } });
        if (!open) {
            await alertService.create({
                type: 'fault', severity: 'CRITICAL', title: `Camera ${device.name} được đánh dấu lỗi`,
                message: 'Lifecycle được Admin chuyển sang FAULT.', deviceId: device.id,
            });
        }
    }
    if (['FAULT', 'MAINTENANCE'].includes(from) && to === 'ACTIVE') {
        const faults = await Alert.findAll({ where: { deviceId: device.id, type: 'fault', status: { [Op.ne]: 'RESOLVED' } } });
        for (const alert of faults) await alertService.autoResolve(alert, 'Camera đã được Admin kích hoạt lại');
    }
    await audit.log(req, { action: 'device.lifecycle', entityType: 'device', entityId: device.id, detail: { from, to, type: 'CAMERA' } });
    emit(device, token);
    return device;
};

/** Quét định kỳ: Camera ACTIVE quá hạn heartbeat → cảnh báo offline (mỗi Camera tối đa 1 cảnh báo mở). */
exports.sweepOffline = async () => {
    const cameras = await Device.findAll({
        where: { type: 'CAMERA', lifecycle: 'ACTIVE' },
        include: [{ model: CameraToken, as: 'cameraToken' }],
    });
    const now = Date.now();
    for (const camera of cameras) {
        const state = presence(camera, camera.cameraToken, now);
        if (state.isOnline || !state.lastSeenAt) continue;
        const existing = await Alert.findOne({ where: { deviceId: camera.id, type: 'offline', status: { [Op.ne]: 'RESOLVED' } } });
        if (existing) continue;
        await alertService.create({
            type: 'offline', severity: 'WARNING',
            title: `Camera ${camera.name} mất kết nối`,
            message: `Camera ${camera.deviceCode} không gửi heartbeat quá ${state.offlineAfterSec} giây.`,
            deviceId: camera.id,
        });
        emit(camera, camera.cameraToken);
    }
};

/**
 * deviceCode các Camera người dùng được xem (bảng camera_media lưu cameraId = deviceCode).
 * null = Admin, xem tất cả.
 */
exports.accessibleCameraCodes = async (user) => {
    if (user.role === 'admin') return null;
    const rows = await UserDevice.findAll({
        where: { userId: user.id },
        include: [{ model: Device, as: 'device', where: { type: 'CAMERA' }, attributes: ['deviceCode'] }],
    });
    return rows.map((row) => row.device.deviceCode);
};
