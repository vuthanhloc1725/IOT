/**
 * Camera service: tạo/thu hồi token, nhận media upload, phục vụ ảnh.
 */
const crypto = require('node:crypto');
const { CameraToken, CameraMedia } = require('../models');
const storage = require('./camera-media.storage');
const ApiError = require('../utils/apiError');
const env = require('../config/env');

// ---- Token quản trị (admin dùng) ----

/**
 * Tạo token mới cho 1 camera. Trả về token gốc (chỉ hiện 1 lần).
 */
exports.createToken = async (cameraId, label) => {
    cameraId = String(cameraId).trim();
    if (!cameraId || cameraId.length > 60) throw ApiError.badRequest('cameraId phải từ 1–60 ký tự');

    const existing = await CameraToken.unscoped().findOne({ where: { cameraId } });
    if (existing) throw ApiError.conflict(`Camera ${cameraId} đã tồn tại`);

    const raw = crypto.randomBytes(32);
    const token = raw.toString('base64url');           // 43 chars
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const record = await CameraToken.create({ cameraId, tokenHash, label: label || null });
    return { id: record.id, cameraId, token, label: record.label };
};

/**
 * Cấp lại token (huỷ token cũ, tạo mới).
 */
exports.reissueToken = async (cameraId) => {
    const record = await CameraToken.unscoped().findOne({ where: { cameraId } });
    if (!record) throw ApiError.notFound(`Camera ${cameraId} không tồn tại`);

    const raw = crypto.randomBytes(32);
    const token = raw.toString('base64url');
    record.tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    record.isActive = true;
    await record.save();
    return { id: record.id, cameraId, token, label: record.label };
};

/**
 * Vô hiệu hoá camera (token bị từ chối, media cũ giữ nguyên).
 */
exports.deactivateToken = async (cameraId) => {
    const record = await CameraToken.unscoped().findOne({ where: { cameraId } });
    if (!record) throw ApiError.notFound(`Camera ${cameraId} không tồn tại`);
    record.isActive = false;
    await record.save();
};

exports.listTokens = () => CameraToken.findAll({ order: [['createdAt', 'DESC']] });

// ---- Media upload (phone gọi) ----

const ACCEPTED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']);

/**
 * Nhận 1 file media từ camera phone.
 * @param {object} metadata  JSON metadata gửi kèm (schemaVersion, eventId, sha256…)
 * @param {Buffer} fileBuffer nội dung file
 * @param {string} fileMime   Content-Type của phần file
 * @param {string} authedCameraId  cameraId đã xác thực từ middleware
 * @returns {{status, eventId, sha256}}
 */
exports.receiveMedia = async (metadata, fileBuffer, fileMime, authedCameraId) => {
    // ---- Validate metadata ----
    if (!metadata || typeof metadata !== 'object') throw ApiError.badRequest('Thiếu metadata');
    const { eventId, cameraId, mediaType, mimeType, sha256, capturedAt, requestId } = metadata;
    if (!eventId || typeof eventId !== 'string' || eventId.length > 120) {
        throw ApiError.badRequest('eventId không hợp lệ');
    }
    if (cameraId !== authedCameraId) {
        throw ApiError.forbidden('cameraId trong metadata không khớp token');
    }

    // ---- Idempotency: đã nhận rồi? ----
    const existing = await CameraMedia.findOne({ where: { eventId } });
    if (existing) {
        if (existing.sha256.toLowerCase() !== sha256?.toLowerCase()) {
            throw ApiError.conflict(`eventId ${eventId} đã tồn tại với sha256 khác`);
        }
        return { status: 'duplicate', eventId, sha256: existing.sha256 };
    }

    // ---- Validate file ----
    if (!Buffer.isBuffer(fileBuffer) || !fileBuffer.length) {
        throw ApiError.badRequest('Thiếu file media');
    }
    const effectiveMime = fileMime || mimeType;
    if (!ACCEPTED_MIMES.has(effectiveMime)) {
        throw ApiError.unprocessable(`Định dạng không hỗ trợ: ${effectiveMime}`);
    }
    if (fileBuffer.length > env.camera.imageMaxBytes) {
        throw ApiError.coded(413, 'MEDIA_TOO_LARGE',
            `File ${fileBuffer.length} bytes vượt giới hạn ${env.camera.imageMaxBytes} bytes`);
    }

    // ---- Verify SHA-256 ----
    const computedHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    if (sha256 && sha256.toLowerCase() !== computedHash.toLowerCase()) {
        throw ApiError.badRequest(`SHA-256 không khớp: gửi ${sha256}, tính được ${computedHash}`);
    }

    // ---- Lưu file + DB ----
    const filename = await storage.save(fileBuffer, effectiveMime);
    try {
        await CameraMedia.create({
            eventId,
            cameraId: authedCameraId,
            requestId: requestId || null,
            mediaType: mediaType === 'video' ? 'video' : 'image',
            mimeType: effectiveMime,
            filename,
            sizeBytes: fileBuffer.length,
            sha256: computedHash,
            capturedAt: capturedAt ? new Date(capturedAt) : null,
        });
    } catch (err) {
        await storage.remove(filename).catch(() => {});
        // Duplicate key race (hai request cùng eventId đến gần nhau)
        if (err.name === 'SequelizeUniqueConstraintError') {
            return { status: 'duplicate', eventId, sha256: computedHash };
        }
        throw err;
    }

    return { status: 'stored', eventId, sha256: computedHash };
};

// ---- Xem media (admin/user gọi) ----

exports.getMediaFile = async (eventId) => {
    const record = await CameraMedia.findOne({ where: { eventId } });
    if (!record) throw ApiError.notFound(`Media ${eventId} không tồn tại`);
    return storage.read(record.filename);
};

exports.listMedia = async ({ cameraId, limit = 50, offset = 0 } = {}) => {
    const where = {};
    if (cameraId) where.cameraId = cameraId;
    return CameraMedia.findAndCountAll({
        where,
        order: [['capturedAt', 'DESC'], ['receivedAt', 'DESC']],
        limit: Math.min(limit, 200),
        offset,
    });
};

exports.deleteMedia = async (eventId) => {
    const record = await CameraMedia.findOne({ where: { eventId } });
    if (!record) throw ApiError.notFound(`Media ${eventId} không tồn tại`);
    await storage.remove(record.filename);
    await record.destroy();
};
