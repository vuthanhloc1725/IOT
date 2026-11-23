const test = require('node:test');
const assert = require('node:assert/strict');
const controller = require('../src/controllers/analysis.controller');
const { Disease, LeafAnalysis } = require('../src/models');
const aiPrediction = require('../src/services/ai-prediction.service');
const imageStorage = require('../src/services/analysis-image.storage');
const socket = require('../src/services/socket.service');
const audit = require('../src/services/audit.service');

const imageBuffer = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const prediction = {
  label: 'anthracnose_leaf_spot',
  label_vi: 'Bệnh thán thư',
  confidence: 0.91,
  is_healthy: false,
  predictions: [{ label: 'anthracnose_leaf_spot', label_vi: 'Bệnh thán thư', confidence: 0.91 }],
};

function responseStub() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('stores a user-uploaded prediction with its image and uploader id', async (t) => {
  let createdValues;
  t.mock.method(aiPrediction, 'predictImage', async () => ({ actualMime: 'image/jpeg', result: prediction }));
  t.mock.method(Disease, 'findOne', async () => ({ id: 21, isHealthy: false }));
  t.mock.method(imageStorage, 'save', async () => 'saved-image.jpg');
  t.mock.method(LeafAnalysis, 'create', async (values) => {
    createdValues = values;
    return { id: 87 };
  });
  t.mock.method(LeafAnalysis, 'findByPk', async () => ({ id: 87, imagePath: 'saved-image.jpg' }));
  t.mock.method(socket, 'emitAuthenticated', () => {});
  t.mock.method(audit, 'log', async () => {});

  const res = responseStub();
  await controller.predict({
    file: { buffer: imageBuffer, originalname: 'leaf.jpg' },
    user: { id: 14 },
  }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.analysisId, 87);
  assert.deepEqual(res.body.data, prediction);
  assert.equal(createdValues.uploadedBy, 14);
  assert.equal(createdValues.deviceId, null);
  assert.equal(createdValues.diseaseId, 21);
  assert.equal(createdValues.imagePath, 'saved-image.jpg');
  assert.equal(createdValues.imageSha256.length, 64);
});

test('removes the stored image if saving the history row fails', async (t) => {
  let removedImage;
  t.mock.method(aiPrediction, 'predictImage', async () => ({ actualMime: 'image/jpeg', result: prediction }));
  t.mock.method(Disease, 'findOne', async () => ({ id: 21, isHealthy: false }));
  t.mock.method(imageStorage, 'save', async () => 'saved-image.jpg');
  t.mock.method(imageStorage, 'remove', async (filename) => { removedImage = filename; });
  t.mock.method(LeafAnalysis, 'create', async () => { throw new Error('database unavailable'); });

  await assert.rejects(() => controller.predict({
    file: { buffer: imageBuffer, originalname: 'leaf.jpg' },
    user: { id: 14 },
  }, responseStub()), /database unavailable/);
  assert.equal(removedImage, 'saved-image.jpg');
});
