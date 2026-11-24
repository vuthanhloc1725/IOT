const { Node, Device, DeviceCommand, sequelize } = require('../models');
const ApiError = require('../utils/apiError');
const { pick } = require('../utils/helpers');
const audit = require('../services/audit.service');
const nodeService = require('../services/node.service');
const mqttDynsec = require('../services/mqtt-dynsec.service');
const env = require('../config/env');
const { createWithSequentialCode } = require('../services/code-generator');
const { normalizeMac, issueToken, matchesToken } = require('../services/node-claim.service');
const provisioning = require('../services/node-provisioning.service');
const commandService = require('../services/command.service');

const { STATE } = provisioning;
const deviceInclude = [{ model: Device, as: 'devices', attributes: ['id', 'deviceCode', 'name', 'type', 'lifecycle'] }];
const find = async (id, opts = {}) => {
    const node = await Node.findByPk(id, opts);
    if (!node) throw ApiError.notFound('Không tìm thấy node');
    return node;
};
// Đọc kèm claimTokenHash (defaultScope ẩn nó) và giữ khóa dòng trong transaction.
const findLocked = async (id, transaction) => {
    const node = await Node.unscoped().findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!node) throw ApiError.notFound('Không tìm thấy node');
    return node;
};

// Mọi response trả Node kèm provisioningState để UI/firmware biết bước tiếp theo.
function present(node) {
    const { claimTokenHash, ...data } = typeof node.toJSON === 'function' ? node.toJSON() : { ...node };
    return { ...data, provisioningState: provisioning.provisioningState(node) };
}

function secureProvisioningTransport(req) {
    const remote = req.socket.remoteAddress;
    return Boolean(req.socket.encrypted) ||
        (env.claimTrustedProxyIps.includes(remote) && req.headers['x-forwarded-proto'] === 'https') ||
        (env.nodeEnv !== 'production' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote));
}

// CLAIM_REQUIRE_TLS=true: claim token chỉ đi qua HTTPS và thiết bị chỉ nhận Broker mqtts://.
function assertClaimTransport(req) {
    if (!env.claimRequireTls) return;
    if (!secureProvisioningTransport(req)) {
        throw ApiError.coded(403, 'INSECURE_TRANSPORT', 'Claim token chỉ được gửi qua HTTPS hoặc reverse proxy tin cậy (CLAIM_REQUIRE_TLS=true).');
    }
    if (!provisioning.deviceBrokerUrl().startsWith('mqtts://')) {
        throw ApiError.coded(503, 'BROKER_TLS_REQUIRED', 'CLAIM_REQUIRE_TLS=true nhưng MQTT_DEVICE_URL/MQTT_URL không dùng mqtts://.');
    }
}

const isActiveDevice = (d) => d.lifecycle !== 'DECOMMISSIONED';
const hasMetrics = (d, metrics) => metrics.every((m) => d.config?.metrics?.includes(m));
// Phần cứng bắt buộc của firmware node_telemetry; thiết bị khác (quạt GPIO27, ...) được phép thêm.
const REQUIRED_DEVICES = [
    { label: 'cảm biến độ ẩm đất SENSOR GPIO34 (SOIL_MOISTURE)', match: (d) => d.type === 'SENSOR' && Number(d.gpioPin) === 34 && hasMetrics(d, ['SOIL_MOISTURE']) },
    { label: 'DHT SENSOR GPIO4 (AIR_TEMPERATURE + AIR_HUMIDITY)', match: (d) => d.type === 'SENSOR' && Number(d.gpioPin) === 4 && hasMetrics(d, ['AIR_TEMPERATURE', 'AIR_HUMIDITY']) },
    { label: 'bơm PUMP GPIO26', match: (d) => d.type === 'PUMP' && Number(d.gpioPin) === 26 },
];

