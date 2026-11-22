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
const os = require('node:os');
const { Op, fn, col } = require('sequelize');
const { CameraToken, Device, LeafAnalysis, CameraMedia } = require('../models');
const ApiError = require('../utils/apiError');
const env = require('../config/env');
const audit = require('../services/audit.service');
const analysisService = require('../services/analysis.service');
const cameraService = require('../services/camera.service');
const { createWithSequentialCode } = require('../services/code-generator');
const cameraLifecycle = require('../services/camera-lifecycle.service');
const cameraCommands = require('../services/camera-command.service');
const socket = require('../services/socket.service');

const AI_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Địa chỉ server mà điện thoại truy cập được. Admin có thể gửi serverUrl (ví dụ http://192.168.1.10:3000)
// vì khi mở web qua localhost/proxy, host của request không dùng được trên điện thoại.
function resolveServerUrl(req) {
    const raw = req.body?.serverUrl ? String(req.body.serverUrl).trim() : `${req.protocol}://${req.get('host')}`;
    let parsed;
    try { parsed = new URL(raw); } catch { throw ApiError.badRequest('serverUrl không hợp lệ'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw ApiError.badRequest('serverUrl phải là http(s)://host[:port]');
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '').replace(/\/api$/, '')}`;
}

const aiPipelineEnabled = () => Boolean(
    env.ai.apiUrl && env.ai.apiKey
    && env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret,
);

// ---- Admin: đăng ký Camera (Device type CAMERA, mã CAM-001, CAM-002…) ----

// Bỏ card ảo (docker, bridge VM…) vì điện thoại không tới được; giữ Wi-Fi/Ethernet/Tailscale.
const VIRTUAL_IFACE = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|podman)/i;

// Gợi ý địa chỉ server cho form Cấp token: IPv4 thật của máy chạy Backend + cổng Backend.
// Trình duyệt không tự biết IP LAN, còn host của request thường là localhost:5173 (Vite).
exports.serverHints = async (_req, res) => {
    const urls = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        if (VIRTUAL_IFACE.test(name)) continue;
        for (const a of addrs || []) {
            if (a.family === 'IPv4' && !a.internal) urls.push({ url: `http://${a.address}:${env.port}`, iface: name });
        }
    }
    res.json({ data: { port: env.port, urls } });
};

exports.register = async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 100) throw ApiError.badRequest('name Camera là bắt buộc, tối đa 100 ký tự');
    const location = req.body?.location ? String(req.body.location).trim().slice(0, 150) : null;
    const interval = req.body?.captureIntervalSeconds === undefined ? 60 : Number(req.body.captureIntervalSeconds);
    if (!Number.isInteger(interval) || interval < 5 || interval > 86400) {
        throw ApiError.badRequest('captureIntervalSeconds phải từ 5 đến 86400 giây');
    }
    const heartbeat = req.body?.heartbeatIntervalSeconds === undefined ? 60 : Number(req.body.heartbeatIntervalSeconds);
    if (!Number.isInteger(heartbeat) || heartbeat < 10 || heartbeat > 3600) {
        throw ApiError.badRequest('heartbeatIntervalSeconds phải từ 10 đến 3600 giây');
    }
    const created = await createWithSequentialCode({
        prefix: 'CAM', Model: Device, field: 'deviceCode',
        values: {
            name, type: 'CAMERA', location, nodeId: null, gpioPin: null,
            lifecycle: 'REGISTERED', isOn: false, config: { captureIntervalSeconds: interval, heartbeatIntervalSeconds: heartbeat },
            configVersion: 0, configAppliedVersion: 0,
        },
    });
    await audit.log(req, {
        action: 'camera.created', entityType: 'device', entityId: created.record.id,
        detail: { cameraId: created.record.deviceCode, location },
    });
    res.status(201).json({ data: cameraLifecycle.toView(created.record, null), meta: { cameraIdGenerated: true } });
};

// ---- Danh sách Camera + online/offline. Admin thấy tất cả, người dùng chỉ thấy Camera được gán ----

const TOKEN_ATTRS = ['expiresAt', 'revokedAt', 'createdAt', 'lastUsedAt'];

