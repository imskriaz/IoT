// routes/users.js
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const { body, param, validationResult } = require('express-validator');
const logger  = require('../utils/logger');
const { isSuperAdmin, hasRole, withEffectiveRole } = require('../middleware/auth');
const authMiddleware = require('../middleware/auth');
const paymentGatewayService = require('../services/paymentGatewayService');
const {
    parseUserPreferences,
    buildUserAdminControls,
    withUserAdminControls
} = require('../services/userAccessService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_ROLES = ['viewer', 'operator', 'admin', 'superadmin'];

/** Strip sensitive fields before returning a user object to the client. */
function safeUser(u) {
    const { password, password_reset_token, totp_secret, totp_pending, ...rest } = u;
    return rest;
}

const requireAdmin = (req, res, next) => {
    const user = withEffectiveRole(req.user || req.session?.user);
    req.user = user;
    if (!user || !hasRole(user.role, 'admin')) {
        return res.status(403).json({ success: false, message: 'Access denied. Admin privileges required' });
    }
    next();
};

function currentSessionUser(req) {
    return withEffectiveRole(req.user || req.session?.user || null);
}

function isAdminUser(user) {
    return !!user && hasRole(user.role, 'admin');
}

function canViewUser(user, userId) {
    return !!user && (Number(user.id) === Number(userId) || isAdminUser(user));
}

function normalizeNonNegativeInt(value, fallback = 0) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function loadUserRecord(db, userId) {
    return db.get(`SELECT * FROM users WHERE id = ?`, [userId]);
}

function usageChannelSql(channel) {
    if (channel === 'api') {
        return `source LIKE '%api%'`;
    }
    return `(source NOT LIKE '%api%' OR source IS NULL)`;
}

async function loadUserAssignedDevices(db, userId) {
    const rows = await db.all(
        `SELECT du.device_id,
                du.can_write,
                du.assigned_at,
                d.name AS device_name,
                d.type AS device_type,
                d.status AS device_status,
                d.last_seen,
                dp.current_package_code,
                dp.current_package_name,
                dp.current_package_limits
         FROM device_users du
         LEFT JOIN devices d ON d.id = du.device_id
         LEFT JOIN device_profiles dp ON dp.device_id = du.device_id
         WHERE du.user_id = ?
         ORDER BY COALESCE(d.name, du.device_id) ASC`,
        [userId]
    );

    return (rows || []).map((row) => ({
        device_id: row.device_id,
        name: row.device_name || row.device_id,
        type: row.device_type || 'unknown',
        status: row.device_status || 'offline',
        last_seen: row.last_seen || null,
        can_write: !!row.can_write,
        assigned_at: row.assigned_at || null,
        package_code: row.current_package_code || '',
        package_name: row.current_package_name || '',
        package_limits: parseUserPreferences(row.current_package_limits)
    }));
}

async function loadAvailableDevices(db) {
    return db.all(
        `SELECT id, name, type, status, last_seen
         FROM devices
         ORDER BY COALESCE(name, id) ASC`
    );
}

async function loadUserUsageData(db, userId, days = 14, recentLimit = 20) {
    const normalizedDays = Math.min(Math.max(Number(days) || 14, 7), 60);
    const normalizedRecentLimit = Math.min(Math.max(Number(recentLimit) || 20, 5), 100);

    const [summaryRow, chartRows, recentRows] = await Promise.all([
        db.get(
            `SELECT
                SUM(CASE WHEN type = 'outgoing' THEN 1 ELSE 0 END) AS outgoing_total,
                SUM(CASE WHEN type = 'incoming' THEN 1 ELSE 0 END) AS incoming_total,
                SUM(CASE WHEN type = 'outgoing' AND timestamp >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS outgoing_30d,
                SUM(CASE WHEN type = 'outgoing' AND ${usageChannelSql('api')} AND timestamp >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS api_30d,
                SUM(CASE WHEN type = 'outgoing' AND ${usageChannelSql('dashboard')} AND timestamp >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS dashboard_30d,
                MAX(CASE WHEN type = 'outgoing' THEN timestamp END) AS last_sent_at
             FROM sms
             WHERE user_id = ?`,
            [userId]
        ),
        db.all(
            `SELECT substr(timestamp, 1, 10) AS day,
                    SUM(CASE WHEN type = 'outgoing' THEN 1 ELSE 0 END) AS outgoing_total,
                    SUM(CASE WHEN type = 'outgoing' AND ${usageChannelSql('api')} THEN 1 ELSE 0 END) AS api_total,
                    SUM(CASE WHEN type = 'outgoing' AND ${usageChannelSql('dashboard')} THEN 1 ELSE 0 END) AS dashboard_total
             FROM sms
             WHERE user_id = ?
               AND timestamp >= date('now', ?)
             GROUP BY substr(timestamp, 1, 10)
             ORDER BY day ASC`,
            [userId, `-${normalizedDays - 1} days`]
        ),
        db.all(
            `SELECT id, device_id, to_number, message, status, source, timestamp
             FROM sms
             WHERE user_id = ?
               AND type = 'outgoing'
             ORDER BY timestamp DESC
             LIMIT ?`,
            [userId, normalizedRecentLimit]
        )
    ]);

    const chartMap = new Map((chartRows || []).map((row) => [row.day, row]));
    const points = [];
    for (let index = normalizedDays - 1; index >= 0; index -= 1) {
        const date = new Date();
        date.setUTCDate(date.getUTCDate() - index);
        const day = date.toISOString().slice(0, 10);
        const row = chartMap.get(day) || {};
        points.push({
            day,
            outgoing_total: Number(row.outgoing_total || 0),
            api_total: Number(row.api_total || 0),
            dashboard_total: Number(row.dashboard_total || 0)
        });
    }

    return {
        summary: {
            outgoing_total: Number(summaryRow?.outgoing_total || 0),
            incoming_total: Number(summaryRow?.incoming_total || 0),
            outgoing_30d: Number(summaryRow?.outgoing_30d || 0),
            api_30d: Number(summaryRow?.api_30d || 0),
            dashboard_30d: Number(summaryRow?.dashboard_30d || 0),
            last_sent_at: summaryRow?.last_sent_at || null
        },
        chart: points,
        recent: (recentRows || []).map((row) => ({
            id: row.id,
            device_id: row.device_id,
            to_number: row.to_number,
            message: row.message,
            status: row.status,
            source: row.source || 'dashboard',
            timestamp: row.timestamp
        }))
    };
}

async function loadUserAuditData(db, userId, username, limit = 20) {
    return db.all(
        `SELECT id, username, success, ip, user_agent, reason, created_at
         FROM login_audit
         WHERE user_id = ? OR username = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [userId, username, Math.min(Math.max(Number(limit) || 20, 5), 100)]
    );
}

async function loadUserDetailPayload(db, targetUser, viewer, includeAdminData = false) {
    const preferences = parseUserPreferences(targetUser.preferences);
    const adminControls = buildUserAdminControls(preferences);

    const [assignedDevices, usage, audit, sessions] = await Promise.all([
        loadUserAssignedDevices(db, targetUser.id),
        loadUserUsageData(db, targetUser.id),
        loadUserAuditData(db, targetUser.id, targetUser.username),
        db.all(
            `SELECT id, ip_address, user_agent, device_info, logged_in_at, last_active, is_active
             FROM login_sessions
             WHERE user_id = ?
             ORDER BY last_active DESC
             LIMIT 20`,
            [targetUser.id]
        )
    ]);

    const packageRequests = await db.all(
        `SELECT id, device_id, package_name, price_bdt, status, requested_at, reviewed_at
         FROM device_package_requests
         WHERE user_id = ?
         ORDER BY requested_at DESC
         LIMIT 20`,
        [targetUser.id]
    );

    const payload = {
        success: true,
        permissions: {
            can_manage: includeAdminData,
            is_self: Number(viewer.id) === Number(targetUser.id)
        },
        user: {
            ...safeUser(targetUser),
            preferences,
            admin_controls: adminControls
        },
        usage,
        audit,
        sessions: (sessions || []).map((row) => ({
            id: row.id,
            ip_address: row.ip_address || '',
            user_agent: row.user_agent || '',
            device_info: row.device_info || '',
            logged_in_at: row.logged_in_at || null,
            last_active: row.last_active || null,
            is_active: !!row.is_active
        })),
        devices: assignedDevices,
        package_requests: packageRequests
    };

    if (includeAdminData) {
        payload.available_devices = await loadAvailableDevices(db);
    }

    return payload;
}

// ---------------------------------------------------------------------------
// Page route — GET /admin/users
// ---------------------------------------------------------------------------

router.get('/capabilities', requireAdmin, async (req, res) => {
    try {
        const query = new URLSearchParams(req.query || {});
        const suffix = query.toString() ? `?${query.toString()}` : '';
        return res.redirect(`/devices/capabilities${suffix}`);
    } catch (error) {
        logger.error('Capabilities redirect error:', error);
        req.flash('error', 'Failed to load capabilities page');
        res.redirect('/');
    }
});

router.get('/account', authMiddleware, async (req, res) => {
    const user = currentSessionUser(req);
    if (!user?.id) {
        return res.redirect('/auth/login');
    }
    return res.redirect(`/admin/users/${user.id}`);
});

router.get('/users', requireAdmin, async (req, res) => {
    try {
        res.render('pages/users', {
            title: 'User Management',
            user: currentSessionUser(req)
        });
    } catch (error) {
        logger.error('Users page error:', error);
        req.flash('error', 'Failed to load users page');
        res.redirect('/');
    }
});

router.get('/users/:id', authMiddleware, async (req, res) => {
    try {
        const viewer = currentSessionUser(req);
        const userId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(userId) || userId <= 0) {
            req.flash('error', 'Invalid user ID');
            return res.redirect('/admin/account');
        }
        if (!canViewUser(viewer, userId)) {
            req.flash('error', 'Access denied.');
            return res.redirect('/admin/account');
        }

        const db = req.app.locals.db;
        const targetUser = await loadUserRecord(db, userId);
        if (!targetUser) {
            req.flash('error', 'User not found');
            return res.redirect(isAdminUser(viewer) ? '/admin/users' : '/admin/account');
        }

        res.render('pages/user-detail', {
            title: Number(viewer.id) === Number(targetUser.id) ? 'My Account' : `User: ${targetUser.username}`,
            user: viewer,
            targetUserId: targetUser.id,
            canManageUser: isAdminUser(viewer)
        });
    } catch (error) {
        logger.error('User detail page error:', error);
        req.flash('error', 'Failed to load user details');
        res.redirect('/dashboard');
    }
});

router.get('/packages', requireAdmin, async (req, res) => {
    try {
        res.render('pages/packages', {
            title: 'Packages',
            user: currentSessionUser(req)
        });
    } catch (error) {
        logger.error('Packages page error:', error);
        req.flash('error', 'Failed to load packages page');
        res.redirect('/dashboard');
    }
});

router.get('/gateway', requireAdmin, async (req, res) => {
    try {
        res.render('pages/gateway', {
            title: 'Payment Gateways',
            user: currentSessionUser(req)
        });
    } catch (error) {
        logger.error('Gateway page error:', error);
        req.flash('error', 'Failed to load payment gateways');
        res.redirect('/dashboard');
    }
});

// ---------------------------------------------------------------------------
// API — GET /api/users
// ---------------------------------------------------------------------------

router.get('/api/users', requireAdmin, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const page   = Math.max(1, parseInt(req.query.page)  || 1);
        const limit  = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 200);
        const offset = (page - 1) * limit;

        let where  = [];
        let params = [];

        if (req.query.role && VALID_ROLES.includes(req.query.role)) {
            where.push('role = ?');
            params.push(req.query.role);
        }

        if (req.query.active !== undefined) {
            where.push('is_active = ?');
            params.push(req.query.active === 'true' ? 1 : 0);
        }

        const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

        const [users, countRow] = await Promise.all([
            db.all(
                `SELECT * FROM users ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            ),
            db.get(`SELECT COUNT(*) as count FROM users ${whereClause}`, params)
        ]);

        res.json({
            success: true,
            users: users.map(safeUser),
            pagination: {
                page,
                limit,
                total: countRow?.count || 0,
                pages: Math.ceil((countRow?.count || 0) / limit)
            }
        });
    } catch (error) {
        logger.error('GET /api/users error:', error);
        res.status(500).json({ success: false, message: 'Failed to retrieve users' });
    }
});

