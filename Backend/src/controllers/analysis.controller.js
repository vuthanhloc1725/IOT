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
function analysisScope(ids) {
    if (ids === null) return {};
    return {
        [Op.or]: [
            { deviceId: { [Op.in]: ids } },
            { deviceId: null },
        ],
    };
}

exports.list = async (req, res) => {
    const { page, limit, offset } = paging(req, 20);
    const deviceIds = await accessibleDeviceIds(req.user);
    const where = {
        ...analysisScope(deviceIds),
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

    if (req.query.diseaseId) {
        const diseaseId = Number(req.query.diseaseId);
        if (!Number.isInteger(diseaseId) || diseaseId <= 0) throw ApiError.badRequest('diseaseId không hợp lệ');
        where.diseaseId = diseaseId;
    }

    const { rows, count } = await LeafAnalysis.findAndCountAll({
        where,
        limit,
        offset,
        order: [['capturedAt', 'DESC']],
        include: [
            { association: 'device', attributes: ['id', 'deviceCode', 'name'] },
            { association: 'disease', attributes: ['id', 'nameVi', 'nameEn', 'isHealthy'] },
        ],
    });

    const data = rows.map((row) => {
        const item = row.toJSON();
        return { ...item, imageUrl: item.imageUrl || (item.imagePath ? `/api/analyses/${item.id}/image` : null) };
    });
    res.json({ data, meta: meta(page, limit, count) });
};

// Chi tiết kết quả + phác đồ điều trị theo bệnh trong danh mục.
exports.get = async (req, res) => {
    const analysis = await LeafAnalysis.findByPk(req.params.id, {
        include: analysisService.fullInclude,
    });
    if (!analysis) throw ApiError.notFound('Không tìm thấy kết quả phân tích');

    if (analysis.deviceId) await getDeviceForUser(req.user, analysis.deviceId);

    const treatments = [...(analysis.disease?.treatments || [])];
    res.json({
        data: analysis,
        imageUrl: analysis.imageUrl || (analysis.imagePath ? `/api/analyses/${analysis.id}/image` : null),
        recommendations: {
            biological: treatments.filter((treatment) => treatment.type === 'BIOLOGICAL'),
            chemical: treatments.filter((treatment) => treatment.type === 'CHEMICAL'),
        },
    });
};

// Ảnh không được public static: yêu cầu JWT và áp dụng cùng phạm vi quyền của kết quả nhận diện.
exports.image = async (req, res) => {
    const analysis = await LeafAnalysis.findByPk(req.params.id, {
        attributes: ['id', 'deviceId', 'imagePath', 'imageUrl'],
    });
    if (!analysis) throw ApiError.notFound('Không tìm thấy kết quả phân tích');
    if (analysis.deviceId) await getDeviceForUser(req.user, analysis.deviceId);
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

