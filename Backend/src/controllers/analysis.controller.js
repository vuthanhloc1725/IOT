const { Op } = require('sequelize');
const { LeafAnalysis } = require('../models');
const ApiError = require('../utils/apiError');
const { dateRange } = require('../utils/helpers');
const { paging, meta } = require('../utils/pagination');
const analysisService = require('../services/analysis.service');
const imageStorage = require('../services/analysis-image.storage');
const { accessibleDeviceIds, getDeviceForUser } = require('../services/access.service');

// Kết quả AI không gắn thiết bị vẫn được hiển thị cho người dùng đã đăng nhập.
// Kết quả cũ có deviceId tiếp tục tuân theo phạm vi phân quyền từng thiết bị.
function analysisScope(ids, userId) {
    if (ids === null) return {};
    return {
        [Op.or]: [
            { deviceId: { [Op.in]: ids } },
            { deviceId: null, [Op.or]: [{ uploadedBy: userId }, { uploadedBy: null }] },
        ],
    };
}

async function assertAnalysisAccess(user, analysis) {
    if (analysis.deviceId) {
        await getDeviceForUser(user, analysis.deviceId);
        return;
    }
    if (user.role !== 'admin' && analysis.uploadedBy != null
        && Number(analysis.uploadedBy) !== Number(user.id)) {
        throw ApiError.notFound('Không tìm thấy kết quả phân tích');
    }
}

exports.list = async (req, res) => {
    const { page, limit, offset } = paging(req, 20);
    const deviceIds = await accessibleDeviceIds(req.user);
    const where = {
        ...analysisScope(deviceIds, req.user.id),
        ...dateRange(req.query, 'capturedAt'),
    };

    if (req.query.deviceId !== undefined && req.query.deviceId !== '') {
        const requestedDeviceId = Number(req.query.deviceId);
        if (!Number.isInteger(requestedDeviceId) || requestedDeviceId <= 0) {
            throw ApiError.badRequest('deviceId không hợp lệ');
        }
        await getDeviceForUser(req.user, requestedDeviceId);
        where.deviceId = requestedDeviceId;
    }



    const { rows, count } = await LeafAnalysis.findAndCountAll({
        where,
        limit,
        offset,
        order: [['capturedAt', 'DESC']],
        include: [
            { association: 'device', attributes: ['id', 'deviceCode', 'name'] },
        ],
    });

    const data = rows.map((row) => {
        const item = row.toJSON();
        return { ...item, imageUrl: item.imageUrl || (item.imagePath ? `/api/analyses/${item.id}/image` : null) };
    });
    res.json({ data, meta: meta(page, limit, count) });
};

// Chi tiết chỉ trả về tên lớp nhận diện và các thông số AI.
exports.get = async (req, res) => {
    const analysis = await LeafAnalysis.findByPk(req.params.id, {
        include: analysisService.fullInclude,
    });
    if (!analysis) throw ApiError.notFound('Không tìm thấy kết quả phân tích');

    await assertAnalysisAccess(req.user, analysis);

    res.json({
        data: analysis,
        imageUrl: analysis.imageUrl || (analysis.imagePath ? `/api/analyses/${analysis.id}/image` : null),
    });
};

// Ảnh không được public static: yêu cầu JWT và áp dụng cùng phạm vi quyền của kết quả nhận diện.
exports.image = async (req, res) => {
    const analysis = await LeafAnalysis.findByPk(req.params.id, {
        attributes: ['id', 'deviceId', 'uploadedBy', 'imagePath', 'imageUrl'],
    });
    if (!analysis) throw ApiError.notFound('Không tìm thấy kết quả phân tích');
    await assertAnalysisAccess(req.user, analysis);
    if (analysis.imageUrl) return res.redirect(302, analysis.imageUrl);
    if (!analysis.imagePath) throw ApiError.notFound('Kết quả này chưa có ảnh nhận diện');

    const image = await imageStorage.read(analysis.imagePath);
    res.set({
        'Content-Type': image.mimeType,
        'Content-Length': String(image.buffer.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.send(image.buffer);
};