async function cameraLastMedia(cameras) {
    const ids = cameras.map((c) => c.id);
    const codes = cameras.map((c) => c.deviceCode);
    if (!ids.length) return new Map();
    const [analyses, media] = await Promise.all([
        LeafAnalysis.findAll({
            where: { deviceId: { [Op.in]: ids } },
            attributes: ['deviceId', [fn('MAX', col('receivedAt')), 'lastAt'], [fn('COUNT', col('id')), 'total']],
            group: ['deviceId'], raw: true,
        }),
        CameraMedia.findAll({
            where: { cameraId: { [Op.in]: codes } },
            attributes: ['cameraId', [fn('MAX', col('receivedAt')), 'lastAt'], [fn('COUNT', col('eventId')), 'total']],
            group: ['cameraId'], raw: true,
        }),
    ]);
    const out = new Map(cameras.map((c) => [c.id, { lastMediaAt: null, mediaCount: 0, analysisCount: 0 }]));
    const byCode = new Map(cameras.map((c) => [c.deviceCode, c.id]));
    const bump = (id, lastAt, total, key) => {
        const row = out.get(id);
        if (!row) return;
        row[key] += Number(total) || 0;
        if (lastAt && (!row.lastMediaAt || new Date(lastAt) > new Date(row.lastMediaAt))) row.lastMediaAt = new Date(lastAt);
    };
    for (const a of analyses) bump(Number(a.deviceId), a.lastAt, a.total, 'analysisCount');
    for (const m of media) bump(byCode.get(m.cameraId), m.lastAt, m.total, 'mediaCount');
    return out;
}

exports.listCameras = async (req, res) => {
    const where = { type: 'CAMERA' };
    const codes = await cameraLifecycle.accessibleCameraCodes(req.user);
    if (codes !== null) where.deviceCode = { [Op.in]: codes };
    const cameras = await Device.findAll({
        where,
        include: [{ model: CameraToken, as: 'cameraToken', attributes: TOKEN_ATTRS }],
        order: [['deviceCode', 'ASC']],
    });
    const stats = await cameraLastMedia(cameras);
    res.json({
        data: cameras.map((c) => cameraLifecycle.toView(c, c.cameraToken, stats.get(c.id))),
        meta: { storage: aiPipelineEnabled() ? 'ai-cloudinary' : 'local-disk' },
    });
};

// ---- Admin: cấp / cấp lại token (token cũ mất hiệu lực ngay) ----

exports.issueToken = async (req, res) => {
    const cameraCode = String(req.params.cameraId || '').trim();
    if (!cameraCode || cameraCode.length > 50) throw ApiError.badRequest('cameraId không hợp lệ');
    const camera = await Device.findOne({ where: { deviceCode: cameraCode, type: 'CAMERA' } });
    if (!camera) throw ApiError.notFound('Không tìm thấy Camera theo deviceCode');
    if (camera.lifecycle === 'DECOMMISSIONED') throw ApiError.conflict('Camera đã ngừng hoạt động (DECOMMISSIONED), không thể cấp token');
    const serverUrl = resolveServerUrl(req);
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
    await cameraLifecycle.onTokenIssued(camera);
    const heartbeatIntervalSeconds = cameraLifecycle.heartbeatIntervalSec(camera);
    const uploadUrl = `${serverUrl}/api/camera/media`;
    const heartbeatUrl = `${serverUrl}/api/camera/heartbeat`;
    // Token thô chỉ xuất hiện trong response lần cấp này.
    res.status(201).json({
        data: {
            cameraId: camera.deviceCode,
            token,
            expiresAt,
            lifecycle: camera.lifecycle,
            uploadUrl,
            heartbeatUrl,
            heartbeatIntervalSeconds,
            // Đoạn cấu hình dán thẳng vào phone-camera/config.json (hoặc quét QR).
            agentConfig: {
                camera_id: camera.deviceCode,
                heartbeat_interval_seconds: heartbeatIntervalSeconds,
                upload: { url: uploadUrl, heartbeat_url: heartbeatUrl, token, allow_insecure_http: serverUrl.startsWith('http://') },
                capture: { interval_seconds: Number(camera.config?.captureIntervalSeconds) || 900 },
            },
        },
        warning: 'Hãy lưu token ngay. Server không thể hiển thị lại token này.',
    });
};

exports.revokeToken = async (req, res) => {
    const camera = await Device.findOne({ where: { deviceCode: req.params.cameraId, type: 'CAMERA' } });
    if (!camera) throw ApiError.notFound('Không tìm thấy Camera');
    await CameraToken.update({ revokedAt: new Date() }, { where: { deviceId: camera.id } });
    await cameraLifecycle.onTokenRevoked(camera);
    await audit.log(req, { action: 'camera.token_revoked', entityType: 'device', entityId: camera.id });
    res.json({ message: 'Đã thu hồi token Camera', data: { cameraId: camera.deviceCode, lifecycle: camera.lifecycle } });
};

