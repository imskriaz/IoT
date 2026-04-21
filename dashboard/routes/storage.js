const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { resolveDeviceId } = require('../utils/deviceResolver');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');

const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, os.tmpdir()),
        filename: (_req, file, cb) => cb(null, `upload-${Date.now()}-${file.originalname}`)
    }),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB per file
        files: 20
    }
});

// Simple in-memory upload rate limiter: max 50 MB per user per hour
const uploadRateLimiter = new Map(); // userId -> { bytes, resetAt }
function checkUploadRateLimit(userId, bytes) {
    const now = Date.now();
    const existing = uploadRateLimiter.get(userId);
    const MAX_BYTES_PER_HOUR = 50 * 1024 * 1024; // 50 MB
    if (!existing || existing.resetAt < now) {
        uploadRateLimiter.set(userId, { bytes, resetAt: now + 3600000 });
        return true;
    }
    if (existing.bytes + bytes > MAX_BYTES_PER_HOUR) return false;
    existing.bytes += bytes;
    return true;
}

// Per-device operation lock — prevents concurrent file mutations on the same device.
// A middleware applies this to all mutation routes (POST/DELETE/PUT) except list/info reads.
const deviceLocks = new Map(); // deviceId → true while locked

function acquireLock(deviceId) {
    if (deviceLocks.get(deviceId)) return false;
    deviceLocks.set(deviceId, true);
    return true;
}

function releaseLock(deviceId) {
    deviceLocks.delete(deviceId);
}

// Middleware: acquire lock before mutation, release after response
function storageMutexMiddleware(req, res, next) {
    const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
    if (SAFE_METHODS.includes(req.method)) return next();

    // Extract deviceId from body or query
    const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
    if (!acquireLock(deviceId)) {
        return res.status(429).json({
            success: false,
            message: 'A storage operation is already in progress on this device'
        });
    }

    // Release the lock when the response finishes (success or error)
    res.on('finish', () => releaseLock(deviceId));
    res.on('close',  () => releaseLock(deviceId)); // client disconnect
    next();
}

router.use(storageMutexMiddleware);

// Per-user upload rate limiter: 50 MB / hour
const UPLOAD_QUOTA_BYTES = 50 * 1024 * 1024; // 50 MB
const uploadUsage = new Map(); // userId -> { bytes, resetAt }

function checkUploadQuota(req, res, next) {
    if (req.path !== '/upload') return next();
    const userId = req.user?.id || req.session?.user?.id || 'anon';
    const now = Date.now();
    let entry = uploadUsage.get(userId);
    if (!entry || entry.resetAt < now) {
        entry = { bytes: 0, resetAt: now + 3600000 };
        uploadUsage.set(userId, entry);
    }
    const files = req.files || [];
    const incomingBytes = files.reduce((s, f) => s + (f.size || 0), 0);
    if (entry.bytes + incomingBytes > UPLOAD_QUOTA_BYTES) {
        return res.status(429).json({
            success: false,
            message: `Upload quota exceeded (${UPLOAD_QUOTA_BYTES / 1024 / 1024} MB/hour). Try again after ${new Date(entry.resetAt).toISOString()}.`
        });
    }
    entry.bytes += incomingBytes;
    next();
}

function isSuccessResponse(response) {
    if (!response) return false;
    if (response.success === true) return true;
    // Some device firmware returns status instead of success.
    if (response.status === 'ok' || response.status === 'success') return true;
    return false;
}

function normalizeStoragePath(pathValue = '') {
    return String(pathValue).replace(/\\/g, '/').replace(/^\/+/, '');
}

// Reject unsafe path segments to prevent traversal / absolute paths.
// Dashboard sends relative paths; we only allow `a/b/c` style without '..' segments.
function validateStoragePath(pathValue = '', label = 'path') {
    const raw = String(pathValue ?? '');
    if (raw.includes('\0')) return { ok: false, error: `${label} contains null byte` };

    const normalized = normalizeStoragePath(raw);
    // Disallow any hidden traversal attempts after normalization.
    const parts = normalized.split('/').filter(p => p);
    for (const part of parts) {
        if (part === '.' || part === '..') {
            return { ok: false, error: `${label} contains unsafe segment '${part}'` };
        }
        if (part.includes('..')) {
            return { ok: false, error: `${label} contains unsafe segment '${part}'` };
        }
        // Prevent attempts like `C:...` or `//server`.
        if (part.includes(':')) {
            return { ok: false, error: `${label} contains ':' which is not allowed` };
        }
    }

    return { ok: true, normalized };
}

