/*
 * Vòng đời cấp phát (provisioning) của Node — nguồn sự thật duy nhất.
 *
 *   LEGACY            Node không có MAC: cấp MQTT credentials trực tiếp (không claim).
 *   NO_TOKEN          Có MAC, chưa có token  ──(claim-token)──▶ AWAITING_CLAIM
 *   AWAITING_CLAIM    Token còn hạn, chờ ESP32 gọi POST /api/provisioning/claim
 *   TOKEN_EXPIRED     Token quá hạn          ──(claim-token)──▶ AWAITING_CLAIM
 *   CLAIM_IN_PROGRESS Token vừa được giữ chỗ (< CLAIM_IN_PROGRESS_MS), đang tạo tài khoản Broker
 *   CLAIM_STUCK       Claim lỗi giữa chừng   ──(claim-token / claim-reconcile, tự dọn Broker)──▶ AWAITING_CLAIM
 *   CLAIMED           Đã có tài khoản MQTT riêng
 *   REVOKED           Đã thu hồi             ──(restore)──▶ CLAIMED | ──(claim-token)──▶ AWAITING_CLAIM (cấp lại)
 *
 * Mọi thao tác Broker ở đây đều idempotent (xóa object "not found" coi như thành công), nên không
 * còn trạng thái "cần đối soát thủ công": hệ thống luôn tự dọn rồi đi tiếp.
 */
const { randomBytes } = require('crypto');
const ApiError = require('../utils/apiError');
const mqttDynsec = require('./mqtt-dynsec.service');
const env = require('../config/env');
const { issueToken } = require('./node-claim.service');

// Giữ chỗ trẻ hơn mốc này được coi là claim đang chạy; cũ hơn là claim bị kẹt và được tự dọn.
const CLAIM_IN_PROGRESS_MS = 60 * 1000;
// Sau khi claim thành công, ESP32 được gửi lại đúng token trong khoảng này nếu mất phản hồi HTTP.
const CLAIM_REPLAY_MS = 10 * 60 * 1000;

const STATE = Object.freeze({
    LEGACY: 'LEGACY',
    NO_TOKEN: 'NO_TOKEN',
    AWAITING_CLAIM: 'AWAITING_CLAIM',
    TOKEN_EXPIRED: 'TOKEN_EXPIRED',
    CLAIM_IN_PROGRESS: 'CLAIM_IN_PROGRESS',
    CLAIM_STUCK: 'CLAIM_STUCK',
    CLAIMED: 'CLAIMED',
    REVOKED: 'REVOKED',
});

const time = (value) => (value ? new Date(value).getTime() : 0);

function provisioningState(node, now = Date.now()) {
    if (node.isRevoked) return STATE.REVOKED;
    if (!node.macAddress) return STATE.LEGACY;
    if (node.claimedAt) return STATE.CLAIMED;
    if (node.claimConsumedAt && !node.claimFailedAt) {
        return now - time(node.claimConsumedAt) < CLAIM_IN_PROGRESS_MS ? STATE.CLAIM_IN_PROGRESS : STATE.CLAIM_STUCK;
    }
    // Hash và hạn luôn được ghi/xóa cùng nhau; chỉ dựa vào hạn vì defaultScope ẩn claimTokenHash.
    if (!node.claimTokenExpiresAt) return STATE.NO_TOKEN;
    if (time(node.claimTokenExpiresAt) <= now) return STATE.TOKEN_EXPIRED;
    return STATE.AWAITING_CLAIM;
}

