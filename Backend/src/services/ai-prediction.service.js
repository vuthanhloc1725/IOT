const ApiError = require('../utils/apiError');
const env = require('../config/env');
const { detectImageMimeType } = require('./analysis-result-payload');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function validateResult(result) {
  if (!result || result.success !== true
      || typeof result.label !== 'string' || !result.label.trim()
      || typeof result.label_vi !== 'string' || !result.label_vi.trim()
      || typeof result.confidence !== 'number' || !Number.isFinite(result.confidence)
      || result.confidence < 0 || result.confidence > 1
      || typeof result.is_healthy !== 'boolean'
      || !Array.isArray(result.predictions)) {
    throw new ApiError(502, 'Response AI không đúng schema: cần label, label_vi, confidence, is_healthy, predictions');
  }

  for (const item of result.predictions) {
    if (!item || typeof item.label !== 'string' || typeof item.label_vi !== 'string'
        || typeof item.confidence !== 'number' || !Number.isFinite(item.confidence)
        || item.confidence < 0 || item.confidence > 1) {
      throw new ApiError(502, 'Một phần tử predictions từ AI không hợp lệ');
    }
  }
}

exports.predictImage = async (image, aiConfig = env.ai) => {
  if (!aiConfig.apiUrl || !aiConfig.apiKey) {
    throw new ApiError(503, 'Chưa cấu hình AI_API_URL và AI_API_KEY');
  }
  if (!image || !Buffer.isBuffer(image.buffer) || !image.buffer.length) {
    throw ApiError.badRequest('Thiếu ảnh cần phân tích');
  }

  const actualMime = detectImageMimeType(image.buffer);
  if (!actualMime || !ALLOWED_IMAGE_TYPES.has(actualMime)) {
    throw ApiError.badRequest('Nội dung file không phải ảnh JPEG, PNG hoặc WebP hợp lệ');
  }
  if (image.buffer.length > MAX_IMAGE_BYTES) {
    throw ApiError.badRequest('Ảnh vượt giới hạn 10 MB');
  }

  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[actualMime];
  const form = new FormData();
  form.append('file', new Blob([image.buffer], { type: actualMime }), `upload.${extension}`);
  const configuredUrl = aiConfig.apiUrl.replace(/\/+$/, '');
  const predictUrl = /\/predict$/i.test(configuredUrl) ? configuredUrl : `${configuredUrl}/predict`;

  let response;
  try {
    response = await fetch(predictUrl, {
      method: 'POST',
      headers: {
        'X-API-Key': aiConfig.apiKey,
        Accept: 'application/json',
        'ngrok-skip-browser-warning': 'true',
      },
      body: form,
      signal: AbortSignal.timeout(aiConfig.requestTimeoutMs),
    });
  } catch (error) {
    throw new ApiError(502, `Không kết nối được AI: ${String(error.message || error).slice(0, 180)}`);
  }

  let result;
  const responseText = await response.text();
  try {
    result = JSON.parse(responseText);
  } catch {
    const contentType = response.headers?.get('content-type') || 'không rõ';
    throw new ApiError(502, `AI trả về nội dung không phải JSON (HTTP ${response.status}, Content-Type: ${contentType}); kiểm tra AI_API_URL và endpoint /predict`);
  }
  if (!response.ok || result?.success !== true) {
    throw new ApiError(502, `AI từ chối phân tích ảnh (HTTP ${response.status})`);
  }

  validateResult(result);
  return { actualMime, result };
};