router.get('/api/gateway', requireAdmin, async (req, res) => {
    try {
        const gateways = await paymentGatewayService.loadPaymentGateways(req.app.locals.db);
        const primary = paymentGatewayService.getPrimaryGateway(gateways);
        res.json({
            success: true,
            gateways: gateways.map(paymentGatewayService.serializeGateway),
            primary_gateway_code: primary?.code || '',
            payment: paymentGatewayService.buildPaymentInstructions(primary)
        });
    } catch (error) {
        logger.error('GET /admin/api/gateway error:', error);
        res.status(500).json({ success: false, message: 'Failed to load payment gateways' });
    }
});

router.put('/api/gateway', requireAdmin, [
    body('gateways').isArray({ min: 1 }).withMessage('At least one payment gateway is required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const gateways = await paymentGatewayService.savePaymentGateways(
            req.app.locals.db,
            req.body.gateways,
            req.session?.user?.id || req.user?.id || null
        );
        const primary = paymentGatewayService.getPrimaryGateway(gateways);
        res.json({
            success: true,
            gateways: gateways.map(paymentGatewayService.serializeGateway),
            primary_gateway_code: primary?.code || '',
            payment: paymentGatewayService.buildPaymentInstructions(primary)
        });
    } catch (error) {
        logger.error('PUT /admin/api/gateway error:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to save payment gateways' });
    }
});

