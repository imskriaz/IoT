const express = require('express');
const router = express.Router();

router.use('/sms', require('./sms'));
router.use('/calls', require('./calls'));
router.use('/contacts', require('./contacts'));
router.use('/status', require('./status'));
router.use('/modem', require('./modem'));
router.use('/ussd', require('./ussd'));
router.use('/intercom', require('./intercom'));
router.use('/settings', require('./settings'));
router.use('/storage', require('./storage'));
router.use('/location', require('./location'));
router.use('/test', require('./test'));
router.use('/logs', require('./logs'));
router.use('/ota', require('./ota'));
router.use('/devices', require('./devices'));
router.use('/gpio', require('./gpio'));
router.use('/queue', require('./queue'));

module.exports = router;
