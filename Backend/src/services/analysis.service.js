const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { Disease, LeafAnalysis, Treatment, Alert } = require('../models');
const ApiError = require('../utils/apiError');
const env = require('../config/env');
const alertService = require('./alert.service');
const socket = require('./socket.service');
const audit = require('./audit.service');

exports.fullInclude = [
  { association: 'device', attributes: ['id', 'deviceCode', 'name', 'location'] },
  { association: 'disease', include: [{ model: Treatment, as: 'treatments' }] },
];

async function findDisease(labels, names) {
  const conditions = [];
  if (labels.length) conditions.push({ modelLabel: { [Op.in]: labels } });
  if (names.length) {
    conditions.push({ nameVi: { [Op.in]: names } });
    conditions.push({ nameEn: { [Op.in]: names } });
  }
  const matches = await Disease.findAll({ where: { [Op.or]: conditions } });
  const unique = [...new Map(matches.map((disease) => [Number(disease.id), disease])).values()];
  if (!unique.length) {
    const label = [...labels, ...names].join(' / ');
    throw ApiError.unprocessable(`Tên/nhãn bệnh "${label}" chưa có trong danh mục diseases`);
  }
  if (unique.length > 1) {
    throw ApiError.unprocessable('Kết quả AI chứa tên/nhãn khớp với nhiều bệnh trong database; hãy gửi modelLabel chính xác');
  }
  return unique[0];
}

function parseCapturedAt(body) {
  const timeValue = body.capturedAt ?? body.timestamp ?? body.ts;
  const capturedAt = timeValue === undefined || timeValue === null || timeValue === ''
    ? new Date()
    : new Date(timeValue);
  if (Number.isNaN(capturedAt.getTime())) throw ApiError.badRequest('capturedAt/timestamp không hợp lệ');
  if (capturedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw ApiError.badRequest('Thời gian nhận diện không được ở quá 5 phút trong tương lai');
  }
  return capturedAt;
}

function makeEventId(value, capturedAt, disease) {
  if (value.eventId) return value.eventId;
  const imageDigest = crypto.createHash('sha256').update(value.imageBuffer).digest('hex');
  const fingerprint = JSON.stringify({
    capturedAt: capturedAt.toISOString(),
    diseaseId: disease.id,
    confidence: value.confidence,
    modelVersion: value.modelVersion,
    inferenceMs: value.inferenceMs,
    boundingBoxes: value.boundingBoxes,
    imageDigest,
  });
  // Dùng hash làm idempotency key nếu bên gửi không cấp eventId ổn định.
  return crypto.createHash('sha256').update(fingerprint).digest('hex');
}

async function loadDuplicate(eventId) {
  const existing = await LeafAnalysis.findOne({ where: { eventId } });
  if (!existing) return null;
  const analysis = await LeafAnalysis.findByPk(existing.id, { include: exports.fullInclude });
  const alert = await Alert.findOne({ where: { analysisId: existing.id, type: 'disease' } });
  return { analysis, alert, duplicate: true };
}

