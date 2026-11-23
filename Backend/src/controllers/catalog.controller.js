const ApiError = require('../utils/apiError');
const { pick } = require('../utils/helpers');
const audit = require('../services/audit.service');

// Bộ CRUD dùng chung cho danh mục bệnh và phương pháp điều trị.
module.exports = (Model, {
    label,
    fields,
    filters = [],
    include = [],
    order = [['id', 'ASC']],
    beforeWrite,
    beforeRemove,
}) => ({
    list: async (req, res) => {
        const where = {};
        for (const field of filters) {
            if (req.query[field] !== undefined) where[field] = req.query[field];
        }
        res.json({ data: await Model.findAll({ where, include, order }) });
    },
    get: async (req, res) => {
        const row = await Model.findByPk(req.params.id, { include });
        if (!row) throw ApiError.notFound(`Không tìm thấy ${label}`);
        res.json({ data: row });
    },
    create: async (req, res) => {
        const values = pick(req.body, fields);
        if (beforeWrite) await beforeWrite({ req, values, row: null, action: 'create' });
        const row = await Model.create(values);
        await audit.log(req, { action: `${label}.create`, entityType: label, entityId: row.id });
        res.status(201).json({ data: row });
    },
    update: async (req, res) => {
        const row = await Model.findByPk(req.params.id);
        if (!row) throw ApiError.notFound(`Không tìm thấy ${label}`);
        const values = pick(req.body, fields);
        if (beforeWrite) await beforeWrite({ req, values, row, action: 'update' });
        await row.update(values);
        await audit.log(req, { action: `${label}.update`, entityType: label, entityId: row.id });
        res.json({ data: row });
    },
    remove: async (req, res) => {
        const row = await Model.findByPk(req.params.id);
        if (!row) throw ApiError.notFound(`Không tìm thấy ${label}`);
        if (beforeRemove) await beforeRemove({ req, row });
        await row.destroy();
        await audit.log(req, { action: `${label}.delete`, entityType: label, entityId: row.id });
        res.status(204).end();
    },
});
