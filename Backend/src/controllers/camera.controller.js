/**
 * Camera controller.
 *
 * Camera là Device type CAMERA (deviceCode CAM-xxx), xác thực upload bằng Bearer token riêng (bảng cameraTokens).
 * POST /api/camera/media nhận multipart/form-data: field "metadata" (JSON) + field "file" (ảnh/video).
 *
 * Hai chế độ lưu:
 *   - AI + Cloudinary đã cấu hình  → gọi AI /predict, upload Cloudinary, lưu leafAnalyses (analysisService.processCameraImage).
 *   - Chưa cấu hình (fallback)      → lưu file trên đĩa (CAMERA_IMAGE_STORAGE_DIR) + bảng camera_media.
 * Response luôn có `status` = "stored" | "duplicate" và `sha256` để agent trên điện thoại xử lý idempotent.
 */
const crypto = require('node:crypto');
const { CameraToken, Device, LeafAnalysis, CameraMedia } = require('../models');
const ApiError = require('../utils/apiError');
const env = require('../config/env');
const audit = require('../services/audit.service');
const analysisService = require('../services/analysis.service');
const cameraService = require('../services/camera.service');
const { createWithSequentialCode } = require('../services/code-generator');

const AI_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const aiPipelineEnabled = () => Boolean(
    env.ai.apiUrl && env.ai.apiKey
    && env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret,
);

// ---- Admin: đăng ký Camera (Device type CAMERA, mã CAM-001, CAM-002…) ----

exports.register = async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 100) throw ApiError.badRequest('name Camera là bắt buộc, tối đa 100 ký tự');
    const location = req.body?.location ? String(req.body.location).trim().slice(0, 150) : null;
    const interval = req.body?.captureIntervalSeconds === undefined ? 60 : Number(req.body.captureIntervalSeconds);
    if (!Number.isInteger(interval) || interval < 5 || interval > 86400) {
        throw ApiError.badRequest('captureIntervalSeconds phải từ 5 đến 86400 giây');
    }
    const created = await createWithSequentialCode({
        prefix: 'CAM', Model: Device, field: 'deviceCode',
        values: {
            name, type: 'CAMERA', location, nodeId: null, gpioPin: null,
            lifecycle: 'REGISTERED', isOn: false, config: { captureIntervalSeconds: interval },
            configVersion: 0, configAppliedVersion: 0,
        },
    });
    await audit.log(req, {
        action: 'camera.created', entityType: 'device', entityId: created.record.id,
        detail: { cameraId: created.record.deviceCode, location },
    });
    res.status(201).json({ data: created.record, meta: { cameraIdGenerated: true } });
};

// ---- Admin: danh sách Camera + trạng thái token ----

exports.listCameras = async (_req, res) => {
    const cameras = await Device.findAll({
        where: { type: 'CAMERA' },
        include: [{ model: CameraToken, as: 'cameraToken', attributes: ['expiresAt', 'revokedAt', 'createdAt', 'lastUsedAt'] }],
        order: [['deviceCode', 'ASC']],
    });
    res.json({ data: cameras, meta: { storage: aiPipelineEnabled() ? 'ai-cloudinary' : 'local-disk' } });
};

// ---- Admin: cấp / cấp lại token (token cũ mất hiệu lực ngay) ----

exports.issueToken = async (req, res) => {
    const cameraCode = String(req.params.cameraId || '').trim();
    if (!cameraCode || cameraCode.length > 50) throw ApiError.badRequest('cameraId không hợp lệ');
    const camera = await Device.findOne({ where: { deviceCode: cameraCode, type: 'CAMERA' } });
    if (!camera) throw ApiError.notFound('Không tìm thấy Camera theo deviceCode');
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    let expiresAt = null;
    if (req.body?.expiresInDays !== undefined) {
        const days = Number(req.body.expiresInDays);
        if (!Number.isInteger(days) || days < 1 || days > 365) throw ApiError.badRequest('expiresInDays phải từ 1 đến 365');
        expiresAt = new Date(Date.now() + days * 86400000);
    }
    await CameraToken.upsert({
        deviceId: camera.id,
        tokenHash,
        expiresAt,
        revokedAt: null,
        createdAt: new Date(),
        lastUsedAt: null,
    });
    await audit.log(req, {
        action: 'camera.token_issued',
        entityType: 'device',
        entityId: camera.id,
        detail: { cameraId: camera.deviceCode, expiresAt },
    });
    // Token thô chỉ xuất hiện trong response lần cấp này.
    res.status(201).json({
        data: {
            cameraId: camera.deviceCode,
            token,
            expiresAt,
            uploadUrl: `${req.protocol}://${req.get('host')}/api/camera/media`,
        },
        warning: 'Hãy lưu token ngay. Server không thể hiển thị lại token này.',
    });
};

