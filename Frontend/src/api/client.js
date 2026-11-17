// API client dùng chung: JWT, query string, lỗi nhất quán và tải ảnh cần xác thực.
const configuredBase = (import.meta.env.VITE_API_URL || '/api').trim();
const BASE_URL = configuredBase.replace(/\/+$/, '');
const TOKEN_KEY = 'token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token) => (token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

function makeUrl(path, params) {
  const url = new URL(`${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`, window.location.origin);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return url;
}

async function handleUnauthorized(status) {
  if (status === 401) {
    setToken(null);
    window.dispatchEvent(new Event('auth:logout'));
  }
}

export async function request(path, { method = 'GET', params, body } = {}) {
  const token = getToken();
  const response = await fetch(makeUrl(path, params), {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    await handleUnauthorized(response.status);
    throw new ApiError(response.status, json?.message || json?.error?.message || response.statusText || 'API error', json);
  }
  return json;
}

export async function postForm(path, formData) {
  const token = getToken();
  const response = await fetch(makeUrl(path), {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    await handleUnauthorized(response.status);
    throw new ApiError(response.status, json?.message || json?.error?.message || response.statusText || 'API error', json);
  }
  return json;
}

export async function getBlob(path) {
  const response = await fetch(makeUrl(path), { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
  if (!response.ok) {
    await handleUnauthorized(response.status);
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, body?.message || response.statusText || 'Không tải được file', body);
  }
  return response.blob();
}

export const get = (path, params) => request(path, { params });
export const post = (path, body) => request(path, { method: 'POST', body });
export const put = (path, body) => request(path, { method: 'PUT', body });
export const patch = (path, body) => request(path, { method: 'PATCH', body });
export const del = (path) => request(path, { method: 'DELETE' });
