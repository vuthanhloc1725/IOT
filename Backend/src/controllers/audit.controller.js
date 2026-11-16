const { AuditLog } = require('../models');
const { dateRange, toBool } = require('../utils/helpers');
const { paging, meta } = require('../utils/pagination');

exports.list = async (req, res) => {
    const { page, limit, offset } = paging(req);
    const where = { ...dateRange(req.query, 'createdAt') };
    for (const k of ['userId', 'action', 'entityType', 'entityId']) if (req.query[k]) where[k] = req.query[k];
    if (toBool(req.query.success) !== undefined) where.success = toBool(req.query.success);
    const { rows, count } = await AuditLog.findAndCountAll({
        where, limit, offset, order: [['id', 'DESC']],
        include: [{ association: 'user', attributes: ['id', 'username', 'role'] }],
    });
    res.json({ data: rows, meta: meta(page, limit, count) });
};
