const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const wrap = require('../utils/wrap');
const ctrl = wrap(require('../controllers/camera.controller'));
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/rbac');
const cameraAuth = require('../middlewares/camera-auth');
const parseCameraUpload = require('../middlewares/camera-upload');

// ---- Admin: đăng ký Camera và cấp/thu hồi credential riêng ----
router.get('/', authenticate, requireRole('admin'), ctrl.listCameras);
router.post('/', authenticate, requireRole('admin'), ctrl.register);
router.post('/tokens/:cameraId', authenticate, requireRole('admin'), ctrl.issueToken);
router.delete('/tokens/:cameraId', authenticate, requireRole('admin'), ctrl.revokeToken);

// ---- Camera/Agent gửi ảnh trực tiếp (Bearer camera token, không cần JWT người dùng) ----
router.post(
    '/media',
    rateLimit({ windowMs: 60_000, limit: 30, message: { error: { status: 429, message: 'Upload quá nhiều, thử lại sau' } } }),
    cameraAuth,
    parseCameraUpload,
    ctrl.receiveMedia,
);

// ---- Xem / quản lý media lưu đĩa (JWT người dùng) ----
router.get('/media', authenticate, ctrl.list);
router.get('/media/:eventId/file', authenticate, ctrl.getFile);
router.delete('/media/:eventId', authenticate, requireRole('admin'), ctrl.deleteMedia);

module.exports = router;
