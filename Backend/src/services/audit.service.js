const { AuditLog } = require('../models');

// Ghi nhật ký thao tác. Không bao giờ làm hỏng request chính nếu ghi log lỗi.
exports.log = async (req, { userId, action, entityType = null, entityId = null, detail = null, success = true }) => {
    try {
        await AuditLog.create({
            userId: userId ?? req?.user?.id ?? null,
            action,
            entityType: entityType,
            entityId: entityId,
            detail: { ...(detail || {}), ip: req?.ip },
            success,
        });
    } catch (e) {
        console.error('[audit] không ghi được log:', e.message);
    }
};
