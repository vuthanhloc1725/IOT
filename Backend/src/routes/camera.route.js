const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const camera = require('../controllers/camera.controller');
const { authenticateCamera } = require('../middlewares/cameraAuth');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/rbac');

// ---- Upload từ phone (xác thực bằng camera token) ----
router.post(
    '/media',
    rateLimit({ windowMs: 60_000, limit: 30, message: { error: { status: 429, message: 'Upload quá nhiều, thử lại sau' } } }),
    authenticateCamera,
    camera.upload,
);

// ---- Xem / quản lý (xác thực bằng JWT user) ----
router.get('/media', authenticate, camera.list);
router.get('/media/:eventId/file', authenticate, camera.getFile);
router.delete('/media/:eventId', authenticate, requireRole('admin'), camera.deleteMedia);

// ---- Admin quản lý camera token ----
router.get('/tokens', authenticate, requireRole('admin'), camera.listTokens);
router.post('/tokens', authenticate, requireRole('admin'), camera.createToken);
router.post('/tokens/:cameraId/reissue', authenticate, requireRole('admin'), camera.reissueToken);
router.post('/tokens/:cameraId/deactivate', authenticate, requireRole('admin'), camera.deactivateToken);

module.exports = router;