function inventoryProblems(devices) {
    const active = devices.filter(isActiveDevice);
    const problems = [];
    for (const required of REQUIRED_DEVICES) {
        const count = active.filter(required.match).length;
        if (count === 0) problems.push(`Thiếu ${required.label}`);
        else if (count > 1) problems.push(`Có ${count} thiết bị trùng vai trò ${required.label}`);
    }
    const byPin = new Map();
    for (const device of active) {
        if (device.gpioPin === null || device.gpioPin === undefined) continue;
        const pin = Number(device.gpioPin);
        byPin.set(pin, [...(byPin.get(pin) || []), device.deviceCode]);
    }
    for (const [pin, codes] of byPin) {
        if (codes.length > 1) problems.push(`GPIO${pin} được gán cho nhiều thiết bị: ${codes.join(', ')}`);
    }
    return problems;
}

/*
 * Lý do từ chối claim, theo thứ tự kiểm tra. Mã lỗi (code) trả về cho ESP32 để in ra Serial;
 * MAC chưa đăng ký và token sai dùng chung CLAIM_INVALID để không dò được token.
 */
function claimDecision(node, token, now = Date.now()) {
    if (!node) return { reason: 'NODE_NOT_FOUND', error: ApiError.coded(403, 'CLAIM_INVALID', 'MAC hoặc claim token không đúng.') };
    if (node.isRevoked) return { reason: 'NODE_REVOKED', error: ApiError.coded(403, 'NODE_REVOKED', 'Node đã bị thu hồi; quản trị cần cấp claim token mới.') };
    const tokenOk = matchesToken(token, node.claimTokenHash);
    const unexpired = node.claimTokenExpiresAt && new Date(node.claimTokenExpiresAt).getTime() > now;
    const state = provisioning.provisioningState(node, now);
    if (state === STATE.CLAIMED) {
        if (tokenOk && unexpired) return { replay: true };
        if (tokenOk) return { reason: 'TOKEN_USED', error: ApiError.coded(409, 'CLAIM_TOKEN_USED', 'Token đã dùng để claim Node này; cần cấp token mới để flash lại.') };
        return { reason: 'ALREADY_CLAIMED', error: ApiError.coded(409, 'NODE_ALREADY_CLAIMED', 'Node đã được claim; quản trị cần cấp token mới (reprovision) để claim lại.') };
    }
    if (!tokenOk) return { reason: node.claimTokenHash ? 'TOKEN_MISMATCH' : 'TOKEN_NOT_ISSUED', error: ApiError.coded(403, 'CLAIM_INVALID', 'MAC hoặc claim token không đúng.') };
    if (!unexpired) return { reason: 'TOKEN_EXPIRED', error: ApiError.coded(403, 'CLAIM_TOKEN_EXPIRED', 'Claim token đã hết hạn; quản trị cần cấp token mới.') };
    if (state === STATE.CLAIM_IN_PROGRESS) {
        const retryAfterSec = Math.max(1, Math.ceil((provisioning.CLAIM_IN_PROGRESS_MS - (now - new Date(node.claimConsumedAt).getTime())) / 1000));
        return { reason: 'CLAIM_IN_PROGRESS', error: ApiError.coded(409, 'CLAIM_IN_PROGRESS', `Đang có một yêu cầu claim khác; thử lại sau ${retryAfterSec} giây.`, { retryAfterSec }) };
    }
    // AWAITING_CLAIM hoặc CLAIM_STUCK (yêu cầu trước đã chết): cho claim, tài khoản cũ được dọn khi tạo mới.
    return { ok: true };
}

const loadDevices = (nodeId, transaction) => Device.findAll({
    where: { nodeId }, attributes: ['deviceCode', 'type', 'gpioPin', 'config', 'lifecycle'], transaction,
});

