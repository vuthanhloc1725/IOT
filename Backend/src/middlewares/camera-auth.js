const crypto = require('node:crypto');
const { CameraToken, Device } = require('../models');
const ApiError = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');

module.exports = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token.length < 32) throw ApiError.unauthorized('Camera token không hợp lệ');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const record = await CameraToken.findOne({ where: { tokenHash } });
  if (!record || record.revokedAt || (record.expiresAt && record.expiresAt <= new Date())) {
    throw ApiError.unauthorized('Camera token không hợp lệ, đã hết hạn hoặc bị thu hồi');
  }
  const device = await Device.findByPk(record.deviceId);
  if (!device || device.type !== 'CAMERA' || device.lifecycle === 'DECOMMISSIONED') {
    throw ApiError.forbidden('Camera không tồn tại hoặc đã ngừng hoạt động');
  }
  record.lastUsedAt = new Date();
  await record.save();
  req.camera = device;
  next();
});