router.get('/api/users/:id/detail', authMiddleware, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const viewer = currentSessionUser(req);
        const userId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(userId) || userId <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid user ID' });
        }
        if (!canViewUser(viewer, userId)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const targetUser = await loadUserRecord(db, userId);
        if (!targetUser) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const payload = await loadUserDetailPayload(db, targetUser, viewer, isAdminUser(viewer));
        res.json(payload);
    } catch (error) {
        logger.error('GET /admin/api/users/:id/detail error:', error);
        res.status(500).json({ success: false, message: 'Failed to load user detail' });
    }
});

router.put('/api/users/:id/profile', authMiddleware, [
    body('name').optional().trim().isLength({ max: 100 }).withMessage('Name too long'),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('Invalid email address').normalizeEmail(),
    body('role').optional().isIn(VALID_ROLES).withMessage('Invalid role'),
    body('is_active').optional().isBoolean().withMessage('is_active must be boolean')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const db = req.app.locals.db;
        const viewer = currentSessionUser(req);
        const userId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(userId) || userId <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid user ID' });
        }
        if (!canViewUser(viewer, userId)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const targetUser = await loadUserRecord(db, userId);
        if (!targetUser) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const isAdmin = isAdminUser(viewer);
        const fields = [];
        const params = [];

        if (req.body.name !== undefined) {
            fields.push('name = ?');
            params.push(req.body.name || null);
        }
        if (req.body.email !== undefined) {
            fields.push('email = ?');
            params.push(req.body.email || null);
        }

        if (isAdmin) {
            if (req.body.role !== undefined) {
                if (req.body.role === 'superadmin' && !isSuperAdmin(req)) {
                    return res.status(403).json({ success: false, message: 'Only a superadmin can assign the superadmin role' });
                }
                if (targetUser.role === 'superadmin' && !isSuperAdmin(req) && req.body.role !== targetUser.role) {
                    return res.status(403).json({ success: false, message: 'Only a superadmin can change a superadmin role' });
                }
                fields.push('role = ?');
                params.push(req.body.role);
            }

            if (req.body.is_active !== undefined) {
                if (Number(targetUser.id) === Number(viewer.id) && !req.body.is_active) {
                    return res.status(400).json({ success: false, message: 'You cannot deactivate your own account' });
                }
                fields.push('is_active = ?');
                params.push(req.body.is_active ? 1 : 0);
            }
        }

        if (!fields.length) {
            return res.status(400).json({ success: false, message: 'No profile fields supplied' });
        }

        params.push(userId);
        await db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
        const updated = await loadUserRecord(db, userId);
        res.json({ success: true, user: safeUser(updated), message: 'Profile updated' });
    } catch (error) {
        logger.error('PUT /admin/api/users/:id/profile error:', error);
        res.status(500).json({ success: false, message: 'Failed to update profile' });
    }
});