function usernameFor(nodeCode) {
    return `node_${String(nodeCode).toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
}

function brokerNames(node) {
    return { username: usernameFor(node.nodeCode), roleName: mqttDynsec.buildNodeRole(node.nodeCode).roleName };
}

function brokerError(action, error) {
    return ApiError.coded(503, 'BROKER_UNAVAILABLE', `${action}: ${error.message}`);
}

function assertBrokerConfigured() {
    try { mqttDynsec.assertConfigured(); } catch (error) { throw brokerError('Broker Dynamic Security chưa sẵn sàng', error); }
}

function deviceBrokerUrl() {
    return env.mqtt.deviceUrl || env.mqtt.url;
}

// Trả thêm host/port/tls để firmware không phải tự phân tích URL.
function credentialsFor(node, password) {
    const brokerUrl = deviceBrokerUrl();
    let host = null;
    let port = null;
    const tls = brokerUrl.startsWith('mqtts://');
    try {
        const parsed = new URL(brokerUrl);
        host = parsed.hostname;
        port = Number(parsed.port) || (tls ? 8883 : 1883);
    } catch { /* để firmware dùng brokerUrl */ }
    return {
        brokerUrl, host, port, tls,
        topicPrefix: env.mqtt.firmwarePrefix,
        nodeCode: node.nodeCode,
        username: node.mqttUsername,
        password,
    };
}

// Xóa client+role theo tên chuẩn và theo tên đang lưu (nếu khác). "Not found" = đã sạch.
async function purgeBrokerAccount(node) {
    const names = brokerNames(node);
    const targets = [[names.username, names.roleName]];
    if (node.mqttUsername && (node.mqttUsername !== names.username || (node.mqttRoleName && node.mqttRoleName !== names.roleName))) {
        targets.push([node.mqttUsername, node.mqttRoleName || names.roleName]);
    }
    assertBrokerConfigured();
    try {
        for (const [username, roleName] of targets) await mqttDynsec.deleteAccount(username, roleName);
    } catch (error) {
        throw brokerError('Không dọn được tài khoản MQTT cũ trên Broker', error);
    }
}

// Tạo tài khoản mới từ trạng thái sạch: dọn object mồ côi của lần claim lỗi trước rồi mới tạo.
async function provisionAccount(node, transaction) {
    const { username, roleName } = brokerNames(node);
    const password = randomBytes(36).toString('base64url');
    assertBrokerConfigured();
    try {
        await mqttDynsec.deleteAccount(username, roleName);
        await mqttDynsec.createAccount({ nodeCode: node.nodeCode, username, password });
    } catch (error) {
        throw brokerError('Không tạo được tài khoản MQTT cho Node', error);
    }
    Object.assign(node, { mqttUsername: username, mqttRoleName: roleName, mqttAccountEnabled: true, mqttProvisionedAt: new Date() });
    await node.save({ transaction });
    return credentialsFor(node, password);
}

// Đổi mật khẩu; nếu DB thiếu thông tin hoặc Broker đã mất client thì tạo lại thay vì báo "không đồng bộ".
async function rotateAccount(node, transaction) {
    if (!node.mqttUsername || !node.mqttRoleName) return provisionAccount(node, transaction);
    const password = randomBytes(36).toString('base64url');
    assertBrokerConfigured();
    try {
        await mqttDynsec.rotatePassword(node.mqttUsername, password);
    } catch (error) {
        if (error.brokerError === 'Client not found') return provisionAccount(node, transaction);
        throw brokerError('Không đổi được mật khẩu MQTT của Node', error);
    }
    Object.assign(node, { mqttAccountEnabled: true, mqttProvisionedAt: new Date() });
    await node.save({ transaction });
    return credentialsFor(node, password);
}

/*
 * Đưa Node có MAC về AWAITING_CLAIM với token mới. Dùng cho: cấp token lần đầu, token hết hạn,
 * claim bị kẹt, Node đã thu hồi, hoặc Node đang hoạt động cần flash lại (reprovision: true).
 * Trả về { token, previousState }.
 */
async function prepareForClaim(node, { transaction, reprovision = false, now = Date.now() } = {}) {
    if (!node.macAddress) {
        throw ApiError.coded(409, 'NODE_HAS_NO_MAC', 'Node chưa đăng ký MAC nên không dùng claim token; dùng "Cấp lại MQTT credentials" hoặc cập nhật Node với macAddress.');
    }
    const previousState = provisioningState(node, now);
    if (previousState === STATE.CLAIM_IN_PROGRESS) {
        const retryAfterSec = Math.max(1, Math.ceil((CLAIM_IN_PROGRESS_MS - (now - time(node.claimConsumedAt))) / 1000));
        throw ApiError.coded(409, 'CLAIM_IN_PROGRESS', `ESP32 đang claim Node này; thử lại sau ${retryAfterSec} giây.`, { retryAfterSec });
    }
    if (previousState === STATE.CLAIMED && !reprovision) {
        throw ApiError.coded(409, 'REPROVISION_CONFIRM_REQUIRED',
            'Node đang hoạt động với tài khoản MQTT riêng. Cấp token mới sẽ xóa tài khoản này: thu hồi Node trước, hoặc gửi {"reprovision": true}.');
    }
    const hasBrokerAccount = Boolean(node.mqttUsername || node.mqttRoleName || node.claimedAt || node.claimConsumedAt);
    if (hasBrokerAccount) await purgeBrokerAccount(node);
    const claim = issueToken();
    Object.assign(node, {
        mqttUsername: null, mqttRoleName: null, mqttAccountEnabled: false, mqttProvisionedAt: null,
        claimedAt: null, claimConsumedAt: null, claimFailedAt: null,
        claimTokenHash: claim.hash, claimTokenExpiresAt: claim.expiresAt,
        isRevoked: false, revokedAt: null,
    });
    await node.save({ transaction });
    return { token: claim.token, previousState, brokerPurged: hasBrokerAccount };
}

module.exports = {
    STATE,
    CLAIM_IN_PROGRESS_MS,
    CLAIM_REPLAY_MS,
    provisioningState,
    usernameFor,
    brokerNames,
    assertBrokerConfigured,
    deviceBrokerUrl,
    purgeBrokerAccount,
    provisionAccount,
    rotateAccount,
    prepareForClaim,
};
