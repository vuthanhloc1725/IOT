const crypto = require('node:crypto');
const { LeafAnalysis } = require('../models');
const ApiError = require('../utils/apiError');
const socket = require('./socket.service');
const audit = require('./audit.service');
const aiPrediction = require('./ai-prediction.service');

exports.fullInclude = [
  { association: 'device', attributes: ['id', 'deviceCode', 'name', 'location'] },
];

// Luồng Camera HTTP: nhận ảnh từ Camera -> gọi AI -> upload Cloudinary -> lưu URL + kết quả AI trong leafAnalyses.
exports.processCameraImage = async ({ camera, eventId, capturedAt: capturedAtInput, image }) => {
  if (!camera || camera.type !== 'CAMERA') throw ApiError.forbidden('Thiết bị gửi dữ liệu không phải CAMERA');

  const existing = await LeafAnalysis.findOne({ where: { eventId } });
  if (existing) {
    if (Number(existing.deviceId) !== Number(camera.id)) {
      throw ApiError.conflict('eventId đã được sử dụng bởi Camera khác');
    }
    const analysis = await LeafAnalysis.findByPk(existing.id, { include: exports.fullInclude });
    return { analysis, duplicate: true, aiResult: null };
  }

  const capturedAt = capturedAtInput ? new Date(capturedAtInput) : new Date();
  if (Number.isNaN(capturedAt.getTime()) || capturedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw ApiError.badRequest('metadata.capturedAt không hợp lệ');
  }

  const { actualMime, result: aiResult } = await aiPrediction.predictImage(image);

  const label = aiResult.label;
  const labelVi = aiResult.label_vi;
  const confidence = aiResult.confidence;
  const predictions = aiResult.predictions;

  const diseaseName = labelVi.trim() || label.trim();

  const imageSha256 = crypto.createHash('sha256').update(image.buffer).digest('hex');
  const cloudinary = require('./cloudinary.service');
  const uploaded = await cloudinary.uploadImage({
    buffer: image.buffer, mimeType: actualMime, cameraId: camera.deviceCode, eventId,
  });

  let analysis;
  try {
    analysis = await LeafAnalysis.create({
      eventId,
      deviceId: camera.id,
      capturedAt,
      diseaseName,
      modelLabel: label.trim(),
      confidence,
      predictions,
      aiResult: {
        label: label.trim(),
        label_vi: labelVi.trim(),
        confidence,
        predictions,
        inference_ms: Number.isFinite(aiResult.inference_ms) ? Math.round(aiResult.inference_ms) : null,
        model_version: typeof aiResult.model_version === 'string' ? aiResult.model_version.slice(0, 50) : null,
      },
      boundingBoxes: null,
      imagePath: null,
      imageUrl: uploaded.url,
      cloudinaryPublicId: uploaded.publicId,
      imageSha256,
      modelVersion: 'external-ai-api',
      inferenceMs: Number.isFinite(aiResult.inference_ms) ? Math.round(aiResult.inference_ms) : null,
    });
  } catch (error) {
    await cloudinary.deleteImage(uploaded.publicId).catch((cleanupError) => {
      console.error('[cloudinary] cleanup failed:', cleanupError.message);
    });
    if (error.name === 'SequelizeUniqueConstraintError') {
      const raced = await LeafAnalysis.findOne({ where: { eventId } });
      if (raced && Number(raced.deviceId) === Number(camera.id)) {
        const duplicateAnalysis = await LeafAnalysis.findByPk(raced.id, { include: exports.fullInclude });
        return { analysis: duplicateAnalysis, duplicate: true, aiResult: null };
      }
    }
    throw error;
  }

  const full = await LeafAnalysis.findByPk(analysis.id, { include: exports.fullInclude });
  socket.emitAuthenticated('analysis:new', full);
  await audit.log(null, {
    action: 'analysis.camera_received',
    entityType: 'leafAnalysis',
    entityId: analysis.id,
    detail: {
      cameraId: camera.deviceCode, eventId, imageSha256,
      cloudinaryPublicId: uploaded.publicId, diseaseName,
      confidence, inferenceMs: aiResult.inference_ms,
    },
  });
  return { analysis: full, aiResult, duplicate: false };
};