router.put('/api/users/:id/admin-controls', authMiddleware, async (req, res) => {
    try {
        const viewer = currentSessionUser(req);
        if (!isAdminUser(viewer)) {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const db = req.app.locals.db;
        const userId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(userId) || userId <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid user ID' });
        }

        const targetUser = await loadUserRecord(db, userId);
        if (!targetUser) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const existingPreferences = parseUserPreferences(targetUser.preferences);
        const nextPreferences = withUserAdminControls(existingPreferences, req.body || {});
        await db.run(
            `UPDATE users SET preferences = ? WHERE id = ?`,
            [JSON.stringify(nextPreferences), userId]
        );

        res.json({
            success: true,
            message: 'Admin controls updated',
            admin_controls: buildUserAdminControls(nextPreferences)
        });
    } catch (error) {
        logger.error('PUT /admin/api/users/:id/admin-controls error:', error);
        res.status(500).json({ success: false, message: 'Failed to update admin controls' });
    }
});

router.put('/api/users/:id/devices', authMiddleware, async (req, res) => {
    try {
        const viewer = currentSessionUser(req);
        if (!isAdminUser(viewer)) {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const db = req.app.locals.db;
        const userId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(userId) || userId <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid user ID' });
        }

        const targetUser = await loadUserRecord(db, userId);
        if (!targetUser) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const assignments = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
        const normalizedAssignments = assignments
            .map((assignment) => ({
                device_id: String(assignment?.device_id || '').trim(),
                can_write: !!assignment?.can_write
            }))
            .filter((assignment) => assignment.device_id);

        const deviceIds = Array.from(new Set(normalizedAssignments.map((assignment) => assignment.device_id)));
        if (deviceIds.length) {
            const placeholders = deviceIds.map(() => '?').join(', ');
            const rows = await db.all(
                `SELECT id FROM devices WHERE id IN (${placeholders})`,
                deviceIds
            );
            const validIds = new Set((rows || []).map((row) => row.id));
            const invalid = deviceIds.find((deviceId) => !validIds.has(deviceId));
            if (invalid) {
                return res.status(400).json({ success: false, message: `Unknown device: ${invalid}` });
            }
        }

        await db.run(`DELETE FROM device_users WHERE user_id = ?`, [userId]);
        for (const assignment of normalizedAssignments) {
            await db.run(
                `INSERT INTO device_users (device_id, user_id, can_write) VALUES (?, ?, ?)`,
                [assignment.device_id, userId, assignment.can_write ? 1 : 0]
            );
        }

        res.json({
            success: true,
            message: 'Device allocation updated',
            devices: await loadUserAssignedDevices(db, userId)
        });
    } catch (error) {
        logger.error('PUT /admin/api/users/:id/devices error:', error);
        res.status(500).json({ success: false, message: 'Failed to update device allocation' });
    }
});

