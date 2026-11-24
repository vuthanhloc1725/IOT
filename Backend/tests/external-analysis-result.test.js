const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExternalResult } = require('../src/services/analysis-result-payload');

const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
const validResult = (overrides = {}) => ({
  capturedAt: '2026-10-26T13:30:00.000Z',
  diseaseLabel: 'Tomato___Late_blight',
  confidence: 0.93,
  modelVersion: 'external-v1',
  imageMimeType: 'image/jpeg',
  imageBase64: jpegBase64,
  ...overrides,
});

test('accepts an external disease result with an image', () => {
  const out = normalizeExternalResult(validResult({ inferenceMs: 240, boundingBoxes: [] }));
  assert.equal(out.ok, true);
  assert.deepEqual(out.value.labels, ['Tomato___Late_blight']);
  assert.equal(out.value.confidence, 0.93);
  assert.equal(out.value.modelVersion, 'external-v1');
  assert.equal(out.value.imageMimeType, 'image/jpeg');
  assert.deepEqual(out.value.imageBuffer, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal(out.value.eventId, null);
});

test('accepts a disease name without requiring any device/source identifier', () => {
  const out = normalizeExternalResult(validResult({ diseaseLabel: undefined, diseaseName: 'Bệnh mốc sương' }));
  assert.equal(out.ok, true);
  assert.deepEqual(out.value.names, ['Bệnh mốc sương']);
  assert.equal(out.value.modelVersion, 'external-v1');
});

test('accepts nested disease fields and a Base64 Data URI', () => {
  const out = normalizeExternalResult({
    disease: { label: 'Tomato___Healthy', name: 'Healthy', confidence: 0.99 },
    model_version: 'v2',
    inference_ms: 100,
    image: { data: `data:image/jpeg;base64,${jpegBase64}`, mime_type: 'image/jpeg' },
  });
  assert.equal(out.ok, true);
  assert.equal(out.value.confidence, 0.99);
  assert.equal(out.value.modelVersion, 'v2');
});

test('rejects missing disease identity or missing image', () => {
  assert.equal(normalizeExternalResult(validResult({ diseaseLabel: undefined })).ok, false);
  assert.equal(normalizeExternalResult({ diseaseLabel: 'Disease-A', confidence: 0.9 }).ok, false);
});

test('rejects invalid confidence and numeric strings', () => {
  assert.equal(normalizeExternalResult(validResult({ confidence: 1.2 })).ok, false);
  assert.equal(normalizeExternalResult(validResult({ confidence: '0.9' })).ok, false);
});

test('rejects image MIME mismatch, unsupported images, and oversized images', () => {
  assert.equal(normalizeExternalResult(validResult({ imageMimeType: 'image/png' })).ok, false);
  assert.equal(normalizeExternalResult(validResult({ imageBase64: Buffer.from('not an image').toString('base64') })).ok, false);
  const tooLarge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024)]).toString('base64');
  assert.equal(normalizeExternalResult(validResult({ imageBase64: tooLarge }), { maxImageBytes: 100 }).ok, false);
});

test('rejects invalid inference time, huge bounding-box list, and malformed event IDs', () => {
  assert.equal(normalizeExternalResult(validResult({ inferenceMs: -1 })).ok, false);
  assert.equal(normalizeExternalResult(validResult({ boundingBoxes: Array(501).fill({}) })).ok, false);
  assert.equal(normalizeExternalResult(validResult({ eventId: 'bad\nvalue' })).ok, false);
  assert.equal(normalizeExternalResult(validResult({ eventId: 'stable-event-001' })).value.eventId, 'stable-event-001');
});
