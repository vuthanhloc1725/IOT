const router = require('express').Router();
const ctrl = require('../utils/wrap')(require('../controllers/analysis.controller'));
const { authenticate } = require('../middlewares/auth');

// Phân hệ chỉ đọc kết quả AI; Camera gửi ảnh và kích hoạt pipeline qua /api/camera/media.
router.use(authenticate);
router.get('/', ctrl.list);
router.get('/:id/image', ctrl.image);
router.get('/:id', ctrl.get);

module.exports = router;