// Trước khi thu hồi: tắt các cơ cấu chấp hành đang bật và chờ ACK ngắn (tối đa 5 giây/thiết bị).
async function requestSafeStopForNode(node) {
    const result = { requested: 0, acknowledged: 0, failed: 0, skipped: 0, details: [] };
    const actuators = await Device.findAll({
        where: { nodeId: node.id, type: ['PUMP', 'FAN'], lifecycle: ['ACTIVE', 'FAULT', 'MAINTENANCE'] },
    });
    for (const device of actuators) {
        if (!device.isOn) { result.skipped += 1; continue; }
        try {
            const command = await commandService.issue({ device, turnOn: false, source: 'ALERT' });
            result.requested += 1;
            const deadline = Date.now() + Math.min(env.commandAckTimeoutSec * 1000, 5000);
            let current = command;
            while (current.status === 'SENT' && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 200));
                current = await DeviceCommand.findByPk(command.id);
            }
            if (current?.status === 'ACKED') result.acknowledged += 1;
            else result.failed += 1;
            result.details.push({ deviceCode: device.deviceCode, commandUuid: command.commandUuid, status: current?.status || 'UNKNOWN' });
        } catch (error) {
            result.failed += 1;
            result.details.push({ deviceCode: device.deviceCode, status: 'NOT_SENT', reason: String(error.message || error).slice(0, 200) });
        }
    }
    return result;
}

exports.list = async (req, res) => {
    const nodes = await Node.findAll({ include: deviceInclude, order: [['id', 'ASC']] });
    res.json({ data: nodes.map(present) });
};

exports.get = async (req, res) => res.json({ data: present(await find(req.params.id, { include: deviceInclude })) });

// Node có MAC nhận claim token (ESP32 tự lấy MQTT credentials); Node không MAC (legacy) nhận credentials ngay.
exports.create = async (req, res) => {
    const { name, firmwareVersion, hardwareVersion, heartbeatTimeoutSec, macAddress } = req.body || {};
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    if (!normalizedName) throw ApiError.badRequest('Cần name');
    const timeout = heartbeatTimeoutSec === undefined ? 60 : Number(heartbeatTimeoutSec);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw ApiError.badRequest('heartbeatTimeoutSec phải là số nguyên từ 1 đến 3600');
    const mac = macAddress === undefined || macAddress === null || macAddress === '' ? null : normalizeMac(macAddress);
    if (macAddress && !mac) throw ApiError.badRequest('macAddress phải là MAC Wi-Fi ESP32 unicast, ví dụ 24:6F:28:AA:BB:CC');
    if (mac) assertClaimTransport(req);
    provisioning.assertBrokerConfigured();
    const claim = mac ? issueToken() : null;

    let created;
    try {
        created = await createWithSequentialCode({
            prefix: 'NODE', Model: Node, field: 'nodeCode',
            values: {
                name: normalizedName,
                firmwareVersion: firmwareVersion || null,
                hardwareVersion: hardwareVersion || null,
                heartbeatTimeoutSec: timeout,
                ...(claim ? { macAddress: mac, claimTokenHash: claim.hash, claimTokenExpiresAt: claim.expiresAt } : {}),
            },
        });
    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
            if (mac) throw ApiError.coded(409, 'MAC_IN_USE', 'MAC này đã được gắn với một Node khác (hoặc trùng mã Node tuần tự).');
            throw ApiError.conflict('Mã Node tuần tự đã tồn tại. Hãy kiểm tra dữ liệu Node cũ trước khi tạo tiếp.');
        }
        throw error;
    }
    const node = created.record;
    let mqttCredentials = null;
    if (!claim) {
        try {
            mqttCredentials = await provisioning.provisionAccount(node);
        } catch (error) {
            await node.destroy(); // legacy: không để lại Node chưa có tài khoản MQTT riêng
            throw error;
        }
    }
    await audit.log(req, { action: 'node.create', entityType: 'node', entityId: node.id, detail: { nodeCode: node.nodeCode, macAddress: mac, mqttUsername: node.mqttUsername, mqttRoleName: node.mqttRoleName } });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ data: present(node), mqttCredentials, ...(claim ? { claimToken: claim.token } : {}), meta: { nodeCodeGenerated: true, mqttAccountProvisioned: !claim } });
};

/*
 * Cấp (lại) claim token cho mọi trạng thái của Node có MAC: chưa có token, hết hạn, claim kẹt,
 * đã thu hồi. Node đang CLAIMED cần {"reprovision": true} vì tài khoản MQTT hiện tại sẽ bị xóa.
 * Tài khoản cũ trên Broker được dọn trong cùng khóa dòng nên không còn lỗi "cần đối soát Broker".
 */
