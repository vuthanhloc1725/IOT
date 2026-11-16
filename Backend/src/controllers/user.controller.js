const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { User, Device, UserDevice, sequelize } = require('../models');
const { ROLES } = require('../constants.js');
const ApiError = require('../utils/apiError');
const { userView, toBool } = require('../utils/helpers');
const { paging, meta } = require('../utils/pagination');
const audit = require('../services/audit.service');
const socketService = require('../services/socket.service');

const find = async (id) => {
    const user = await User.findByPk(id);
    if (!user) throw ApiError.notFound('Không tìm thấy người dùng');
    return user;
};

exports.list = async (req, res) => {
    const { page, limit, offset } = paging(req);
    const where = {};

    if (req.query.role) where.role = req.query.role;

    const isActive = toBool(req.query.isActive);
    if (isActive !== undefined) where.isActive = isActive;

    if (req.query.q) {
        const query = `%${req.query.q}%`;
        where[Op.or] = [
            { username: { [Op.like]: query } },
            { email: { [Op.like]: query } },
            { fullName: { [Op.like]: query } }
        ];
    }

    // Trả danh sách thiết bị gán kèm tài khoản để giao diện Quản lý người dùng
    // dựng được cả chế độ 'Theo người dùng' và 'Theo thiết bị' mà không cần gọi N+1 API.
    const { rows, count } = await User.findAndCountAll({
        where,
        include: [{
            model: Device,
            as: 'devices',
            attributes: ['id', 'deviceCode', 'name', 'type'],
            through: { attributes: [] },
        }],
        distinct: true,
        limit,
        offset,
        order: [['id', 'ASC']]
    });

    res.json({ data: rows.map((row) => ({ ...userView(row), devices: row.devices || [] })), meta: meta(page, limit, count) });
};

exports.get = async (req, res) => {
    const user = await User.findByPk(req.params.id, {
        include: [{
            model: Device,
            as: 'devices',
            attributes: ['id', 'name', 'type'],
            through: { attributes: [] }
        }]
    });

    if (!user) throw ApiError.notFound('Không tìm thấy người dùng');

    res.json({ data: { ...userView(user), devices: user.devices || [] } });
};

exports.create = async (req, res) => {
    const {
        username,
        email,
        password,
        fullName,
        role = 'viewer'
    } = req.body || {};

    if (!username || !email || !password || !fullName) {
        throw ApiError.badRequest('Cần username, email, password, fullName');
    }

    if (String(password).length < 8) {
        throw ApiError.badRequest('Mật khẩu tối thiểu 8 ký tự');
    }

    if (!ROLES.includes(role)) {
        throw ApiError.badRequest(`role phải thuộc: ${ROLES.join(', ')}`);
    }

    const user = await User.create({
        username,
        email,
        fullName,
        role,
        passwordHash: await bcrypt.hash(String(password), 10)
    });

    await audit.log(req, {
        action: 'user.create',
        entityType: 'user',
        entityId: user.id,
        detail: { username, role }
    });

    res.status(201).json({ data: userView(user) });
};

exports.update = async (req, res) => {
    const user = await find(req.params.id);
    const { email, fullName, role, isActive, password } = req.body || {};

    const isSelf = String(user.id) === String(req.user.id);
    const previousRole = user.role;
    const previousIsActive = user.isActive;

    if (isSelf && ((role && role !== user.role) || isActive === false)) {
        throw ApiError.badRequest(
            'Không thể tự hạ quyền hoặc tự khóa tài khoản của chính mình'
        );
    }

    if (role !== undefined && !ROLES.includes(role)) {
        throw ApiError.badRequest(`role phải thuộc: ${ROLES.join(', ')}`);
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
        throw ApiError.badRequest('isActive phải là true/false');
    }

    if (email !== undefined) user.email = email;
    if (fullName !== undefined) user.fullName = fullName;
    if (role !== undefined) user.role = role;
    if (isActive !== undefined) user.isActive = isActive;

    if (password) {
        if (String(password).length < 8) {
            throw ApiError.badRequest('Mật khẩu tối thiểu 8 ký tự');
        }

        user.passwordHash = await bcrypt.hash(String(password), 10);
    }

    await user.save();

    // Với JWT stateless: cập nhật lại room nếu role/phạm vi thay đổi; chỉ ngắt socket khi tài khoản bị khóa.
    if (!user.isActive) socketService.disconnectUser(user.id);
    else await socketService.refreshUserRooms(user.id);

    await audit.log(req, {
        action: 'user.update',
        entityType: 'user',
        entityId: user.id,
        detail: {
            role,
            isActive,
            passwordChanged: !!password
        }
    });

    res.json({ data: userView(user) });
};

// Khóa tài khoản, không xóa cứng để giữ audit log
exports.deactivate = async (req, res) => {
    const user = await find(req.params.id);

    if (String(user.id) === String(req.user.id)) {
        throw ApiError.badRequest(
            'Không thể tự khóa tài khoản của chính mình'
        );
    }

    user.isActive = false;
    await user.save();
    socketService.disconnectUser(user.id);

    await audit.log(req, {
        action: 'user.deactivate',
        entityType: 'user',
        entityId: user.id
    });

    res.json({ data: userView(user) });
};

// PUT /users/:id/devices
// Body: { "deviceIds": [1, 2, 3] }
// Thay toàn bộ phạm vi thiết bị của user
exports.assignDevices = async (req, res) => {
    const user = await find(req.params.id);
    const deviceIds = req.body?.deviceIds;

    if (
        !Array.isArray(deviceIds) ||
        deviceIds.some((id) => !Number.isInteger(id))
    ) {
        throw ApiError.badRequest('deviceIds phải là mảng số nguyên');
    }

    const uniqueDeviceIds = [...new Set(deviceIds)];

    const foundCount = await Device.count({
        where: { id: { [Op.in]: uniqueDeviceIds } }
    });

    if (foundCount !== uniqueDeviceIds.length) {
        throw ApiError.badRequest('Có deviceId không tồn tại');
    }

    await sequelize.transaction(async (transaction) => {
        await UserDevice.destroy({
            where: { userId: user.id },
            transaction
        });

        if (uniqueDeviceIds.length) {
            await UserDevice.bulkCreate(
                uniqueDeviceIds.map((deviceId) => ({
                    userId: user.id,
                    deviceId
                })),
                { transaction }
            );
        }
    });

    await socketService.refreshUserRooms(user.id);

    await audit.log(req, {
        action: 'user.assign_devices',
        entityType: 'user',
        entityId: user.id,
        detail: { deviceIds: uniqueDeviceIds }
    });

    res.json({
        data: {
            userId: user.id,
            deviceIds: uniqueDeviceIds
        }
    });
};