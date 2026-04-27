'use strict';
const express = require('express');
const router  = express.Router();
const { body, param, validationResult } = require('express-validator');
const logger  = require('../utils/logger');
const { hasRole } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Device Groups
 *   description: Aggregate multiple devices into named groups
 */

/**
 * @swagger
 * /device-groups:
 *   get:
 *     summary: List device groups
 *     description: Admins see all groups; others see only groups they own.
 *     tags: [Device Groups]
 *     security:
 *       - sessionCookie: []
 *     responses:
 *       200:
 *         description: Array of groups with member count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 groups:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/DeviceGroup' }
 *   post:
 *     summary: Create a device group
 *     tags: [Device Groups]
 *     security:
 *       - sessionCookie: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:        { type: string }
 *               description: { type: string }
 *               color:       { type: string, example: "#0d6efd" }
 *               device_ids:  { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Group created
 */
// GET /api/device-groups — list groups visible to current user
router.get('/', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const isAdmin = hasRole(req.session.user?.role, 'admin');
        const userId  = req.session.user?.id;

        const groups = isAdmin
            ? await db.all(`
                SELECT g.*, u.username AS owner_name,
                       (SELECT COUNT(*) FROM device_group_members m WHERE m.group_id = g.id) AS member_count
                FROM device_groups g
                LEFT JOIN users u ON u.id = g.owner_id
                ORDER BY g.name ASC
              `)
            : await db.all(`
                SELECT g.*, u.username AS owner_name,
                       (SELECT COUNT(*) FROM device_group_members m WHERE m.group_id = g.id) AS member_count
                FROM device_groups g
                LEFT JOIN users u ON u.id = g.owner_id
                WHERE g.owner_id = ?
                ORDER BY g.name ASC
              `, [userId]);

        res.json({ success: true, groups });
    } catch (error) {
        logger.error('GET /api/device-groups error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch groups' });
    }
});

// GET /api/device-groups/:id — get group with its devices
router.get('/:id', [param('id').isInt({ min: 1 })], async (req, res) => {
    try {
        const db = req.app.locals.db;
        const group = await db.get(`SELECT * FROM device_groups WHERE id = ?`, [req.params.id]);
        if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

        const isAdmin = hasRole(req.session.user?.role, 'admin');
        if (!isAdmin && group.owner_id !== req.session.user?.id) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const devices = await db.all(`
            SELECT d.id, d.name, d.status, d.type
            FROM device_group_members m
            INNER JOIN devices d ON d.id = m.device_id
            WHERE m.group_id = ?
            ORDER BY d.name ASC
        `, [req.params.id]);

        res.json({ success: true, group: { ...group, devices } });
    } catch (error) {
        logger.error('GET /api/device-groups/:id error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch group' });
    }
});

// POST /api/device-groups — create a group
router.post('/', [
    body('name').trim().notEmpty().withMessage('Name required').isLength({ max: 100 }),
    body('description').optional({ nullable: true }).trim().isLength({ max: 500 }),
    body('color').optional({ nullable: true }).matches(/^#[0-9a-fA-F]{6}$/).withMessage('Invalid color hex'),
    body('device_ids').optional().isArray()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

        const db = req.app.locals.db;
        const { name, description, color, device_ids } = req.body;
        const ownerId = req.session.user.id;

        const result = await db.run(
            `INSERT INTO device_groups (name, description, owner_id, color) VALUES (?, ?, ?, ?)`,
            [name, description || null, ownerId, color || '#0d6efd']
        );
        const groupId = result.lastID;

        if (Array.isArray(device_ids) && device_ids.length) {
            for (const deviceId of device_ids) {
                await db.run(
                    `INSERT OR IGNORE INTO device_group_members (group_id, device_id) VALUES (?, ?)`,
                    [groupId, deviceId]
                );
            }
        }

        logger.info(`Device group created: ${name} (id=${groupId}) by user ${ownerId}`);
        res.json({ success: true, id: groupId });
    } catch (error) {
        logger.error('POST /api/device-groups error:', error);
        res.status(500).json({ success: false, message: 'Failed to create group' });
    }
});

// PUT /api/device-groups/:id — update group
router.put('/:id', [
    param('id').isInt({ min: 1 }),
    body('name').optional().trim().notEmpty().isLength({ max: 100 }),
    body('description').optional({ nullable: true }).trim().isLength({ max: 500 }),
    body('color').optional({ nullable: true }).matches(/^#[0-9a-fA-F]{6}$/)
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

        const db = req.app.locals.db;
        const group = await db.get(`SELECT * FROM device_groups WHERE id = ?`, [req.params.id]);
        if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

        const isAdmin = hasRole(req.session.user?.role, 'admin');
        if (!isAdmin && group.owner_id !== req.session.user?.id) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const { name, description, color } = req.body;
        await db.run(
            `UPDATE device_groups SET
                name = COALESCE(?, name),
                description = COALESCE(?, description),
                color = COALESCE(?, color)
             WHERE id = ?`,
            [name || null, description !== undefined ? description : null, color || null, req.params.id]
        );
        res.json({ success: true });
    } catch (error) {
        logger.error('PUT /api/device-groups/:id error:', error);
        res.status(500).json({ success: false, message: 'Failed to update group' });
    }
});

// POST /api/device-groups/:id/members — add device to group
router.post('/:id/members', [
    param('id').isInt({ min: 1 }),
    body('device_id').trim().notEmpty()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

        const db = req.app.locals.db;
        const group = await db.get(`SELECT * FROM device_groups WHERE id = ?`, [req.params.id]);
        if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

        const isAdmin = hasRole(req.session.user?.role, 'admin');
        if (!isAdmin && group.owner_id !== req.session.user?.id) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        await db.run(
            `INSERT OR IGNORE INTO device_group_members (group_id, device_id) VALUES (?, ?)`,
            [req.params.id, req.body.device_id]
        );
        res.json({ success: true });
    } catch (error) {
        logger.error('POST /api/device-groups/:id/members error:', error);
        res.status(500).json({ success: false, message: 'Failed to add member' });
    }
});

// DELETE /api/device-groups/:id/members/:deviceId — remove device from group
router.delete('/:id/members/:deviceId', [
    param('id').isInt({ min: 1 })
], async (req, res) => {
    try {
        const db = req.app.locals.db;
        const group = await db.get(`SELECT * FROM device_groups WHERE id = ?`, [req.params.id]);
        if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

        const isAdmin = hasRole(req.session.user?.role, 'admin');
        if (!isAdmin && group.owner_id !== req.session.user?.id) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        await db.run(
            `DELETE FROM device_group_members WHERE group_id = ? AND device_id = ?`,
            [req.params.id, req.params.deviceId]
        );
        res.json({ success: true });
    } catch (error) {
        logger.error('DELETE group member error:', error);
        res.status(500).json({ success: false, message: 'Failed to remove member' });
    }
});

// DELETE /api/device-groups/:id — delete group
router.delete('/:id', [param('id').isInt({ min: 1 })], async (req, res) => {
    try {
        const db = req.app.locals.db;
        const group = await db.get(`SELECT * FROM device_groups WHERE id = ?`, [req.params.id]);
        if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

        const isAdmin = hasRole(req.session.user?.role, 'admin');
        if (!isAdmin && group.owner_id !== req.session.user?.id) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        await db.run(`DELETE FROM device_groups WHERE id = ?`, [req.params.id]);
        logger.info(`Device group deleted: id=${req.params.id}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('DELETE /api/device-groups/:id error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete group' });
    }
});

module.exports = router;
