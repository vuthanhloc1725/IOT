const router = require('express').Router();
const wrap = require('../utils/wrap');
const device = wrap(require('../controllers/device.controller'));
const reading = wrap(require('../controllers/reading.controller'));
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/rbac');

router.use(authenticate);

// Xem: mọi vai trò (Viewer/Operator chỉ thấy thiết bị được gán)
router.get('/', device.list);
router.get('/:id', device.get);
router.get('/:id/readings', reading.byDevice);
router.get('/:id/commands', device.listCommands);

// Điều khiển bơm/quạt: Admin + Operator. Viewer bị 403 ở đây (kịch bản demo bước 4)
router.post('/:id/commands', requireRole('admin', 'operator'), device.sendCommand);
router.patch('/:id/config', requireRole('admin', 'operator'), device.updateConfig);

// Legacy probe endpoint dành cho firmware đời trước. Firmware v1.2 dùng inventory qua POST /.
router.post('/probe', requireRole('admin'), device.probeAndRegister);
router.post('/', requireRole('admin'), device.create); // đăng ký theo inventory Firmware v1.2
// Tạo/sửa thiết bị: Admin. Operator được đổi vòng đời trong phạm vi thiết bị được gán.
router.patch('/:id', requireRole('admin'), device.update);
router.post('/:id/lifecycle', requireRole('admin', 'operator'), device.changeLifecycle);

module.exports = router;