// ---- Camera/Agent: heartbeat (Bearer camera token) ----
// camera-auth đã cập nhật lastUsedAt + tự ACTIVE ở lần đầu. Trả cấu hình để agent tự đồng bộ.
exports.heartbeat = async (req, res) => {
    const camera = req.camera;
    cameraCommands.noteAgentVersion(camera.deviceCode, req.body?.agentVersion);
    res.json({
        status: 'ok',
        cameraId: camera.deviceCode,
        lifecycle: camera.lifecycle,
        acceptingUploads: ['PROVISIONED', 'ACTIVE'].includes(camera.lifecycle),
        heartbeatIntervalSeconds: cameraLifecycle.heartbeatIntervalSec(camera),
        captureIntervalSeconds: captureIntervalOf(camera),
        configVersion: Number(camera.configVersion || 0),
        // Fallback cho agent không long-poll: lệnh "chụp ngay" đang chờ được giao kèm heartbeat.
        // Agent cũ (< 0.4.0) bỏ qua trường này → không giao, để lệnh không kẹt ở DELIVERED.
        commands: cameraCommands.supportsCommands(camera.deviceCode) === false
            ? [] : await cameraCommands.waitForCommands(camera.deviceCode, 0),
        serverTime: new Date().toISOString(),
    });
};

// 0 = tắt chụp định kỳ (chỉ chụp theo yêu cầu); null = chưa cấu hình (agent giữ giá trị trong config.json).
function captureIntervalOf(camera) {
    const raw = camera.config?.captureIntervalSeconds;
    if (raw === undefined || raw === null || raw === '') return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : null;
}

function parseIntervalField(body, key, { min, max, allowZero }) {
    if (body?.[key] === undefined) return undefined;
    const value = Number(body[key]);
    if (!Number.isInteger(value) || (!(allowZero && value === 0) && (value < min || value > max))) {
        throw ApiError.badRequest(`${key} phải là ${allowZero ? '0 (tắt) hoặc ' : ''}số nguyên từ ${min} đến ${max} giây`);
    }
    return value;
}

async function findCameraFor(req, { adminOnly = false } = {}) {
    const code = String(req.params.cameraId || '').trim();
    if (!code || code.length > 50) throw ApiError.badRequest('cameraId không hợp lệ');
    if (adminOnly && req.user.role !== 'admin') throw ApiError.forbidden();
    const allowed = await cameraLifecycle.accessibleCameraCodes(req.user);
    if (allowed !== null && !allowed.includes(code)) throw ApiError.notFound('Không tìm thấy Camera');
    const camera = await Device.findOne({ where: { deviceCode: code, type: 'CAMERA' } });
    if (!camera) throw ApiError.notFound('Không tìm thấy Camera');
    return camera;
}

// ---- Admin: đổi chu kỳ chụp / heartbeat. Agent nhận ở lần heartbeat kế tiếp (≤ heartbeatIntervalSeconds) ----
exports.updateConfig = async (req, res) => {
    const camera = await findCameraFor(req, { adminOnly: true });
    const capture = parseIntervalField(req.body, 'captureIntervalSeconds', { min: 5, max: 86400, allowZero: true });
    const heartbeat = parseIntervalField(req.body, 'heartbeatIntervalSeconds', { min: 10, max: 3600, allowZero: false });
    if (capture === undefined && heartbeat === undefined) {
        throw ApiError.badRequest('Cần captureIntervalSeconds và/hoặc heartbeatIntervalSeconds');
    }
    const before = { ...(camera.config || {}) };
    const next = { ...before };
    if (capture !== undefined) next.captureIntervalSeconds = capture;
    if (heartbeat !== undefined) next.heartbeatIntervalSeconds = heartbeat;
    camera.config = next; // gán object mới để Sequelize nhận thay đổi cột JSON
    camera.configVersion = Number(camera.configVersion || 0) + 1;
    await camera.save();
    await audit.log(req, {
        action: 'camera.config_updated', entityType: 'device', entityId: camera.id,
        detail: { cameraId: camera.deviceCode, before, after: next },
    });
    const view = cameraLifecycle.toView(camera, null);
    try { socket.emitDevice(camera.id, 'device:update', view); } catch { /* socket chưa khởi tạo (test/CLI) */ }
    res.json({
        message: 'Đã lưu. Camera áp dụng ở lần heartbeat kế tiếp.',
        data: {
            cameraId: camera.deviceCode,
            captureIntervalSeconds: captureIntervalOf(camera),
            heartbeatIntervalSeconds: cameraLifecycle.heartbeatIntervalSec(camera),
            configVersion: camera.configVersion,
        },
    });
};

