import { get, post, setToken } from './client';
import { resetSocket } from './socket';

export async function login(username, password) {
  const response = await post('/auth/login', { username, password });
  setToken(response.data.token);
  resetSocket();
  return response.data.user;
}
export const me = () => get('/auth/me').then((response) => response.data);
export const changePassword = (old_password, new_password) => post('/auth/change-password', { old_password, new_password });
export function logout() {
  // Logout đơn giản: xóa JWT khỏi localStorage và đóng socket ở trình duyệt hiện tại.
  setToken(null);
  resetSocket();
}
