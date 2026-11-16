const router = require('express').Router();
const ctrl = require('../utils/wrap')(require('../controllers/analysis.controller'));
const { authenticate } = require('../middlewares/auth');

// Lịch sử kết quả AI đọc qua JWT; Camera gửi ảnh qua /api/camera/media.
router.use(authenticate);
router.get('/', ctrl.list);
router.get('/:id/image', ctrl.image);
router.get('/:id', ctrl.get);

module.exports = router;