// Luồng Camera HTTP: nhận ảnh từ Camera -> gọi AI -> upload Cloudinary -> lưu URL + kết quả AI trong leafAnalyses.
exports.processCameraImage = async ({ camera, eventId, capturedAt: capturedAtInput, image }) => {
  if (!camera || camera.type !== 'CAMERA') throw ApiError.forbidden('Thiết bị gửi dữ liệu không phải CAMERA');
  if (!env.ai.apiUrl || !env.ai.apiKey) throw new ApiError(503, 'Chưa cấu hình AI_API_URL và AI_API_KEY');

  const { detectImageMimeType } = require('./analysis-result-payload');
  const actualMime = detectImageMimeType(image.buffer);
  if (!actualMime || !['image/jpeg', 'image/png', 'image/webp'].includes(actualMime)) {
    throw ApiError.badRequest('Nội dung file không phải ảnh JPEG, PNG hoặc WebP hợp lệ');
  }
  if (image.buffer.length > 10 * 1024 * 1024) throw ApiError.badRequest('Ảnh vượt giới hạn 10 MB');

  const existing = await LeafAnalysis.findOne({ where: { eventId } });
  if (existing) {
    if (Number(existing.deviceId) !== Number(camera.id)) {
      throw ApiError.conflict('eventId đã được sử dụng bởi Camera khác');
    }
    const analysis = await LeafAnalysis.findByPk(existing.id, { include: exports.fullInclude });
    const alert = await Alert.findOne({ where: { analysisId: existing.id, type: 'disease' } });
    return { analysis, alert, duplicate: true, aiResult: null };
  }

  const capturedAt = capturedAtInput ? new Date(capturedAtInput) : new Date();
  if (Number.isNaN(capturedAt.getTime()) || capturedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw ApiError.badRequest('metadata.capturedAt không hợp lệ');
  }

  const form = new FormData();
  form.append('file', new Blob([image.buffer], { type: actualMime }), image.originalName || 'camera-image');
  let response;
  try {
    response = await fetch(`${env.ai.apiUrl.replace(/\/+$/, '')}/predict`, {
      method: 'POST',
      headers: { 'X-API-Key': env.ai.apiKey },
      body: form,
      signal: AbortSignal.timeout(env.ai.requestTimeoutMs),
    });
  } catch (error) {
    throw new ApiError(502, `Không kết nối được AI: ${String(error.message || error).slice(0, 180)}`);
  }
  let aiResult;
  try { aiResult = await response.json(); }
  catch { throw new ApiError(502, 'AI trả về response không phải JSON hợp lệ'); }
  if (!response.ok || aiResult.success !== true) {
    throw new ApiError(502, `AI từ chối phân tích ảnh (HTTP ${response.status})`);
  }

  const label = aiResult.label;
  const labelVi = aiResult.label_vi;
  const confidence = aiResult.confidence;
  const predictions = aiResult.predictions;
  if (typeof label !== 'string' || !label.trim() || typeof labelVi !== 'string' || !labelVi.trim()
      || typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1
      || typeof aiResult.is_healthy !== 'boolean' || !Array.isArray(predictions)) {
    throw new ApiError(502, 'Response AI không đúng schema: cần label, label_vi, confidence, is_healthy, predictions');
  }
  for (const item of predictions) {
    if (!item || typeof item.label !== 'string' || typeof item.label_vi !== 'string'
        || typeof item.confidence !== 'number' || !Number.isFinite(item.confidence)
        || item.confidence < 0 || item.confidence > 1) {
      throw new ApiError(502, 'Một phần tử predictions từ AI không hợp lệ');
    }
  }

  const disease = await Disease.findOne({ where: { modelLabel: label.trim() } })
    || await Disease.findOne({ where: { nameVi: labelVi.trim() } });
  if (!disease) throw ApiError.unprocessable(`Nhãn AI "${label}" (${labelVi}) chưa có trong danh mục diseases`);
  if (Boolean(disease.isHealthy) !== aiResult.is_healthy) {
    throw ApiError.unprocessable('is_healthy của AI không khớp danh mục diseases');
  }

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
      diseaseId: disease.id,
      confidence,
      predictions,
      aiResult: {
        label: label.trim(),
        label_vi: labelVi.trim(),
        confidence,
        is_healthy: aiResult.is_healthy,
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
        const duplicateAlert = await Alert.findOne({ where: { analysisId: raced.id, type: 'disease' } });
        return { analysis: duplicateAnalysis, alert: duplicateAlert, duplicate: true, aiResult: null };
      }
    }
    throw error;
  }

  let alert = null;
  if (!disease.isHealthy && confidence >= env.ai.minConfidence) {
    alert = await alertService.create({
      type: 'disease',
      severity: confidence >= 0.85 ? 'CRITICAL' : 'WARNING',
      title: `Phát hiện bệnh ${disease.nameVi}`,
      message: `Camera ${camera.deviceCode}: ${disease.nameVi} (độ tin cậy ${Math.round(confidence * 100)}%)`,
      deviceId: camera.id,
      analysisId: analysis.id,
    });
  }

  const full = await LeafAnalysis.findByPk(analysis.id, { include: exports.fullInclude });
  socket.emitAuthenticated('analysis:new', full);
  await audit.log(null, {
    action: 'analysis.camera_received',
    entityType: 'leafAnalysis',
    entityId: analysis.id,
    detail: {
      cameraId: camera.deviceCode, eventId, imageSha256,
      cloudinaryPublicId: uploaded.publicId, diseaseId: disease.id,
      confidence, inferenceMs: aiResult.inference_ms,
    },
  });
  return { analysis: full, alert, aiResult, duplicate: false };
};
