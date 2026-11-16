/**
 * Xác thực camera phone bằng Bearer token (SHA-256 hash so sánh timing-safe).
 * Gắn req.camera = { id, cameraId, label }.
 */
const crypto = require('node:crypto');
const { CameraToken } = require('../models');
const ApiError = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');

exports.authenticateCamera = asyncHandler(async (req, _res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) throw ApiError.unauthorized('Thiếu Authorization header');

    const hash = crypto.createHash('sha256').update(token).digest('hex');
    // Tìm tất cả token active rồi so sánh timing-safe để tránh timing attack.
    const rows = await CameraToken.unscoped().findAll({ where: { isActive: true }, attributes: ['id', 'cameraId', 'label', 'tokenHash'] });
    let matched = null;
    for (const row of rows) {
        try {
            if (crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(row.tokenHash, 'hex'))) {
                matched = row;
                break;
            }
        } catch { /* length mismatch = not a match */ }
    }
    if (!matched) throw ApiError.unauthorized('Camera token không hợp lệ');
    req.camera = { id: matched.id, cameraId: matched.cameraId, label: matched.label };
    next();
});
