'use strict';

const express = require('express');
const router = express.Router();
const { authorizeDeviceAccess } = require('../middleware/auth');
const { getCatalog } = require('../services/hardwareCatalogService');
const { parseJson, validateConfiguration, saveApplyIntent } = require('../services/hardwareConfigService');

function errorJson(res, status, message, details) {
    return res.status(status).json({ success: false, message, ...(details ? { details } : {}) });
}

async function access(req, res, next) {
    try {
        req.authorizedDeviceId = await authorizeDeviceAccess(req, req.params.deviceId, {
            write: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
        });
        return next();
    } catch (error) {
        return errorJson(res, error.statusCode || 500, error.message || 'Device access denied');
    }
}

router.get('/:deviceId/hardware', access, async (req, res, next) => {
    try {
        const db = req.app.locals.db;
        const row = await db.get('SELECT * FROM device_hardware_configs WHERE device_id = ?', [req.authorizedDeviceId]);
        const jobs = await db.all(
            'SELECT action_id, requested_revision, requested_hash, status, error_json, created_at, updated_at FROM device_hardware_apply_jobs WHERE device_id = ? ORDER BY updated_at DESC LIMIT 20',
            [req.authorizedDeviceId]
        );
        return res.json({
            success: true,
            catalog: getCatalog(),
            desired: row ? { revision: row.desired_revision, hash: row.desired_hash, configuration: parseJson(row.desired_json) } : null,
            applied: row ? { revision: row.applied_revision, hash: row.applied_hash, configuration: parseJson(row.applied_json) } : null,
            observed: row ? { revision: row.observed_revision, hash: row.observed_hash, state: parseJson(row.observed_json) } : null,
            jobs: jobs.map(job => ({ ...job, error: parseJson(job.error_json) }))
        });
    } catch (error) { return next(error); }
});

router.post('/:deviceId/hardware/validate', access, async (req, res, next) => {
    try {
        const result = validateConfiguration(req.app.locals.db, req.authorizedDeviceId, req.body?.configuration || req.body);
        return res.status(result.valid ? 200 : 422).json({ success: result.valid, ...result });
    } catch (error) {
        if (error.statusCode) return errorJson(res, error.statusCode, error.message, error.details);
        return next(error);
    }
});

router.post('/:deviceId/hardware/apply', access, async (req, res, next) => {
    try {
        const result = saveApplyIntent(req.app.locals.db, {
            deviceId: req.authorizedDeviceId,
            configuration: req.body?.configuration || req.body,
            expectedRevision: req.body?.expectedRevision,
            createdBy: req.user?.id || req.session?.user?.id || null
        });
        return res.status(202).json(result);
    } catch (error) {
        if (error.statusCode) return errorJson(res, error.statusCode, error.message, error.details);
        if (error.code === 'SQLITE_BUSY') return errorJson(res, 503, 'Hardware configuration storage is busy; retry after reloading');
        return next(error);
    }
});
router.get('/:deviceId/hardware/jobs/:actionId', access, async (req, res, next) => {
    try {
        const row = await req.app.locals.db.get(
            'SELECT * FROM device_hardware_apply_jobs WHERE action_id = ? AND device_id = ?',
            [req.params.actionId, req.authorizedDeviceId]
        );
        if (!row) return errorJson(res, 404, 'Hardware apply job not found');
        return res.json({ success: true, job: { ...row, configuration: parseJson(row.requested_config_json), error: parseJson(row.error_json) } });
    } catch (error) { return next(error); }
});

module.exports = router;
