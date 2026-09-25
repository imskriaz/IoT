// middleware/auth.js
const crypto = require('crypto');
const logger = require('../utils/logger');
const { explicitDeviceIds, normalizeDeviceId, resolveDeviceId } = require('../utils/deviceResolver');

// API-key controls are enforced here (before any route handler) so individual
// routes cannot accidentally forget device scoping or rate limiting.
const apiKeyRateBuckets = new Map();
function parseDeviceIds(value) {
    if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean);
    try {
        const parsed = JSON.parse(String(value || '[]'));
        return Array.isArray(parsed) ? parsed.map(v => String(v || '').trim()).filter(Boolean) : [];
    } catch (_) {
        return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
    }
}

function requestedDeviceId(req) {
    // Global authentication cannot infer what a route's generic `id` means, or
    // select a session/default device before the route has resolved its target.
    return explicitDeviceIds(req)[0] || '';
}

function enforceApiKeyControls(req, res, apiKeyRow) {
    const limit = Number(apiKeyRow.rate_limit_rpm || 0);
    if (limit > 0) {
        const now = Date.now();
        let bucket = apiKeyRateBuckets.get(apiKeyRow.id);
        if (!bucket || now - bucket.windowStart >= 60000) bucket = { count: 0, windowStart: now };
        bucket.count += 1;
        apiKeyRateBuckets.set(apiKeyRow.id, bucket);
        res.set('X-RateLimit-Limit', String(limit));
        res.set('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
        if (bucket.count > limit) {
            const retryAfter = Math.max(1, Math.ceil((bucket.windowStart + 60000 - now) / 1000));
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({ success: false, message: 'Rate limit exceeded', retryAfter });
        }
    }

    const scoped = parseDeviceIds(apiKeyRow.device_ids);
    const requested = requestedDeviceId(req);
    // A scoped key may only address devices in its allow-list. Requests that do
    // not carry a device id are left to the route (list/read endpoints may be
    // intentionally aggregate), but never permit an explicit out-of-scope id.
    if (scoped.length && requested && !scoped.includes(requested)) {
        return res.status(403).json({ success: false, message: 'API key is not authorized for this device' });
    }
    req.apiKeyDeviceIds = scoped;
    return null;
}

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
    const normalizedRole = user.role === 'user' ? 'viewer' : user.role; // legacy schema default
    if (!isEnvAdminUsername(user.username)) {
        return normalizedRole === user.role ? user : { ...user, role: normalizedRole };
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
    if (authHeader && authHeader.trim().startsWith('Bearer edk_')) {
        raw = authHeader.trim().slice(7);
    } else if (req.headers['x-api-key']) {
        raw = req.headers['x-api-key'];
    }
    raw = String(raw || '').trim();
    const isDashboardKey = raw.startsWith('edk_');
    const isPhoneKey = raw.startsWith('pk_') && getRequestPath(req).startsWith('/v1/');
    if (!raw || (!isDashboardKey && !isPhoneKey)) return null;

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
        requestPath.startsWith('/api/ota/download/') ||
        requestPath.startsWith('/ota/download/')
    ) {
        return next();
    }

    // ── API key authentication ─────────────────────────────────────────────────
    const apiKeyRow = await _resolveApiKey(req);
    if (apiKeyRow) {
        req.user = withEffectiveRole({ id: apiKeyRow.uid, username: apiKeyRow.username, role: apiKeyRow.role });
        req.session = req.session || {};
        req.session.user = req.user;
        const controlError = enforceApiKeyControls(req, res, apiKeyRow);
        if (controlError) return controlError;
        req.apiKey = {
            id: apiKeyRow.id,
            name: apiKeyRow.name,
            scopes: apiKeyRow.scopes,
            device_ids: apiKeyRow.device_ids || null
        };

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
    try {
        const explicit = normalizeDeviceId(req.params?.[paramName]);
        req.deviceAccessParam = paramName;
        const deviceId = explicit || resolveDeviceId(req);
        const authorized = await authorizeDeviceAccess(req, deviceId, { write: writeOnly });
        req.authorizedDeviceId = authorized;
        next();
    } catch (err) {
        if (err.statusCode) {
            if (req.path?.startsWith('/api/') || req.xhr || isApiRequest(req)) return res.status(err.statusCode).json({ success: false, message: err.message });
            if (typeof req.flash === 'function') req.flash('error', err.message);
            return res.redirect('/devices');
        }
        logger.error('requireDeviceAccess error:', err);
        next(err);
    }
};

function accessError(statusCode, message, code = 'DEVICE_ACCESS_DENIED') {
    const error = new Error(message); error.statusCode = statusCode; error.code = code; return error;
}

/** Authorize a concrete device for the authenticated request. */
async function authorizeDeviceAccess(req, deviceId, options = {}) {
    const ids = explicitDeviceIds(req);
    // `id` may name a message/job rather than a device. Only the route's
    // explicit requireDeviceAccess(paramName) contract may give it that meaning.
    const routeId = normalizeDeviceId(req?.params?.[req.deviceAccessParam || 'deviceId']);
    if (routeId && !ids.includes(routeId)) ids.push(routeId);
    const normalized = normalizeDeviceId(deviceId);
    if (ids.length > 1) throw accessError(400, 'Conflicting device selectors', 'DEVICE_SELECTOR_CONFLICT');
    if (!normalized) throw accessError(400, 'Device ID required', 'DEVICE_REQUIRED');
    if (ids.length && ids[0] !== normalized) throw accessError(400, 'Conflicting device selectors', 'DEVICE_SELECTOR_CONFLICT');
    const user = withEffectiveRole(req.user || req.session?.user);
    if (!user?.id || !user?.role) throw accessError(401, 'Authentication required', 'AUTH_REQUIRED');
    if (!hasRole(user.role, 'viewer')) throw accessError(403, 'Device access denied');
    const scoped = Array.isArray(req.apiKeyDeviceIds) ? req.apiKeyDeviceIds : parseDeviceIds(req.apiKey?.device_ids);
    if (scoped.length && !scoped.includes(normalized)) throw accessError(403, 'API key is not authorized for this device', 'DEVICE_KEY_SCOPE');
    if (options.write && !hasRole(user.role, 'operator')) throw accessError(403, 'Write access required for this action', 'WRITE_REQUIRED');
    if (hasRole(user.role, 'admin')) return normalized;
    const db = req.app?.locals?.db;
    if (!db) throw accessError(403, 'Device access cannot be verified', 'DEVICE_ACCESS_UNVERIFIED');
    const assignment = await db.get('SELECT can_write FROM device_users WHERE device_id = ? AND user_id = ?', [normalized, user.id]);
    if (!assignment) throw accessError(403, 'Access denied: device not assigned to you');
    if (options.write && !Number(assignment.can_write)) throw accessError(403, 'Write access required for this action', 'WRITE_REQUIRED');
    return normalized;
}

/** Filter aggregate device views before serializing any runtime state. */
async function filterAuthorizedDevices(req, devices) {
    const user = withEffectiveRole(req.user || req.session?.user);
    if (!user?.id || !user?.role) throw accessError(401, 'Authentication required', 'AUTH_REQUIRED');
    if (!hasRole(user.role, 'viewer')) throw accessError(403, 'Device access denied');
    const selectors = explicitDeviceIds(req);
    if (selectors.length > 1) throw accessError(400, 'Conflicting device selectors', 'DEVICE_SELECTOR_CONFLICT');
    const scoped = Array.isArray(req.apiKeyDeviceIds) ? req.apiKeyDeviceIds : parseDeviceIds(req.apiKey?.device_ids);
    let assigned = null;
    if (!hasRole(user.role, 'admin')) {
        const db = req.app?.locals?.db;
        if (!db?.all) throw accessError(503, 'Device access cannot be verified', 'DEVICE_ACCESS_UNVERIFIED');
        assigned = new Set((await db.all('SELECT device_id FROM device_users WHERE user_id = ?', [user.id]))
            .map(row => normalizeDeviceId(row.device_id)));
    }
    return devices.filter(device => {
        const id = normalizeDeviceId(device?.id);
        return id && (!scoped.length || scoped.includes(id)) && (!assigned || assigned.has(id))
            && (!selectors.length || selectors[0] === id);
    });
}

module.exports = authMiddleware;
module.exports.admin = adminMiddleware;
module.exports.requireRole = requireRole;
module.exports.requireDeviceAccess = requireDeviceAccess;
module.exports.isSuperAdmin = isSuperAdmin;
module.exports.hasRole = hasRole;
module.exports.withEffectiveRole = withEffectiveRole;
module.exports.isEnvAdminUsername = isEnvAdminUsername;
module.exports.parseDeviceIds = parseDeviceIds;
module.exports.requestedDeviceId = requestedDeviceId;
module.exports.authorizeDeviceAccess = authorizeDeviceAccess;
module.exports.filterAuthorizedDevices = filterAuthorizedDevices;
