const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { claim } = require('../utils/wrap')(require('../controllers/node.controller'));

router.post('/claim', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
}), claim);

module.exports = router;
