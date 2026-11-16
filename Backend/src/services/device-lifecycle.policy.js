const FRESH_PROOF_MS = 5 * 60 * 1000;

// Returns a user-safe explanation if FAULT/MAINTENANCE -> ACTIVE is not justified.
function recoveryBlockReason(device, node, now = Date.now()) {
  if (!device || !['FAULT', 'MAINTENANCE'].includes(device.lifecycle)) return null;
  const lifecycleTimestamp = device.lifecycleChangedAt || device.stateChangedAt; // fallback for rows not yet migrated
  if (!lifecycleTimestamp || !Number.isFinite(new Date(lifecycleTimestamp).getTime())) {
    return 'Thiết bị chưa có thời điểm chuyển trạng thái hợp lệ; hãy chuyển qua MAINTENANCE và xác minh lại.';
  }
  if (!node || node.isRevoked || !node.mqttAccountEnabled || !node.isOnline || !node.lastHeartbeatAt) {
    return 'Node phải chưa bị thu hồi, có tài khoản MQTT đang bật và đang online trước khi khôi phục ACTIVE.';
  }
  const heartbeatAge = now - new Date(node.lastHeartbeatAt).getTime();
  if (!Number.isFinite(heartbeatAge) || heartbeatAge < -5000 || heartbeatAge > Number(node.heartbeatTimeoutSec || 60) * 1000) {
    return 'Heartbeat của Node đã cũ; hãy chờ Node gửi heartbeat mới.';
  }
  if (Number(device.configAppliedVersion || 0) !== Number(device.configVersion || 0)) {
    return 'Phiên bản cấu hình hiện tại chưa được Node ACK. Chờ Node gửi lại config có version khớp sau khi áp dụng.';
  }
  // Firmware v1.2 inventory mode has no device/probe or current/flow sensor. For these
  // actuators, require the Node to be fresh and the output confirmed OFF before manual recovery.
  if (device.type === 'FAN' || (device.type === 'PUMP' && !device.config?.hardwareFeedback?.type)) {
    if (device.isOn) return 'Không thể khôi phục khi cơ cấu chấp hành vẫn đang bật; xác nhận trạng thái OFF trước.';
    return null;
  }
  if (!device.readinessVerifiedAt || !device.readinessType) {
    return 'Thiếu bằng chứng readiness mới. Cảm biến cần gửi telemetry mới; bơm đời cũ cần self-test qua cảm biến dòng/lưu lượng.';
  }
  const proofTime = new Date(device.readinessVerifiedAt).getTime();
  const changedAt = new Date(lifecycleTimestamp).getTime();
  const proofAge = now - proofTime;
  if (!Number.isFinite(proofTime) || proofTime <= changedAt) {
    return 'Bằng chứng readiness phải mới hơn thời điểm thiết bị vào FAULT/MAINTENANCE.';
  }
  if (!Number.isFinite(proofAge) || proofAge < -5000 || proofAge > FRESH_PROOF_MS) {
    return 'Bằng chứng readiness đã quá 5 phút; cần kiểm tra lại thiết bị.';
  }
  if (device.type === 'SENSOR' && device.readinessType !== 'SENSOR_TELEMETRY') {
    return 'Bằng chứng phục hồi của cảm biến không hợp lệ.';
  }
  if (device.type === 'PUMP') {
    const configuredFeedback = String(device.config?.hardwareFeedback?.type || '').toUpperCase();
    if (!['CURRENT_SENSOR', 'FLOW_SENSOR'].includes(configuredFeedback)
      || device.readinessType !== configuredFeedback) {
      return 'Bằng chứng phục hồi của bơm phải khớp CURRENT_SENSOR/FLOW_SENSOR đã cấu hình.';
    }
    if (device.isOn) return 'Không thể khôi phục ACTIVE khi trạng thái bơm vẫn đang bật; hãy xác nhận bơm đã tắt an toàn trước.';
  }
  return null;
}

module.exports = { recoveryBlockReason, FRESH_PROOF_MS };
