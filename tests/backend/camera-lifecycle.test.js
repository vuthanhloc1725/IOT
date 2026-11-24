/**
 * Unit test vòng đời Camera + phân quyền media (không cần database).
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const state = { alerts: [], created: [], tokens: [], userDevices: [], media: [] };

const models = require('../src/models');
models.Alert = {
    findAll: async () => state.alerts.filter((a) => a.status !== 'RESOLVED'),
    findOne: async ({ where }) => state.alerts.find((a) => a.deviceId === where.deviceId && a.type === where.type && a.status !== 'RESOLVED') || null,
};
models.CameraToken = { findOne: async ({ where }) => state.tokens.find((t) => t.deviceId === where.deviceId) || null };
models.Device = { update: async () => [1], findAll: async () => state.cameras || [] };
models.UserDevice = {
    findAll: async ({ where }) => state.userDevices.filter((u) => u.userId === where.userId).map((u) => ({ device: { deviceCode: u.code } })),
};
models.CameraMedia = {
    findOne: async ({ where }) => state.media.find((m) => m.eventId === where.eventId) || null,
    findAndCountAll: async ({ where }) => ({ where, count: 0, rows: [] }),
};

const alertPath = require.resolve('../src/services/alert.service');
require.cache[alertPath] = {
    id: alertPath, filename: alertPath, loaded: true,
    exports: {
        create: async (data) => { state.created.push(data); return data; },
        autoResolve: async (alert) => { alert.status = 'RESOLVED'; },
    },
};
const auditPath = require.resolve('../src/services/audit.service');
require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: { log: async () => {} } };
const storagePath = require.resolve('../src/services/camera-media.storage');
require.cache[storagePath] = {
    id: storagePath, filename: storagePath, loaded: true,
    exports: { read: async () => ({ buffer: Buffer.from('x'), mimeType: 'image/jpeg' }) },
};

const cam = require('../src/services/camera-lifecycle.service');
const cameraService = require('../src/services/camera.service');

function camera(lifecycle = 'ACTIVE', config = {}) {
    return { id: 7, name: 'Cam vườn', deviceCode: 'CAM-007', type: 'CAMERA', lifecycle, config, save: async function save() { return this; } };
}
const token = (lastUsedAt, extra = {}) => ({ deviceId: 7, revokedAt: null, expiresAt: null, lastUsedAt, update: async function u(v) { Object.assign(this, v); }, ...extra });
const admin = { id: 1, role: 'admin' };

beforeEach(() => {
    state.alerts = []; state.created = []; state.tokens = []; state.userDevices = []; state.media = []; state.cameras = [];
});

describe('presence', () => {
    it('online khi heartbeat trong cửa sổ 3× interval (tối thiểu 90s)', () => {
        const now = Date.now();
        assert.equal(cam.presence(camera(), token(new Date(now - 60_000)), now).isOnline, true);
        assert.equal(cam.presence(camera(), token(new Date(now - 200_000)), now).isOnline, false);
        assert.equal(cam.presence(camera('ACTIVE', { heartbeatIntervalSeconds: 120 }), token(new Date(now - 300_000)), now).isOnline, true);
    });

    it('offline khi token bị thu hồi hoặc chưa có token', () => {
        const now = Date.now();
        const p = cam.presence(camera(), token(new Date(now), { revokedAt: new Date() }), now);
        assert.equal(p.isOnline, false);
        assert.equal(p.token.status, 'REVOKED');
        assert.equal(cam.presence(camera(), null, now).token.status, 'NONE');
    });

    it('toView không bao giờ chứa tokenHash', () => {
        const view = cam.toView({ ...camera(), cameraToken: { tokenHash: 'secret' } }, token(new Date()));
        assert.equal(JSON.stringify(view).includes('secret'), false);
    });
});

describe('lifecycle', () => {
    it('cấp token: REGISTERED → PROVISIONED; thu hồi: ACTIVE → REGISTERED', async () => {
        const c = camera('REGISTERED');
        await cam.onTokenIssued(c);
        assert.equal(c.lifecycle, 'PROVISIONED');
        c.lifecycle = 'ACTIVE';
        await cam.onTokenRevoked(c);
        assert.equal(c.lifecycle, 'REGISTERED');
    });

    it('liên lạc đầu tiên PROVISIONED → ACTIVE và đóng cảnh báo offline', async () => {
        const c = camera('PROVISIONED');
        state.alerts.push({ deviceId: 7, type: 'offline', status: 'OPEN' });
        await cam.onCameraContact(c, token(new Date()), { wasOnline: false });
        assert.equal(c.lifecycle, 'ACTIVE');
        assert.equal(state.alerts[0].status, 'RESOLVED');
    });

    it('upload chỉ nhận ở PROVISIONED/ACTIVE', () => {
        assert.doesNotThrow(() => cam.assertCanUpload(camera('ACTIVE')));
        assert.throws(() => cam.assertCanUpload(camera('MAINTENANCE')), (e) => e.status === 403 && e.code === 'CAMERA_NOT_ACCEPTING');
    });

    it('không cho kích hoạt lại khi Camera offline', async () => {
        state.tokens.push(token(new Date(Date.now() - 3_600_000)));
        await assert.rejects(cam.changeLifecycle({ user: admin }, camera('MAINTENANCE'), 'ACTIVE'), (e) => e.status === 409);
    });

    it('người dùng thường không đổi được lifecycle Camera', async () => {
        await assert.rejects(cam.changeLifecycle({ user: { id: 2, role: 'user' } }, camera('ACTIVE'), 'MAINTENANCE'), (e) => e.status === 403);
    });

    it('FAULT tạo cảnh báo; DECOMMISSIONED thu hồi token', async () => {
        const t = token(new Date());
        state.tokens.push(t);
        const c = camera('ACTIVE');
        await cam.changeLifecycle({ user: admin }, c, 'FAULT');
        assert.equal(state.created[0].type, 'fault');
        await cam.changeLifecycle({ user: admin }, c, 'DECOMMISSIONED');
        assert.ok(t.revokedAt instanceof Date);
    });

    it('sweep tạo đúng 1 cảnh báo offline cho Camera quá hạn heartbeat', async () => {
        state.cameras = [{ ...camera('ACTIVE'), cameraToken: token(new Date(Date.now() - 3_600_000)) }];
        await cam.sweepOffline();
        assert.equal(state.created.length, 1);
        state.alerts.push({ deviceId: 7, type: 'offline', status: 'OPEN' });
        await cam.sweepOffline();
        assert.equal(state.created.length, 1);
    });
});

describe('RBAC media', () => {
    it('admin = null (xem tất cả); user chỉ thấy Camera được gán', async () => {
        assert.equal(await cam.accessibleCameraCodes(admin), null);
        state.userDevices.push({ userId: 2, code: 'CAM-001' });
        assert.deepEqual(await cam.accessibleCameraCodes({ id: 2, role: 'user' }), ['CAM-001']);
    });

    it('getMediaFile trả 404 với media của Camera không được gán', async () => {
        state.media.push({ eventId: 'e1', cameraId: 'CAM-002', filename: 'a.jpg' });
        await assert.rejects(cameraService.getMediaFile('e1', ['CAM-001']), (e) => e.status === 404);
        const ok = await cameraService.getMediaFile('e1', null);
        assert.equal(ok.mimeType, 'image/jpeg');
    });

    it('listMedia lọc theo Camera được gán, chặn cameraId ngoài quyền', async () => {
        const denied = await cameraService.listMedia({ cameraId: 'CAM-002', allowedCodes: ['CAM-001'] });
        assert.equal(denied.count, 0);
        const scoped = await cameraService.listMedia({ allowedCodes: ['CAM-001'] });
        assert.ok(scoped.where.cameraId);
    });
});