function validateStorageName(nameValue = '', label = 'name') {
    const raw = String(nameValue ?? '');
    if (raw.includes('\0')) return { ok: false, error: `${label} contains null byte` };
    if (raw.includes('/') || raw.includes('\\')) return { ok: false, error: `${label} must not contain slashes` };
    if (raw === '.' || raw === '..' || raw.includes('..')) return { ok: false, error: `${label} is not a valid name` };
    if (raw.includes(':')) return { ok: false, error: `${label} contains ':' which is not allowed` };
    return { ok: true, value: raw };
}

function splitPathAndName(fullPath) {
    const normalized = normalizeStoragePath(fullPath);
    const parts = normalized.split('/').filter(Boolean);
    const filename = parts.pop() || '';
    const dirPath = parts.join('/');
    return { dirPath, filename };
}

function isCommandTimeout(error) {
    if (typeof error?.message !== 'string') return false;
    const normalized = error.message.toLowerCase();
    return normalized.includes('timeout') || normalized.includes('timed out');
}

function buildUnavailableStorageInfo(errorMessage) {
    return {
        success: true,
        data: {
            internal: {
                available: false,
                mounted: false,
                total: 0,
                used: 0,
                free: 0
            },
            sd: {
                available: false,
                cardDetected: false,
                mounted: false,
                total: 0,
                used: 0,
                free: 0,
                type: 'SSD',
                filesystem: null,
                cardType: null,
                bus: null,
                pins: null,
                error: errorMessage
            }
        }
    };
}

function wantsLiveRefresh(req) {
    const requested = String(req.query.refresh || req.query.live || req.query.force || '').trim().toLowerCase();
    return requested === '1' || requested === 'true' || requested === 'yes';
}

function buildStorageInfoFromCachedStatus(deviceId) {
    const status = global.modemService?.getDeviceStatus?.(deviceId);
    const storage = status?.storage || null;
    if (!storage) {
        return null;
    }

    const mounted = !!(storage.mounted || storage.mediaAvailable);
    const total = Number(storage.totalBytes || 0);
    const used = Number(storage.usedBytes || 0);
    const free = Number(storage.freeBytes || 0);

    return {
        success: true,
        data: {
            internal: {
                available: false,
                mounted: false,
                total: 0,
                used: 0,
                free: 0
            },
            sd: {
                available: mounted,
                cardDetected: mounted,
                mounted,
                total: mounted ? total : 0,
                used: mounted ? used : 0,
                free: mounted ? free : 0,
                type: storage.type || storage.label || 'SSD',
                filesystem: storage.filesystem || null,
                cardType: storage.type || storage.label || null,
                bus: storage.bus || null,
                pins: null,
                lastError: storage.lastError || null,
                error: mounted ? null : 'Using cached storage status'
            }
        }
    };
}

