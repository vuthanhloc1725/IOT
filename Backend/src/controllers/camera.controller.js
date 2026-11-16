/**
 * Camera controller: upload media (phone gọi), xem/quản lý (admin gọi).
 *
 * Upload endpoint nhận multipart/form-data với 2 phần:
 *   - "metadata" (application/json): JSON mô tả media
 *   - "file" (image/jpeg | image/png | video/mp4…): nội dung media
 *
 * Không dùng multer; parse multipart bằng built-in stream để giữ zero-dependency.
 */
const cameraService = require('../services/camera.service');
const ApiError = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const env = require('../config/env');

// ---- Multipart parser (nhẹ, chỉ cho 2 phần nhỏ) ----

function parseMultipart(req) {
    return new Promise((resolve, reject) => {
        const contentType = req.headers['content-type'] || '';
        const match = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
        if (!match) return reject(ApiError.badRequest('Content-Type phải là multipart/form-data'));
        const boundary = match[1] || match[2];
        const delimiter = Buffer.from(`--${boundary}`);
        const maxBytes = env.camera.imageMaxBytes + 256 * 1024; // metadata headroom

        const chunks = [];
        let received = 0;
        req.on('data', (chunk) => {
            received += chunk.length;
            if (received > maxBytes) {
                req.destroy();
                return reject(ApiError.coded(413, 'MEDIA_TOO_LARGE', `Payload vượt ${maxBytes} bytes`));
            }
            chunks.push(chunk);
        });
        req.on('error', reject);
        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks);
                const parts = splitMultipart(body, delimiter);
                resolve(parts);
            } catch (e) {
                reject(e);
            }
        });
    });
}

function splitMultipart(body, delimiter) {
    const parts = {};
    let start = body.indexOf(delimiter);
    if (start === -1) throw ApiError.badRequest('Multipart body rỗng');
    start += delimiter.length;
    while (true) {
        // skip \r\n after delimiter
        if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
        if (body[start] === 0x2d && body[start + 1] === 0x2d) break; // -- after last boundary
        const next = body.indexOf(delimiter, start);
        if (next === -1) break;
        const partData = body.subarray(start, next);
        // Tách header và body: ngăn bởi \r\n\r\n
        const sep = partData.indexOf('\r\n\r\n');
        if (sep === -1) { start = next + delimiter.length; continue; }
        const headerStr = partData.subarray(0, sep).toString('utf-8');
        const partBody = partData.subarray(sep + 4);
        // Bỏ trailing \r\n (trước boundary)
        const cleaned = (partBody.length >= 2 && partBody[partBody.length - 2] === 0x0d && partBody[partBody.length - 1] === 0x0a)
            ? partBody.subarray(0, partBody.length - 2) : partBody;
        // Parse name
        const nameMatch = headerStr.match(/name="([^"]+)"/);
        if (!nameMatch) { start = next + delimiter.length; continue; }
        const name = nameMatch[1];
        const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n;]+)/i);
        parts[name] = { data: cleaned, contentType: ctMatch ? ctMatch[1].trim() : null };
        start = next + delimiter.length;
    }
    return parts;
}

// ---- Upload: phone gọi POST /api/camera/media ----

exports.upload = asyncHandler(async (req, res) => {
    const parts = await parseMultipart(req);

    if (!parts.metadata) throw ApiError.badRequest('Thiếu phần "metadata" trong multipart');
    if (!parts.file) throw ApiError.badRequest('Thiếu phần "file" trong multipart');

    let metadata;
    try {
        metadata = JSON.parse(parts.metadata.data.toString('utf-8'));
    } catch {
        throw ApiError.badRequest('metadata không phải JSON hợp lệ');
    }

    const result = await cameraService.receiveMedia(
        metadata,
        parts.file.data,
        parts.file.contentType,
        req.camera.cameraId,
    );

    const status = result.status === 'stored' ? 201 : 200;
    res.status(status).json(result);
});

// ---- Xem ảnh: GET /api/camera/media/:eventId/file ----

exports.getFile = asyncHandler(async (req, res) => {
    const { buffer, mimeType } = await cameraService.getMediaFile(req.params.eventId);
    res.set({
        'Content-Type': mimeType,
        'Content-Length': String(buffer.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.send(buffer);
});

// ---- Danh sách media: GET /api/camera/media ----

exports.list = asyncHandler(async (req, res) => {
    const { cameraId, limit, offset } = req.query;
    const { count, rows } = await cameraService.listMedia({
        cameraId,
        limit: Number(limit) || 50,
        offset: Number(offset) || 0,
    });
    res.json({
        data: rows.map((r) => ({
            ...r.toJSON(),
            fileUrl: `/api/camera/media/${r.eventId}/file`,
        })),
        meta: { total: count, limit: Number(limit) || 50, offset: Number(offset) || 0 },
    });
});

// ---- Xoá media: DELETE /api/camera/media/:eventId ----

exports.deleteMedia = asyncHandler(async (req, res) => {
    await cameraService.deleteMedia(req.params.eventId);
    res.json({ message: 'Đã xoá' });
});

// ---- Admin: tạo camera token ----

exports.createToken = asyncHandler(async (req, res) => {
    const { cameraId, label } = req.body;
    const result = await cameraService.createToken(cameraId, label);
    res.status(201).json({
        data: result,
        meta: { warning: 'Token chỉ hiện 1 lần. Lưu lại ngay để cấu hình điện thoại.' },
    });
});

exports.reissueToken = asyncHandler(async (req, res) => {
    const result = await cameraService.reissueToken(req.params.cameraId);
    res.json({
        data: result,
        meta: { warning: 'Token mới. Cập nhật config.json trên điện thoại.' },
    });
});

exports.deactivateToken = asyncHandler(async (req, res) => {
    await cameraService.deactivateToken(req.params.cameraId);
    res.json({ message: `Camera ${req.params.cameraId} đã bị vô hiệu hoá` });
});

exports.listTokens = asyncHandler(async (_req, res) => {
    const tokens = await cameraService.listTokens();
    res.json({ data: tokens });
});
