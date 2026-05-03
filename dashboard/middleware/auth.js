// middleware/auth.js
const crypto = require('crypto');
const logger = require('../utils/logger');

function getRequiredScope(method, path) {
    if (['GET', 'HEAD'].includes(method)) return 'read';
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return 'write';
    return 'read';
}

// Role hierarchy — higher index = more privileged
const ROLE_ORDER = ['viewer', 'operator', 'admin', 'superadmin'];

function getEnvAdminUsername() {
    return String(process.env.ADMIN_USERNAME || process.env.SUPER_USER || 'admin').trim();
}

function isEnvAdminUsername(username) {
    const expected = getEnvAdminUsername();
    const candidate = String(username || '').trim();
    return !!expected && !!candidate && candidate === expected;
}

function withEffectiveRole(user) {
    if (!user) return user;
    if (!isEnvAdminUsername(user.username)) {
        return user;
    }
    return {
        ...user,
        role: 'superadmin',
        is_env_admin: true
    };
}

/**
 * Returns true if the user's role meets or exceeds the required role.
 */
function hasRole(userRole, requiredRole) {
    const userIdx = ROLE_ORDER.indexOf(userRole);
    const reqIdx  = ROLE_ORDER.indexOf(requiredRole);
    if (userIdx === -1 || reqIdx === -1) return false;
    return userIdx >= reqIdx;
}

function getRequestPath(req) {
    const candidate = req.originalUrl || req.url || `${req.baseUrl || ''}${req.path || ''}`;
    return String(candidate || '').split('?')[0];
}

function isApiRequest(req) {
    const requestPath = getRequestPath(req);
    return requestPath === '/api' || requestPath.startsWith('/api/') || requestPath.startsWith('/v1/');
}

/**
 * Resolve an API key from the request header (Bearer token or X-API-Key).
 * Returns the DB row if valid and active, null otherwise.
 */
async function _resolveApiKey(req) {
    let raw = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer edk_')) {
        raw = authHeader.slice(7);
    } else if (req.headers['x-api-key']) {
        raw = req.headers['x-api-key'];
    }
    if (!raw || !raw.startsWith('edk_')) return null;

    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const db = req.app?.locals?.db;
    if (!db) return null;

    try {
        const row = await db.get(
            `SELECT ak.*, u.username, u.role, u.id as uid
             FROM api_keys ak JOIN users u ON ak.user_id = u.id
             WHERE ak.key_hash = ? AND ak.is_active = 1
               AND u.is_active = 1
               AND (ak.expires_at IS NULL OR ak.expires_at > CURRENT_TIMESTAMP)`,
            [hash]
        );
        if (!row) return null;
        // Update last_used (fire-and-forget)
        db.run('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?', [row.id]).catch(() => {});
        return row;
    } catch {
        return null;
    }
}

/**
 * Authentication middleware
 * Accepts session cookies OR API keys (Authorization: Bearer edk_... / X-API-Key: edk_...)
 */
const authMiddleware = async (req, res, next) => {
    const requestPath = getRequestPath(req);

    // Public paths that don't require authentication
    const publicPaths = [
        '/auth/login',
        '/auth/logout',
        '/login',
        '/health'
    ];

    if (
        publicPaths.includes(requestPath) ||
        requestPath.startsWith('/auth/') ||
        requestPath.startsWith('/ota/download/')
    ) {
        return next();
    }

    // ── API key authentication ─────────────────────────────────────────────────
    const apiKeyRow = await _resolveApiKey(req);
    if (apiKeyRow) {
        req.user = withEffectiveRole({ id: apiKeyRow.uid, username: apiKeyRow.username, role: apiKeyRow.role });
        req.apiKey = { id: apiKeyRow.id, name: apiKeyRow.name, scopes: apiKeyRow.scopes };

        // Enforce scope
        const requiredScope = getRequiredScope(req.method, req.path);
        const keyScopes = (apiKeyRow.scopes || '').split(',').map(s => s.trim()).filter(Boolean);
        // 'admin' scope includes read+write; 'write' includes read
        const hasScope = keyScopes.includes('admin') ||
                         (requiredScope === 'write' && keyScopes.includes('write')) ||
                         (requiredScope === 'read' && (keyScopes.includes('read') || keyScopes.includes('write')));
        if (keyScopes.length > 0 && !hasScope) {
            return res.status(403).json({ success: false, error: `API key missing '${requiredScope}' scope` });
        }

        return next();
    }

    // ── Session authentication ─────────────────────────────────────────────────
    // Check if user is authenticated
    if (!req.session.user) {
        logger.debug(`Unauthorized access attempt to ${requestPath}`);

        // Check if it's an API request
        if (isApiRequest(req)) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        return res.redirect('/auth/login');
    }

    if (req.session.user?.id && req.app?.locals?.db) {
        try {
            const currentUser = await req.app.locals.db.get(
                'SELECT id, role, is_active FROM users WHERE id = ?',
                [req.session.user.id]
            );
            if (currentUser && !Number(currentUser.is_active)) {
                if (typeof req.session.destroy === 'function') {
                    await new Promise((resolve) => req.session.destroy(() => resolve()));
                } else {
                    delete req.session.user;
                }

                if (isApiRequest(req)) {
                    return res.status(401).json({ success: false, message: 'Account is inactive' });
                }

                if (typeof req.flash === 'function') {
                    req.flash('error', 'This account is inactive');
                }
                return res.redirect('/auth/login');
            }

            if (currentUser) {
                req.session.user = {
                    ...req.session.user,
                    role: currentUser.role || req.session.user.role
                };
            }
        } catch (_) {}
    }

    // Force password change before accessing anything else
    if (req.session.user?.mustChangePassword) {
        if (isApiRequest(req)) {
            return res.status(403).json({ success: false, message: 'Password change required' });
        }
        return res.redirect('/auth/change-password');
    }

    // Force 2FA setup if role mandates it
    if (req.session.user?.must_setup_2fa) {
        const allowed2faSetupPaths = ['/auth/setup-2fa-required', '/auth/api/2fa/setup', '/auth/api/2fa/confirm', '/auth/api/2fa/complete-required', '/auth/logout'];
        if (!allowed2faSetupPaths.some(p => requestPath.startsWith(p))) {
            if (isApiRequest(req)) {
                return res.status(403).json({ success: false, message: '2FA setup required before accessing the dashboard' });
            }
            return res.redirect('/auth/setup-2fa-required');
        }
    }

    // Add user to request for easy access
    req.user = withEffectiveRole(req.session.user);
    if (req.session.user && req.user?.role !== req.session.user?.role) {
        req.session.user = {
            ...req.session.user,
            role: req.user.role,
            is_env_admin: true
        };
    }

    // Update last_active for session-based logins
    if (req.session?.user && req.sessionID) {
        try {
            const db = require('../config/database').getDatabase();
            if (db) {
                db.prepare('UPDATE login_sessions SET last_active=CURRENT_TIMESTAMP WHERE session_id=? AND is_active=1')
                    .run(req.sessionID);
            }
        } catch (_) {}
    }

    next();
};

