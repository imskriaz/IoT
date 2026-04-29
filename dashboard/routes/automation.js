'use strict';
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { resolveDeviceId } = require('../utils/deviceResolver');

function getAutomationEngine(req) {
    return req.app.locals.automationEngine || require('../services/automationEngine');
}

// ─── List flows ───────────────────────────────────────────────
router.get('/flows', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const flows = await db.all(
            `SELECT id, name, description, enabled, device_id, created_at, updated_at,
                    last_triggered, trigger_count, last_result
             FROM automation_flows ORDER BY updated_at DESC`
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
        const flow = await db.get('SELECT * FROM automation_flows WHERE id = ?', [req.params.id]);
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
        const { name = 'New Flow', description = '', nodes = [], edges = [], enabled = 1, device_id } = req.body;
        const deviceId = device_id || resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const result = await db.run(
            `INSERT INTO automation_flows (name, description, nodes, edges, enabled, device_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [name.slice(0,200), description.slice(0,500), JSON.stringify(nodes), JSON.stringify(edges), enabled ? 1 : 0, deviceId]
        );
        getAutomationEngine(req).invalidateCache();
        const flow = await db.get('SELECT * FROM automation_flows WHERE id = ?', [result.lastID]) || {
            id: result.lastID,
            name: name.slice(0, 200),
            description: description.slice(0, 500),
            nodes,
            edges,
            enabled: enabled ? 1 : 0,
            device_id: deviceId
        };
        if (global.io) global.io.emit('automation:flow:created', { id: flow.id, name: flow.name });
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
        const { name, description, nodes, edges, enabled, device_id } = req.body;
        const existing = await db.get('SELECT id, device_id FROM automation_flows WHERE id = ?', [req.params.id]);
        if (!existing) return res.status(404).json({ success: false, message: 'Flow not found' });
        const resolvedDeviceId = device_id || existing.device_id || resolveDeviceId(req, DEFAULT_DEVICE_ID);
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
        getAutomationEngine(req).invalidateCache();
        const flow = await db.get('SELECT * FROM automation_flows WHERE id = ?', [req.params.id]);
        try { flow.nodes = JSON.parse(flow.nodes); } catch { flow.nodes = []; }
        try { flow.edges = JSON.parse(flow.edges); } catch { flow.edges = []; }
        if (global.io) global.io.emit('automation:flow:updated', { id: flow.id });
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
        const flow = await db.get('SELECT id, enabled FROM automation_flows WHERE id = ?', [req.params.id]);
        if (!flow) return res.status(404).json({ success: false, message: 'Flow not found' });
        const newEnabled = flow.enabled ? 0 : 1;
        await db.run('UPDATE automation_flows SET enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [newEnabled, req.params.id]);
        getAutomationEngine(req).invalidateCache();
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
        await db.run('DELETE FROM automation_flows WHERE id = ?', [req.params.id]);
        getAutomationEngine(req).invalidateCache();
        if (global.io) global.io.emit('automation:flow:deleted', { id: parseInt(req.params.id) });
        res.json({ success: true });
    } catch (e) {
        logger.error('DELETE /api/automation/flows/:id error:', e);
        res.status(500).json({ success: false, message: 'Failed to delete flow' });
    }
});

// ─── Manual test run ─────────────────────────────────────────
router.post('/flows/:id/run', async (req, res) => {
    try {
        const result = await getAutomationEngine(req).testRun(parseInt(req.params.id), req.body || {});
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