exports.reissueClaimToken = async (req, res) => {
    assertClaimTransport(req);
    const reprovision = req.body?.reprovision === true;
    const result = await sequelize.transaction(async (transaction) => {
        const node = await findLocked(req.params.id, transaction);
        const prepared = await provisioning.prepareForClaim(node, { transaction, reprovision });
        return { node, ...prepared };
    });
    const { node, token, previousState, brokerPurged } = result;
    if (brokerPurged) await nodeService.markOffline(node, 'cấp claim token mới; tài khoản MQTT cũ đã bị xóa');
    await audit.log(req, { action: 'node.claim_token_reissued', entityType: 'node', entityId: node.id, detail: { macAddress: node.macAddress, previousState, brokerPurged, reprovision } });
    res.set('Cache-Control', 'no-store');
    res.json({ data: present(node), claimToken: token, previousState, brokerPurged });
};

// Giải phóng claim bị kẹt: dọn client/role trên Broker rồi mở lại token hiện tại (nếu còn hạn).
// Idempotent: Node không kẹt thì trả về trạng thái hiện tại thay vì 409.
exports.reconcileClaim = async (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    const result = await sequelize.transaction(async (transaction) => {
        const node = await findLocked(req.params.id, transaction);
        const state = provisioning.provisioningState(node);
        if (state === STATE.CLAIM_IN_PROGRESS) {
            const retryAfterSec = Math.max(1, Math.ceil((provisioning.CLAIM_IN_PROGRESS_MS - (Date.now() - new Date(node.claimConsumedAt).getTime())) / 1000));
            throw ApiError.coded(409, 'CLAIM_IN_PROGRESS', `ESP32 đang claim Node này; thử lại sau ${retryAfterSec} giây.`, { retryAfterSec });
        }
        if (state !== STATE.CLAIM_STUCK) return { node, state, reconciled: false };
        await provisioning.purgeBrokerAccount(node);
        Object.assign(node, {
            mqttUsername: null, mqttRoleName: null, mqttAccountEnabled: false, mqttProvisionedAt: null,
            claimConsumedAt: null, claimFailedAt: new Date(),
        });
        await node.save({ transaction });
        return { node, state, reconciled: true };
    });
    const { node, state, reconciled } = result;
    if (reconciled) {
        await audit.log(req, { action: 'node.claim_reconciled', entityType: 'node', entityId: node.id, detail: { nodeCode: node.nodeCode, reason: reason || null, brokerPurged: true } });
    }
    const message = reconciled
        ? 'Đã dọn tài khoản Broker của claim bị kẹt. ESP32 có thể claim lại bằng token còn hạn, hoặc cấp token mới.'
        : `Node đang ở trạng thái ${state}; không có claim bị kẹt cần dọn.`;
    res.json({ data: present(node), reconciled, message });
};

