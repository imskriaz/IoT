/**
 * OTA Firmware Update routes
 * POST /api/ota/upload  — upload a .bin firmware file
 * POST /api/ota/flash   — trigger OTA update on device via MQTT
 * GET  /api/ota/list    — list available firmware files
 * DELETE /api/ota/:filename — delete a firmware file
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { admin: adminMiddleware } = require('../middleware/auth');

const FIRMWARE_DIR = path.join(__dirname, '../data/firmware');
const LOCAL_OTA_DIR = path.resolve(__dirname, '../../ota');
const OTA_COMMAND_TIMEOUT_MS = 300000;
fs.mkdirSync(FIRMWARE_DIR, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, FIRMWARE_DIR),
        filename: (_req, file, cb) => {
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            cb(null, `firmware-${ts}${path.extname(file.originalname)}`);
        }
    }),
    limits: { fileSize: 4 * 1024 * 1024, files: 1 }, // 4 MB max
    fileFilter: (_req, file, cb) => {
        if (path.extname(file.originalname).toLowerCase() !== '.bin') {
            return cb(new Error('Only .bin firmware files are accepted'));
        }
        cb(null, true);
    }
});

function safeFilename(name) {
    return /^[\w.\-]+$/.test(name) && !name.includes('..');
}

async function listFirmwareFiles(dirPath) {
    const files = await fs.promises.readdir(dirPath);
    const binFiles = files.filter(f => f.endsWith('.bin'));
    const details = await Promise.all(binFiles.map(async f => {
        const stat = await fs.promises.stat(path.join(dirPath, f));
        return { filename: f, size: stat.size, uploadedAt: stat.mtime.toISOString() };
    }));
    details.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    return details;
}

function otaSigningSecret() {
    return process.env.OTA_DOWNLOAD_SECRET || process.env.SESSION_SECRET || 'esp32-dashboard-ota';
}

function createDownloadSignature(filename, expires) {
    return crypto
        .createHmac('sha256', otaSigningSecret())
        .update(`${filename}:${expires}`)
        .digest('hex');
}

function isLoopbackHost(hostname) {
    const normalized = String(hostname || '').trim().toLowerCase();
    return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(normalized);
}

function getOtaBaseUrl(req) {
    const configured = (process.env.OTA_BASE_URL || process.env.PUBLIC_BASE_URL || '').trim();
    if (configured) {
        return configured.replace(/\/+$/, '');
    }

    const host = req.get('host');
    if (!host) return null;

    const protocol = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
    const hostname = host.replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '');
    if (isLoopbackHost(hostname)) {
        return null;
    }

    return `${protocol}://${host}`;
}

function buildSignedFirmwareUrl(req, filename) {
    const baseUrl = getOtaBaseUrl(req);
    if (!baseUrl) return null;

    const expires = Date.now() + (15 * 60 * 1000);
    const sig = createDownloadSignature(filename, expires);
    return `${baseUrl}/api/ota/download/${encodeURIComponent(filename)}?expires=${expires}&sig=${sig}`;
}

router.get('/download/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        const expires = Number(req.query.expires);
        const sig = String(req.query.sig || '');

        if (!safeFilename(filename) || !filename.endsWith('.bin')) {
            return res.status(400).json({ success: false, message: 'Invalid firmware filename' });
        }
        if (!Number.isFinite(expires) || expires < Date.now()) {
            return res.status(403).json({ success: false, message: 'Firmware download link expired' });
        }

        const expected = createDownloadSignature(filename, expires);
        const sigBuf = Buffer.from(sig, 'hex');
        const expectedBuf = Buffer.from(expected, 'hex');
        if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
            return res.status(403).json({ success: false, message: 'Invalid firmware download signature' });
        }

        const filePath = path.resolve(FIRMWARE_DIR, filename);
        if (!filePath.startsWith(FIRMWARE_DIR + path.sep) || !fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: 'Firmware file not found' });
        }

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.sendFile(filePath);
    } catch (error) {
        logger.error('OTA download error:', error);
        res.status(500).json({ success: false, message: 'Failed to download firmware' });
    }
});

// List firmware files
router.get('/list', adminMiddleware, async (req, res) => {
    try {
        const details = await listFirmwareFiles(FIRMWARE_DIR);
        res.json({ success: true, data: details });
    } catch (error) {
        logger.error('OTA list error:', error);
        res.status(500).json({ success: false, message: 'Failed to list firmware files' });
    }
});

router.get('/local-list', adminMiddleware, async (_req, res) => {
    try {
        await fs.promises.mkdir(LOCAL_OTA_DIR, { recursive: true });
        const details = await listFirmwareFiles(LOCAL_OTA_DIR);
        res.json({ success: true, data: details });
    } catch (error) {
        logger.error('Local OTA list error:', error);
        res.status(500).json({ success: false, message: 'Failed to list ota folder firmware files' });
    }
});

// Upload firmware file
router.post('/upload', adminMiddleware, (req, res) => {
    upload.single('firmware')(req, res, (err) => {
        if (err) {
            logger.error('OTA upload error:', err.message);
            return res.status(400).json({ success: false, message: 'File upload failed' });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }
        logger.info(`OTA firmware uploaded: ${req.file.filename} (${req.file.size} bytes)`);
        res.json({
            success: true,
            message: 'Firmware uploaded successfully',
            data: { filename: req.file.filename, size: req.file.size }
        });
    });
});

router.post('/import-local', adminMiddleware, express.json(), async (req, res) => {
    try {
        const filename = String(req.body?.filename || '').trim();
        if (!filename || !safeFilename(filename) || !filename.endsWith('.bin')) {
            return res.status(400).json({ success: false, message: 'Invalid firmware filename' });
        }

        const sourcePath = path.resolve(LOCAL_OTA_DIR, filename);
        if (!sourcePath.startsWith(LOCAL_OTA_DIR + path.sep) || !fs.existsSync(sourcePath)) {
            return res.status(404).json({ success: false, message: 'ota folder firmware file not found' });
        }

        const destinationPath = path.resolve(FIRMWARE_DIR, filename);
        if (!destinationPath.startsWith(FIRMWARE_DIR + path.sep)) {
            return res.status(400).json({ success: false, message: 'Invalid destination filename' });
        }

        await fs.promises.copyFile(sourcePath, destinationPath);
        const stat = await fs.promises.stat(destinationPath);
        logger.info(`OTA firmware imported from ota folder: ${filename} (${stat.size} bytes)`);
        res.json({
            success: true,
            message: 'Firmware imported from ota folder',
            data: { filename, size: stat.size }
        });
    } catch (error) {
        logger.error('OTA local import error:', error);
        res.status(500).json({ success: false, message: 'Failed to import firmware from ota folder' });
    }
});

/**
 * Run OTA pre-flight.
 *
 * Legacy persisted device-test history has been retired, so OTA no longer reads
 * dropped dashboard tables like test_results/test_steps here. Keep the hook in
 * place so a future runtime/device-backed pre-flight can be added without
 * changing the route contract.
 */
