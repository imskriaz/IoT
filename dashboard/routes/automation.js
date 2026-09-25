'use strict';
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { resolveDeviceId } = require('../utils/deviceResolver');
const automationEngine = require('../services/automationEngine');
const { withEffectiveRole } = require('../middleware/auth');

// ─── Ownership & device authorization (SEC-03) ───────────────────────────────

function isFlowAdmin(req) {
    const user = withEffectiveRole(req.user || req.session?.user);
    return user?.role === 'admin' || user?.role === 'superadmin';
}

/** Flow is readable/writable by its owner or an admin. */
async function assertFlowOwnership(req, db, flowId) {
    const flow = await db.get('SELECT id, user_id, device_id FROM automation_flows WHERE id = ?', [flowId]);
    if (!flow) {
        const err = new Error('Flow not found');
        err.statusCode = 404;
        throw err;
    }
    const user = withEffectiveRole(req.user || req.session?.user);
    if (!isFlowAdmin(req) && Number(flow.user_id) !== Number(user?.id)) {
        const err = new Error('Flow not owned by you');
        err.statusCode = 403;
        throw err;
    }
    return flow;
}

/** The flow's target device must be assigned with write access (admin bypass). */
async function assertFlowDeviceAccess(req, db, deviceId) {
    if (!deviceId) return;
    if (isFlowAdmin(req)) return;
    const user = withEffectiveRole(req.user || req.session?.user);
    const assignment = await db.get(
        'SELECT can_write FROM device_users WHERE device_id = ? AND user_id = ?',
        [deviceId, user?.id ?? -1]
    );
    if (!assignment || !Number(assignment.can_write)) {
        const err = new Error('Write access to the target device is required');
        err.statusCode = 403;
        throw err;
    }
}

function ownershipErrorResponse(res, err) {
    if (err.statusCode === 404) return res.status(404).json({ success: false, message: err.message });
    if (err.statusCode === 403) return res.status(403).json({ success: false, message: err.message });
    throw err;
}

function flowVisibilityCondition(req) {
    // Legacy rows (user_id NULL) stay admin-only; new flows are owner-scoped.
    return isFlowAdmin(req) ? '' : 'AND user_id = ?';
}

function flowVisibilityParams(req) {
    if (isFlowAdmin(req)) return [];
    const user = withEffectiveRole(req.user || req.session?.user);
    return [user?.id ?? -1];
}

// ─── List flows ───────────────────────────────────────────────
router.get('/flows', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const flows = await db.all(
            `SELECT id, name, description, enabled, device_id, created_at, updated_at,
                    last_triggered, trigger_count, last_result
             FROM automation_flows WHERE 1=1 ${flowVisibilityCondition(req)} ORDER BY updated_at DESC`,
            flowVisibilityParams(req)
        );
        res.json({ success: true, flows });
    } catch (e) {
        logger.error('GET /api/automation/flows error:', e);
        res.status(500).json({ success: false, message: 'Failed to load flows' });
    }
});

// ─── Get one flow (full with nodes/edges) ────────────────────
router.get('/flows/:id', async (req, res) => {
    try {
        const db = req.app.locals.db;
        let flow;
        try {
            await assertFlowOwnership(req, db, req.params.id);
            flow = await db.get('SELECT * FROM automation_flows WHERE id = ?', [req.params.id]);
        } catch (err) { return ownershipErrorResponse(res, err); }
        if (!flow) return res.status(404).json({ success: false, message: 'Flow not found' });
        try { flow.nodes = JSON.parse(flow.nodes); } catch { flow.nodes = []; }
        try { flow.edges = JSON.parse(flow.edges); } catch { flow.edges = []; }
        res.json({ success: true, flow });
    } catch (e) {
        logger.error('GET /api/automation/flows/:id error:', e);
        res.status(500).json({ success: false, message: 'Failed to load flow' });
    }
});

