class ApiError extends Error {
    constructor(status, message, details, code) {
        super(message);
        this.status = status;
        this.details = details;
        this.code = code;
    }
    // `code` là mã máy-đọc-được (ví dụ CLAIM_TOKEN_EXPIRED) để firmware/frontend xử lý không cần phân tích message.
    static coded(status, code, message, details) { return new ApiError(status, message, details, code); }
    static badRequest(m, d) { return new ApiError(400, m, d); }
    static unauthorized(m = 'Chưa đăng nhập') { return new ApiError(401, m); }
    static forbidden(m = 'Không có quyền') { return new ApiError(403, m); }
    static notFound(m = 'Không tìm thấy') { return new ApiError(404, m); }
    static conflict(m) { return new ApiError(409, m); }
    static unprocessable(m) { return new ApiError(422, m); }
}
module.exports = ApiError;
