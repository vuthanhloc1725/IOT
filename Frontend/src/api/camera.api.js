import { get, post, patch, del, getBlob } from './client';

// Camera = Device loại CAMERA (điện thoại chạy agent), gửi ảnh qua HTTP bằng camera token.
export const listCameras = () => get('/camera');
export const registerCamera = (body) => post('/camera', body);
export const getServerHints = () => get('/camera/server-hints');
export const issueToken = (cameraId, body = {}) => post(`/camera/tokens/${encodeURIComponent(cameraId)}`, body);
export const revokeToken = (cameraId) => del(`/camera/tokens/${encodeURIComponent(cameraId)}`);
export const listMedia = (params) => get('/camera/media', params);
export const getMediaFile = (eventId) => getBlob(`/camera/media/${encodeURIComponent(eventId)}/file`);
export const deleteMedia = (eventId) => del(`/camera/media/${encodeURIComponent(eventId)}`);

// Chu kỳ chụp (0 = tắt, chỉ chụp theo yêu cầu) — agent áp dụng trong ≤ 25 giây.
export const updateCameraConfig = (cameraId, body) => patch(`/camera/${encodeURIComponent(cameraId)}/config`, body);
// Chụp ngay: trả requestId, hỏi trạng thái tới khi DONE / FAILED / EXPIRED.
export const captureNow = (cameraId, body = {}) => post(`/camera/${encodeURIComponent(cameraId)}/capture`, body);
export const getCommandStatus = (cameraId, requestId) => get(`/camera/${encodeURIComponent(cameraId)}/commands/${encodeURIComponent(requestId)}`);
