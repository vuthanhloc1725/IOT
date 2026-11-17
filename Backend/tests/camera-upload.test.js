/**
 * Integration test cho POST /api/camera/media.
 * Chạy được không cần database (mock Sequelize models).
 */
const crypto = require('node:crypto');
const http = require('node:http');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---- Mock models trước khi require app ----
const CAM = 'CAM-001';
const mockDb = { tokens: [], media: [], analyses: [], lifecycle: 'ACTIVE' };

function resetMockDb() {
    mockDb.tokens.length = 0;
    mockDb.media.length = 0;
    mockDb.analyses.length = 0;
    mockDb.lifecycle = 'ACTIVE';
}

// Tạo 1 camera token test (deviceId = 1 → Device CAM-001)
function seedToken() {
    const raw = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    mockDb.tokens.push({ deviceId: 1, tokenHash: hash, revokedAt: null, expiresAt: null, save: async () => {} });
    return raw;
}

const CameraTokenMock = {
    findOne: async ({ where }) => mockDb.tokens.find((t) => t.tokenHash === where.tokenHash) || null,
};
const DeviceMock = {
    findByPk: async (id) => (id === 1 ? { id: 1, deviceCode: CAM, type: 'CAMERA', lifecycle: mockDb.lifecycle, config: {} } : null),
    update: async () => [0],
};
const LeafAnalysisMock = {
    findOne: async ({ where }) => mockDb.analyses.find((a) => a.eventId === where.eventId) || null,
};
const CameraMediaMock = {
    findOne: async ({ where }) => mockDb.media.find((m) => m.eventId === where.eventId) || null,
    create: async (data) => { const r = { ...data, toJSON: () => r }; mockDb.media.push(r); return r; },
    findAndCountAll: async () => ({ count: mockDb.media.length, rows: mockDb.media }),
};

// Ép chế độ fallback lưu đĩa và giới hạn nhỏ để test 413 (phải đặt trước khi nạp middleware upload).
const env = require('../src/config/env');
env.ai.apiUrl = '';
env.ai.apiKey = '';
env.camera.imageMaxBytes = 4096;

// Patch models (camera-auth/controller destructure models khi được require)
const models = require('../src/models');
models.CameraToken = CameraTokenMock;
models.Device = DeviceMock;
models.LeafAnalysis = LeafAnalysisMock;
models.CameraMedia = CameraMediaMock;
models.Alert = { findAll: async () => [], findOne: async () => null };

// Mock storage
const storagePath = require.resolve('../src/services/camera-media.storage');
require.cache[storagePath] = {
    id: storagePath, filename: storagePath, loaded: true,
    exports: {
        save: async () => 'mock-uuid.jpg',
        read: async () => ({ buffer: Buffer.from('jpg'), mimeType: 'image/jpeg' }),
        remove: async () => {},
        directory: '/tmp/test-camera-media',
    },
};

const app = require('../app');

// ---- Helpers ----