exports.claim = async (req, res) => {
    const mac = normalizeMac(req.body?.macAddress);
    const token = req.body?.claimToken;
    if (!mac || typeof token !== 'string') throw ApiError.coded(400, 'CLAIM_BAD_REQUEST', 'Cần macAddress (MAC Wi-Fi ESP32) và claimToken dạng chuỗi.');
    assertClaimTransport(req);
    provisioning.assertBrokerConfigured();

    let reservationAt = null;
    let brokerTouched = false;
    let claimedNode = null;
    let devices;
    let mqttCredentials;
    let replay = false;
    try {
        // Giao dịch 1: kiểm tra và giữ chỗ token (commit trước khi chạm Broker, vốn không có transaction).
        await sequelize.transaction(async (transaction) => {
            const node = await Node.unscoped().findOne({ where: { macAddress: mac }, transaction, lock: transaction.LOCK.UPDATE });
            const decision = claimDecision(node, token);
            if (decision.error) {
                console.warn('[claim] rejected', { macAddress: mac, nodeCode: node?.nodeCode || null, reason: decision.reason });
                throw decision.error;
            }
            devices = await loadDevices(node.id, transaction);
            if (decision.replay) {
                // ESP32 mất phản hồi lần trước và gửi lại đúng token: cấp lại mật khẩu, không claim lần hai.
                mqttCredentials = await provisioning.rotateAccount(node, transaction);
                claimedNode = node;
                replay = true;
                return;
            }
            const problems = inventoryProblems(devices);
            if (problems.length) {
                throw ApiError.coded(409, 'INVENTORY_MISMATCH', `Thiết bị đăng ký trên Node chưa khớp phần cứng: ${problems.join('; ')}`, { problems });
            }
            reservationAt = new Date();
            node.claimConsumedAt = reservationAt;
            node.claimFailedAt = null;
            await node.save({ transaction });
        });
        if (!replay) {
            // Giao dịch 2: tạo tài khoản Broker khi giữ khóa dòng, có rào chắn theo mốc giữ chỗ.
            await sequelize.transaction(async (transaction) => {
                const node = await Node.findOne({ where: { macAddress: mac }, transaction, lock: transaction.LOCK.UPDATE });
                if (!node || node.isRevoked || node.claimedAt || node.claimFailedAt ||
                    new Date(node.claimConsumedAt).getTime() !== reservationAt.getTime()) {
                    throw ApiError.coded(409, 'CLAIM_SUPERSEDED', 'Trạng thái Node thay đổi trong lúc claim (bị thu hồi hoặc cấp token mới); ESP32 cần token mới.');
                }
                brokerTouched = true;
                if (node.mqttUsername || node.mqttRoleName) await provisioning.purgeBrokerAccount(node);
                mqttCredentials = await provisioning.provisionAccount(node, transaction);
                node.claimedAt = new Date();
                // Giữ hash token thêm CLAIM_REPLAY_MS để ESP32 gửi lại nếu mất phản hồi HTTP.
                node.claimTokenExpiresAt = new Date(Date.now() + provisioning.CLAIM_REPLAY_MS);
                await node.save({ transaction });
                claimedNode = node;
            });
        }
    } catch (error) {
        if (reservationAt) await releaseReservation(mac, reservationAt, brokerTouched);
        if (reservationAt && !(error instanceof ApiError)) {
            throw ApiError.coded(503, 'CLAIM_FAILED', `Claim thất bại tạm thời, ESP32 có thể thử lại cùng token: ${error.message}`);
        }
        throw error;
    }
    try { await audit.log(req, { action: replay ? 'node.claim_replayed' : 'node.claimed', entityType: 'node', entityId: claimedNode.id, detail: { macAddress: mac, deviceCount: devices.length } }); }
    catch (error) { console.error('[claim] Không ghi được audit:', error.message); }
    res.set('Cache-Control', 'no-store');
    res.json({ nodeCode: claimedNode.nodeCode, macAddress: mac, mqttCredentials, devices, replay });
};

/*
 * Claim lỗi sau khi giữ chỗ: dọn Broker (best-effort) và trả token về trạng thái chờ claim để ESP32
 * thử lại. Có rào chắn: yêu cầu cũ không bao giờ đụng tới lần giữ chỗ/tài khoản mới hơn. Nếu không ghi
 * được DB, Node ở CLAIM_STUCK và tự được dọn ở lần claim/cấp token sau.
 */
async function releaseReservation(mac, reservationAt, brokerTouched) {
    try {
        await sequelize.transaction(async (transaction) => {
            const node = await Node.findOne({ where: { macAddress: mac }, transaction, lock: transaction.LOCK.UPDATE });
            if (!node || node.claimedAt || node.claimFailedAt ||
                new Date(node.claimConsumedAt).getTime() !== reservationAt.getTime()) return;
            if (brokerTouched) {
                const { username, roleName } = provisioning.brokerNames(node);
                try { await mqttDynsec.deleteAccount(username, roleName); }
                catch (cleanupError) { console.error('[claim] Chưa dọn được Broker, sẽ dọn ở lần claim sau:', cleanupError.message); }
            }
            await Node.update(
                { claimConsumedAt: null, claimFailedAt: new Date() },
                { where: { macAddress: mac, claimedAt: null, claimFailedAt: null, claimConsumedAt: reservationAt }, transaction },
            );
        });
    } catch (markError) {
        console.error('[claim] Không giải phóng được giữ chỗ (Node sẽ ở CLAIM_STUCK):', markError.message);
    }
}