exports.revokeToken = async (req, res) => {
    const camera = await Device.findOne({ where: { deviceCode: req.params.cameraId, type: 'CAMERA' } });
    if (!camera) throw ApiError.notFound('Không tìm thấy Camera');
    await CameraToken.update({ revokedAt: new Date() }, { where: { deviceId: camera.id } });
    await audit.log(req, { action: 'camera.token_revoked', entityType: 'device', entityId: camera.id });
    res.json({ message: 'Đã thu hồi token Camera' });
};

// ---- Upload: phone/agent gọi POST /api/camera/media ----

exports.receiveMedia = async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Thiếu file trong multipart field "file"');
    let metadata;
    try {
        metadata = typeof req.body.metadata === 'string' ? JSON.parse(req.body.metadata) : req.body.metadata;
    } catch {
        throw ApiError.badRequest('metadata phải là JSON hợp lệ');
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw ApiError.badRequest('Cần multipart field metadata chứa JSON object');
    }
    const cameraCode = req.camera.deviceCode;
    if (String(metadata.cameraId || '').trim() !== cameraCode) {
        throw ApiError.forbidden('metadata.cameraId không khớp Camera được xác thực bằng token');
    }
    const eventId = String(metadata.eventId || '').trim();
    if (!eventId || eventId.length > 100 || /[\u0000-\u001f\u007f]/.test(eventId)) {
        throw ApiError.badRequest('metadata.eventId là bắt buộc, tối đa 100 ký tự');
    }
    const buffer = req.file.buffer;
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    if (metadata.sha256 && String(metadata.sha256).toLowerCase() !== sha256) {
        throw ApiError.badRequest(`SHA-256 không khớp: gửi ${metadata.sha256}, tính được ${sha256}`);
    }

    // eventId đã nằm ở kho còn lại (ví dụ vừa đổi chế độ lưu) → coi là duplicate, không lưu 2 nơi.
    const [inAnalyses, inMedia] = await Promise.all([
        LeafAnalysis.findOne({ where: { eventId }, attributes: ['id', 'deviceId', 'imageSha256'] }),
        CameraMedia.findOne({ where: { eventId } }),
    ]);
    const existing = inAnalyses || inMedia;
    if (existing) {
        const owner = inAnalyses ? Number(inAnalyses.deviceId) === Number(req.camera.id) : inMedia.cameraId === cameraCode;
        const storedSha = (inAnalyses ? inAnalyses.imageSha256 : inMedia.sha256) || null;
        if (!owner) throw ApiError.conflict('eventId đã được sử dụng bởi Camera khác');
        if (storedSha && storedSha.toLowerCase() !== sha256) {
            throw ApiError.conflict(`eventId ${eventId} đã tồn tại với sha256 khác`);
        }
        return res.status(200).json({ status: 'duplicate', eventId, sha256 });
    }

    if (!aiPipelineEnabled()) {
        const result = await cameraService.receiveMedia(
            { ...metadata, cameraId: cameraCode, eventId, sha256 },
            buffer,
            req.file.mimetype,
            cameraCode,
        );
        return res.status(result.status === 'stored' ? 201 : 200).json({ ...result, storage: 'local-disk' });
    }

    if (!AI_IMAGE_MIMES.has(req.file.mimetype)) {
        throw ApiError.coded(415, 'UNSUPPORTED_MEDIA', 'Chế độ AI chỉ nhận ảnh JPEG, PNG hoặc WebP');
    }
    const result = await analysisService.processCameraImage({
        camera: req.camera,
        eventId,
        capturedAt: metadata.capturedAt || metadata.timestamp,
        image: { buffer, mimeType: req.file.mimetype, originalName: req.file.originalname },
    });
    res.status(result.duplicate ? 200 : 201).json({
        status: result.duplicate ? 'duplicate' : 'stored',
        eventId,
        sha256,
        storage: 'ai-cloudinary',
        data: result.analysis,
        alert: result.alert,
        aiResult: result.aiResult,
        imageUrl: result.analysis?.imageUrl || null,
    });
};

// ---- Xem media lưu đĩa (fallback) ----

exports.getFile = async (req, res) => {
    const { buffer, mimeType } = await cameraService.getMediaFile(req.params.eventId);
    res.set({
        'Content-Type': mimeType,
        'Content-Length': String(buffer.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.send(buffer);
};

exports.list = async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { count, rows } = await cameraService.listMedia({ cameraId: req.query.cameraId, limit, offset });
    res.json({
        data: rows.map((r) => ({ ...r.toJSON(), fileUrl: `/api/camera/media/${encodeURIComponent(r.eventId)}/file` })),
        meta: { total: count, limit, offset },
    });
};

exports.deleteMedia = async (req, res) => {
    await cameraService.deleteMedia(req.params.eventId);
    await audit.log(req, { action: 'camera.media_deleted', entityType: 'cameraMedia', detail: { eventId: req.params.eventId } });
    res.json({ message: 'Đã xoá' });
};