// ---------------------------------------------------------------------------
// API — POST /api/users  (create)
// ---------------------------------------------------------------------------

const createValidation = [
    body('username').trim().notEmpty().withMessage('Username is required')
        .isLength({ min: 3, max: 30 }).withMessage('Username must be 3–30 characters')
        .matches(/^[a-zA-Z0-9_.-]+$/).withMessage('Username may only contain letters, numbers, _ . -'),
    body('password').notEmpty().withMessage('Password is required')
        .isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('name').optional().trim().isLength({ max: 100 }).withMessage('Name too long'),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('Invalid email address').normalizeEmail(),
    body('role').isIn(VALID_ROLES).withMessage('Invalid role')
];

router.post('/api/users', requireAdmin, createValidation, async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const db = req.app.locals.db;
        const { username, password, name, email, role } = req.body;

        // Only a superadmin may create another superadmin
        if (role === 'superadmin' && !isSuperAdmin(req)) {
            return res.status(403).json({ success: false, message: 'Only a superadmin can create superadmin accounts' });
        }

        // Check for duplicate username
        const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
        if (existing) {
            return res.status(409).json({ success: false, message: 'Username already exists' });
        }

        const hashed = await bcrypt.hash(password, 10);
        const result = await db.run(
            `INSERT INTO users (username, password, name, email, role, is_active, must_change_password)
             VALUES (?, ?, ?, ?, ?, 1, 1)`,
            [username, hashed, name || null, email || null, role]
        );

        logger.info(`User created: ${username} (role=${role}) by ${req.session.user.username}`);

        const created = await db.get('SELECT * FROM users WHERE id = ?', [result.lastID]);
        res.status(201).json({ success: true, message: 'User created', user: safeUser(created) });
    } catch (error) {
        logger.error('POST /api/users error:', error);
        res.status(500).json({ success: false, message: 'Failed to create user' });
    }
});

// ---------------------------------------------------------------------------
// API — PUT /api/users/:id  (update profile/role/status)
// ---------------------------------------------------------------------------

const updateValidation = [
    body('name').optional().trim().isLength({ max: 100 }).withMessage('Name too long'),
    body('email').optional({ checkFalsy: true }).isEmail().withMessage('Invalid email address').normalizeEmail(),
    body('role').optional().isIn(VALID_ROLES).withMessage('Invalid role'),
    body('is_active').optional().isBoolean().withMessage('is_active must be boolean')
];

router.put('/api/users/:id', requireAdmin, updateValidation, async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const id = parseInt(req.params.id, 10);
        if (!id || id < 1) {
            return res.status(400).json({ success: false, message: 'Invalid user ID' });
        }

        const db   = req.app.locals.db;
        const target = await db.get('SELECT * FROM users WHERE id = ?', [id]);
        if (!target) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Protect superadmin records from non-superadmins
        if (target.is_protected && !isSuperAdmin(req)) {
            return res.status(403).json({ success: false, message: 'Cannot edit a protected account' });
        }

        // Non-superadmin cannot promote/demote to superadmin
        const newRole = req.body.role;
        if (newRole && newRole === 'superadmin' && !isSuperAdmin(req)) {
            return res.status(403).json({ success: false, message: 'Only a superadmin can assign the superadmin role' });
        }
        if (newRole && target.role === 'superadmin' && !isSuperAdmin(req)) {
            return res.status(403).json({ success: false, message: 'Only a superadmin can change a superadmin\'s role' });
        }

        const fields = [];
        const params = [];

        if (req.body.name !== undefined)      { fields.push('name = ?');      params.push(req.body.name || null); }
        if (req.body.email !== undefined)     { fields.push('email = ?');     params.push(req.body.email || null); }
        if (newRole !== undefined)            { fields.push('role = ?');      params.push(newRole); }
        if (req.body.is_active !== undefined) { fields.push('is_active = ?'); params.push(req.body.is_active ? 1 : 0); }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, message: 'No fields to update' });
        }

        params.push(id);
        await db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);

        logger.info(`User ${id} updated by ${req.session.user.username}`);
        const updated = await db.get('SELECT * FROM users WHERE id = ?', [id]);
        res.json({ success: true, message: 'User updated', user: safeUser(updated) });
    } catch (error) {
        logger.error('PUT /api/users/:id error:', error);
        res.status(500).json({ success: false, message: 'Failed to update user' });
    }
});

