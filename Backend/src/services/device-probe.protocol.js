const { METRICS } = require('../constants');

const PUMP_EVIDENCE = ['CURRENT_SENSOR', 'FLOW_SENSOR'];

function normalizeProbeAck(payload, expected) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'ACK probe không phải object JSON' };
  if (payload.requestId !== expected.requestId) return { ok: false, reason: 'requestId không khớp' };
  // deviceCode intentionally does not exist yet; it is generated only after this probe succeeds.
  const detectedType = String(payload.detectedType || payload.type || '').toUpperCase();
  if (detectedType !== expected.type) return { ok: false, reason: 'Loại phần cứng phát hiện không khớp' };
  const gpioPin = payload.gpioPin === null || payload.gpioPin === undefined ? null : Number(payload.gpioPin);
  if (gpioPin !== expected.gpioPin) return { ok: false, reason: 'GPIO phản hồi không khớp yêu cầu' };
  if (typeof payload.present !== 'boolean') return { ok: false, reason: 'ACK probe thiếu trường present true/false' };
  if (!payload.present) return { ok: false, reason: String(payload.message || 'Node không phát hiện thiết bị phần cứng') };
  const selfTest = payload.selfTest;
  if (!selfTest || selfTest.ok !== true) return { ok: false, reason: String(selfTest?.message || 'Thiết bị không vượt qua self-test') };
  const evidence = String(payload.presenceEvidence || selfTest.evidence || '').toUpperCase();
  if (expected.type === 'SENSOR') {
    const metric = String(selfTest.metric || '').toUpperCase();
    const valueRaw = selfTest.value;
    const value = Number(valueRaw);
    if (valueRaw === null || valueRaw === undefined || valueRaw === '' || !METRICS.includes(metric) || !Number.isFinite(value)) return { ok: false, reason: 'Cảm biến phải cung cấp metric hợp lệ và giá trị đọc thực tế trong selfTest' };
    if (['SOIL_MOISTURE', 'AIR_HUMIDITY'].includes(metric) && (value < 0 || value > 100)) return { ok: false, reason: `Giá trị ${metric} ngoài khoảng 0–100` };
    return { ok: true, evidence: evidence || `SENSOR_READ:${metric}`, metric, value };
  }
  if (expected.type === 'PUMP') {
    if (!PUMP_EVIDENCE.includes(evidence)) return { ok: false, reason: 'Không thể xác minh bơm vật lý chỉ bằng GPIO/relay. Cần phản hồi CURRENT_SENSOR hoặc FLOW_SENSOR.' };
    const value = Number(selfTest.value);
    if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: 'Self-test không ghi nhận dòng điện hoặc lưu lượng dương; không đăng ký bơm.' };
    const expectedFeedback = String(expected.hardwareFeedback?.type || '').toUpperCase();
    if (evidence !== expectedFeedback) return { ok: false, reason: 'Loại phản hồi dòng/lưu lượng không khớp cấu hình đăng ký' };
    if (expected.allowActuatorTest !== true) return { ok: false, reason: 'Chưa được người dùng cho phép chạy kiểm tra bơm có kiểm soát' };
    const duration = Number(payload.testDurationMs);
    if (!Number.isInteger(duration) || duration < 1 || duration > 1000) return { ok: false, reason: 'Probe bơm phải báo testDurationMs từ 1 đến 1000 ms' };
    return { ok: true, evidence, metric: String(selfTest.metric || evidence), value, testDurationMs: duration };
  }
  return { ok: false, reason: 'Loại thiết bị không được hỗ trợ bởi quy trình probe' };
}

module.exports = { normalizeProbeAck, PUMP_EVIDENCE };
