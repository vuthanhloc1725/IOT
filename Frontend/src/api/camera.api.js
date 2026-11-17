import { get, post, del, getBlob } from './client';

// Camera = Device loại CAMERA (điện thoại chạy agent), gửi ảnh qua HTTP bằng camera token.
export const listCameras = () => get('/camera');
export const registerCamera = (body) => post('/camera', body);
export const getServerHints = () => get('/camera/server-hints');
export const issueToken = (cameraId, body = {}) => post(`/camera/tokens/${encodeURIComponent(cameraId)}`, body);
export const revokeToken = (cameraId) => del(`/camera/tokens/${encodeURIComponent(cameraId)}`);
export const listMedia = (params) => get('/camera/media', params);
export const getMediaFile = (eventId) => getBlob(`/camera/media/${encodeURIComponent(eventId)}/file`);
export const deleteMedia = (eventId) => del(`/camera/media/${encodeURIComponent(eventId)}`);