exports.update = async (req, res) => {
    const node = await find(req.params.id);
    const changes = pick(req.body, ['name', 'firmwareVersion', 'hardwareVersion', 'heartbeatTimeoutSec']);
    if (changes.heartbeatTimeoutSec !== undefined) {
        changes.heartbeatTimeoutSec = Number(changes.heartbeatTimeoutSec);
        if (!Number.isInteger(changes.heartbeatTimeoutSec) || changes.heartbeatTimeoutSec < 1 || changes.heartbeatTimeoutSec > 3600) throw ApiError.badRequest('heartbeatTimeoutSec phải là số nguyên từ 1 đến 3600');
    }
    if (changes.name !== undefined) {
        changes.name = String(changes.name).trim();
        if (!changes.name) throw ApiError.badRequest('name không được rỗng');
    }
    await node.update(changes);
    await audit.log(req, { action: 'node.update', entityType: 'node', entityId: node.id, detail: { fields: Object.keys(changes) } });
    res.json({ data: present(node) });
};

// Đổi mật khẩu MQTT của Node đang hoạt động; tự tạo lại tài khoản nếu Broker đã mất client.
exports.issueMqttCredentials = async (req, res) => {
    const { node, mqttCredentials } = await sequelize.transaction(async (transaction) => {
        const node = await findLocked(req.params.id, transaction);
        if (node.isRevoked) throw ApiError.coded(409, 'NODE_REVOKED', 'Node đang bị thu hồi; hãy khôi phục hoặc cấp claim token mới trước.');
        if (node.macAddress && !node.claimedAt) {
            throw ApiError.coded(409, 'NODE_NOT_CLAIMED', 'Node có MAC nhận MQTT credentials qua claim; hãy cấp claim token rồi để ESP32 claim.');
        }
        return { node, mqttCredentials: await provisioning.rotateAccount(node, transaction) };
    });
    await nodeService.markOffline(node, 'cấp lại mật khẩu MQTT; ESP32 cần cập nhật credential mới');
    await audit.log(req, { action: 'node.mqtt_credentials_rotated', entityType: 'node', entityId: node.id, detail: { nodeCode: node.nodeCode, mqttUsername: node.mqttUsername } });
    res.set('Cache-Control', 'no-store');
    res.json({ data: present(node), mqttCredentials, message: 'Đã cấp lại mật khẩu MQTT. Cập nhật mật khẩu mới vào cấu hình Wi-Fi/MQTT của ESP32.' });
};

// Thu hồi: khóa tài khoản Broker (ngắt phiên) trước rồi mới đánh dấu trong DB. Gọi lại khi đã thu hồi là no-op.
exports.revoke = async (req, res) => {
    // Gửi lệnh dừng NGOÀI transaction (chờ ACK tới vài giây, không giữ khóa dòng).
    // Node offline hoặc không ACK: vẫn thu hồi nhưng báo rõ trong safeStop.
    const current = await find(req.params.id);
    let safeStop = null;
    if (!current.isRevoked) {
        safeStop = current.isOnline ? await requestSafeStopForNode(current) : {
            requested: 0, acknowledged: 0, failed: 0, skipped: 0,
            details: [{ status: 'SKIPPED_NODE_OFFLINE', reason: 'Không thể gửi lệnh dừng khi Node offline' }],
        };
    }
    const { node, alreadyRevoked } = await sequelize.transaction(async (transaction) => {
        const node = await findLocked(req.params.id, transaction);
        if (node.isRevoked) return { node, alreadyRevoked: true };
        if (node.mqttUsername) {
            try { await mqttDynsec.disableAccount(node.mqttUsername); }
            catch (error) {
                if (error.brokerError !== 'Client not found') {
                    throw ApiError.coded(503, 'BROKER_UNAVAILABLE', `Broker chưa thu hồi được tài khoản ${node.mqttUsername}: ${error.message}. Node vẫn chưa được đánh dấu thu hồi.`);
                }
            }
        }
        node.isRevoked = true;
        node.claimTokenHash = null;
        node.claimTokenExpiresAt = null;
        node.revokedAt = new Date();
        node.mqttAccountEnabled = false;
        await node.save({ transaction });
        return { node, alreadyRevoked: false };
    });
    if (!alreadyRevoked) {
        await nodeService.markOffline(node, 'node bị thu hồi');
        await audit.log(req, { action: 'node.revoke', entityType: 'node', entityId: node.id, detail: { mqttUsername: node.mqttUsername, brokerAccountDisabled: Boolean(node.mqttUsername), safeStop } });
    }
    let message = 'Đã thu hồi Node, gửi lệnh dừng cho các cơ cấu chấp hành đang bật và khóa/ngắt phiên MQTT.';
    if (alreadyRevoked) message = 'Node đã ở trạng thái thu hồi.';
    else if (safeStop?.failed) message = 'Đã thu hồi Node và khóa MQTT. Một số thiết bị chưa xác nhận lệnh dừng; cần kiểm tra an toàn tại hiện trường.';
    res.json({ data: present(node), safeStop, message });
};