function buildMultipart(metadata, fileData, fileMime = 'image/jpeg') {
    const boundary = '----testboundary123';
    const metaJson = JSON.stringify(metadata);
    const parts = [
        `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metaJson}\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.jpg"\r\nContent-Type: ${fileMime}\r\n\r\n`,
    ];
    const head = Buffer.from(parts[0] + parts[1], 'utf-8');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    return { body: Buffer.concat([head, fileData, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

function request(server, { method, path, headers, body }) {
    return new Promise((resolve, reject) => {
        const addr = server.address();
        const req = http.request({ hostname: '127.0.0.1', port: addr.port, method, path, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                let json;
                try { json = JSON.parse(raw); } catch { json = null; }
                resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// ---- Tests ----

describe('Camera upload endpoint', () => {
    let server, token;

    before((_, done) => {
        server = app.listen(0, done);
    });
    after((_, done) => {
        server.close(done);
    });
    beforeEach(() => {
        resetMockDb();
        token = seedToken();
    });

    it('rejects missing auth', async () => {
        const res = await request(server, { method: 'POST', path: '/api/camera/media', headers: {}, body: Buffer.alloc(0) });
        assert.equal(res.status, 401);
    });

    it('rejects wrong token', async () => {
        const fileData = crypto.randomBytes(100);
        const sha = crypto.createHash('sha256').update(fileData).digest('hex');
        const { body, contentType } = buildMultipart(
            { eventId: 'e1', cameraId: CAM, sha256: sha, mediaType: 'image', mimeType: 'image/jpeg' },
            fileData,
        );
        const res = await request(server, {
            method: 'POST', path: '/api/camera/media',
            headers: { Authorization: 'Bearer wrong-token', 'Content-Type': contentType, 'Content-Length': body.length },
            body,
        });
        assert.equal(res.status, 401);
    });

    it('accepts valid upload and returns stored', async () => {
        const fileData = crypto.randomBytes(200);
        const sha = crypto.createHash('sha256').update(fileData).digest('hex');
        const { body, contentType } = buildMultipart(
            { schemaVersion: 2, eventId: 'ev-001', cameraId: CAM, sha256: sha, mediaType: 'image', mimeType: 'image/jpeg', capturedAt: new Date().toISOString() },
            fileData,
        );
        const res = await request(server, {
            method: 'POST', path: '/api/camera/media',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType, 'Content-Length': body.length },
            body,
        });
        assert.equal(res.status, 201);
        assert.equal(res.body.status, 'stored');
        assert.equal(res.body.eventId, 'ev-001');
        assert.equal(res.body.sha256, sha);
        assert.equal(mockDb.media.length, 1);
    });

    it('returns duplicate for same eventId', async () => {
        const fileData = crypto.randomBytes(50);
        const sha = crypto.createHash('sha256').update(fileData).digest('hex');
        // Seed existing media
        mockDb.media.push({ eventId: 'ev-dup', cameraId: CAM, sha256: sha });
        const { body, contentType } = buildMultipart(
            { eventId: 'ev-dup', cameraId: CAM, sha256: sha, mediaType: 'image', mimeType: 'image/jpeg' },
            fileData,
        );
        const res = await request(server, {
            method: 'POST', path: '/api/camera/media',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType, 'Content-Length': body.length },
            body,
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.status, 'duplicate');
    });

    it('rejects mismatched cameraId', async () => {
        const fileData = crypto.randomBytes(50);
        const sha = crypto.createHash('sha256').update(fileData).digest('hex');
        const { body, contentType } = buildMultipart(
            { eventId: 'ev-bad', cameraId: 'WRONG-CAM', sha256: sha, mediaType: 'image', mimeType: 'image/jpeg' },
            fileData,
        );
        const res = await request(server, {
            method: 'POST', path: '/api/camera/media',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType, 'Content-Length': body.length },
            body,
        });
        assert.equal(res.status, 403);
    });

    it('rejects sha256 mismatch', async () => {
        const fileData = crypto.randomBytes(50);
        const { body, contentType } = buildMultipart(
            { eventId: 'ev-sha', cameraId: CAM, sha256: 'a'.repeat(64), mediaType: 'image', mimeType: 'image/jpeg' },
            fileData,
        );
        const res = await request(server, {
            method: 'POST', path: '/api/camera/media',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType, 'Content-Length': body.length },
            body,
        });
        assert.equal(res.status, 400);
    });
    function upload(meta, fileData, mime = 'image/jpeg', auth = token) {
        const { body, contentType } = buildMultipart(meta, fileData, mime);
        return request(server, {
            method: 'POST', path: '/api/camera/media',
            headers: { Authorization: `Bearer ${auth}`, 'Content-Type': contentType, 'Content-Length': body.length },
            body,
        });
    }

    it('rejects oversize file with 413', async () => {
        const res = await upload({ eventId: 'ev-big', cameraId: CAM }, crypto.randomBytes(8192));
        assert.equal(res.status, 413);
    });

    it('rejects unsupported mime with 415', async () => {
        const res = await upload({ eventId: 'ev-txt', cameraId: CAM }, Buffer.from('hello'), 'text/plain');
        assert.equal(res.status, 415);
    });

    it('treats eventId already in leafAnalyses as duplicate', async () => {
        const fileData = crypto.randomBytes(64);
        const sha = crypto.createHash('sha256').update(fileData).digest('hex');
        mockDb.analyses.push({ id: 9, eventId: 'ev-ai', deviceId: 1, imageSha256: sha });
        const res = await upload({ eventId: 'ev-ai', cameraId: CAM, sha256: sha }, fileData);
        assert.equal(res.status, 200);
        assert.equal(res.body.status, 'duplicate');
        assert.equal(mockDb.media.length, 0);
    });

    it('rejects eventId owned by another camera with 409', async () => {
        mockDb.media.push({ eventId: 'ev-other', cameraId: 'CAM-999', sha256: 'b'.repeat(64) });
        const res = await upload({ eventId: 'ev-other', cameraId: CAM }, crypto.randomBytes(32));
        assert.equal(res.status, 409);
    });

    it('blocks uploads with 403 CAMERA_NOT_ACCEPTING while in MAINTENANCE', async () => {
        mockDb.lifecycle = 'MAINTENANCE';
        const res = await upload({ eventId: 'ev-maint', cameraId: CAM }, crypto.randomBytes(32));
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, 'CAMERA_NOT_ACCEPTING');
        assert.equal(mockDb.media.length, 0);
    });

    it('heartbeat updates lastUsedAt and reports lifecycle', async () => {
        const res = await request(server, {
            method: 'POST', path: '/api/camera/heartbeat',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: Buffer.from('{}'),
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.status, 'ok');
        assert.equal(res.body.cameraId, CAM);
        assert.equal(res.body.acceptingUploads, true);
        assert.equal(res.body.heartbeatIntervalSeconds, 60);
        assert.ok(mockDb.tokens[0].lastUsedAt instanceof Date);
    });

    it('heartbeat still accepted in MAINTENANCE but reports acceptingUploads=false', async () => {
        mockDb.lifecycle = 'MAINTENANCE';
        const res = await request(server, { method: 'POST', path: '/api/camera/heartbeat', headers: { Authorization: `Bearer ${token}` } });
        assert.equal(res.status, 200);
        assert.equal(res.body.acceptingUploads, false);
    });

    it('heartbeat rejects missing token', async () => {
        const res = await request(server, { method: 'POST', path: '/api/camera/heartbeat', headers: {} });
        assert.equal(res.status, 401);
    });
});
