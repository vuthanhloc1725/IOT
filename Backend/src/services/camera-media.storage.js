/**
 * Lưu/đọc/xoá ảnh camera trên disk.
 * Giống analysis-image.storage.js nhưng thêm video/mp4 và dùng thư mục riêng.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const ApiError = require('../utils/apiError');
const env = require('../config/env');

const STORAGE_DIR = path.isAbsolute(env.camera.imageStorageDir)
    ? env.camera.imageStorageDir
    : path.resolve(process.cwd(), env.camera.imageStorageDir);

const EXTENSIONS = Object.freeze({
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
});
const MIME_TYPES = Object.freeze({
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
});

exports.save = async (buffer, mimeType) => {
    const extension = EXTENSIONS[mimeType];
    if (!Buffer.isBuffer(buffer) || !buffer.length || !extension) {
        throw ApiError.badRequest('Media không hợp lệ hoặc định dạng không hỗ trợ');
    }
    await fs.mkdir(STORAGE_DIR, { recursive: true, mode: 0o700 });
    const filename = `${crypto.randomUUID()}${extension}`;
    await fs.writeFile(path.join(STORAGE_DIR, filename), buffer, { flag: 'wx', mode: 0o600 });
    return filename;
};

exports.read = async (filename) => {
    if (typeof filename !== 'string' || path.basename(filename) !== filename) {
        throw ApiError.notFound('Không tìm thấy media');
    }
    const ext = path.extname(filename).toLowerCase();
    const mimeType = MIME_TYPES[ext];
    if (!mimeType) throw ApiError.notFound('Không tìm thấy media');
    try {
        const buffer = await fs.readFile(path.join(STORAGE_DIR, filename));
        return { buffer, mimeType };
    } catch (error) {
        if (error.code === 'ENOENT') throw ApiError.notFound('File media không còn trên máy chủ');
        throw error;
    }
};

exports.remove = async (filename) => {
    if (typeof filename !== 'string' || path.basename(filename) !== filename) return;
    try {
        await fs.unlink(path.join(STORAGE_DIR, filename));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
};

exports.directory = STORAGE_DIR;
