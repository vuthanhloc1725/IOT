const { fn, col, Op } = require('sequelize');
const { Device, Node, Alert, LeafAnalysis, SensorReading } = require('../models');
const { METRICS } = require('../constants');
const ApiError = require('../utils/apiError');
const { dateRange } = require('../utils/helpers');
const { accessibleDeviceIds, scopeWhere, getDeviceForUser } = require('../services/access.service');

function scopeAnalysisWhere(ids) {
    if (ids === null) return {};
    return { [Op.or]: [{ deviceId: { [Op.in]: ids } }, { deviceId: null }] };
}

function scopeAlertWhere(ids) {
    if (ids === null) return {};
    return { [Op.or]: [
        { deviceId: { [Op.in]: ids } },
        { deviceId: null, type: 'disease', analysisId: { [Op.not]: null } },
    ] };
}

exports.summary = async (req, res) => {
    const ids = await accessibleDeviceIds(req.user);
    const dWhere = scopeWhere(ids, 'id');
    const alertWhere = scopeAlertWhere(ids);
    const analysisWhere = scopeAnalysisWhere(ids);
    const [byLifecycle, alertsBySeverity, latestAnalyses] = await Promise.all([
        Device.findAll({ attributes: ['lifecycle', [fn('COUNT', col('id')), 'count']], where: dWhere, group: ['lifecycle'], raw: true }),
        Alert.findAll({ attributes: ['severity', [fn('COUNT', col('id')), 'count']], where: { ...alertWhere, status: { [Op.ne]: 'RESOLVED' } }, group: ['severity'], raw: true }),
        LeafAnalysis.findAll({
            where: analysisWhere, limit: 5, order: [['capturedAt', 'DESC']],
            include: [{ association: 'disease', attributes: ['id', 'nameVi', 'isHealthy'] }, { association: 'device', attributes: ['id', 'name'] }],
        }),
    ]);
    const data = {
        devicesByLifecycle: byLifecycle.map((r) => ({ lifecycle: r.lifecycle, count: Number(r.count) })),
        openAlertsBySeverity: alertsBySeverity.map((r) => ({ severity: r.severity, count: Number(r.count) })),
        latestAnalyses: latestAnalyses.map((analysis) => {
            const item = analysis.toJSON();
            return { ...item, imageUrl: item.imageUrl || (item.imagePath ? `/api/analyses/${item.id}/image` : null) };
        }),
    };
    if (req.user.role === 'admin') {
        data.nodes = { total: await Node.count(), online: await Node.count({ where: { isOnline: true } }) };
    }
    res.json({ data });
};
// Chuỗi readings cho biểu đồ dashboard. Mặc định lấy 24 giờ gần nhất.
// GET /api/dashboard/telemetry?from=&to=&deviceId=&metric=&limit=
exports.telemetry = async (req, res) => {
    const ids = await accessibleDeviceIds(req.user);
    const where = { ...scopeWhere(ids, 'deviceId') };
    const range = dateRange(req.query, 'recordedAt');
    Object.assign(where, range);
    if (!req.query.from && !req.query.to) {
        where.recordedAt = { [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000) };
    } else {
        const from = req.query.from ? new Date(req.query.from) : null;
        const to = req.query.to ? new Date(req.query.to) : null;
        if (from && to && from > to) throw ApiError.badRequest('from phải nhỏ hơn hoặc bằng to');
    }
    if (req.query.deviceId !== undefined) {
        const id = Number(req.query.deviceId);
        if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('deviceId không hợp lệ');
        // getDeviceForUser ensures an operator cannot query another user's device.
        await getDeviceForUser(req.user, id);
        where.deviceId = id;
    }
    if (req.query.metric) {
        if (!METRICS.includes(req.query.metric)) throw ApiError.badRequest(`metric phải thuộc: ${METRICS.join(', ')}`);
        where.metric = req.query.metric;
    } else {
        where.metric = { [Op.in]: ['SOIL_MOISTURE', 'AIR_TEMPERATURE', 'AIR_HUMIDITY'] };
    }
    if (ids && ids.length === 0) return res.json({ data: [], meta: { count: 0 } });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 2000, 1), 5000);
    const rows = await SensorReading.findAll({
        where,
        include: [{ association: 'device', attributes: ['id', 'deviceCode', 'name', 'type'] }],
        order: [['recordedAt', 'ASC']],
        limit,
    });
    res.json({ data: rows, meta: { count: rows.length, limit } });
};