async function runPreflight(_db, _deviceId) {
    return { ok: true, skipped: true, reason: 'Persisted OTA pre-flight history is disabled' };
}

/**
 * @swagger
 * tags:
 *   name: OTA
 *   description: Over-the-air firmware management
 */

/**
 * @swagger
 * /ota/flash:
 *   post:
 *     summary: Push firmware to device via MQTT
 *     description: |
 *       Triggers an OTA update on the target device. The dashboard keeps the
 *       pre-flight hook for future runtime safety checks, but it no longer reads
 *       retired persisted device-test history tables before flashing.
 *     tags: [OTA]
 *     security:
 *       - sessionCookie: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [filename]
 *             properties:
 *               deviceId:      { type: string, default: "1" }
 *               filename:      { type: string, example: "firmware-2024-01-01.bin" }
 *               skipPreflight: { type: boolean, default: false, description: "Reserved for future runtime pre-flight checks" }
 *     responses:
 *       200:
 *         description: OTA command sent to device
 *       412:
 *         description: Reserved for a future OTA pre-flight failure
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:     { type: boolean, example: false }
 *                 message:     { type: string }
 *                 failedTests: { type: array, items: { type: object, properties: { id: { type: string }, name: { type: string } } } }
 *                 hint:        { type: string }
 *       503:
 *         description: MQTT not connected
 */
// Trigger OTA update on device via MQTT
router.post('/flash', adminMiddleware, async (req, res) => {
    try {
        const { filename, skipPreflight = false } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);

        if (!filename || !safeFilename(filename)) {
            return res.status(400).json({ success: false, message: 'Invalid firmware filename' });
        }

        const filePath = path.join(FIRMWARE_DIR, filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: 'Firmware file not found' });
        }

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({ success: false, message: 'MQTT not connected — cannot trigger OTA' });
        }

        // Pre-flight check — block if critical tests failed (unless caller overrides)
        if (!skipPreflight) {
            const db = req.app.locals.db;
            const preflight = await runPreflight(db, deviceId);
            if (!preflight.ok) {
                logger.warn(`OTA pre-flight blocked for ${deviceId}: ${preflight.reason}`);
                return res.status(412).json({
                    success: false,
                    message: preflight.reason,
                    failedTests: preflight.failedTests,
                    hint: 'Pass skipPreflight=true to force flash anyway'
                });
            }
        }

        // Build URL the device will fetch the firmware from
        const firmwareUrl = buildSignedFirmwareUrl(req, filename);
        if (!firmwareUrl) {
            return res.status(400).json({
                success: false,
                message: 'OTA base URL is not reachable from the device. Open the dashboard via a reachable IP/domain or set OTA_BASE_URL.'
            });
        }

        await global.mqttService.publishCommand(
            deviceId,
            'ota-update',
            { url: firmwareUrl, timeout: OTA_COMMAND_TIMEOUT_MS },
            false,
            OTA_COMMAND_TIMEOUT_MS
        );

        // Record in history and keep only last 10 per device
        const db = req.app.locals.db;
        if (db) {
            const stat = fs.statSync(filePath);
            const devStatus = global.modemService?.getDeviceStatus?.(deviceId);
            await db.run(
                `INSERT INTO device_ota_history (device_id, filename, firmware_version, file_size, flashed_by) VALUES (?, ?, ?, ?, ?)`,
                [deviceId, filename, devStatus?.firmware || null, stat.size, req.session?.user?.username || 'admin']
            );
            // Prune to 10 most recent
            await db.run(
                `DELETE FROM device_ota_history WHERE device_id = ? AND id NOT IN (
                    SELECT id FROM device_ota_history WHERE device_id = ? ORDER BY flashed_at DESC LIMIT 10
                )`,
                [deviceId, deviceId]
            );
        }

        // Notify all browser clients that OTA has started
        if (global.io) {
            global.io.to('device:' + deviceId).emit('ota:started', { deviceId, filename, firmwareUrl });
        }

        logger.info(`OTA flash triggered on ${deviceId} — url: ${firmwareUrl}`);
        res.json({ success: true, message: 'OTA update triggered', data: { deviceId, firmwareUrl } });
    } catch (error) {
        logger.error('OTA flash error:', error);
        res.status(500).json({ success: false, message: 'Failed to trigger OTA update' });
    }
});

