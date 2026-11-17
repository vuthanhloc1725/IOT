const router = require('express').Router();
const ctrl = require('../utils/wrap')(require('../controllers/analysis.controller'));
const { authenticate } = require('../middlewares/auth');
const parseImageUpload = require('../middlewares/image-upload');

// Lịch sử và tải ảnh trực tiếp cần JWT; Camera gửi ảnh qua /api/camera/media.
router.use(authenticate);
router.post('/predict', parseImageUpload, ctrl.predict);
router.get('/', ctrl.list);
router.get('/:id/image', ctrl.image);
router.get('/:id', ctrl.get);

module.exports = router;