// ---------------------------------------------------------------------------
// API — PUT /api/users/:id/password  (reset password)
// ---------------------------------------------------------------------------

router.put('/api/users/:id/password', requireAdmin, [
    body('password').notEmpty().withMessage('Password is required')
        .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const id = parseInt(req.params.id, 10);
        if (!id || id < 1) {
            return res.status(400).json({ success: false, message: 'Invalid user ID' });
        }

        const db = req.app.locals.db;
        const target = await db.get('SELECT * FROM users WHERE id = ?', [id]);
        if (!target) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Protect superadmin from non-superadmins
        if (target.is_protected && !isSuperAdmin(req)) {
            return res.status(403).json({ success: false, message: 'Cannot reset a protected account\'s password' });
        }

        const hashed = await bcrypt.hash(req.body.password, 10);
        await db.run(
            'UPDATE users SET password = ?, must_change_password = 1 WHERE id = ?',
            [hashed, id]
        );

        logger.info(`Password reset for user ${id} by ${req.session.user.username}`);
        res.json({ success: true, message: 'Password reset. User must change it on next login.' });
    } catch (error) {
        logger.error('PUT /api/users/:id/password error:', error);
        res.status(500).json({ success: false, message: 'Failed to reset password' });
    }
});

// ---------------------------------------------------------------------------
// API — DELETE /api/users/:id  (deactivate or hard-delete)
// ---------------------------------------------------------------------------

router.delete('/api/users/:id', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id || id < 1) {
            return res.status(400).json({ success: false, message: 'Invalid user ID' });
        }

        const db = req.app.locals.db;
        const target = await db.get('SELECT * FROM users WHERE id = ?', [id]);
        if (!target) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Cannot delete own account
        if (target.id === req.session.user.id) {
            return res.status(400).json({ success: false, message: 'Cannot delete your own account' });
        }

        // Cannot delete protected users
        if (target.is_protected) {
            return res.status(403).json({ success: false, message: 'Cannot delete a protected account' });
        }

        // Non-superadmins cannot delete superadmin accounts
        if (target.role === 'superadmin' && !isSuperAdmin(req)) {
            return res.status(403).json({ success: false, message: 'Only a superadmin can delete superadmin accounts' });
        }

        const force = req.query.force === 'true';
        if (force) {
            await db.run('DELETE FROM users WHERE id = ?', [id]);
            logger.info(`User ${id} (${target.username}) permanently deleted by ${req.session.user.username}`);
            res.json({ success: true, message: 'User permanently deleted' });
        } else {
            await db.run('UPDATE users SET is_active = 0 WHERE id = ?', [id]);
            logger.info(`User ${id} (${target.username}) deactivated by ${req.session.user.username}`);
            res.json({ success: true, message: 'User deactivated' });
        }
    } catch (error) {
        logger.error('DELETE /api/users/:id error:', error);
        res.status(500).json({ success: false, message: 'Failed to deactivate user' });
    }
});

// ---------------------------------------------------------------------------
// API — GET /api/users/stats
// ---------------------------------------------------------------------------

router.get('/api/users/stats', requireAdmin, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const [total, active, byRole] = await Promise.all([
            db.get('SELECT COUNT(*) as count FROM users'),
            db.get('SELECT COUNT(*) as count FROM users WHERE is_active = 1'),
            db.all('SELECT role, COUNT(*) as count FROM users GROUP BY role')
        ]);

        res.json({
            success: true,
            stats: {
                total:  total?.count  || 0,
                active: active?.count || 0,
                byRole: byRole || []
            }
        });
    } catch (error) {
        logger.error('GET /api/users/stats error:', error);
        res.status(500).json({ success: false, message: 'Failed to retrieve stats' });
    }
});

