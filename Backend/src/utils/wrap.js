const asyncHandler = require('./asyncHandler');

// Express 4 không tự bắt lỗi async: bọc mọi hàm của controller để lỗi đi vào errorHandler
module.exports = (controller) =>
    Object.fromEntries(
        Object.entries(controller).map(([name, fn]) => [name, typeof fn === 'function' ? asyncHandler(fn) : fn])
    );
