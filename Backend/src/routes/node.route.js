const router = require('express').Router();
const ctrl = require('../utils/wrap')(require('../controllers/node.controller'));
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/rbac');

router.use(authenticate, requireRole('admin'));

router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.get('/:id', ctrl.get);
router.patch('/:id', ctrl.update);
router.post('/:id/revoke', ctrl.revoke);
router.post('/:id/restore', ctrl.restore);
router.post('/:id/mqtt-credentials', ctrl.issueMqttCredentials);
router.post('/:id/claim-token', ctrl.reissueClaimToken);
router.post('/:id/claim-reconcile', ctrl.reconcileClaim);

module.exports = router;