// ─── Create flow ─────────────────────────────────────────────
router.post('/flows', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const user = withEffectiveRole(req.user || req.session?.user);
        const { name = 'New Flow', description = '', nodes = [], edges = [], enabled = 1, device_id } = req.body;
        const deviceId = device_id || resolveDeviceId(req, DEFAULT_DEVICE_ID);
        try {
            await assertFlowDeviceAccess(req, db, deviceId);
        } catch (err) { return ownershipErrorResponse(res, err); }
        const result = await db.run(
            `INSERT INTO automation_flows (name, description, nodes, edges, enabled, device_id, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [name.slice(0,200), description.slice(0,500), JSON.stringify(nodes), JSON.stringify(edges), enabled ? 1 : 0, deviceId, user?.id ?? null]
        );
        automationEngine.invalidateCache();
        const flow = await db.get('SELECT * FROM automation_flows WHERE id = ?', [result.lastID]) || {
            id: result.lastID,
            name: name.slice(0, 200),
            description: description.slice(0, 500),
            nodes,
            edges,
            enabled: enabled ? 1 : 0,
            device_id: deviceId
        };
        if (global.io) global.io.to(`user:${user?.id}`).emit('automation:flow:created', { id: flow.id, name: flow.name });
        res.status(201).json({ success: true, flow });
    } catch (e) {
        logger.error('POST /api/automation/flows error:', e);
        res.status(500).json({ success: false, message: 'Failed to create flow' });
    }
});

// ─── Update flow ─────────────────────────────────────────────
router.put('/flows/:id', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const user = withEffectiveRole(req.user || req.session?.user);
        const { name, description, nodes, edges, enabled, device_id } = req.body;
        let existing;
        try {
            existing = await assertFlowOwnership(req, db, req.params.id);
        } catch (err) { return ownershipErrorResponse(res, err); }
        const resolvedDeviceId = device_id || existing.device_id || resolveDeviceId(req, DEFAULT_DEVICE_ID);
        try {
            await assertFlowDeviceAccess(req, db, resolvedDeviceId);
        } catch (err) { return ownershipErrorResponse(res, err); }
        await db.run(
            `UPDATE automation_flows SET name=?, description=?, nodes=?, edges=?, enabled=?, device_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
            [
                (name||'').slice(0,200),
                (description||'').slice(0,500),
                JSON.stringify(nodes||[]),
                JSON.stringify(edges||[]),
                enabled !== false ? 1 : 0,
                resolvedDeviceId,
                req.params.id
            ]
        );
        automationEngine.invalidateCache();
        const flow = await db.get('SELECT * FROM automation_flows WHERE id = ?', [req.params.id]);
        try { flow.nodes = JSON.parse(flow.nodes); } catch { flow.nodes = []; }
        try { flow.edges = JSON.parse(flow.edges); } catch { flow.edges = []; }
        if (global.io) global.io.to(`user:${user?.id}`).emit('automation:flow:updated', { id: flow.id });
        res.json({ success: true, flow });
    } catch (e) {
        logger.error('PUT /api/automation/flows/:id error:', e);
        res.status(500).json({ success: false, message: 'Failed to update flow' });
    }
});

// ─── Toggle enabled ───────────────────────────────────────────
router.patch('/flows/:id/toggle', async (req, res) => {
    try {
        const db = req.app.locals.db;
        try {
            await assertFlowOwnership(req, db, req.params.id);
        } catch (err) { return ownershipErrorResponse(res, err); }
        const flow = await db.get('SELECT id, enabled FROM automation_flows WHERE id = ?', [req.params.id]);
        if (!flow) return res.status(404).json({ success: false, message: 'Flow not found' });
        const newEnabled = flow.enabled ? 0 : 1;
        await db.run('UPDATE automation_flows SET enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [newEnabled, req.params.id]);
        automationEngine.invalidateCache();
        res.json({ success: true, enabled: !!newEnabled });
    } catch (e) {
        logger.error('PATCH /api/automation/flows/:id/toggle error:', e);
        res.status(500).json({ success: false, message: 'Failed to toggle flow' });
    }
});

// ─── Delete flow ─────────────────────────────────────────────
router.delete('/flows/:id', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const user = withEffectiveRole(req.user || req.session?.user);
        try {
            await assertFlowOwnership(req, db, req.params.id);
        } catch (err) { return ownershipErrorResponse(res, err); }
        await db.run('DELETE FROM automation_flows WHERE id = ?', [req.params.id]);
        automationEngine.invalidateCache();
        if (global.io) global.io.to(`user:${user?.id}`).emit('automation:flow:deleted', { id: parseInt(req.params.id) });
        res.json({ success: true });
    } catch (e) {
        logger.error('DELETE /api/automation/flows/:id error:', e);
        res.status(500).json({ success: false, message: 'Failed to delete flow' });
    }
});

// ─── Manual test run ─────────────────────────────────────────
router.post('/flows/:id/run', async (req, res) => {
    try {
        const db = req.app.locals.db;
        try {
            await assertFlowOwnership(req, db, req.params.id);
        } catch (err) { return ownershipErrorResponse(res, err); }
        const result = await automationEngine.testRun(parseInt(req.params.id), req.body || {});
        res.json({ success: true, ...result });
    } catch (e) {
        logger.error('POST /api/automation/flows/:id/run error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// ─── Execution logs ───────────────────────────────────────────
router.get('/flows/:id/logs', async (req, res) => {
    try {
        const db = req.app.locals.db;
        try {
            await assertFlowOwnership(req, db, req.params.id);
        } catch (err) { return ownershipErrorResponse(res, err); }
        const limit = Math.min(parseInt(req.query.limit)||50, 200);
        const logs = await db.all(
            `SELECT id, status, trigger, log, created_at FROM automation_logs
             WHERE flow_id = ? ORDER BY created_at DESC LIMIT ?`,
            [req.params.id, limit]
        );
        res.json({ success: true, logs });
    } catch (e) {
        logger.error('GET /api/automation/flows/:id/logs error:', e);
        res.status(500).json({ success: false, message: 'Failed to load logs' });
    }
});

module.exports = router;
