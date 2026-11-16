const ApiError = require('../utils/apiError');

exports.notFound = (req, res, next) => next(ApiError.notFound(`Không có route ${req.method} ${req.originalUrl}`));

// eslint-disable-next-line no-unused-vars
exports.errorHandler = (err, req, res, next) => {
    let status = err.status || 500;
    let message = err.message;
    let details = err.details;

    switch (err.name) {
        case 'SequelizeValidationError':
            status = 400;
            message = 'Dữ liệu không hợp lệ';
            details = err.errors.map((e) => ({ field: e.path, message: e.message }));
            break;
        case 'SequelizeUniqueConstraintError':
            status = 409;
            message = 'Dữ liệu bị trùng';
            details = err.errors.map((e) => ({ field: e.path, message: `${e.path} đã tồn tại` }));
            break;
        case 'SequelizeForeignKeyConstraintError':
            status = 409;
            message = 'Vi phạm ràng buộc khóa ngoại (bản ghi đang được tham chiếu hoặc tham chiếu không tồn tại)';
            break;
        default:
    }

    if (status >= 500) {
        console.error('[error]', err);
        message = process.env.NODE_ENV === 'production' ? 'Lỗi máy chủ' : message;
    }
    const code = err instanceof ApiError ? err.code : undefined;
    res.status(status).json({ error: { status, ...(code ? { code } : {}), message, details } });
};