function waitForMqttEvent(eventName, deviceId, timeoutMs, predicate = null) {
    return new Promise((resolve, reject) => {
        const mqttService = global.mqttService;
        if (!mqttService || typeof mqttService.on !== 'function') {
            reject(new Error('MQTT service unavailable'));
            return;
        }

        const cleanup = () => {
            clearTimeout(timer);
            if (typeof mqttService.off === 'function') {
                mqttService.off(eventName, onEvent);
            }
        };

        const onEvent = (incomingDeviceId, data) => {
            if (incomingDeviceId !== deviceId) return;
            if (predicate && !predicate(data)) return;
            cleanup();
            resolve(data);
        };

        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for ${eventName}`));
        }, timeoutMs);

        mqttService.on(eventName, onEvent);
    });
}

function runQueuedDeviceOperation(deviceId, task) {
    if (global.mqttService && typeof global.mqttService.runDeviceOperation === 'function') {
        return global.mqttService.runDeviceOperation(deviceId, task);
    }
    return task();
}

function buildStorageCommandOptions(command, options = {}) {
    const normalized = String(command || '').trim().toLowerCase();
    const merged = {
        source: 'dashboard-storage',
        ...options
    };

    if (!merged.domain) {
        if (normalized === 'storage-info') {
            merged.domain = 'status';
        } else if (normalized.startsWith('storage-')) {
            merged.domain = 'storage';
        }
    }

    if (normalized === 'storage-info' && merged.bypassCompatibility == null) {
        merged.bypassCompatibility = true;
    }

    return merged;
}

async function publishAndWaitForMqttEvent(deviceId, eventName, command, payload = {}, timeoutMs = 10000, predicate = null, options = {}) {
    const eventPromise = waitForMqttEvent(eventName, deviceId, timeoutMs, predicate);
    try {
        await global.mqttService.publishCommand(
            deviceId,
            command,
            payload,
            false,
            timeoutMs,
            buildStorageCommandOptions(command, options)
        );
        return await eventPromise;
    } catch (error) {
        eventPromise.catch(() => {});
        throw error;
    }
}

function normalizeStorageEntries(entries = []) {
    return entries.map(entry => ({
        name: entry.name || '',
        path: normalizeStoragePath(entry.path || entry.name || ''),
        size: Number(entry.size || 0),
        isDirectory: Boolean(entry.dir || entry.isDirectory),
        type: entry.dir || entry.isDirectory ? 'directory' : 'file'
    }));
}

function normalizeStorageInfoResponse(response) {
    const total = Number(response?.total || response?.stats?.total || 0);
    const used = Number(response?.used || response?.stats?.used || 0);
    const free = Number(response?.free || response?.stats?.free || 0);
    return {
        mounted: response?.mounted === true || total > 0 || used > 0 || free > 0,
        cardDetected: response?.cardDetected === true || response?.mounted === true,
        total,
        used,
        free,
        type: response?.type || 'SSD',
        filesystem: response?.filesystem || 'FAT32',
        cardType: response?.cardType || null,
        bus: response?.bus || null,
        pins: response?.pins || null,
        lastError: response?.lastError || response?.error || null
    };
}

function joinStoragePath(dirPath = '', filename = '') {
    const safeDir = normalizeStoragePath(dirPath);
    const safeName = String(filename || '').replace(/^\/+/, '');
    return normalizeStoragePath([safeDir, safeName].filter(Boolean).join('/'));
}

function isLikelyTextBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return true;
    let suspicious = 0;
    for (const byte of buffer) {
        if (byte === 9 || byte === 10 || byte === 13) continue;
        if (byte === 0) return false;
        if (byte < 32 || byte === 127) suspicious++;
    }
    return (suspicious / buffer.length) < 0.1;
}

function normalizeStorageReadResponse(response) {
    if (!response || response.error) {
        return {
            success: false,
            message: response?.error || response?.message || 'Failed to read file'
        };
    }

    const hasPayload = typeof response.data === 'string' || typeof response.content === 'string';
    if (!hasPayload && !isSuccessResponse(response)) {
        return {
            success: false,
            message: response?.message || 'Failed to read file'
        };
    }

    const encoding = String(response.encoding || (typeof response.data === 'string' ? 'base64' : 'utf8')).toLowerCase();
    const rawPayload = typeof response.data === 'string' ? response.data : String(response.content || '');

    try {
        const buffer = encoding === 'base64'
            ? Buffer.from(rawPayload, 'base64')
            : Buffer.from(rawPayload, 'utf8');

        return {
            success: true,
            buffer,
            encoding,
            size: Number(response.size ?? buffer.length),
            bytes: Number(response.bytes ?? buffer.length),
            offset: Number(response.offset || 0),
            path: response.path || null
        };
    } catch (error) {
        return {
            success: false,
            message: 'Failed to decode storage payload'
        };
    }
}

async function readStorageFileChunks(deviceId, filePath, timeout = 30000) {
    const chunks = [];
    let offset = 0;
    let expectedSize = null;
    let attempts = 0;

    while (attempts < 256) {
        attempts++;
        const response = await global.mqttService.publishCommand(
            deviceId,
            'storage-read',
            { path: filePath, offset, maxBytes: 512 },
            true,
            timeout
        );

        const normalized = normalizeStorageReadResponse(response);
        if (!normalized.success) {
            return normalized;
        }

        if (expectedSize == null) {
            expectedSize = normalized.size;
        }

        chunks.push(normalized.buffer);
        offset += normalized.buffer.length;

        if (normalized.buffer.length === 0) break;
        if (expectedSize != null && offset >= expectedSize) break;
        if (normalized.bytes < 512) break;
    }

    const buffer = Buffer.concat(chunks);
    if (expectedSize != null && buffer.length < expectedSize) {
        return {
            success: false,
            message: 'Storage read returned incomplete file data'
        };
    }

    return {
        success: true,
        buffer,
        size: expectedSize ?? buffer.length
    };
}

// Get device storage info and directory listing
async function listStorageHandler(req, res) {
    try {
        const dirPathInput = req.query.path || '';
        const dirPathValidation = validateStoragePath(dirPathInput, 'path');
        if (!dirPathValidation.ok) {
            return res.status(400).json({
                success: false,
                message: dirPathValidation.error
            });
        }
        const dirPath = dirPathValidation.normalized;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        
        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected',
                online: false
            });
        }

        const { infoResponse, storageInfo, response } = await runQueuedDeviceOperation(deviceId, async () => {
            const infoResponse = await publishAndWaitForMqttEvent(
                deviceId,
                'storage:info',
                'storage-info',
                {},
                10000,
                null,
                { skipQueue: true }
            ).catch(() => null);
            const storageInfo = infoResponse ? normalizeStorageInfoResponse(infoResponse) : null;

            if (!infoResponse || (storageInfo && !storageInfo.mounted)) {
                return { infoResponse, storageInfo, response: null };
            }

            const response = await publishAndWaitForMqttEvent(
                deviceId,
                'storage:list',
                'storage-list',
                { path: dirPath },
                15000,
                data => Array.isArray(data?.entries) || typeof data?.error === 'string',
                { skipQueue: true }
            );
            return { infoResponse, storageInfo, response };
        });

        if (!infoResponse) {
            return res.json({
                success: true,
                data: {
                    path: dirPath,
                    items: [],
                    stats: {
                        total: 0,
                        used: 0,
                        free: 0,
                        usagePercent: 0
                    },
                    breadcrumbs: getBreadcrumbs(dirPath),
                    online: false,
                    error: 'Device storage not responding'
                }
            });
        }

        if (storageInfo && !storageInfo.mounted) {
            return res.json({
                success: true,
                data: {
                    path: dirPath,
                    items: [],
                    stats: {
                        total: storageInfo.total,
                        used: storageInfo.used,
                        free: storageInfo.free,
                        usagePercent: 0
                    },
                    breadcrumbs: getBreadcrumbs(dirPath),
                    online: true,
                    error: infoResponse?.error || 'Device storage not available'
                }
            });
        }

        if (Array.isArray(response?.entries)) {
            const total = Number(storageInfo?.total || 0);
            const used = Number(storageInfo?.used || 0);
            const free = Number(storageInfo?.free || 0);
            const usagePercent = total > 0 ? Math.round((used / total) * 100) : 0;
            res.json({
                success: true,
                data: {
                    path: dirPath,
                    items: normalizeStorageEntries(response.entries),
                    stats: {
                        total,
                        used,
                        free,
                        usagePercent
                    },
                    breadcrumbs: getBreadcrumbs(dirPath)
                }
            });
        } else if (response?.error) {
            res.json({
                success: true,
                data: {
                    path: dirPath,
                    items: [],
                    stats: {
                        total: 0,
                        used: 0,
                        free: 0,
                        usagePercent: 0
                    },
                    breadcrumbs: getBreadcrumbs(dirPath),
                    online: true,
                    error: response.error
                }
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to get storage info'
            });
        }
    } catch (error) {
        if (!isCommandTimeout(error)) {
            logger.error('Storage API error:', error);
        }

        res.json({
            success: true,
            data: {
                path: req.query.path || '',
                items: [],
                stats: {
                    total: 0,
                    used: 0,
                    free: 0,
                    usagePercent: 0
                },
                breadcrumbs: getBreadcrumbs(req.query.path || ''),
                online: false,
                error: isCommandTimeout(error) ? 'Storage not responding' : 'Storage unavailable'
            }
        });
    }
}

// Compatibility endpoint used by frontend file manager
router.get('/list', listStorageHandler);

// Main storage listing endpoint
router.get('/', listStorageHandler);

// Get device storage info via MQTT
router.get('/info', async (req, res) => {
    try {
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);

        if (!wantsLiveRefresh(req)) {
            const cached = buildStorageInfoFromCachedStatus(deviceId);
            if (cached) {
                return res.json(cached);
            }
            return res.json(buildUnavailableStorageInfo('Using cached storage status'));
        }
        
        if (!global.mqttService || !global.mqttService.connected) {
            return res.json(buildUnavailableStorageInfo('MQTT not connected'));
        }

        const response = await runQueuedDeviceOperation(deviceId, () =>
            publishAndWaitForMqttEvent(
                deviceId,
                'storage:info',
                'storage-info',
                {},
                10000,
                null,
                { skipQueue: true }
            )
        );
        const info = normalizeStorageInfoResponse(response);

        if (info.mounted) {
            res.json({
                success: true,
                data: {
                    internal: {
                        available: false,
                        mounted: false,
                        total: 0,
                        used: 0,
                        free: 0
                    },
                    sd: {
                        available: true,
                        cardDetected: info.cardDetected,
                        mounted: info.mounted,
                        total: info.total,
                        used: info.used,
                        free: info.free,
                        type: info.type,
                        filesystem: info.filesystem,
                        cardType: info.cardType,
                        bus: info.bus,
                        pins: info.pins,
                        lastError: info.lastError
                    }
                }
            });
        } else {
            res.json({
                success: true,
                data: {
                    internal: {
                        available: false,
                        mounted: false,
                        total: 0,
                        used: 0,
                        free: 0
                    },
                    sd: {
                        available: false,
                        cardDetected: info.cardDetected,
                        mounted: false,
                        total: 0,
                        used: 0,
                        free: 0,
                        filesystem: info.filesystem,
                        cardType: info.cardType,
                        bus: info.bus,
                        pins: info.pins,
                        lastError: info.lastError,
                        error: response?.message || 'Device storage not available'
                    }
                }
            });
        }
    } catch (error) {
        if (isCommandTimeout(error)) {
            logger.debug(`Storage info timed out for device ${resolveDeviceId(req, DEFAULT_DEVICE_ID)}`);
            return res.json(buildUnavailableStorageInfo('No device storage detected or firmware lacks storage-info support'));
        }
        logger.warn(`Storage info error: ${error.message}`);
        res.json(buildUnavailableStorageInfo('Device storage info unavailable'));
    }
});

// Read file content
router.get('/read', async (req, res) => {
    try {
        const filePathInput = req.query.path || '';
        const filePathValidation = validateStoragePath(filePathInput, 'path');
        if (!filePathValidation.ok) {
            return res.status(400).json({
                success: false,
                message: filePathValidation.error
            });
        }
        const filePath = filePathValidation.normalized;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        
        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const result = await readStorageFileChunks(deviceId, filePath, 30000);
        if (!result.success) {
            return res.status(500).json({
                success: false,
                message: result.message || 'Failed to read file'
            });
        }

        const isText = isLikelyTextBuffer(result.buffer);
        res.json({
            success: true,
            data: {
                type: isText ? 'text' : 'binary',
                content: isText ? result.buffer.toString('utf8') : result.buffer.toString('base64'),
                size: result.size,
                mime: isText ? 'text/plain; charset=utf-8' : 'application/octet-stream'
            }
        });
    } catch (error) {
        logger.error('Storage read error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to read file'
        });
    }
});

// Download file
router.get('/download', async (req, res) => {
    try {
        const filePathInput = req.query.path || '';
        const filePathValidation = validateStoragePath(filePathInput, 'path');
        if (!filePathValidation.ok) {
            return res.status(400).json({
                success: false,
                message: filePathValidation.error
            });
        }
        const filePath = filePathValidation.normalized;
        const fileNameInput = req.query.filename || filePath.split('/').pop();
        const fileNameValidation = validateStorageName(fileNameInput, 'filename');
        if (!fileNameValidation.ok) {
            return res.status(400).json({
                success: false,
                message: fileNameValidation.error
            });
        }
        const fileName = fileNameValidation.value;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        
        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const result = await readStorageFileChunks(deviceId, filePath, 60000);
        if (!result.success) {
            return res.status(500).json({
                success: false,
                message: result.message || 'Failed to download file'
            });
        }

        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', isLikelyTextBuffer(result.buffer) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
        res.setHeader('Content-Length', result.buffer.length);
        res.send(result.buffer);
    } catch (error) {
        logger.error('Storage download error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to download file'
        });
    }
});

// Upload file
router.post('/upload', upload.array('files'), checkUploadQuota, async (req, res) => {
    try {
        const { path: destPath = '' } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const destPathValidation = validateStoragePath(destPath, 'path');
        if (!destPathValidation.ok) {
            return res.status(400).json({
                success: false,
                message: destPathValidation.error
            });
        }

        const user = req.user || req.session?.user;
        const fileSize = req.file?.size || parseInt(req.headers['content-length']) || 0;
        if (!checkUploadRateLimit(user?.id || req.ip, parseInt(fileSize))) {
            return res.status(429).json({ success: false, error: 'Upload rate limit exceeded (50 MB/hour)' });
        }

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }


        const multipartFiles = Array.isArray(req.files) ? req.files : [];

        // multipart/form-data mode (frontend upload modal)
        if (multipartFiles.length > 0) {
            const results = [];

            for (const file of multipartFiles) {
                let content = null;
                try {
                    const buf = await fs.promises.readFile(file.path);
                    if (!isLikelyTextBuffer(buf)) {
                        results.push({
                            filename: file.originalname,
                            success: false,
                            message: 'Binary uploads are not supported by current device firmware'
                        });
                        continue;
                    }
                    content = buf.toString('utf8');
                } finally {
                    fs.promises.unlink(file.path).catch(() => {});
                }

                const targetPath = joinStoragePath(destPathValidation.normalized, file.originalname);
                const response = await global.mqttService.publishCommand(
                    deviceId,
                    'storage-write',
                    {
                        path: targetPath,
                        data: content,
                        append: false
                    },
                    true,
                    60000
                );

                results.push({
                    filename: file.originalname,
                    success: isSuccessResponse(response),
                    message: response?.message || null
                });
            }

            const successCount = results.filter(r => r.success).length;
            return res.json({
                success: successCount > 0,
                message: `Uploaded ${successCount}/${results.length} file(s)`,
                data: results
            });
        }

        // JSON mode (single file upload)
        const { filename, content } = req.body;
        if (!filename || content == null) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        const filenameValidation = validateStorageName(filename, 'filename');
        if (!filenameValidation.ok) {
            return res.status(400).json({
                success: false,
                message: filenameValidation.error
            });
        }

        const targetPath = joinStoragePath(destPathValidation.normalized, filenameValidation.value);

        const response = await global.mqttService.publishCommand(
            deviceId,
            'storage-write',
            {
                path: targetPath,
                data: String(content),
                append: false
            },
            true,
            60000
        );

        if (!isSuccessResponse(response)) {
            return res.status(500).json({
                success: false,
                message: response?.message || 'Failed to upload file'
            });
        }

        res.json({
            success: true,
            message: 'File uploaded successfully',
            path: response.path
        });
    } catch (error) {
        logger.error('Storage upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to upload file'
        });
    }
});

// Save/update text file
router.post('/save', async (req, res) => {
    try {
        const { path: filePath, content = '' } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        if (!filePath) {
            return res.status(400).json({
                success: false,
                message: 'File path is required'
            });
        }

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const filePathValidation = validateStoragePath(filePath, 'path');
        if (!filePathValidation.ok) {
            return res.status(400).json({
                success: false,
                message: filePathValidation.error
            });
        }
        const safeFilePath = filePathValidation.normalized;
        const response = await global.mqttService.publishCommand(
            deviceId,
            'storage-write',
            {
                path: safeFilePath,
                data: String(content),
                append: false
            },
            true,
            30000
        );

        if (!isSuccessResponse(response)) {
            return res.status(500).json({
                success: false,
                message: response?.message || 'Failed to save file'
            });
        }

        res.json({
            success: true,
            message: 'File saved successfully'
        });
    } catch (error) {
        logger.error('Storage save error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save file'
        });
    }
});

// Create new file with optional initial content
router.post('/touch', async (req, res) => {
    try {
        const { path: dirPath = '', name, content = '' } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'File name is required'
            });
        }

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const dirPathValidation = validateStoragePath(dirPath, 'path');
        if (!dirPathValidation.ok) {
            return res.status(400).json({
                success: false,
                message: dirPathValidation.error
            });
        }
        const nameValidation = validateStorageName(name, 'name');
        if (!nameValidation.ok) {
            return res.status(400).json({
                success: false,
                message: nameValidation.error
            });
        }

        const response = await global.mqttService.publishCommand(
            deviceId,
            'storage-write',
            {
                path: joinStoragePath(dirPathValidation.normalized, nameValidation.value),
                data: String(content),
                append: false
            },
            true,
            30000
        );

        if (!isSuccessResponse(response)) {
            return res.status(500).json({
                success: false,
                message: response?.message || 'Failed to create file'
            });
        }

        res.json({
            success: true,
            message: 'File created successfully'
        });
    } catch (error) {
        logger.error('Storage touch error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create file'
        });
    }
});

// Download multiple files as zip is not available unless firmware supports it.
router.post('/download-multiple', async (req, res) => {
    res.status(501).json({
        success: false,
        message: 'Multi-file download is not supported by current device firmware yet'
    });
});

// Compression requires dedicated device-side command support.
router.post('/compress', async (req, res) => {
    try {
        return res.status(501).json({
            success: false,
            message: 'Compression is not supported by current device firmware'
        });
        const { items, archiveName, destination = '' } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        if (!Array.isArray(items) || items.length === 0 || !archiveName) {
            return res.status(400).json({
                success: false,
                message: 'Items and archive name are required'
            });
        }

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const archiveNameValidation = validateStorageName(archiveName, 'archiveName');
        if (!archiveNameValidation.ok) {
            return res.status(400).json({
                success: false,
                message: archiveNameValidation.error
            });
        }
        const destinationValidation = destination
            ? validateStoragePath(destination, 'destination')
            : { ok: true, normalized: '' };
        if (!destinationValidation.ok) {
            return res.status(400).json({
                success: false,
                message: destinationValidation.error
            });
        }
        const safeItems = [];
        for (const item of items) {
            const v = validateStoragePath(item, 'items');
            if (!v.ok) {
                return res.status(400).json({
                    success: false,
                    message: v.error
                });
            }
            safeItems.push(v.normalized);
        }

        const response = await global.mqttService.publishCommand(
            deviceId,
            'storage-compress',
            {
                items: safeItems,
                archiveName: archiveNameValidation.value,
                destination: destinationValidation.normalized
            },
            true,
            60000
        );

        if (!isSuccessResponse(response)) {
            return res.status(501).json({
                success: false,
                message: response?.message || 'Compression is not supported by current firmware'
            });
        }

        res.json({
            success: true,
            message: response?.message || 'Archive created successfully',
            data: response
        });
    } catch (error) {
        logger.error('Storage compress error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to compress items'
        });
    }
});

// Create directory
router.post('/mkdir', async (req, res) => {
    try {
        const { path: dirPath, name } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        
        if (!dirPath || !name) {
            return res.status(400).json({
                success: false,
                message: 'Path and name are required'
            });
        }

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const dirPathValidation = validateStoragePath(dirPath, 'path');
        if (!dirPathValidation.ok) {
            return res.status(400).json({
                success: false,
                message: dirPathValidation.error
            });
        }
        const nameValidation = validateStorageName(name, 'name');
        if (!nameValidation.ok) {
            return res.status(400).json({
                success: false,
                message: nameValidation.error
            });
        }

        const response = await global.mqttService.publishCommand(
            deviceId, 
            'storage-mkdir', 
            { path: dirPathValidation.normalized, name: nameValidation.value },
            true,
            15000
        );

        if (isSuccessResponse(response)) {
            res.json({
                success: true,
                message: 'Directory created successfully'
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to create directory'
            });
        }
    } catch (error) {
        logger.error('Storage mkdir error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create directory'
        });
    }
});

// Delete file/directory
router.post('/delete', async (req, res) => {
    try {
        const { items } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        
        if (!items || !items.length) {
            return res.status(400).json({
                success: false,
                message: 'No items selected'
            });
        }

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const safeItems = [];
        for (const item of items) {
            const v = validateStoragePath(item, 'items');
            if (!v.ok) {
                return res.status(400).json({
                    success: false,
                    message: v.error
                });
            }
            safeItems.push(v.normalized);
        }

        const results = [];
        for (const item of safeItems) {
            const response = await global.mqttService.publishCommand(
                deviceId,
                'storage-delete',
                { path: item },
                true,
                30000
            );

            results.push({
                path: item,
                success: isSuccessResponse(response) || response?.success === true,
                message: response?.error || response?.message || null
            });
        }

        const successCount = results.filter(result => result.success).length;
        if (successCount === 0) {
            return res.status(500).json({
                success: false,
                message: 'Failed to delete items',
                data: results
            });
        }

        res.json({
            success: true,
            message: `Deleted ${successCount}/${results.length} item(s)`,
            data: results
        });
    } catch (error) {
        logger.error('Storage delete error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete items'
        });
    }
});

router.post('/format', async (req, res) => {
    try {
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const storageType = String(req.body?.storageType || 'sd').toLowerCase();

        if (storageType !== 'sd') {
            return res.status(400).json({
                success: false,
                message: 'Only device storage formatting is supported'
            });
        }

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const response = await global.mqttService.publishCommand(
            deviceId,
            'storage-format',
            {},
            true,
            120000
        );

        if (response && response.success) {
            return res.json({
                success: true,
                message: response.message || 'Device storage formatted successfully'
            });
        }

        res.status(500).json({
            success: false,
            message: response?.message || 'Failed to format device storage'
        });
    } catch (error) {
        if (!isCommandTimeout(error)) {
            logger.error('Storage format error:', error);
        }
        res.status(500).json({
            success: false,
            message: isCommandTimeout(error) ? 'Device storage format timed out' : 'Failed to format device storage'
        });
    }
});

// Rename file/directory
router.post('/rename', async (req, res) => {
    try {
        const { path: oldPath, newName } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        
        if (!oldPath || !newName) {
            return res.status(400).json({
                success: false,
                message: 'Path and new name are required'
            });
        }

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const oldPathValidation = validateStoragePath(oldPath, 'oldPath');
        if (!oldPathValidation.ok) {
            return res.status(400).json({
                success: false,
                message: oldPathValidation.error
            });
        }
        const newNameValidation = validateStorageName(newName, 'newName');
        if (!newNameValidation.ok) {
            return res.status(400).json({
                success: false,
                message: newNameValidation.error
            });
        }

        const response = await global.mqttService.publishCommand(
            deviceId, 
            'storage-rename', 
            { oldPath: oldPathValidation.normalized, newName: newNameValidation.value },
            true,
            20000
        );

        if (isSuccessResponse(response)) {
            res.json({
                success: true,
                message: 'Renamed successfully'
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to rename'
            });
        }
    } catch (error) {
        logger.error('Storage rename error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to rename item'
        });
    }
});

// Move files
router.post('/move', async (req, res) => {
    try {
        const { items, destination } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        
        if (!items || !items.length || !destination) {
            return res.status(400).json({
                success: false,
                message: 'Items and destination required'
            });
        }

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const destinationValidation = validateStoragePath(destination, 'destination');
        if (!destinationValidation.ok) {
            return res.status(400).json({
                success: false,
                message: destinationValidation.error
            });
        }
        const safeItems = [];
        for (const item of items) {
            const v = validateStoragePath(item, 'items');
            if (!v.ok) {
                return res.status(400).json({
                    success: false,
                    message: v.error
                });
            }
            safeItems.push(v.normalized);
        }

        const response = await global.mqttService.publishCommand(
            deviceId, 
            'storage-move', 
            { items: safeItems, destination: destinationValidation.normalized },
            true,
            60000
        );

        if (isSuccessResponse(response)) {
            res.json({
                success: true,
                message: response.message || 'Items moved successfully',
                data: { items: safeItems, destination: destinationValidation.normalized }
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to move items'
            });
        }
    } catch (error) {
        logger.error('Storage move error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to move items'
        });
    }
});

// Copy files
router.post('/copy', async (req, res) => {
    try {
        const { items, destination } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        
        if (!items || !items.length || !destination) {
            return res.status(400).json({
                success: false,
                message: 'Items and destination required'
            });
        }

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const destinationValidation = validateStoragePath(destination, 'destination');
        if (!destinationValidation.ok) {
            return res.status(400).json({
                success: false,
                message: destinationValidation.error
            });
        }
        const safeItems = [];
        for (const item of items) {
            const v = validateStoragePath(item, 'items');
            if (!v.ok) {
                return res.status(400).json({
                    success: false,
                    message: v.error
                });
            }
            safeItems.push(v.normalized);
        }

        const response = await global.mqttService.publishCommand(
            deviceId, 
            'storage-copy', 
            { items: safeItems, destination: destinationValidation.normalized },
            true,
            90000
        );

        if (isSuccessResponse(response)) {
            res.json({
                success: true,
                message: response.message || 'Items copied successfully',
                data: { items: safeItems, destination: destinationValidation.normalized }
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to copy items'
            });
        }
    } catch (error) {
        logger.error('Storage copy error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to copy items'
        });
    }
});

// Get device storage status (for dashboard)
router.get('/status', async (req, res) => {
    try {
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        
        if (!global.mqttService || !global.mqttService.connected) {
            return res.json({
                success: true,
                data: {
                    mounted: false,
                    total: 0,
                    used: 0,
                    free: 0,
                    usagePercent: 0,
                    online: false
                }
            });
        }

        try {
            const response = await runQueuedDeviceOperation(deviceId, () =>
                publishAndWaitForMqttEvent(
                    deviceId,
                    'storage:info',
                    'storage-info',
                    {},
                    10000,
                    data => data && (typeof data.mounted === 'boolean' || typeof data.cardDetected === 'boolean' || typeof data.success === 'boolean'),
                    { skipQueue: true }
                )
            );

            const info = normalizeStorageInfoResponse(response);
            if (info.mounted) {
                const usagePercent = info.total > 0 ? 
                    Math.round((info.used / info.total) * 100) : 0;
                
                res.json({
                    success: true,
                    data: {
                        mounted: true,
                        total: info.total,
                        used: info.used,
                        free: info.free,
                        usagePercent: usagePercent,
                        online: true
                    }
                });
            } else {
                res.json({
                    success: true,
                    data: {
                        mounted: false,
                        total: 0,
                        used: 0,
                        free: 0,
                        usagePercent: 0,
                        online: true,
                        error: info.lastError || 'Device storage not available'
                    }
                });
            }
        } catch (error) {
            if (!isCommandTimeout(error)) {
                logger.warn('Storage status request failed:', error.message);
            }
            res.json({
                success: true,
                data: {
                    mounted: false,
                    total: 0,
                    used: 0,
                    free: 0,
                    usagePercent: 0,
                    online: false,
                    error: 'Device not responding'
                }
            });
        }
    } catch (error) {
        logger.error('Storage status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get storage status'
        });
    }
});

// Helper function for breadcrumbs
function getBreadcrumbs(path) {
    if (!path) return [];
    const parts = path.split('/').filter(p => p);
    const breadcrumbs = [];
    let currentPath = '';

    for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        breadcrumbs.push({
            name: part,
            path: currentPath
        });
    }

    return breadcrumbs;
}

module.exports = router;
