/**
 * Hàng đợi lệnh Camera trong bộ nhớ (chụp ngay theo yêu cầu).
 *
 * Agent trên điện thoại chỉ nói HTTP (không MQTT) nên server không "đẩy" được lệnh. Thay vào đó:
 *   - Web gọi POST /api/camera/:cameraId/capture → enqueue() tạo lệnh PENDING.
 *   - Agent long-poll POST /api/camera/commands/poll → waitForCommands() trả ngay nếu có lệnh,
 *     hoặc giữ kết nối tới khi có lệnh / hết thời gian chờ. Lệnh chuyển DELIVERED.
 *   - Agent chụp + upload xong gọi POST /api/camera/commands/:requestId/ack → DONE / FAILED.
 *   - Web hỏi GET /api/camera/:cameraId/commands/:requestId để biết trạng thái.
 *
 * Lệnh hết hạn sau COMMAND_TTL_MS (mặc định 5 phút) nếu agent offline — không xếp hàng chụp bù sau nhiều giờ.
 * Mất khi restart server là chấp nhận được: đây là lệnh tức thời, không phải dữ liệu.
 */
const crypto = require('node:crypto');

const COMMAND_TTL_MS = 5 * 60_000;
const DELIVERED_RETRY_MS = 90_000; // agent nhận nhưng không ack (crash) → cho nhận lại
const MAX_PENDING_PER_CAMERA = 5;
const KEEP_FINISHED_MS = 30 * 60_000;
const ACTIONS = new Set(['capture']);

const MIN_AGENT_VERSION = '0.4.0'; // agent đầu tiên biết nhận lệnh (long-poll + đọc commands trong heartbeat)

const commands = new Map(); // requestId → command
const agentVersions = new Map(); // cameraCode → phiên bản agent báo trong heartbeat / long-poll gần nhất

function versionAtLeast(version, min) {
    const a = String(version || '').split('.').map((n) => parseInt(n, 10) || 0);
    const b = min.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i += 1) {
        if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
    }
    return true;
}
const waiters = new Map(); // cameraCode → Set<resolve>

function now() { return Date.now(); }

function publicView(cmd) {
    if (!cmd) return null;
    const { cameraCode, requestId, action, status, message, eventId, createdAt, deliveredAt, finishedAt, requestedBy } = cmd;
    return {
        cameraId: cameraCode, requestId, action, status, message: message || null, eventId: eventId || null,
        createdAt: new Date(createdAt).toISOString(),
        deliveredAt: deliveredAt ? new Date(deliveredAt).toISOString() : null,
        finishedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
        requestedBy: requestedBy ?? null,
    };
}

function sweep() {
    const t = now();
    for (const [id, cmd] of commands) {
        if (['PENDING', 'DELIVERED'].includes(cmd.status) && t - cmd.createdAt > COMMAND_TTL_MS) {
            cmd.status = 'EXPIRED';
            cmd.message = 'Camera không phản hồi trong 5 phút (agent offline?)';
            cmd.finishedAt = t;
        }
        if (cmd.finishedAt && t - cmd.finishedAt > KEEP_FINISHED_MS) commands.delete(id);
    }
}

function deliverable(cameraCode) {
    const t = now();
    return [...commands.values()]
        .filter((c) => c.cameraCode === cameraCode && (
            c.status === 'PENDING' || (c.status === 'DELIVERED' && t - c.deliveredAt > DELIVERED_RETRY_MS)
        ))
        .sort((a, b) => a.createdAt - b.createdAt);
}

function takeDeliverable(cameraCode) {
    sweep();
    const list = deliverable(cameraCode);
    const t = now();
    for (const c of list) { c.status = 'DELIVERED'; c.deliveredAt = t; }
    return list.map((c) => ({ requestId: c.requestId, action: c.action, camera: c.camera, createdAt: new Date(c.createdAt).toISOString() }));
}

function wake(cameraCode) {
    const set = waiters.get(cameraCode);
    if (!set) return;
    waiters.delete(cameraCode);
    for (const resolve of set) resolve();
}

