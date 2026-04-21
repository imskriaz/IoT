'use strict';
const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const crypto = require('crypto');
const logger = require('../utils/logger');

const VALID_EVENTS = ['sms.incoming', 'call.incoming', 'call.status', 'gps.location', 'device.online', 'device.offline'];

const webhookValidation = [
    body('name').trim().notEmpty().withMessage('Name required').isLength({ max: 100 }),
    body('url').trim().isURL({ require_tld: false }).withMessage('Valid URL required').isLength({ max: 500 }),
    body('events').isArray({ min: 1 }).withMessage('At least one event required'),
    body('events.*').isIn(VALID_EVENTS).withMessage('Invalid event type'),
    body('secret').optional({ nullable: true }).isLength({ max: 200 }),
    body('device_ids').optional({ nullable: true }).isArray()
];

/**
 * @swagger
 * tags:
 *   name: Webhooks
 *   description: Outbound HTTP callbacks triggered by device events
 */

/**
 * @swagger
 * /webhooks:
 *   get:
 *     summary: List your webhooks
 *     tags: [Webhooks]
 *     security:
 *       - sessionCookie: []
 *     responses:
 *       200:
 *         description: Array of webhooks
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Webhook' }
 *   post:
 *     summary: Create a webhook
 *     tags: [Webhooks]
 *     security:
 *       - sessionCookie: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, url, events]
 *             properties:
 *               name:       { type: string }
 *               url:        { type: string, format: uri }
 *               events:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [sms.incoming, call.incoming, call.status, gps.location, device.online, device.offline]
 *               secret:     { type: string, description: "HMAC-SHA256 signing secret" }
 *               device_ids: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Webhook created
 */
// GET /api/webhooks — list user's webhooks
router.get('/', async (req, res) => {
    try {
        const rows = await req.app.locals.db.all(
            `SELECT id, name, url, events, device_ids, is_active, created_at, last_fired_at, last_status
             FROM webhooks WHERE user_id = ? ORDER BY created_at DESC`,
            [req.session.user.id]
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        logger.error('GET /api/webhooks error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch webhooks' });
    }
});

// POST /api/webhooks — create
router.post('/', webhookValidation, async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

        const { name, url, events, secret, device_ids } = req.body;
        const result = await req.app.locals.db.run(
            `INSERT INTO webhooks (user_id, name, url, events, secret, device_ids)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                req.session.user.id,
                name,
                url,
                (Array.isArray(events) ? events : [events]).join(','),
                secret || null,
                device_ids?.length ? JSON.stringify(device_ids) : null
            ]
        );
        logger.info(`Webhook created by user ${req.session.user.id}: ${url}`);
        const newWebhook = await req.app.locals.db.get(`SELECT * FROM webhooks WHERE id = ?`, [result.lastID]);
        if (global.io) global.io.emit('webhook:created', newWebhook);
        res.json({ success: true, id: result.lastID });
    } catch (error) {
        logger.error('POST /api/webhooks error:', error);
        res.status(500).json({ success: false, message: 'Failed to create webhook' });
    }
});

/**
 * @swagger
 * /webhooks/{id}:
 *   put:
 *     summary: Update a webhook
 *     tags: [Webhooks]
 *     security:
 *       - sessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:       { type: string }
 *               url:        { type: string, format: uri }
 *               events:     { type: array, items: { type: string } }
 *               is_active:  { type: boolean }
 *     responses:
 *       200:
 *         description: Webhook updated
 *       404:
 *         description: Not found
 *   delete:
 *     summary: Delete a webhook
 *     tags: [Webhooks]
 *     security:
 *       - sessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Deleted
 *       404:
 *         description: Not found
 */
// PUT /api/webhooks/:id — update
router.put('/:id', [
    param('id').isInt({ min: 1 }),
    ...webhookValidation,
    body('is_active').optional().isBoolean()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

        const db = req.app.locals.db;
        const hook = await db.get(
            `SELECT id FROM webhooks WHERE id = ? AND user_id = ?`,
            [req.params.id, req.session.user.id]
        );
        if (!hook) return res.status(404).json({ success: false, message: 'Webhook not found' });

        const { name, url, events, secret, device_ids, is_active } = req.body;
        await db.run(
            `UPDATE webhooks SET name=?, url=?, events=?, secret=?, device_ids=?, is_active=?
             WHERE id=?`,
            [
                name,
                url,
                (Array.isArray(events) ? events : [events]).join(','),
                secret || null,
                device_ids?.length ? JSON.stringify(device_ids) : null,
                is_active !== undefined ? (is_active ? 1 : 0) : 1,
                req.params.id
            ]
        );
        const updatedWebhook = await db.get(`SELECT * FROM webhooks WHERE id = ?`, [req.params.id]);
        if (global.io) global.io.emit('webhook:updated', updatedWebhook);
        res.json({ success: true });
    } catch (error) {
        logger.error('PUT /api/webhooks/:id error:', error);
        res.status(500).json({ success: false, message: 'Failed to update webhook' });
    }
});

// DELETE /api/webhooks/:id — delete
router.delete('/:id', [param('id').isInt({ min: 1 })], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

        const db = req.app.locals.db;
        const result = await db.run(
            `DELETE FROM webhooks WHERE id = ? AND user_id = ?`,
            [req.params.id, req.session.user.id]
        );
        if (result.changes === 0) return res.status(404).json({ success: false, message: 'Webhook not found' });
        if (global.io) global.io.emit('webhook:deleted', { id: parseInt(req.params.id) });
        res.json({ success: true });
    } catch (error) {
        logger.error('DELETE /api/webhooks/:id error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete webhook' });
    }
});

// POST /api/webhooks/:id/test — send test payload
router.post('/:id/test', [param('id').isInt({ min: 1 })], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

        const db = req.app.locals.db;
        const hook = await db.get(
            `SELECT * FROM webhooks WHERE id = ? AND user_id = ?`,
            [req.params.id, req.session.user.id]
        );
        if (!hook) return res.status(404).json({ success: false, message: 'Webhook not found' });

        const webhookService = req.app.locals.webhookService;
        if (!webhookService) return res.status(500).json({ success: false, message: 'Webhook service unavailable' });

        await webhookService._deliver(hook, 'test', 'test-device', {
            message: 'This is a test delivery from ESP32 Dashboard',
            timestamp: new Date().toISOString()
        });
        res.json({ success: true, message: 'Test payload sent' });
    } catch (error) {
        logger.error('POST /api/webhooks/:id/test error:', error);
        res.status(500).json({ success: false, message: 'Test delivery failed' });
    }
});

module.exports = router;