// GET /api/ota/history/:deviceId — last 10 flash records for rollback UI
router.get('/history/:deviceId', adminMiddleware, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const rows = await db.all(
            `SELECT id, filename, firmware_version, file_size, flashed_at, flashed_by, notes
             FROM device_ota_history
             WHERE device_id = ? ORDER BY flashed_at DESC LIMIT 10`,
            [req.params.deviceId]
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        logger.error('OTA history error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch OTA history' });
    }
});

// POST /api/ota/rollback — re-flash the previous firmware for a device
router.post('/rollback', adminMiddleware, async (req, res) => {
    try {
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const db = req.app.locals.db;

        const rows = await db.all(
            `SELECT filename FROM device_ota_history WHERE device_id = ? ORDER BY flashed_at DESC LIMIT 10`,
            [deviceId]
        );

        if (rows.length < 2) {
            return res.status(400).json({ success: false, message: 'No previous firmware to roll back to' });
        }

        const filename = rows[1].filename; // index 1 = previous
        const filePath = path.join(FIRMWARE_DIR, filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: `Previous firmware file not found: ${filename}` });
        }

        if (!global.mqttService?.connected) {
            return res.status(503).json({ success: false, message: 'MQTT not connected — cannot trigger OTA' });
        }

        const firmwareUrl = buildSignedFirmwareUrl(req, filename);
        if (!firmwareUrl) {
            return res.status(400).json({
                success: false,
                message: 'OTA base URL is not reachable from the device. Open the dashboard via a reachable IP/domain or set OTA_BASE_URL.'
            });
        }

        await global.mqttService.publishCommand(
            deviceId,
            'ota-update',
            { url: firmwareUrl, timeout: OTA_COMMAND_TIMEOUT_MS },
            false,
            OTA_COMMAND_TIMEOUT_MS
        );

        // Record rollback in history and prune
        await db.run(
            `INSERT INTO device_ota_history (device_id, filename, flashed_by) VALUES (?, ?, ?)`,
            [deviceId, filename, (req.session?.user?.username || 'admin') + ' (rollback)']
        );
        await db.run(
            `DELETE FROM device_ota_history WHERE device_id = ? AND id NOT IN (
                SELECT id FROM device_ota_history WHERE device_id = ? ORDER BY flashed_at DESC LIMIT 10
            )`,
            [deviceId, deviceId]
        );

        if (global.io) {
            global.io.to('device:' + deviceId).emit('ota:started', { deviceId, filename, firmwareUrl });
        }

        logger.info(`OTA rollback triggered on ${deviceId} — filename: ${filename}`);
        res.json({ success: true, message: 'Rollback triggered', data: { deviceId, filename, firmwareUrl } });
    } catch (error) {
        logger.error('OTA rollback error:', error);
        res.status(500).json({ success: false, message: 'Failed to trigger rollback' });
    }
});

// Delete a firmware file
router.delete('/:filename', adminMiddleware, async (req, res) => {
    try {
        const { filename } = req.params;
        if (!safeFilename(filename) || !filename.endsWith('.bin')) {
            return res.status(400).json({ success: false, message: 'Invalid filename' });
        }
        const filePath = path.resolve(FIRMWARE_DIR, filename);
        if (!filePath.startsWith(FIRMWARE_DIR + path.sep)) {
            return res.status(400).json({ success: false, message: 'Invalid filename' });
        }
        await fs.promises.unlink(filePath);
        logger.info(`OTA firmware deleted: ${filename}`);
        res.json({ success: true, message: 'Firmware file deleted' });
    } catch (error) {
        if (error.code === 'ENOENT') {
            return res.status(404).json({ success: false, message: 'File not found' });
        }
        logger.error('OTA delete error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete firmware file' });
    }
});

module.exports = router;
