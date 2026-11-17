const test = require('node:test');
const assert = require('node:assert/strict');
const { predictImage } = require('../src/services/ai-prediction.service');

const validResult = {
  success: true,
  class_id: 0,
  label: 'anthracnose_leaf_spot',
  label_vi: 'Bệnh thán thư',
  confidence: 0.91,
  is_healthy: false,
  predictions: [
    { class_id: 0, label: 'anthracnose_leaf_spot', label_vi: 'Bệnh thán thư', confidence: 0.91 },
    { class_id: 1, label: 'healthy', label_vi: 'Lá khỏe mạnh', confidence: 0.06 },
    { class_id: 2, label: 'straw_mite', label_vi: 'Nhện hại lá', confidence: 0.03 },
  ],
  inference_ms: 120,
};

test('sends an uploaded image as multipart file with the AI API key', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(validResult),
    };
  });

  const image = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  const out = await predictImage({ buffer: image, originalName: 'leaf.jpg' }, {
    apiUrl: 'https://ai.example.test/',
    apiKey: 'test-key',
    requestTimeoutMs: 1000,
  });

  assert.equal(request.url, 'https://ai.example.test/predict');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-API-Key'], 'test-key');
  assert.equal(request.options.headers['ngrok-skip-browser-warning'], 'true');
  assert.equal(request.options.body.get('file').type, 'image/jpeg');
  assert.equal(out.actualMime, 'image/jpeg');
  assert.deepEqual(out.result, validResult);
});

test('rejects invalid image bytes before calling the AI server', async (t) => {
  let called = false;
  t.mock.method(globalThis, 'fetch', async () => {
    called = true;
    throw new Error('fetch should not be called');
  });

  await assert.rejects(
    () => predictImage({ buffer: Buffer.from('not an image') }, {
      apiUrl: 'https://ai.example.test',
      apiKey: 'test-key',
      requestTimeoutMs: 1000,
    }),
    /Nội dung file không phải ảnh JPEG, PNG hoặc WebP hợp lệ/
  );
  assert.equal(called, false);
});

test('accepts AI_API_URL with an existing /predict path without appending it twice', async (t) => {
  let requestUrl;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requestUrl = url;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(validResult),
    };
  });

  await predictImage({ buffer: Buffer.from([0xff, 0xd8, 0xff]) }, {
    apiUrl: 'https://ai.example.test/predict/',
    apiKey: 'test-key',
    requestTimeoutMs: 1000,
  });

  assert.equal(requestUrl, 'https://ai.example.test/predict');
});

test('rejects an AI response that does not match the prediction schema', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ success: true, label: 'healthy' }),
  }));

  await assert.rejects(
    () => predictImage({ buffer: Buffer.from([0xff, 0xd8, 0xff]) }, {
      apiUrl: 'https://ai.example.test',
      apiKey: 'test-key',
      requestTimeoutMs: 1000,
    }),
    /Response AI không đúng schema/
  );
});