/*
 * Khôi phục Node đã thu hồi:
 *  - Đã claim và còn tài khoản Broker  → mở lại tài khoản (ESP32 dùng lại credential cũ).
 *  - Có MAC nhưng chưa claim/mất tài khoản → cấp claim token mới (ESP32 claim lại).
 *  - Legacy không MAC                   → mở lại hoặc tạo lại tài khoản, trả credentials.
 */
exports.restore = async (req, res) => {
    const result = await sequelize.transaction(async (transaction) => {
        const node = await findLocked(req.params.id, transaction);
        if (!node.isRevoked) return { node, noop: true };
        if (node.macAddress && (!node.claimedAt || !node.mqttUsername)) {
            assertClaimTransport(req);
            const { token } = await provisioning.prepareForClaim(node, { transaction, reprovision: true });
            return { node, claimToken: token };
        }
        let mqttCredentials = null;
        if (!node.mqttUsername || !node.mqttRoleName) {
            mqttCredentials = await provisioning.provisionAccount(node, transaction);
        } else {
            provisioning.assertBrokerConfigured();
            try {
                await mqttDynsec.enableAccount(node.mqttUsername);
            } catch (error) {
                if (error.brokerError !== 'Client not found') {
                    throw ApiError.coded(503, 'BROKER_UNAVAILABLE', `Không mở lại được tài khoản MQTT của Node: ${error.message}`);
                }
                // Broker đã mất client: Node có MAC claim lại, Node legacy nhận tài khoản mới.
                if (node.macAddress) {
                    assertClaimTransport(req);
                    const { token } = await provisioning.prepareForClaim(node, { transaction, reprovision: true });
                    return { node, claimToken: token };
                }
                mqttCredentials = await provisioning.provisionAccount(node, transaction);
            }
        }
        Object.assign(node, {
            isRevoked: false, revokedAt: null, isOnline: false, onlineSince: null,
            mqttAccountEnabled: true, mqttProvisionedAt: node.mqttProvisionedAt || new Date(),
        });
        await node.save({ transaction });
        return { node, mqttCredentials };
    });
    const { node, noop, claimToken = null, mqttCredentials = null } = result;
    if (noop) return res.json({ data: present(node), mqttCredentials: null, message: 'Node chưa bị thu hồi; không cần khôi phục.' });
    await audit.log(req, { action: 'node.restore', entityType: 'node', entityId: node.id, detail: { nodeCode: node.nodeCode, mqttUsername: node.mqttUsername, claimTokenIssued: Boolean(claimToken), requiresFreshHeartbeat: true } });
    res.set('Cache-Control', 'no-store');
    let message = 'Đã mở lại tài khoản MQTT. Node chỉ trực tuyến sau khi kết nối và gửi heartbeat mới.';
    if (claimToken) message = 'Đã khôi phục Node; ESP32 cần claim lại bằng token mới (chỉ hiển thị một lần).';
    else if (mqttCredentials) message = 'Đã khôi phục Node với tài khoản MQTT mới; cập nhật credential vào ESP32.';
    res.json({ data: present(node), mqttCredentials, ...(claimToken ? { claimToken } : {}), message });
};
