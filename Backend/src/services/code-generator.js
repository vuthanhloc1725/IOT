const { randomBytes } = require('crypto');

// Server-generated, opaque business identifiers. Never use these as MQTT credentials.
// 64 random bits keeps identifiers readable while making collisions extremely unlikely.
function candidate(prefix) {
    return `${prefix}-${randomBytes(8).toString('hex').toUpperCase()}`;
}

function isTargetUniqueViolation(error, field) {
    if (error?.name !== 'SequelizeUniqueConstraintError') return false;
    if (error.fields && Object.prototype.hasOwnProperty.call(error.fields, field)) return true;
    return Array.isArray(error.errors) && error.errors.some((item) => item.path === field);
}

async function createWithGeneratedCode({ prefix, Model, field, values, maxAttempts = 8 }) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const code = candidate(prefix);
        const existing = await Model.findOne({ where: { [field]: code }, attributes: ['id'] });
        if (existing) continue;

        try {
            const record = await Model.create({ ...values, [field]: code });
            return { record, code };
        } catch (error) {
            // A concurrent request could win the race after findOne; retry only if this
            // exact generated-code unique key collided. Other DB errors must propagate.
            if (isTargetUniqueViolation(error, field)) continue;
            throw error;
        }
    }
    const error = new Error(`Không thể sinh mã ${prefix} duy nhất sau ${maxAttempts} lần thử`);
    error.code = 'CODE_GENERATION_EXHAUSTED';
    throw error;
}


/**
 * Create a record first so MySQL can allocate its AUTO_INCREMENT id, then use
 * that id as the human-readable business code (NODE-001, DEV-001, ...).
 * Both writes run in one transaction; the unique index remains the final guard.
 * Existing records are deliberately not rewritten by this helper.
 */
function formatSequentialCode(prefix, id) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new Error('ID bản ghi không hợp lệ để tạo mã');
    return `${prefix}-${String(id).padStart(3, '0')}`;
}

async function createWithSequentialCode({ prefix, Model, field, values }) {
    if (!/^[A-Z]{2,10}$/.test(String(prefix))) throw new Error('Prefix mã không hợp lệ');
    if (!Model?.sequelize) throw new Error('Model chưa được gắn Sequelize instance');

    return Model.sequelize.transaction(async (transaction) => {
        const temporaryCode = `${prefix}-PENDING-${randomBytes(8).toString('hex').toUpperCase()}`;
        const record = await Model.create(
            { ...values, [field]: temporaryCode },
            { transaction }
        );
        const code = formatSequentialCode(prefix, record.id);
        await record.update({ [field]: code }, { transaction });
        return { record, code };
    });
}

// Mã tuần tự (NODE-001, DEV-001, CAM-001) là mặc định khi tạo mới; createWithGeneratedCode giữ lại cho mã ngẫu nhiên.
module.exports = { createWithSequentialCode, formatSequentialCode, createWithGeneratedCode };
