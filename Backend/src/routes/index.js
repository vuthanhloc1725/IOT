const router = require('express').Router();

router.use('/auth', require('./auth.route'));
router.use('/users', require('./user.route'));
router.use('/nodes', require('./node.route'));
router.use('/provisioning', require('./provisioning.route'));
router.use('/devices', require('./device.route'));
router.use('/readings', require('./reading.route'));
router.use('/alerts', require('./alert.route'));
router.use('/analyses', require('./analysis.route'));
router.use('/audit-logs', require('./audit.route'));
router.use('/dashboard', require('./dashboard.route'));
router.use('/camera', require('./camera.route'));
router.use('/', require('./catalog.route')); // /diseases /treatments

module.exports = router;
