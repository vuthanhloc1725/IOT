const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const env = require('./src/config/env');
const routes = require('./src/routes');
const { notFound, errorHandler } = require('./src/middlewares/error');

const app = express();

app.set('trust proxy', 1); // đúng IP người dùng khi chạy sau nginx/proxy (ảnh hưởng rate limit và audit log)

// ---- Middleware chung ----
app.use(helmet());
app.use(
    cors({
        origin: env.corsOrigin === '*' ? true : env.corsOrigin.split(',').map((s) => s.trim()),
        credentials: true,
    })
);
app.use(express.json({ limit: '1mb' }));
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : ':method :url :status - :response-time ms'));

// ---- Chặn dò mật khẩu: tối đa 20 lần đăng nhập / 15 phút / IP ----
app.use(
    '/api/auth/login',
    rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 20,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: { status: 429, message: 'Đăng nhập quá nhiều lần, thử lại sau 15 phút' } },
    })
);

// ---- Kiểm tra server còn sống ----
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ---- API ----
app.use('/api', routes);

// ---- Xử lý lỗi (phải đặt cuối cùng) ----
app.use(notFound);
app.use(errorHandler);

module.exports = app;