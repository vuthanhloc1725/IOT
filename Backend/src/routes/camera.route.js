const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const wrap = require('../utils/wrap');
const ctrl = wrap(require('../controllers/camera.controller'));
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/rbac');
const cameraAuth = require('../middlewares/camera-auth');
const parseCameraUpload = require('../middlewares/image-upload');

const cameraLifecycle = require('../services/camera-lifecycle.service');

// Upload chỉ nhận khi Camera PROVISIONED/ACTIVE; kiểm tra trước khi đọc file để không tốn băng thông.
const acceptingUploads = (req, _res, next) => {
    try { cameraLifecycle.assertCanUpload(req.camera); next(); } catch (err) { next(err); }
};

// ---- Danh sách Camera: Admin thấy tất cả, người dùng chỉ thấy Camera được gán ----
router.get('/', authenticate, ctrl.listCameras);

// ---- Admin: đăng ký Camera và cấp/thu hồi credential riêng ----
router.post('/', authenticate, requireRole('admin'), ctrl.register);
router.get('/server-hints', authenticate, requireRole('admin'), ctrl.serverHints);
router.post('/tokens/:cameraId', authenticate, requireRole('admin'), ctrl.issueToken);
router.delete('/tokens/:cameraId', authenticate, requireRole('admin'), ctrl.revokeToken);

// ---- Camera/Agent: heartbeat + gửi ảnh trực tiếp (Bearer camera token, không cần JWT người dùng) ----
router.post(
    '/heartbeat',
    rateLimit({ windowMs: 60_000, limit: 30, message: { error: { status: 429, message: 'Heartbeat quá dày, thử lại sau' } } }),
    cameraAuth,
    ctrl.heartbeat,
);
router.post(
    '/media',
    rateLimit({ windowMs: 60_000, limit: 30, message: { error: { status: 429, message: 'Upload quá nhiều, thử lại sau' } } }),
    cameraAuth,
    acceptingUploads,
    parseCameraUpload,
    ctrl.receiveMedia,
);

// ---- Agent: long-poll nhận lệnh "chụp ngay" + ack kết quả (mỗi poll giữ ≤ 25s nên 60/phút là dư) ----
router.post(
    '/commands/poll',
    rateLimit({ windowMs: 60_000, limit: 60, message: { error: { status: 429, message: 'Poll lệnh quá dày, thử lại sau' } } }),
    cameraAuth,
    ctrl.pollCommands,
);
router.post(
    '/commands/:requestId/ack',
    rateLimit({ windowMs: 60_000, limit: 60, message: { error: { status: 429, message: 'Ack quá nhiều, thử lại sau' } } }),
    cameraAuth,
    ctrl.ackCommand,
);

// ---- Web: đổi chu kỳ chụp (Admin), chụp ngay + xem trạng thái lệnh (Admin hoặc người được gán Camera) ----
router.patch('/:cameraId/config', authenticate, requireRole('admin'), ctrl.updateConfig);
router.post(
    '/:cameraId/capture',
    authenticate,
    rateLimit({ windowMs: 60_000, limit: 10, message: { error: { status: 429, message: 'Bấm chụp quá nhanh, thử lại sau' } } }),
    ctrl.captureNow,
);
router.get('/:cameraId/commands/:requestId', authenticate, ctrl.commandStatus);

// ---- Xem / quản lý media lưu đĩa (JWT người dùng) ----
router.get('/media', authenticate, ctrl.list);
router.get('/media/:eventId/file', authenticate, ctrl.getFile);
router.delete('/media/:eventId', authenticate, requireRole('admin'), ctrl.deleteMedia);

module.exports = router;
