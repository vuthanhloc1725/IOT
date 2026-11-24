const { QueryTypes } = require('sequelize');
const { sequelize, SensorReading } = require('../models');
const { METRICS } = require('../constants');
const ApiError = require('../utils/apiError');
const { dateRange } = require('../utils/helpers');
const { accessibleDeviceIds, getDeviceForUser } = require('../services/access.service');

// GET /devices/:id/readings?metric=&from=&to=&limit=   (trả về tăng dần theo thời gian, sẵn để vẽ biểu đồ)
exports.byDevice = async (req, res) => {
    const device = await getDeviceForUser(req.user, req.params.id);
    const where = { deviceId: device.id, ...dateRange(req.query, 'recordedAt') };
    if (req.query.metric) {
        if (!METRICS.includes(req.query.metric)) throw ApiError.badRequest(`metric phải thuộc: ${METRICS.join(', ')}`);
        where.metric = req.query.metric;
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
    const rows = await SensorReading.findAll({ where, order: [['recordedAt', 'DESC']], limit });
    res.json({ data: rows.reverse() });
};

// GET /readings/latest — giá trị mới nhất của từng (thiết bị, metric) mà user được xem
exports.latest = async (req, res) => {
    const ids = await accessibleDeviceIds(req.user);
    if (ids && !ids.length) return res.json({ data: [] });
    const sql = `
    SELECT r.deviceId, r.metric, r.recordedAt, r.value, r.isBackfilled
    FROM sensorReadings r
    JOIN (SELECT deviceId, metric, MAX(recordedAt) AS m FROM sensorReadings GROUP BY deviceId, metric) x
      ON x.deviceId = r.deviceId AND x.metric = r.metric AND x.m = r.recordedAt
    ${ids ? 'WHERE r.deviceId IN (:ids)' : ''}`;
    const rows = await sequelize.query(sql, { type: QueryTypes.SELECT, ...(ids ? { replacements: { ids } } : {}) });
    res.json({ data: rows.map((r) => ({ ...r, value: Number(r.value) })) });
};
