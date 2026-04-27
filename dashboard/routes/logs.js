const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const logger = require('../utils/logger');
const { admin: adminMiddleware } = require('../middleware/auth');
const { clearFileLogs } = require('../services/logCleanupService');

const LOGS_DIR = path.join(__dirname, '../logs');
const VALID_SOURCES = ['app', 'mqtt', 'error'];
const VALID_LEVELS = ['error', 'warn', 'info', 'debug'];

/**
 * Read the last `limit` JSON-log lines from a rotating log file,
 * optionally filtering by level and a `since` ISO timestamp.
 *
 * Rotating files are named  <name>-YYYY-MM-DD.log  so we find the
 * most-recent file whose date is >= the since date (or today's file
 * if since is absent).
 */
async function readLogLines(source, { level, limit, since }) {
    // Resolve which file to read: prefer today's, fall back to latest
    const prefix = source === 'app' ? 'app-' : source === 'mqtt' ? 'mqtt-' : 'error-';

    let files;
    try {
        files = fs.readdirSync(LOGS_DIR)
            .filter(f => f.startsWith(prefix) && f.endsWith('.log'))
            .sort()
            .reverse(); // newest first
    } catch (e) {
        return [];
    }

    if (!files.length) return [];

    const lines = [];
    const sinceDate = since ? new Date(since) : null;
    const wantLevel = level && VALID_LEVELS.includes(level) ? level : null;

    // Read files newest-first until we have enough lines
    for (const file of files) {
        if (lines.length >= limit) break;

        const filePath = path.join(LOGS_DIR, file);
        let fileLines = [];

        await new Promise((resolve) => {
            const rl = readline.createInterface({
                input: fs.createReadStream(filePath),
                crlfDelay: Infinity
            });
            rl.on('line', (raw) => {
                if (!raw.trim()) return;
                try {
                    const entry = JSON.parse(raw);
                    if (sinceDate && new Date(entry.timestamp) <= sinceDate) return;
                    if (wantLevel && entry.level !== wantLevel) return;
                    fileLines.push(entry);
                } catch {
                    // Non-JSON line — skip
                }
            });
            rl.on('close', resolve);
            rl.on('error', resolve);
        });

        // Keep only the tail from this file so we don't overshoot the limit
        const need = limit - lines.length;
        fileLines = fileLines.slice(-need);
        lines.unshift(...fileLines);
    }

    // Return newest-first
    return lines.reverse().slice(0, limit);
}

// ==================== API: GET /api/logs ====================
// Query params:
//   source  — app | mqtt | error  (default: app)
//   level   — error | warn | info | debug  (default: all)
//   limit   — 1-500  (default: 100)
//   since   — ISO timestamp  (default: none)
router.get('/', async (req, res) => {
    try {
        const source = VALID_SOURCES.includes(req.query.source) ? req.query.source : 'app';
        const level  = req.query.level || null;
        const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
        const since  = req.query.since || null;

        const entries = await readLogLines(source, { level, limit, since });

        res.json({ success: true, count: entries.length, entries });
    } catch (error) {
        logger.error('Log API error:', error);
        res.status(500).json({ success: false, message: 'Failed to read logs' });
    }
});

router.delete('/', adminMiddleware, async (req, res) => {
    try {
        const source = VALID_SOURCES.includes(req.query.source) ? req.query.source : 'app';
        const result = clearFileLogs(source);
        res.json({
            success: true,
            message: `${source} log cleared`,
            data: result
        });
    } catch (error) {
        logger.error('Log clear API error:', error);
        res.status(500).json({ success: false, message: 'Failed to clear logs' });
    }
});

// ==================== PAGE: GET /logs ====================
router.get('/page', (req, res) => {
    res.render('pages/logs', {
        title: 'System Logs',
        user: req.session.user
    });
});

module.exports = router;
