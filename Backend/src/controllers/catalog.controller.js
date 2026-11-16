const ApiError = require('../utils/apiError');
const { pick } = require('../utils/helpers');
const audit = require('../services/audit.service');

// Bộ CRUD dùng chung cho diseases / treatments
module.exports = (Model, { label, fields, filters = [], include = [], order = [['id', 'ASC']] }) => ({
    list: async (req, res) => {
        const where = {};
        for (const f of filters) if (req.query[f] !== undefined) where[f] = req.query[f];
        res.json({ data: await Model.findAll({ where, include, order }) });
    },
    get: async (req, res) => {
        const row = await Model.findByPk(req.params.id, { include });
        if (!row) throw ApiError.notFound(`Không tìm thấy ${label}`);
        res.json({ data: row });
    },
    create: async (req, res) => {
        const row = await Model.create(pick(req.body, fields));
        await audit.log(req, { action: `${label}.create`, entityType: label, entityId: row.id });
        res.status(201).json({ data: row });
    },
    update: async (req, res) => {
        const row = await Model.findByPk(req.params.id);
        if (!row) throw ApiError.notFound(`Không tìm thấy ${label}`);
        await row.update(pick(req.body, fields));
        await audit.log(req, { action: `${label}.update`, entityType: label, entityId: row.id });
        res.json({ data: row });
    },
    remove: async (req, res) => {
        const row = await Model.findByPk(req.params.id);
        if (!row) throw ApiError.notFound(`Không tìm thấy ${label}`);
        await row.destroy(); // vi phạm FK sẽ trả 409 qua error handler
        await audit.log(req, { action: `${label}.delete`, entityType: label, entityId: row.id });
        res.status(204).end();
    },
});
