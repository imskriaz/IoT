const express = require('express');
const router = express.Router();
const notificationService = require('../services/notificationService');

const VALID_READ_FILTERS = new Set(['all', 'read', 'unread']);
const VALID_CATEGORIES = new Set(['all', 'system', 'device', 'sms', 'call', 'queue', 'automation', 'security', 'network']);

function currentUser(req) {
    return req.session?.user || req.user || null;
}

function parseLimit(value) {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(parsed)) return 50;
    return Math.min(200, Math.max(10, parsed));
}

function parseOffset(value) {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, parsed);
}

function parseIdList(value) {
    const list = Array.isArray(value) ? value : [value];
    return list
        .flatMap(item => String(item || '').split(','))
        .map(item => Number.parseInt(item.trim(), 10))
        .filter(Number.isFinite);
}

function parseMetadata(row) {
    if (!row || !row.metadata) return row;
    try {
        return { ...row, metadata: JSON.parse(row.metadata) };
    } catch (_) {
        return { ...row, metadata: null };
    }
}

function buildWhere(req) {
    const user = currentUser(req);
    const params = [];
    const where = ['(user_id IS NULL OR user_id = ?)'];
    params.push(user?.id || 0);

    const read = VALID_READ_FILTERS.has(String(req.query.read || '').toLowerCase())
        ? String(req.query.read).toLowerCase()
        : 'all';
    if (read === 'read') where.push('read = 1');
    if (read === 'unread') where.push('COALESCE(read, 0) = 0');

    const category = String(req.query.category || 'all').trim().toLowerCase();
    if (VALID_CATEGORIES.has(category) && category !== 'all') {
        where.push('category = ?');
        params.push(category);
    }

    const deviceId = String(req.query.deviceId || req.query.device || '').trim();
    if (deviceId) {
        where.push('(device_id = ? OR device_id IS NULL)');
        params.push(deviceId);
    }

    const search = String(req.query.q || '').trim();
    if (search) {
        where.push('(title LIKE ? OR message LIKE ? OR device_id LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    return { where, params };
}

router.get('/', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const limit = parseLimit(req.query.limit);
        const offset = parseOffset(req.query.offset);
        const { where, params } = buildWhere(req);

        const rows = await db.all(
            `SELECT *
             FROM notifications
             WHERE ${where.join(' AND ')}
               AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
             ORDER BY datetime(created_at) DESC, id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const unread = await db.get(
            `SELECT COUNT(*) AS count
             FROM notifications
             WHERE ${where.join(' AND ')}
               AND COALESCE(read, 0) = 0
               AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`,
            params
        );
        const total = await db.get(
            `SELECT COUNT(*) AS count
             FROM notifications
             WHERE ${where.join(' AND ')}
               AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`,
            params
        );

        res.json({
            success: true,
            notifications: rows.map(parseMetadata),
            unreadCount: Number(unread?.count || 0),
            totalCount: Number(total?.count || 0),
            limit,
            offset
        });
    } catch (error) {
        req.app.locals.logger?.error?.('Notifications list error:', error);
        res.status(500).json({ success: false, message: 'Failed to load notifications' });
    }
});

router.get('/summary', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const user = currentUser(req);
        const row = await db.get(
            `SELECT COUNT(*) AS unreadCount
             FROM notifications
             WHERE (user_id IS NULL OR user_id = ?)
               AND COALESCE(read, 0) = 0
               AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`,
            [user?.id || 0]
        );
        res.json({ success: true, unreadCount: Number(row?.unreadCount || 0) });
    } catch (error) {
        req.app.locals.logger?.error?.('Notifications summary error:', error);
        res.status(500).json({ success: false, message: 'Failed to load notification summary' });
    }
});

router.post('/capture', async (req, res) => {
    try {
        const user = currentUser(req);
        const notification = await notificationService.capture({
            ...req.body,
            userId: req.body?.userId || null,
            source: req.body?.source || 'dashboard',
            metadata: {
                ...(req.body?.metadata || {}),
                capturedBy: user?.id || null
            }
        });
        if (!notification) {
            return res.status(400).json({ success: false, message: 'Notification title is required' });
        }
        res.status(201).json({ success: true, notification: parseMetadata(notification) });
    } catch (error) {
        req.app.locals.logger?.error?.('Notifications capture error:', error);
        res.status(500).json({ success: false, message: 'Failed to capture notification' });
    }
});

router.post('/read', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const ids = parseIdList(req.body?.ids || req.body?.id);
        if (!ids.length) {
            return res.status(400).json({ success: false, message: 'No notifications selected' });
        }
        const placeholders = ids.map(() => '?').join(',');
        await db.run(
            `UPDATE notifications
             SET read = 1, read_at = CURRENT_TIMESTAMP
             WHERE id IN (${placeholders})`,
            ids
        );
        res.json({ success: true, updated: ids.length });
    } catch (error) {
        req.app.locals.logger?.error?.('Notifications read error:', error);
        res.status(500).json({ success: false, message: 'Failed to mark notifications read' });
    }
});

router.post('/unread', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const ids = parseIdList(req.body?.ids || req.body?.id);
        if (!ids.length) {
            return res.status(400).json({ success: false, message: 'No notifications selected' });
        }
        const placeholders = ids.map(() => '?').join(',');
        await db.run(
            `UPDATE notifications
             SET read = 0, read_at = NULL
             WHERE id IN (${placeholders})`,
            ids
        );
        res.json({ success: true, updated: ids.length });
    } catch (error) {
        req.app.locals.logger?.error?.('Notifications unread error:', error);
        res.status(500).json({ success: false, message: 'Failed to mark notifications unread' });
    }
});

router.post('/read-all', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { where, params } = buildWhere(req);
        await db.run(
            `UPDATE notifications
             SET read = 1, read_at = CURRENT_TIMESTAMP
             WHERE ${where.join(' AND ')}`,
            params
        );
        res.json({ success: true });
    } catch (error) {
        req.app.locals.logger?.error?.('Notifications read-all error:', error);
        res.status(500).json({ success: false, message: 'Failed to mark notifications read' });
    }
});

router.post('/delete', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const ids = parseIdList(req.body?.ids || req.body?.id);
        if (!ids.length) {
            return res.status(400).json({ success: false, message: 'No notifications selected' });
        }
        const placeholders = ids.map(() => '?').join(',');
        await db.run(
            `DELETE FROM notifications
             WHERE id IN (${placeholders})`,
            ids
        );
        res.json({ success: true, deleted: ids.length });
    } catch (error) {
        req.app.locals.logger?.error?.('Notifications delete error:', error);
        res.status(500).json({ success: false, message: 'Failed to remove notifications' });
    }
});

router.post('/delete-all', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { where, params } = buildWhere(req);
        await db.run(
            `DELETE FROM notifications
             WHERE ${where.join(' AND ')}`,
            params
        );
        res.json({ success: true });
    } catch (error) {
        req.app.locals.logger?.error?.('Notifications delete-all error:', error);
        res.status(500).json({ success: false, message: 'Failed to clear notifications' });
    }
});

module.exports = router;
