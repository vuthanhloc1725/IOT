const multer = require('multer');
const ApiError = require('../utils/apiError');
const env = require('../config/env');

// video/mp4 chỉ được chấp nhận ở chế độ lưu đĩa; controller trả 415 nếu đang ở chế độ AI.
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: env.camera.imageMaxBytes, files: 1, fields: 1, fieldSize: 16 * 1024, parts: 2 },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED.has(file.mimetype)) {
            return cb(ApiError.coded(415, 'UNSUPPORTED_MEDIA', 'Chỉ chấp nhận JPEG, PNG, WebP hoặc MP4'));
        }
        cb(null, true);
    },
}).single('file');

// Mã lỗi khớp phone agent: 413/415/400 = từ chối vĩnh viễn, không retry.
module.exports = (req, res, next) => upload(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return next(ApiError.coded(413, 'MEDIA_TOO_LARGE', `File vượt giới hạn ${env.camera.imageMaxBytes} bytes`));
        }
        return next(ApiError.badRequest(`Multipart không hợp lệ: ${error.message}`));
    }
    next(error);
});