// GET /admin/api/audit — login audit log (paginated)
router.get('/api/audit', requireAdmin, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const page  = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, parseInt(req.query.limit) || 50);
        const offset = (page - 1) * limit;
        const username = req.query.username?.trim() || null;

        const where = username ? `WHERE la.username LIKE ?` : '';
        const params = username ? [`%${username}%`] : [];

        const [rows, total] = await Promise.all([
            db.all(`
                SELECT la.id, la.username, la.success, la.ip, la.reason, la.created_at,
                       u.name
                FROM login_audit la
                LEFT JOIN users u ON u.id = la.user_id
                ${where}
                ORDER BY la.created_at DESC
                LIMIT ? OFFSET ?
            `, [...params, limit, offset]),
            db.get(`SELECT COUNT(*) AS count FROM login_audit la ${where}`, params)
        ]);

        res.json({ success: true, audit: rows, total: total.count, page, limit });
    } catch (error) {
        logger.error('GET /admin/api/audit error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch audit log' });
    }
});

// GET /admin/api/sessions — list active sessions (admin only)
router.get('/api/sessions', requireAdmin, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const nowUnix = Math.floor(Date.now() / 1000);
        // connect-sqlite3 stores sessions with 'expired' as a Unix timestamp integer
        const rows = await db.all(
            `SELECT sid, sess, expired FROM sessions WHERE expired > ? ORDER BY expired DESC`,
            [nowUnix]
        );

        const sessions = rows.map(row => {
            let parsed = {};
            try { parsed = typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess; } catch (_) {}
            return {
                sid: row.sid,
                user: parsed.user ? { id: parsed.user.id, username: parsed.user.username, role: parsed.user.role } : null,
                expires: new Date(row.expired * 1000).toISOString(),
                isCurrent: row.sid === req.sessionID
            };
        });

        res.json({ success: true, sessions });
    } catch (error) {
        logger.error('GET /admin/api/sessions error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch sessions' });
    }
});

// DELETE /admin/api/sessions/:sid — terminate a session (admin only)
router.delete('/api/sessions/:sid', requireAdmin, async (req, res) => {
    try {
        const sid = req.params.sid;
        if (sid === req.sessionID) {
            return res.status(400).json({ success: false, message: 'Cannot terminate your own session here. Use logout instead.' });
        }
        const db = req.app.locals.db;
        await db.run(`DELETE FROM sessions WHERE sid = ?`, [sid]);
        logger.info(`Session terminated by admin ${req.session.user.username}: ${sid}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('DELETE /admin/api/sessions/:sid error:', error);
        res.status(500).json({ success: false, message: 'Failed to terminate session' });
    }
});

// GET /admin/api/user/preferences — get current user's preferences
router.get('/api/user/preferences', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
    try {
        const db = req.app.locals.db;
        const row = await db.get(`SELECT preferences FROM users WHERE id = ?`, [req.session.user.id]);
        let prefs = {};
        try { prefs = row?.preferences ? JSON.parse(row.preferences) : {}; } catch (_) {}
        res.json({ success: true, preferences: prefs });
    } catch (error) {
        logger.error('GET preferences error:', error);
        res.status(500).json({ success: false, message: 'Failed to load preferences' });
    }
});

// PUT /admin/api/user/preferences — save current user's preferences
router.put('/api/user/preferences', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
    try {
        const prefs = req.body;
        if (typeof prefs !== 'object' || Array.isArray(prefs)) {
            return res.status(400).json({ success: false, message: 'Preferences must be a JSON object' });
        }
        const db = req.app.locals.db;
        await db.run(
            `UPDATE users SET preferences = ? WHERE id = ?`,
            [JSON.stringify(prefs), req.session.user.id]
        );
        res.json({ success: true });
    } catch (error) {
        logger.error('PUT preferences error:', error);
        res.status(500).json({ success: false, message: 'Failed to save preferences' });
    }
});

// POST /admin/api/invites — create invite link (admin only)
router.post('/api/invites', requireAdmin, [
    body('role').optional().isIn(VALID_ROLES),
    body('email').optional({ nullable: true }).isEmail().normalizeEmail()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

        await req.app.locals.db.run(
            `INSERT INTO invite_tokens (token, email, role, created_by, expires_at) VALUES (?, ?, ?, ?, ?)`,
            [token, req.body.email || null, req.body.role || 'viewer', req.session.user.id, expiresAt]
        );

        const host = req.protocol + '://' + req.get('host');
        logger.info(`Invite created by ${req.session.user.username} — token: ${token.substring(0, 8)}…`);
        res.json({ success: true, link: `${host}/register?token=${token}`, expiresAt });
    } catch (error) {
        logger.error('POST /api/invites error:', error);
        res.status(500).json({ success: false, message: 'Failed to create invite' });
    }
});

// GET /admin/api/invites — list pending invites
router.get('/api/invites', requireAdmin, async (req, res) => {
    try {
        const rows = await req.app.locals.db.all(
            `SELECT i.id, i.email, i.role, i.expires_at, i.used_at,
                    u.username AS created_by_username
             FROM invite_tokens i
             LEFT JOIN users u ON u.id = i.created_by
             WHERE i.used_at IS NULL AND i.expires_at > CURRENT_TIMESTAMP
             ORDER BY i.id DESC LIMIT 50`
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        logger.error('GET /api/invites error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch invites' });
    }
});

// POST /admin/api/users/:id/magic-link — generate a one-time login link (admin only)
router.post('/api/users/:id/magic-link', requireAdmin, [param('id').isInt({ min: 1 })], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

        const userId = parseInt(req.params.id);
        const db = req.app.locals.db;
        const user = await db.get('SELECT id, username, is_active FROM users WHERE id = ?', [userId]);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        if (!user.is_active) return res.status(400).json({ success: false, message: 'User is deactivated' });
        // Prevent generating link for self — admins should log in normally
        if (userId === req.session.user.id) return res.status(400).json({ success: false, message: 'Cannot generate magic link for yourself' });

        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes

        await db.run(
            'UPDATE users SET magic_login_token = ?, magic_login_expires = ? WHERE id = ?',
            [tokenHash, expires, userId]
        );

        const host = `${req.protocol}://${req.get('host')}`;
        logger.info(`Magic login link generated for user ${user.username} by ${req.session.user.username}`);
        res.json({ success: true, url: `${host}/auth/magic/${token}`, expiresIn: '15 minutes' });
    } catch (error) {
        logger.error('POST magic-link error:', error);
        res.status(500).json({ success: false, message: 'Failed to generate magic link' });
    }
});

// DELETE /admin/api/invites/:id — revoke invite
router.delete('/api/invites/:id', requireAdmin, [param('id').isInt({ min: 1 })], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });
        await req.app.locals.db.run(`DELETE FROM invite_tokens WHERE id = ?`, [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        logger.error('DELETE /api/invites/:id error:', error);
        res.status(500).json({ success: false, message: 'Failed to revoke invite' });
    }
});

