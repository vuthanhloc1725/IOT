const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const env = require('../config/env');
const { User } = require('../models');
const ApiError = require('../utils/apiError');
const { userView } = require('../utils/helpers');
const audit = require('../services/audit.service');

// JWT stateless đơn giản: chỉ lưu id và role; frontend lưu token trong localStorage.
const sign = (u) => jwt.sign({ sub: u.id, role: u.role }, env.jwt.secret, { expiresIn: env.jwt.expiresIn });

exports.login = async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) throw ApiError.badRequest('Thiếu username hoặc password');
    const user = await User.scope('withPassword').findOne({ where: { [Op.or]: [{ username }, { email: username }] } });
    const ok = user && user.isActive && (await bcrypt.compare(String(password), user.passwordHash));
    if (!ok) {
        await audit.log(req, { userId: user?.id, action: 'auth.login', entityType: 'user', entityId: user?.id, success: false, detail: { username } });
        throw ApiError.unauthorized('Sai tài khoản hoặc mật khẩu');
    }
    user.lastLoginAt = new Date();
    await user.save();
    await audit.log(req, { userId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id });
    res.json({ data: { token: sign(user), user: userView(user) } });
};

exports.me = async (req, res) => res.json({ data: userView(req.user) });

exports.changePassword = async (req, res) => {
    const { old_password, new_password } = req.body || {};
    if (!old_password || !new_password || String(new_password).length < 8) {
        throw ApiError.badRequest('Cần old_password và new_password (tối thiểu 8 ký tự)');
    }
    const user = await User.scope('withPassword').findByPk(req.user.id);
    if (!(await bcrypt.compare(String(old_password), user.passwordHash))) throw ApiError.badRequest('Mật khẩu cũ không đúng');
    user.passwordHash = await bcrypt.hash(String(new_password), 10);
    await user.save();
    await audit.log(req, { action: 'auth.change_password', entityType: 'user', entityId: user.id, detail: { sessionsRevoked: false } });
    res.json({ data: { message: 'Đã đổi mật khẩu thành công. Hãy đăng nhập lại nếu bạn muốn làm mới phiên hiện tại.' } });
};