// ---- Người dùng được gán / Admin: chụp ngay ----
exports.captureNow = async (req, res) => {
    const camera = await findCameraFor(req);
    if (!['PROVISIONED', 'ACTIVE'].includes(camera.lifecycle)) {
        throw ApiError.conflict(`Camera đang ${camera.lifecycle}, chưa nhận lệnh chụp (cần cấp token và chạy agent)`);
    }
    if (cameraCommands.supportsCommands(camera.deviceCode) === false) {
        throw ApiError.coded(409, 'AGENT_OUTDATED',
            `Agent trên điện thoại là bản ${cameraCommands.agentVersion(camera.deviceCode)}, chưa hỗ trợ "Chụp ngay". `
            + `Hãy chép camera_agent.py mới (>= ${cameraCommands._constants.MIN_AGENT_VERSION}) lên điện thoại rồi khởi động lại agent.`);
    }
    const side = req.body?.camera === undefined ? 'back' : String(req.body.camera);
    if (!['back', 'front'].includes(side)) throw ApiError.badRequest('camera phải là "back" hoặc "front"');
    let cmd;
    try {
        cmd = cameraCommands.enqueue({ cameraCode: camera.deviceCode, action: 'capture', camera: side, requestedBy: req.user.id });
    } catch (err) {
        if (err.code === 'TOO_MANY_PENDING') throw ApiError.coded(429, 'TOO_MANY_PENDING', err.message);
        throw err;
    }
    await audit.log(req, {
        action: 'camera.capture_requested', entityType: 'device', entityId: camera.id,
        detail: { cameraId: camera.deviceCode, requestId: cmd.requestId },
    });
    res.status(202).json({ message: 'Đã gửi lệnh chụp, chờ Camera thực hiện', data: cmd });
};

exports.commandStatus = async (req, res) => {
    const camera = await findCameraFor(req);
    const cmd = cameraCommands.get(camera.deviceCode, String(req.params.requestId || ''));
    if (!cmd) throw ApiError.notFound('Không tìm thấy lệnh (đã hết hạn hoặc server vừa khởi động lại)');
    res.set('Cache-Control', 'no-store'); // web hỏi liên tục, không để trình duyệt trả 304 từ cache
    res.json({ data: cmd });
};

// ---- Camera/Agent: long-poll nhận lệnh + báo kết quả (Bearer camera token) ----
const MAX_POLL_WAIT_SEC = 25;

exports.pollCommands = async (req, res) => {
    const requested = Number(req.body?.waitSeconds ?? MAX_POLL_WAIT_SEC);
    const waitSec = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), MAX_POLL_WAIT_SEC) : MAX_POLL_WAIT_SEC;
    cameraCommands.noteCommandCapable(req.camera.deviceCode);
    const controller = new AbortController();
    // res 'close' (không phải req 'close'): req đóng ngay khi đọc xong body JSON trên Node mới.
    res.on('close', () => controller.abort());
    const commands = await cameraCommands.waitForCommands(req.camera.deviceCode, waitSec * 1000, controller.signal);
    if (controller.signal.aborted || res.writableEnded) return;
    res.json({
        commands,
        captureIntervalSeconds: captureIntervalOf(req.camera),
        serverTime: new Date().toISOString(),
    });
};

exports.ackCommand = async (req, res) => {
    const requestId = String(req.params.requestId || '');
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw ApiError.badRequest('requestId không hợp lệ');
    if (typeof req.body?.success !== 'boolean') throw ApiError.badRequest('success phải là boolean');
    const cmd = cameraCommands.ack({
        cameraCode: req.camera.deviceCode, requestId,
        success: req.body.success, message: req.body.message, eventId: req.body.eventId,
    });
    if (!cmd) throw ApiError.notFound('Không tìm thấy lệnh');
    try { socket.emitDevice(req.camera.id, 'camera:command', cmd); } catch { /* socket chưa khởi tạo */ }
    res.json({ status: 'ok', data: cmd });
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
    const allowedCodes = await cameraLifecycle.accessibleCameraCodes(req.user);
    const { buffer, mimeType } = await cameraService.getMediaFile(req.params.eventId, allowedCodes);
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
    const allowedCodes = await cameraLifecycle.accessibleCameraCodes(req.user);
    const cameraId = req.query.cameraId ? String(req.query.cameraId).trim() : undefined;
    const { count, rows } = await cameraService.listMedia({ cameraId, limit, offset, allowedCodes });
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
