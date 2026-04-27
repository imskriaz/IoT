'use strict';
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { body, param, validationResult } = require('express-validator');
const logger  = require('../utils/logger');

const VALID_SCOPES = ['read', 'write', 'admin'];

// ---------------------------------------------------------------------------
// Per-key sliding-window rate limiter (in-memory, resets on server restart)
// ---------------------------------------------------------------------------
const _rateBuckets = new Map(); // keyId -> { count, windowStart }

function checkRateLimit(keyId, limitRpm) {
    if (!limitRpm) return null; // unlimited
    const now    = Date.now();
    const window = 60_000; // 1 minute
    let bucket = _rateBuckets.get(keyId);
    if (!bucket || now - bucket.windowStart >= window) {
        bucket = { count: 0, windowStart: now };
    }
    bucket.count++;
    _rateBuckets.set(keyId, bucket);
    if (bucket.count > limitRpm) {
        const retryAfter = Math.ceil((bucket.windowStart + window - now) / 1000);
        return retryAfter; // seconds until window resets
    }
    return null;
}

function generateApiKey() {
    const raw = crypto.randomBytes(32).toString('hex');
    return `edk_${raw}`; // prefix makes keys recognisable
}

function hashKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * @swagger
 * tags:
 *   name: API Keys
 *   description: Manage personal API keys for programmatic access
 */

/**
 * @swagger
 * /keys:
 *   get:
 *     summary: List your API keys
 *     tags: [API Keys]
 *     security:
 *       - sessionCookie: []
 *       - apiKey: []
 *     responses:
 *       200:
 *         description: Array of API key objects (no secret hashes)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 keys:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ApiKey'
 */
// GET /api/keys — list caller's API keys (no hashes returned)
router.get('/', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const keys = await db.all(
            `SELECT id, name, key_prefix, scopes, device_ids, last_used, expires_at, is_active, created_at, rate_limit_rpm
             FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`,
            [req.session.user.id]
        );
        res.json({ success: true, keys });
    } catch (error) {
        logger.error('GET /api/keys error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch API keys' });
    }
});

/**
 * @swagger
 * /keys:
 *   post:
 *     summary: Create a new API key
 *     description: The plaintext key is returned **only once** — store it securely.
 *     tags: [API Keys]
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
 *               name:           { type: string, example: "Home automation bot" }
 *               scopes:         { type: string, enum: [read, write, admin], default: read }
 *               device_ids:     { type: array, items: { type: string } }
 *               expires_days:   { type: integer, minimum: 1, maximum: 365 }
 *               rate_limit_rpm: { type: integer, minimum: 1, maximum: 10000 }
 *     responses:
 *       200:
 *         description: Key created — includes plaintext key
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 id:      { type: integer }
 *                 key:     { type: string, description: "Full plaintext key — shown once" }
 *                 prefix:  { type: string }
 */
// POST /api/keys — create a new API key (returns plaintext key ONCE)
router.post('/', [
    body('name').trim().notEmpty().withMessage('Name required').isLength({ max: 100 }),
    body('scopes').optional().isIn(VALID_SCOPES).withMessage('Invalid scope'),
    body('device_ids').optional().isArray(),
    body('expires_days').optional().isInt({ min: 1, max: 365 }),
    body('rate_limit_rpm').optional({ nullable: true }).isInt({ min: 1, max: 10000 }).withMessage('Rate limit must be 1–10000 req/min')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

        const db = req.app.locals.db;
        const { name, scopes = 'read', device_ids, expires_days, rate_limit_rpm } = req.body;

        const plainKey  = generateApiKey();
        const keyHash   = hashKey(plainKey);
        const keyPrefix = plainKey.substring(0, 12); // "edk_" + 8 chars shown in list

        const expiresAt = expires_days
            ? new Date(Date.now() + expires_days * 86400000).toISOString()
            : null;

        const rateLimit = rate_limit_rpm ? parseInt(rate_limit_rpm) : null;
        const result = await db.run(
            `INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, device_ids, expires_at, rate_limit_rpm)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.session.user.id, name, keyHash, keyPrefix,
             scopes, device_ids ? JSON.stringify(device_ids) : null, expiresAt, rateLimit]
        );

        logger.info(`API key created: ${name} (id=${result.lastID}) for user ${req.session.user.id}`);
        res.json({ success: true, id: result.lastID, key: plainKey, prefix: keyPrefix });
    } catch (error) {
        logger.error('POST /api/keys error:', error);
        res.status(500).json({ success: false, message: 'Failed to create API key' });
    }
});

/**
 * @swagger
 * /keys/{id}:
 *   delete:
 *     summary: Revoke an API key
 *     tags: [API Keys]
 *     security:
 *       - sessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Key revoked
 *       404:
 *         description: Key not found or not owned by caller
 */
// DELETE /api/keys/:id — revoke (deactivate) a key
router.delete('/:id', [param('id').isInt({ min: 1 })], async (req, res) => {
    try {
        const db = req.app.locals.db;
        const result = await db.run(
            `UPDATE api_keys SET is_active = 0 WHERE id = ? AND user_id = ?`,
            [req.params.id, req.session.user.id]
        );
        if (!result.changes) return res.status(404).json({ success: false, message: 'Key not found' });
        logger.info(`API key revoked: id=${req.params.id} by user ${req.session.user.id}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('DELETE /api/keys/:id error:', error);
        res.status(500).json({ success: false, message: 'Failed to revoke key' });
    }
});

// Middleware: apiKeyAuth — validates X-API-Key header, attaches req.apiKeyUser
// Export separately so it can be used by other routes
async function apiKeyAuth(req, res, next) {
    const rawKey = req.headers['x-api-key'];
    if (!rawKey) return next();  // no key present — let session auth handle it

    try {
        const db = req.app.locals.db;
        const hash = hashKey(rawKey);
        const keyRow = await db.get(
            `SELECT k.*, u.id AS uid, u.username, u.role, u.is_active AS user_active
             FROM api_keys k
             INNER JOIN users u ON u.id = k.user_id
             WHERE k.key_hash = ? AND k.is_active = 1`,
            [hash]
        );

        if (!keyRow) return res.status(401).json({ success: false, message: 'Invalid API key' });
        if (!keyRow.user_active) return res.status(403).json({ success: false, message: 'Account inactive' });
        if (keyRow.expires_at && new Date(keyRow.expires_at) < new Date()) {
            return res.status(401).json({ success: false, message: 'API key expired' });
        }

        // Rate limit check
        if (keyRow.rate_limit_rpm) {
            const retryAfter = checkRateLimit(keyRow.id, keyRow.rate_limit_rpm);
            if (retryAfter !== null) {
                res.set('Retry-After', String(retryAfter));
                res.set('X-RateLimit-Limit', String(keyRow.rate_limit_rpm));
                return res.status(429).json({
                    success: false,
                    message: `Rate limit exceeded. Retry after ${retryAfter}s.`
                });
            }
        }

        // Attach user to session-like object for compatibility
        req.session = req.session || {};
        req.session.user = { id: keyRow.uid, username: keyRow.username, role: keyRow.role };
        req.apiKey = { id: keyRow.id, scopes: keyRow.scopes, device_ids: keyRow.device_ids };

        // Update last_used (fire-and-forget)
        db.run(`UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?`, [keyRow.id]).catch(() => {});

        next();
    } catch (err) {
        logger.error('apiKeyAuth error:', err);
        next(err);
    }
}

module.exports = router;
module.exports.apiKeyAuth = apiKeyAuth;