// ---------------------------------------------------------------------------
// API — GET /api/users/:id/sessions — list active sessions for a user
// ---------------------------------------------------------------------------

router.get('/api/users/:id/sessions', authMiddleware, async (req, res) => {
    try {
        const db = require('../config/database').getDatabase();
        const userId = parseInt(req.params.id);
        // Users can only view their own sessions; admins can view any
        const currentUser = req.user || req.session?.user;
        if (currentUser.id !== userId && !['admin','superadmin'].includes(currentUser.role)) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }
        const sessions = db.prepare(`
            SELECT id, ip_address, user_agent, device_info, logged_in_at, last_active,
                   (session_id = ?) as is_current
            FROM login_sessions
            WHERE user_id = ? AND is_active = 1
            ORDER BY last_active DESC
        `).all(req.sessionID, userId);
        res.json({ success: true, sessions });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Failed to fetch sessions' });
    }
});

// ---------------------------------------------------------------------------
// API — DELETE /api/users/:id/sessions/:sessionRecordId — remote logout
// ---------------------------------------------------------------------------

router.delete('/api/users/:id/sessions/:sessionRecordId', authMiddleware, async (req, res) => {
    try {
        const db = require('../config/database').getDatabase();
        const userId = parseInt(req.params.id);
        const currentUser = req.user || req.session?.user;
        if (currentUser.id !== userId && !['admin','superadmin'].includes(currentUser.role)) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }
        // Get the session_id to invalidate
        const record = db.prepare('SELECT session_id FROM login_sessions WHERE id=? AND user_id=?').get(req.params.sessionRecordId, userId);
        if (!record) return res.status(404).json({ success: false, error: 'Session not found' });
        // Mark as inactive
        db.prepare('UPDATE login_sessions SET is_active=0 WHERE id=?').run(req.params.sessionRecordId);
        // Destroy the actual express session
        const sessionStore = req.sessionStore;
        if (sessionStore && typeof sessionStore.destroy === 'function') {
            sessionStore.destroy(record.session_id, () => {});
        }
        res.json({ success: true, message: 'Session terminated' });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Failed to terminate session' });
    }
});

module.exports = router;
