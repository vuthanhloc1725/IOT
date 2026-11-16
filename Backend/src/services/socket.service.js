const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { User } = require('../models');
const { accessibleDeviceIds } = require('./access.service');

let io = null;

// Client kết nối: io(url, { auth: { token } })
exports.init = (httpServer) => {
  io = new Server(httpServer, {
    cors: { origin: env.corsOrigin === '*' ? true : env.corsOrigin.split(',') },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const payload = jwt.verify(token, env.jwt.secret);
      const user = await User.findByPk(payload.sub);
      if (!user || !user.isActive) throw new Error('inactive_user');
      socket.user = user;
      socket.data.userId = user.id;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    // Kết quả AI không gắn một thiết bị cụ thể được phát tới mọi phiên đăng nhập hợp lệ.
    socket.join('authenticated');
    const ids = await accessibleDeviceIds(socket.user);
    if (ids === null) socket.join('all');
    else ids.forEach((id) => socket.join(`device:${id}`));
  });
  return io;
};

// Phát tới admin + những ai được gán thiết bị đó
exports.emitDevice = (deviceId, event, payload) => {
  if (!io) return;
  let target = io.to('all');
  if (deviceId) target = target.to(`device:${deviceId}`);
  target.emit(event, payload);
};

// Phát cho admin (sự kiện cấp node, không gắn thiết bị)
exports.emitAdmin = (event, payload) => io && io.to('all').emit(event, payload);

// Dùng cho kết quả AI/ảnh nhận diện không gắn với một deviceId cụ thể.
exports.emitAuthenticated = (event, payload) => io && io.to('authenticated').emit(event, payload);



// Disconnect currently connected Socket.IO sessions after role/account changes.
// Logout itself is client-side (clear localStorage); this does not revoke copied JWTs.
exports.disconnectUser = (userId) => {
  if (!io) return;
  for (const client of io.sockets.sockets.values()) {
    if (Number(client.data.userId ?? client.user?.id) === Number(userId)) client.disconnect(true);
  }
};

// Refresh live Socket.IO access after a role, account-state or user-device assignment changes.
exports.refreshUserRooms = async (userId) => {
  if (!io) return;
  const user = await User.findByPk(userId);
  for (const client of io.sockets.sockets.values()) {
    if (Number(client.data.userId ?? client.user?.id) !== Number(userId)) continue;
    if (!user || !user.isActive) {
      client.disconnect(true);
      continue;
    }
    client.user = user;
    for (const room of [...client.rooms]) {
      if (room === 'all' || room.startsWith('device:')) client.leave(room);
    }
    if (user.role === 'admin') {
      await client.join('all');
    } else {
      const ids = await accessibleDeviceIds(user);
      if (ids) for (const id of ids) await client.join(`device:${id}`);
    }
  }
};
