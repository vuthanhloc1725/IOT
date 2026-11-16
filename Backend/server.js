const http = require('http');
const env = require('./src/config/env');
const { sequelize } = require('./src/models');
const app = require('./app');
const socketService = require('./src/services/socket.service');
const mqttClient = require('./src/services/mqtt.client');
const ingest = require('./src/services/ingest.service');
const nodeService = require('./src/services/node.service');

async function syncDatabase() {
    switch (env.db.sync) {
        case 'force':
            console.warn('[db] DB_SYNC=force → XÓA và tạo lại toàn bộ bảng');
            await sequelize.sync({ force: true });
            break;
        case 'none':
            break;
        default: // 'safe': chỉ tạo bảng còn thiếu, không đụng dữ liệu
            await sequelize.sync();
    }
}

async function main() {
    await sequelize.authenticate();
    console.log(`[db] đã kết nối ${env.db.dialect}`);
    await syncDatabase();

    const server = http.createServer(app);
    server.on('error', (error) => {
        const message = error.code === 'EADDRINUSE'
            ? `Cổng HTTP ${env.port} đang được sử dụng. Dừng phiên backend đang chạy rồi khởi động lại.`
            : error.message;
        console.error('[server] không khởi động được:', message);
        process.exit(1);
    });
    socketService.init(server);          // Socket.IO dùng chung cổng với Express
    mqttClient.start(async (nodeCode, kind, payload) => {
        return ingest.handle(nodeCode, kind, payload);
    }, async () => nodeService.retryPendingConfigurations({ force: true })); // retry cấu hình chưa ACK sau connect/reconnect

    // Quét heartbeat + lệnh quá hạn ACK. Bọc try/catch để một lần lỗi không làm dừng vòng quét.
    let sweeping = false;
    const sweepTimer = setInterval(async () => {
        if (sweeping) return; // tránh chồng lấn nếu lần trước chưa xong
        sweeping = true;
        try {
            await nodeService.sweep();
        } catch (e) {
            console.error('[sweep] lỗi:', e.message);
        } finally {
            sweeping = false;
        }
    }, env.heartbeatSweepSec * 1000);

    server.listen(env.port, '0.0.0.0', () => console.log(`[http] listening on 0.0.0.0:${env.port} (${env.nodeEnv})`));

    // Tắt êm: ngừng nhận request, đóng MQTT và DB
    let closing = false;
    const shutdown = async (signal) => {
        if (closing) return;
        closing = true;
        console.log(`\n[server] nhận ${signal}, đang tắt...`);
        clearInterval(sweepTimer);
        const force = setTimeout(() => process.exit(1), 10000);
        force.unref();
        server.close();
        try {
            await mqttClient.stop();
            await sequelize.close();
        } finally {
            process.exit(0);
        }
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));

main().catch((e) => {
    console.error('[server] không khởi động được:', e.message);
    process.exit(1);
});
