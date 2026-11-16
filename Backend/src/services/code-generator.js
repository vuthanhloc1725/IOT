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

module.exports = { createWithGeneratedCode };
