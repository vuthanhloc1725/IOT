/**
 * Hàng đợi lệnh "chụp ngay" + endpoint đổi chu kỳ chụp (không cần database).
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const commands = require('../src/services/camera-command.service');

describe('camera-command.service', () => {
    beforeEach(() => commands._reset());

    it('giao lệnh PENDING một lần rồi ack DONE', async () => {
        const cmd = commands.enqueue({ cameraCode: 'CAM-001', requestedBy: 1 });
        assert.equal(cmd.status, 'PENDING');
        const first = await commands.waitForCommands('CAM-001', 0);
        assert.deepEqual(first.map((c) => c.requestId), [cmd.requestId]);
        assert.equal(commands.get('CAM-001', cmd.requestId).status, 'DELIVERED');
        assert.deepEqual(await commands.waitForCommands('CAM-001', 0), []);
        const done = commands.ack({ cameraCode: 'CAM-001', requestId: cmd.requestId, success: true, eventId: 'evt-1' });
        assert.equal(done.status, 'DONE');
        assert.equal(done.eventId, 'evt-1');
        // ack lặp không đổi kết quả
        assert.equal(commands.ack({ cameraCode: 'CAM-001', requestId: cmd.requestId, success: false }).status, 'DONE');
    });

    it('long-poll thức dậy ngay khi có lệnh mới', async () => {
        const started = Date.now();
        const waiting = commands.waitForCommands('CAM-002', 5000);
        setTimeout(() => commands.enqueue({ cameraCode: 'CAM-002' }), 50);
        const got = await waiting;
        assert.equal(got.length, 1);
        assert.ok(Date.now() - started < 2000);
    });

    it('long-poll hết giờ trả mảng rỗng; abort dừng chờ', async () => {
        assert.deepEqual(await commands.waitForCommands('CAM-003', 30), []);
        const ac = new AbortController();
        const waiting = commands.waitForCommands('CAM-003', 5000, ac.signal);
        ac.abort();
        assert.deepEqual(await waiting, []);
    });

    it('camera khác không thấy / không ack được lệnh', async () => {
        const cmd = commands.enqueue({ cameraCode: 'CAM-001' });
        assert.deepEqual(await commands.waitForCommands('CAM-009', 0), []);
        assert.equal(commands.ack({ cameraCode: 'CAM-009', requestId: cmd.requestId, success: true }), null);
        assert.equal(commands.get('CAM-009', cmd.requestId), null);
    });

    it('giới hạn số lệnh chờ mỗi Camera', () => {
        for (let i = 0; i < commands._constants.MAX_PENDING_PER_CAMERA; i += 1) commands.enqueue({ cameraCode: 'CAM-004' });
        assert.throws(() => commands.enqueue({ cameraCode: 'CAM-004' }), (e) => e.code === 'TOO_MANY_PENDING');
    });
});

describe('camera.controller config/capture', () => {
    const models = require('../src/models');
    const audit = require('../src/services/audit.service');
    audit.log = async () => {};
    const state = { camera: null, userDevices: [] };
    models.Device = { findOne: async ({ where }) => (state.camera && state.camera.deviceCode === where.deviceCode ? state.camera : null) };
    models.UserDevice = {
        findAll: async ({ where }) => state.userDevices.filter((u) => u.userId === where.userId).map((u) => ({ device: { deviceCode: u.code } })),
    };
    const ctrl = require('../src/controllers/camera.controller');

    const makeCamera = (over = {}) => ({
        id: 7, deviceCode: 'CAM-001', type: 'CAMERA', lifecycle: 'ACTIVE', configVersion: 2,
        config: { captureIntervalSeconds: 900, heartbeatIntervalSeconds: 60 },
        save: async function save() { this.saved = true; }, toJSON() { return { ...this }; },
        ...over,
    });
    const res = () => {
        const r = { statusCode: 200, body: null, on() {}, set() { return r; }, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; } };
        return r;
    };
    const admin = { id: 1, role: 'admin' };

    beforeEach(() => { commands._reset(); state.camera = makeCamera(); state.userDevices = []; });

    it('Admin đổi chu kỳ chụp, kể cả 0 = tắt; heartbeat trả đúng giá trị', async () => {
        const r = res();
        await ctrl.updateConfig({ params: { cameraId: 'CAM-001' }, body: { captureIntervalSeconds: 43200 }, user: admin }, r);
        assert.equal(r.body.data.captureIntervalSeconds, 43200);
        assert.equal(state.camera.configVersion, 3);
        assert.equal(state.camera.config.heartbeatIntervalSeconds, 60);
        await ctrl.updateConfig({ params: { cameraId: 'CAM-001' }, body: { captureIntervalSeconds: 0 }, user: admin }, res());
        const hb = res();
        await ctrl.heartbeat({ camera: state.camera }, hb);
        assert.equal(hb.body.captureIntervalSeconds, 0);
    });

    it('từ chối chu kỳ không hợp lệ và người dùng không phải Admin', async () => {
        for (const bad of [3, 86401, 1.5, 'abc', -1]) {
            await assert.rejects(
                ctrl.updateConfig({ params: { cameraId: 'CAM-001' }, body: { captureIntervalSeconds: bad }, user: admin }, res()),
                (e) => e.status === 400,
            );
        }
        await assert.rejects(
            ctrl.updateConfig({ params: { cameraId: 'CAM-001' }, body: { captureIntervalSeconds: 60 }, user: { id: 2, role: 'user' } }, res()),
            (e) => e.status === 403,
        );
    });

    it('người dùng được gán chụp ngay; người không được gán bị 404; Camera chưa có token bị 409', async () => {
        const user = { id: 5, role: 'user' };
        await assert.rejects(ctrl.captureNow({ params: { cameraId: 'CAM-001' }, body: {}, user }, res()), (e) => e.status === 404);
        state.userDevices = [{ userId: 5, code: 'CAM-001' }];
        const r = res();
        await ctrl.captureNow({ params: { cameraId: 'CAM-001' }, body: {}, user }, r);
        assert.equal(r.statusCode, 202);
        assert.equal(r.body.data.status, 'PENDING');
        // heartbeat fallback giao lệnh
        const hb = res();
        await ctrl.heartbeat({ camera: state.camera }, hb);
        assert.equal(hb.body.commands[0].requestId, r.body.data.requestId);
        // agent ack
        const ack = res();
        await ctrl.ackCommand({ params: { requestId: r.body.data.requestId }, body: { success: true, eventId: 'e1' }, camera: state.camera }, ack);
        assert.equal(ack.body.data.status, 'DONE');
        const st = res();
        await ctrl.commandStatus({ params: { cameraId: 'CAM-001', requestId: r.body.data.requestId }, user }, st);
        assert.equal(st.body.data.status, 'DONE');

        // agent cũ: heartbeat không giao lệnh, bấm chụp báo 409 AGENT_OUTDATED
        const oldHb = res();
        commands.enqueue({ cameraCode: 'CAM-001' });
        await ctrl.heartbeat({ camera: state.camera, body: { agentVersion: '0.3.0' } }, oldHb);
        assert.deepEqual(oldHb.body.commands, []);
        await assert.rejects(ctrl.captureNow({ params: { cameraId: 'CAM-001' }, body: {}, user: admin }, res()),
            (e) => e.status === 409 && e.code === 'AGENT_OUTDATED');
        await ctrl.heartbeat({ camera: state.camera, body: { agentVersion: '0.4.0' } }, res());
        await ctrl.captureNow({ params: { cameraId: 'CAM-001' }, body: {}, user: admin }, res());

        state.camera = makeCamera({ lifecycle: 'REGISTERED' });
        await assert.rejects(ctrl.captureNow({ params: { cameraId: 'CAM-001' }, body: {}, user: admin }, res()), (e) => e.status === 409);
    });
});