exports.enqueue = ({ cameraCode, action = 'capture', camera = 'back', requestedBy = null }) => {
    if (!ACTIONS.has(action)) throw new Error(`action không hỗ trợ: ${action}`);
    sweep();
    const open = [...commands.values()].filter((c) => c.cameraCode === cameraCode && ['PENDING', 'DELIVERED'].includes(c.status));
    if (open.length >= MAX_PENDING_PER_CAMERA) {
        const err = new Error('Camera đang có quá nhiều lệnh chờ, thử lại sau');
        err.code = 'TOO_MANY_PENDING';
        throw err;
    }
    const cmd = {
        requestId: crypto.randomUUID(), cameraCode, action, camera,
        status: 'PENDING', createdAt: now(), deliveredAt: null, finishedAt: null, requestedBy,
    };
    commands.set(cmd.requestId, cmd);
    wake(cameraCode);
    return publicView(cmd);
};

/** Ghi phiên bản agent (từ heartbeat). Long-poll tự nó đã chứng minh agent hỗ trợ lệnh. */
exports.noteAgentVersion = (cameraCode, version) => {
    if (typeof version === 'string' && version.length <= 20) agentVersions.set(cameraCode, version);
};
exports.noteCommandCapable = (cameraCode) => {
    if (!exports.supportsCommands(cameraCode)) agentVersions.set(cameraCode, MIN_AGENT_VERSION);
};
/** true | false | null (chưa biết: server vừa khởi động, agent chưa heartbeat). */
exports.supportsCommands = (cameraCode) => {
    if (!agentVersions.has(cameraCode)) return null;
    return versionAtLeast(agentVersions.get(cameraCode), MIN_AGENT_VERSION);
};
exports.agentVersion = (cameraCode) => agentVersions.get(cameraCode) || null;

exports.pendingCount = (cameraCode) => { sweep(); return deliverable(cameraCode).length; };

/** Trả lệnh ngay nếu có; nếu không, chờ tối đa timeoutMs. onAbort để hủy khi client ngắt kết nối. */
exports.waitForCommands = async (cameraCode, timeoutMs, signal) => {
    let list = takeDeliverable(cameraCode);
    if (list.length || timeoutMs <= 0) return list;
    await new Promise((resolve) => {
        let set = waiters.get(cameraCode);
        if (!set) { set = new Set(); waiters.set(cameraCode, set); }
        const done = () => { clearTimeout(timer); set.delete(done); if (!set.size && waiters.get(cameraCode) === set) waiters.delete(cameraCode); resolve(); };
        const timer = setTimeout(done, timeoutMs);
        set.add(done);
        signal?.addEventListener?.('abort', done, { once: true });
    });
    if (signal?.aborted) return [];
    list = takeDeliverable(cameraCode);
    return list;
};

exports.ack = ({ cameraCode, requestId, success, message, eventId }) => {
    sweep();
    const cmd = commands.get(requestId);
    if (!cmd || cmd.cameraCode !== cameraCode) return null;
    if (['DONE', 'FAILED', 'EXPIRED'].includes(cmd.status)) return publicView(cmd); // ack lặp: idempotent
    cmd.status = success ? 'DONE' : 'FAILED';
    cmd.message = message ? String(message).slice(0, 300) : null;
    cmd.eventId = eventId ? String(eventId).slice(0, 100) : null;
    cmd.finishedAt = now();
    return publicView(cmd);
};

exports.get = (cameraCode, requestId) => {
    sweep();
    const cmd = commands.get(requestId);
    return cmd && cmd.cameraCode === cameraCode ? publicView(cmd) : null;
};

// Dành cho test.
exports._reset = () => { commands.clear(); agentVersions.clear(); for (const code of [...waiters.keys()]) wake(code); };
exports._constants = { COMMAND_TTL_MS, DELIVERED_RETRY_MS, MAX_PENDING_PER_CAMERA, MIN_AGENT_VERSION };