/**
 * Check if user has admin role (or superadmin)
 */
const adminMiddleware = (req, res, next) => {
    const user = withEffectiveRole(req.user || req.session.user);
    req.user = user;
    if (!user || !hasRole(user.role, 'admin')) {
        logger.warn(`Admin access denied for user: ${user?.username}`);

        if (req.originalUrl.startsWith('/api/') || req.path.startsWith('/api/')) {
            return res.status(403).json({
                success: false,
                message: 'Admin access required'
            });
        }

        req.flash('error', 'Access denied. Admin privileges required.');
        return res.redirect('/');
    }
    next();
};

/**
 * Middleware factory — requires the user's role to be one of the given roles.
 * Usage: router.get('/route', requireRole('admin', 'superadmin'), handler)
 */
const requireRole = (...roles) => (req, res, next) => {
    const user = withEffectiveRole(req.user || req.session.user);
    req.user = user;
    const userRole = user?.role;
    if (!userRole || !roles.includes(userRole)) {
        logger.warn(`Role access denied (need ${roles.join('/')}) for user: ${user?.username}`);

        if (req.originalUrl.startsWith('/api/') || req.path.startsWith('/api/')) {
            return res.status(403).json({
                success: false,
                message: 'Insufficient permissions'
            });
        }

        req.flash('error', 'Access denied. Insufficient permissions.');
        return res.redirect('/');
    }
    next();
};

/**
 * Returns true if the current request's user is a superadmin.
 */
function isSuperAdmin(req) {
    const user = withEffectiveRole(req.user || req.session.user);
    return user?.role === 'superadmin';
}

/**
 * Middleware factory — checks the user has been assigned access to a device.
 * Admins and superadmins bypass the check (they see all devices).
 *
 * @param {string} paramName  - req.params key that holds the device ID (default: 'deviceId')
 * @param {boolean} writeOnly - if true, also require can_write = 1
 *
 * Usage:
 *   router.get('/:deviceId/status', requireDeviceAccess(), handler)
 *   router.post('/:id/command', requireDeviceAccess('id', true), handler)
 */
const requireDeviceAccess = (paramName = 'deviceId', writeOnly = false) => async (req, res, next) => {
    const user = withEffectiveRole(req.user || req.session.user);
    req.user = user;
    const userRole = user?.role;
    // Admins always pass
    if (hasRole(userRole, 'admin')) return next();

    const deviceId = req.params[paramName];
    if (!deviceId) {
        return res.status(400).json({ success: false, message: 'Device ID required' });
    }

    try {
        const db = req.app.locals.db;
        const assignment = await db.get(
            `SELECT can_write FROM device_users WHERE device_id = ? AND user_id = ?`,
            [deviceId, user.id]
        );

        if (!assignment) {
            if (req.path.startsWith('/api/') || req.xhr) {
                return res.status(403).json({ success: false, message: 'Access denied: device not assigned to you' });
            }
            req.flash('error', 'Access denied: device not assigned to your account.');
            return res.redirect('/devices');
        }

        if (writeOnly && !assignment.can_write) {
            if (req.path.startsWith('/api/') || req.xhr) {
                return res.status(403).json({ success: false, message: 'Write access required for this action' });
            }
            req.flash('error', 'Write access required for this action.');
            return res.redirect('/devices');
        }

        next();
    } catch (err) {
        logger.error('requireDeviceAccess error:', err);
        next(err);
    }
};

module.exports = authMiddleware;
module.exports.admin = adminMiddleware;
module.exports.requireRole = requireRole;
module.exports.requireDeviceAccess = requireDeviceAccess;
module.exports.isSuperAdmin = isSuperAdmin;
module.exports.hasRole = hasRole;
module.exports.withEffectiveRole = withEffectiveRole;
module.exports.isEnvAdminUsername = isEnvAdminUsername;
