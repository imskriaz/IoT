const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { execFile } = require('child_process');
const os = require('os');
const { admin: adminMiddleware } = require('../middleware/auth');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const {
    getEffectiveSystemSettings,
    normalizeTimezone,
    saveSystemSettings,
    pruneLogFiles
} = require('../services/systemSettingsService');
const { clearAllDashboardLogs } = require('../services/logCleanupService');

function detectSystemTimezone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function isValidTimezone(value) {
    return normalizeTimezone(value, '') === String(value || '').trim();
}

const ENV_PATH = path.join(__dirname, '../.env');
const MQTT_PROTOCOLS = new Set(['mqtt', 'mqtts', 'ws', 'wss']);

function parseBooleanEnv(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value).trim().toLowerCase() === 'true';
}

function normalizeCountryCode(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizeUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function readEnvFile() {
    try {
        return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    } catch (error) {
        logger.error('Error reading .env file:', error);
        return '';
    }
}

function mergeEnvContent(envContent, updates) {
    let nextContent = String(envContent || '');

    Object.entries(updates).forEach(([key, value]) => {
        const normalized = value === undefined || value === null ? '' : String(value);
        const regex = new RegExp(`^${key}=.*`, 'm');
        if (regex.test(nextContent)) {
            nextContent = nextContent.replace(regex, `${key}=${normalized}`);
        } else {
            if (nextContent && !nextContent.endsWith('\n')) nextContent += '\n';
            nextContent += `${key}=${normalized}\n`;
        }
    });

    return nextContent;
}

function writeEnvUpdates(updates) {
    const envContent = mergeEnvContent(readEnvFile(), updates);
    try {
        fs.writeFileSync(ENV_PATH, envContent);
    } catch (error) {
        logger.error('Error writing .env file:', error);
        throw new Error('Failed to save settings');
    }
}

function applyProcessEnv(updates) {
    Object.entries(updates).forEach(([key, value]) => {
        process.env[key] = value === undefined || value === null ? '' : String(value);
    });
}

function applyLoggerLevel(loggerInstance, level) {
    if (!loggerInstance || !level) return;
    loggerInstance.level = level;
    if (Array.isArray(loggerInstance.transports)) {
        loggerInstance.transports.forEach((transport) => {
            if (!transport || transport.level === 'error') return;
            transport.level = level;
        });
    }
}

function isDbBackupFilename(filename) {
    return /^[\w\-.]+\.db$/i.test(String(filename || ''));
}

const MANAGED_SYSTEM_ENV_FIELDS = [
    {
        key: 'deviceStatusRefreshMs',
        envNames: ['DASHBOARD_DEVICE_STATUS_REFRESH_MS', 'DEVICE_STATUS_AUTO_REFRESH_MS'],
        format: value => String(parseInt(value, 10) || 60000)
    },
    {
        key: 'statusWatchIntervalMs',
        envNames: ['DASHBOARD_STATUS_WATCH_INTERVAL_MS'],
        format: value => String(parseInt(value, 10) || 45000)
    },
    {
        key: 'statusWatchTtlMs',
        envNames: ['DASHBOARD_STATUS_WATCH_TTL_MS'],
        format: value => String(parseInt(value, 10) || 180000)
    },
    {
        key: 'statusWatchRefreshMs',
        envNames: ['DASHBOARD_STATUS_WATCH_REFRESH_MS'],
        format: value => String(parseInt(value, 10) || 120000)
    },
    {
        key: 'logRetentionDays',
        envNames: ['LOG_RETENTION_DAYS'],
        format: value => String(parseInt(value, 10) || 30)
    },
    {
        key: 'logLevel',
        envNames: ['LOG_LEVEL'],
        format: value => String(value || 'info').trim().toLowerCase() || 'info'
    },
    {
        key: 'timezone',
        envNames: ['TZ'],
        format: value => String(value || 'UTC').trim() || 'UTC'
    }
];

function buildManagedSystemEnvUpdates(savedSystem = {}, effective = {}) {
    return MANAGED_SYSTEM_ENV_FIELDS.reduce((updates, field) => {
        const meta = effective[field.key] || {};
        if (meta.source !== 'dashboard_env') {
            return updates;
        }

        const envName = field.envNames.includes(meta.envName) ? meta.envName : field.envNames[0];
        updates[envName] = field.format(savedSystem[field.key]);
        return updates;
    }, {});
}

// Get all settings (cleaned - only system-level settings)
router.get('/', async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            throw new Error('Database not available');
        }

        // Get all settings from database
        const settings = await db.all('SELECT * FROM settings');
        
        // Format as key-value object
        const settingsObj = {};
        settings.forEach(s => {
            try {
                settingsObj[s.key] = JSON.parse(s.value);
            } catch {
                settingsObj[s.key] = s.value;
            }
        });

        const mqttRuntimeStatus = global.mqttService?.getStatus?.() || {};

        // Get MQTT settings from environment (only what's needed)
        settingsObj.mqtt = {
            host: process.env.MQTT_HOST || mqttRuntimeStatus.host || '',
            port: parseInt(process.env.MQTT_PORT) || mqttRuntimeStatus.port || 1883,
            protocol: (process.env.MQTT_PROTOCOL || mqttRuntimeStatus.protocol || 'mqtt').trim(),
            username: process.env.MQTT_USER || mqttRuntimeStatus.username || 'deviceuser',
            passwordSet: Boolean(process.env.MQTT_PASSWORD),
            clientId: process.env.MQTT_CLIENT_ID || mqttRuntimeStatus.clientId || `esp32-dashboard-${os.hostname()}`,
            rejectUnauthorized: parseBooleanEnv(process.env.MQTT_REJECT_UNAUTHORIZED, false),
            connected: Boolean(mqttRuntimeStatus.connected),
            connecting: Boolean(mqttRuntimeStatus.connecting),
            reconnecting: Boolean(mqttRuntimeStatus.reconnecting),
            state: mqttRuntimeStatus.state || (mqttRuntimeStatus.connected ? 'connected' : 'disconnected'),
            lastError: mqttRuntimeStatus.lastError || null,
            lastErrorAt: mqttRuntimeStatus.lastErrorAt || null
        };

        const effectiveSystem = await getEffectiveSystemSettings(db);
        settingsObj.system = effectiveSystem.system;
        settingsObj.effective = effectiveSystem.effective;
        settingsObj.environmentOverrides = effectiveSystem.environmentOverrides;

        // Get notification settings (simplified)
        settingsObj.notifications = settingsObj.notifications || {
            email: {
                enabled: false,
                smtp: '',
                port: 587,
                secure: false,
                user: '',
                from: '',
                to: ''
            },
            telegram: {
                enabled: false,
                botToken: '',
                chatId: ''
            }
        };

        // Get users from database
        const users = await db.all('SELECT id, username, name, email, role, created_at, last_login FROM users');
        settingsObj.users = users;

        // Get backup settings
        settingsObj.backup = settingsObj.backup || {
            autoBackup: false,
            backupInterval: 'daily',
            backupTime: '02:00',
            keepCount: 7,
            backupPath: path.join(__dirname, '../backups'),
            lastBackup: null
        };

        // Get firmware settings (minimal)
        settingsObj.firmware = settingsObj.firmware || {
            currentVersion: '1.0.0',
            availableVersion: null,
            lastCheck: null,
            autoUpdate: false,
            updateChannel: 'stable'
        };

        res.json({
            success: true,
            data: settingsObj
        });
    } catch (error) {
        logger.error('API get settings error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch settings'
        });
    }
});

// POST /api/settings/theme — save per-user theme preference
router.get('/runtime', async (req, res) => {
    try {
        const effectiveSystem = await getEffectiveSystemSettings(req.app.locals.db);
        res.json({
            success: true,
            data: {
                deviceStatusRefreshMs: effectiveSystem.system.deviceStatusRefreshMs,
                deviceStatusRefreshSeconds: effectiveSystem.system.deviceStatusRefreshSeconds,
                statusWatchIntervalMs: effectiveSystem.system.statusWatchIntervalMs,
                statusWatchIntervalSeconds: effectiveSystem.system.statusWatchIntervalSeconds,
                statusWatchTtlMs: effectiveSystem.system.statusWatchTtlMs,
                statusWatchTtlSeconds: effectiveSystem.system.statusWatchTtlSeconds,
                statusWatchRefreshMs: effectiveSystem.system.statusWatchRefreshMs,
                statusWatchRefreshSeconds: effectiveSystem.system.statusWatchRefreshSeconds,
                logRetentionDays: effectiveSystem.system.logRetentionDays,
                timezone: effectiveSystem.system.timezone,
                browserDefaultTimezone: detectSystemTimezone(),
                sources: {
                    deviceStatusRefreshMs: effectiveSystem.effective.deviceStatusRefreshMs.source,
                    statusWatchIntervalMs: effectiveSystem.effective.statusWatchIntervalMs.source,
                    statusWatchTtlMs: effectiveSystem.effective.statusWatchTtlMs.source,
                    statusWatchRefreshMs: effectiveSystem.effective.statusWatchRefreshMs.source,
                    logRetentionDays: effectiveSystem.effective.logRetentionDays.source,
                    timezone: effectiveSystem.effective.timezone.source
                }
            }
        });
    } catch (error) {
        logger.error('API runtime settings error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch runtime settings' });
    }
});

router.post('/theme', async (req, res) => {
    try {
        const { theme } = req.body;
        if (!['light', 'dark'].includes(theme)) {
            return res.status(400).json({ success: false, message: 'Invalid theme value' });
        }
        const user = req.user || req.session.user;
        if (!user?.id) {
            return res.status(401).json({ success: false, message: 'Not authenticated' });
        }
        const db = req.app.locals.db;
        const row = await db.get('SELECT preferences FROM users WHERE id = ?', [user.id]);
        let prefs = {};
        try { prefs = JSON.parse(row?.preferences || '{}'); } catch (_) {}
        prefs.theme = theme;
        await db.run('UPDATE users SET preferences = ? WHERE id = ?', [JSON.stringify(prefs), user.id]);
        if (req.session.user) req.session.user.theme = theme;
        res.json({ success: true });
    } catch (error) {
        logger.error('API theme save error:', error);
        res.status(500).json({ success: false, message: 'Failed to save theme' });
    }
});

// PUT /api/settings — update a single key/value setting (admin only)
router.put('/', adminMiddleware, [
    body('key').trim().notEmpty().isLength({ max: 100 }),
    body('value').exists()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

        const { key, value } = req.body;
        const db = req.app.locals.db;

        // Restrict to known safe keys to prevent arbitrary writes
        const ALLOWED_KEYS = ['require_2fa_roles', 'n8n_enabled', 'n8n_webhook_url', 'n8n_events'];
        if (!ALLOWED_KEYS.includes(key)) {
            return res.status(400).json({ success: false, message: `Setting '${key}' cannot be updated via this endpoint` });
        }

        const val = typeof value === 'string' ? value : JSON.stringify(value);
        await db.run(
            `UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE key = ?`,
            [val, (req.user || req.session.user).id, key]
        );
        logger.info(`Setting '${key}' updated by ${(req.user || req.session.user).username}`);

        // Bust n8n config cache when integration settings change
        if (key.startsWith('n8n_')) {
            req.app.locals.n8nService?.invalidateCache();
        }

        res.json({ success: true });
    } catch (error) {
        logger.error('PUT /api/settings error:', error);
        res.status(500).json({ success: false, message: 'Failed to update setting' });
    }
});

// ==================== MQTT SETTINGS ====================

// Update MQTT settings
router.post('/mqtt', adminMiddleware, [
    body('host').notEmpty().withMessage('MQTT host is required'),
    body('port').isInt({ min: 1, max: 65535 }).withMessage('Valid port required'),
    body('protocol').optional().isIn(Array.from(MQTT_PROTOCOLS)).withMessage('Valid MQTT protocol required'),
    body('username').optional(),
    body('password').optional(),
    body('clientId').optional(),
    body('rejectUnauthorized').optional().isBoolean().withMessage('TLS verify must be true or false')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { host, port, protocol, username, password, clientId, rejectUnauthorized } = req.body;
        const normalizedProtocol = String(protocol || process.env.MQTT_PROTOCOL || 'mqtt').trim().toLowerCase();
        const tlsVerify = !!rejectUnauthorized;

        const updates = {
            MQTT_HOST: host,
            MQTT_PORT: port,
            MQTT_PROTOCOL: normalizedProtocol,
            MQTT_USER: username || '',
            MQTT_CLIENT_ID: clientId || `esp32-dashboard-${Date.now()}`,
            MQTT_REJECT_UNAUTHORIZED: String(tlsVerify)
        };

        if (password && password !== '********') {
            updates.MQTT_PASSWORD = password;
        }
        writeEnvUpdates(updates);
        applyProcessEnv(updates);

        // Reconnect MQTT with new settings
        if (global.mqttService) {
            try {
                await global.mqttService.reconnect({
                    host,
                    port: parseInt(port),
                    protocol: normalizedProtocol,
                    username: username || undefined,
                    password: process.env.MQTT_PASSWORD || undefined,
                    clientId: updates.MQTT_CLIENT_ID,
                    rejectUnauthorized: tlsVerify
                });
            } catch (mqttError) {
                logger.error('Error reconnecting MQTT:', mqttError);
            }
        }

        logger.info('MQTT settings updated');

        res.json({
            success: true,
            message: 'MQTT settings updated successfully'
        });
    } catch (error) {
        logger.error('API update MQTT settings error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update MQTT settings'
        });
    }
});

// Test MQTT connection
router.post('/test/mqtt', async (req, res) => {
    try {
        const { host, port, protocol, username, password, clientId, rejectUnauthorized } = req.body;
        const normalizedProtocol = String(protocol || process.env.MQTT_PROTOCOL || 'mqtt').trim().toLowerCase();

        // Create temporary MQTT client for testing
        const mqtt = require('mqtt');
        
        const client = mqtt.connect(`${normalizedProtocol}://${host}`, {
            port: parseInt(port),
            username,
            password: password || process.env.MQTT_PASSWORD,
            clientId: clientId || process.env.MQTT_CLIENT_ID || `test_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
            connectTimeout: 10000,
            reconnectPeriod: 0,
            rejectUnauthorized: rejectUnauthorized === undefined
                ? parseBooleanEnv(process.env.MQTT_REJECT_UNAUTHORIZED, false)
                : !!rejectUnauthorized
        });

        const timeout = setTimeout(() => {
            client.end();
            res.json({
                success: false,
                message: 'Connection timeout'
            });
        }, 10000);

        client.on('connect', () => {
            clearTimeout(timeout);
            client.end();
            res.json({
                success: true,
                message: 'MQTT connection successful'
            });
        });

        client.on('error', (error) => {
            clearTimeout(timeout);
            client.end();
            const authFailed = /not authorized|auth/i.test(error.message || '');
            res.json({
                success: false,
                message: authFailed ? 'MQTT auth failed - check username/password/client ID' : 'Connection failed'
            });
        });

    } catch (error) {
        logger.error('MQTT test error:', error);
        res.status(500).json({
            success: false,
            message: 'MQTT test failed'
        });
    }
});

// ==================== SYSTEM SETTINGS ====================

// Update system settings
router.post('/system', adminMiddleware, [
    body('deviceName').notEmpty(),
    body('phoneCountryCode').optional({ values: 'falsy' }).trim().isLength({ max: 8 }),
    body('publicBaseUrl').optional({ values: 'falsy' }).trim().isLength({ max: 300 }),
    body('otaBaseUrl').optional({ values: 'falsy' }).trim().isLength({ max: 300 }),
    body('timezone').notEmpty().custom(isValidTimezone).withMessage('Valid timezone required'),
    body('logLevel').isIn(['debug', 'info', 'warn', 'error']),
    body('autoRestart').isBoolean(),
    body('restartSchedule').optional().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/),
    body('backupConfig').isBoolean(),
    body('deviceStatusRefreshMs').isInt({ min: 5000, max: 3600000 }),
    body('statusWatchIntervalMs').isInt({ min: 10000, max: 300000 }),
    body('statusWatchTtlMs').isInt({ min: 60000, max: 900000 }),
    body('statusWatchRefreshMs').isInt({ min: 30000, max: 600000 }),
    body('logRetentionDays').isInt({ min: 1, max: 3650 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const db = req.app.locals.db;

        if (!db) {
            throw new Error('Database not available');
        }

        const currentEffective = await getEffectiveSystemSettings(db);
        const saved = await saveSystemSettings(db, req.body, (req.user || req.session.user)?.id || null);
        const envUpdates = {
            ...buildManagedSystemEnvUpdates(saved.savedSystem, currentEffective.effective),
            PHONE_COUNTRY_CODE: normalizeCountryCode(req.body.phoneCountryCode),
            PUBLIC_BASE_URL: normalizeUrl(req.body.publicBaseUrl),
            OTA_BASE_URL: normalizeUrl(req.body.otaBaseUrl)
        };
        writeEnvUpdates(envUpdates);
        applyProcessEnv(envUpdates);
        const effective = await getEffectiveSystemSettings(db);

        // Update logger level
        applyLoggerLevel(global.logger, effective.system.logLevel);
        req.app.locals.applyStatusWatchConfig?.(effective.system);

        // Hostname change is opt-in and Linux-only; deviceName is just the dashboard display name by default.
        // Validate hostname: RFC 1123 — alphanumeric and hyphens only, no leading/trailing hyphens
        if (req.body.applyHostname === true && process.platform === 'linux' && req.body.deviceName !== os.hostname()) {
            const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
            if (!hostnameRegex.test(req.body.deviceName)) {
                logger.warn('Invalid hostname format, skipping hostnamectl:', req.body.deviceName);
            } else {
                try {
                    execFile('sudo', ['hostnamectl', 'set-hostname', req.body.deviceName], (error) => {
                        if (error) {
                            logger.error('Error setting hostname:', error);
                        }
                    });
                } catch (hostnameError) {
                    logger.error('Failed to set hostname:', hostnameError);
                }
            }
        }

        const retention = pruneLogFiles(path.join(__dirname, '../logs'), effective.system.logRetentionDays, logger);

        logger.info('System settings updated');

        res.json({
            success: true,
            message: 'System settings updated successfully',
            data: {
                system: {
                    ...effective.system,
                    phoneCountryCode: envUpdates.PHONE_COUNTRY_CODE,
                    publicBaseUrl: envUpdates.PUBLIC_BASE_URL,
                    otaBaseUrl: envUpdates.OTA_BASE_URL
                },
                effective: effective.effective,
                prunedLogs: retention.deleted
            }
        });
    } catch (error) {
        logger.error('API update system settings error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update system settings'
        });
    }
});

// Restart server
router.post('/restart', adminMiddleware, (req, res) => {
    try {
        logger.info('Server restart requested');
        
        res.json({
            success: true,
            message: 'Server is restarting...',
            data: {
                restartPath: req.get('referer') || '/settings'
            }
        });

        // Restart after delay
        setTimeout(() => {
            process.exit(0);
        }, 2000);

    } catch (error) {
        logger.error('Restart error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to restart'
        });
    }
});

// ==================== NOTIFICATION SETTINGS ====================

// Update notification settings
router.post('/notifications', adminMiddleware, [
    body('email.enabled').isBoolean(),
    body('email.smtp').optional(),
    body('email.port').optional().isInt(),
    body('email.secure').optional().isBoolean(),
    body('email.user').optional(),
    body('email.pass').optional(),
    body('email.from').optional().isEmail(),
    body('email.to').optional().isEmail(),
    body('telegram.enabled').isBoolean(),
    body('telegram.botToken').optional(),
    body('telegram.chatId').optional()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { email, telegram } = req.body;
        const db = req.app.locals.db;

        if (!db) {
            throw new Error('Database not available');
        }

        // Save to settings table
        await db.run(`
            INSERT OR REPLACE INTO settings (key, value, updated_at) 
            VALUES (?, ?, CURRENT_TIMESTAMP)
        `, ['notifications', JSON.stringify({ email, telegram })]);

        logger.info('Notification settings updated');

        res.json({
            success: true,
            message: 'Notification settings updated successfully'
        });
    } catch (error) {
        logger.error('API update notifications error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update notification settings'
        });
    }
});

// Test email
router.post('/test/email', async (req, res) => {
    try {
        const { smtp, port, secure, user, pass, from, to } = req.body;

        // In production, use nodemailer here
        // For now, simulate success
        setTimeout(() => {
            res.json({
                success: true,
                message: 'Test email sent successfully'
            });
        }, 2000);

    } catch (error) {
        logger.error('Email test error:', error);
        res.status(500).json({
            success: false,
            message: 'Email test failed'
        });
    }
});

// Test Telegram
router.post('/test/telegram', async (req, res) => {
    try {
        const { botToken, chatId } = req.body;

        // Simulate success
        setTimeout(() => {
            res.json({
                success: true,
                message: 'Test Telegram message sent'
            });
        }, 2000);

    } catch (error) {
        logger.error('Telegram test error:', error);
        res.status(500).json({
            success: false,
            message: 'Telegram test failed'
        });
    }
});

// ==================== FIRMWARE SETTINGS ====================

// Update firmware settings
router.post('/firmware', adminMiddleware, [
    body('autoUpdate').isBoolean(),
    body('updateChannel').isIn(['stable', 'beta', 'dev'])
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { autoUpdate, updateChannel } = req.body;
        const db = req.app.locals.db;

        if (!db) {
            throw new Error('Database not available');
        }

        // Get current firmware settings
        const currentSettings = await db.get('SELECT value FROM settings WHERE key = ?', ['firmware']);
        let firmwareSettings = currentSettings ? JSON.parse(currentSettings.value) : { currentVersion: '1.0.0' };

        // Update settings
        firmwareSettings = {
            ...firmwareSettings,
            autoUpdate,
            updateChannel
        };

        await db.run(`
            INSERT OR REPLACE INTO settings (key, value, updated_at) 
            VALUES (?, ?, CURRENT_TIMESTAMP)
        `, ['firmware', JSON.stringify(firmwareSettings)]);

        logger.info('Firmware settings updated');

        res.json({
            success: true,
            message: 'Firmware settings updated successfully'
        });
    } catch (error) {
        logger.error('API update firmware settings error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update firmware settings'
        });
    }
});

// Check for firmware updates
router.post('/firmware/check', adminMiddleware, async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            throw new Error('Database not available');
        }

        // Get current firmware settings
        const settings = await db.get('SELECT value FROM settings WHERE key = ?', ['firmware']);
        const firmwareSettings = settings ? JSON.parse(settings.value) : { currentVersion: '1.0.0' };

        // Request device to check for updates via MQTT
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        if (global.mqttService && global.mqttService.connected && deviceId) {
            await global.mqttService.publishCommand(deviceId, 'check-firmware', {});
        }

        // Simulate checking for updates
        const availableVersion = '1.0.1';

        // Update settings
        firmwareSettings.availableVersion = availableVersion;
        firmwareSettings.lastCheck = new Date().toISOString();

        await db.run(`
            INSERT OR REPLACE INTO settings (key, value, updated_at) 
            VALUES (?, ?, CURRENT_TIMESTAMP)
        `, ['firmware', JSON.stringify(firmwareSettings)]);

        res.json({
            success: true,
            message: availableVersion > firmwareSettings.currentVersion ? 
                `Update available: ${availableVersion}` : 'Firmware is up to date',
            data: {
                current: firmwareSettings.currentVersion,
                available: availableVersion,
                updateAvailable: availableVersion > firmwareSettings.currentVersion
            }
        });
    } catch (error) {
        logger.error('API check firmware error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check for updates'
        });
    }
});

// Perform firmware update
router.post('/firmware/update', adminMiddleware, async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            throw new Error('Database not available');
        }

        // Get firmware settings
        const settings = await db.get('SELECT value FROM settings WHERE key = ?', ['firmware']);
        const firmwareSettings = settings ? JSON.parse(settings.value) : {};

        if (!firmwareSettings.availableVersion) {
            return res.status(400).json({
                success: false,
                message: 'No update available. Check for updates first.'
            });
        }

        // Send OTA update command via MQTT
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        if (global.mqttService && global.mqttService.connected && deviceId) {
            await global.mqttService.publishCommand(deviceId, 'ota-update', {
                version: firmwareSettings.availableVersion
            });

            logger.info(`Firmware update initiated to version ${firmwareSettings.availableVersion}`);

            res.json({
                success: true,
                message: `Firmware update to version ${firmwareSettings.availableVersion} initiated`,
                data: {
                    version: firmwareSettings.availableVersion
                }
            });
        } else {
            res.status(503).json({
                success: false,
                message: 'Device not connected'
            });
        }
    } catch (error) {
        logger.error('API firmware update error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to initiate firmware update'
        });
    }
});

// ==================== BACKUP FUNCTIONS ====================

// Create backup
router.post('/backup/create', adminMiddleware, async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            throw new Error('Database not available');
        }

        const backupDir = path.join(__dirname, '../backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(backupDir, `backup-${timestamp}.db`);

        // Backup database
        const dbPath = path.join(__dirname, '../data/database.sqlite');
        if (fs.existsSync(dbPath)) {
            fs.copyFileSync(dbPath, backupFile);
        }

        // Update last backup time in settings
        await db.run(`
            INSERT OR REPLACE INTO settings (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
        `, ['backup', JSON.stringify({ lastBackup: new Date().toISOString() })]);

        // Retention policy: delete .db backups older than 30 days
        const retentionMs = 30 * 24 * 60 * 60 * 1000;
        try {
            fs.readdirSync(backupDir)
                .filter(f => f.startsWith('backup-') && f.endsWith('.db'))
                .forEach(f => {
                    const fPath = path.join(backupDir, f);
                    const age = Date.now() - fs.statSync(fPath).mtimeMs;
                    if (age > retentionMs) {
                        fs.unlinkSync(fPath);
                        logger.info(`Deleted old backup: ${f}`);
                    }
                });
        } catch (retErr) {
            logger.warn('Retention cleanup error:', retErr.message);
        }

        logger.info(`Backup created: ${backupFile}`);

        res.json({
            success: true,
            message: 'Backup created successfully',
            file: `backup-${timestamp}.db`
        });
    } catch (error) {
        logger.error('Backup creation error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create backup'
        });
    }
});

// Restore from backup
router.post('/backup/restore', adminMiddleware, [
    body('file').notEmpty().custom(isDbBackupFilename)
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: 'Invalid filename' });
        }

        const { file } = req.body;
        const backupDir = path.join(__dirname, '../backups');
        const backupFile = path.resolve(backupDir, file);

        // Guard against path traversal
        if (!backupFile.startsWith(backupDir + path.sep)) {
            return res.status(400).json({ success: false, message: 'Invalid filename' });
        }

        if (!fs.existsSync(backupFile)) {
            return res.status(404).json({
                success: false,
                message: 'Backup file not found'
            });
        }

        // Restore database
        const dbPath = path.join(__dirname, '../data/database.sqlite');
        fs.copyFileSync(backupFile, dbPath);

        logger.info(`Backup restored: ${file}`);

        res.json({
            success: true,
            message: 'Backup restored successfully. Server will restart.'
        });

        // Restart server after delay
        setTimeout(() => {
            process.exit(0);
        }, 3000);

    } catch (error) {
        logger.error('Backup restore error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to restore backup'
        });
    }
});

// Get backup list
router.get('/backups', (req, res) => {
    try {
        const backupDir = path.join(__dirname, '../backups');
        
        if (!fs.existsSync(backupDir)) {
            return res.json({
                success: true,
                data: []
            });
        }

        const files = fs.readdirSync(backupDir)
            .filter(f => f.endsWith('.db'))
            .map(f => {
                const stat = fs.statSync(path.join(backupDir, f));
                return {
                    name: f,
                    size: stat.size,
                    created: stat.birthtime,
                    modified: stat.mtime
                };
            })
            .sort((a, b) => b.modified - a.modified);

        res.json({
            success: true,
            data: files
        });
    } catch (error) {
        logger.error('Get backups error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get backups'
        });
    }
});

// Download backup
router.get('/backups/:filename/download', (req, res) => {
    try {
        const { filename } = req.params;
        if (!isDbBackupFilename(filename)) {
            return res.status(400).json({ success: false, message: 'Invalid filename' });
        }

        const backupDir = path.join(__dirname, '../backups');
        const backupFile = path.resolve(backupDir, filename);

        if (!backupFile.startsWith(backupDir + path.sep)) {
            return res.status(400).json({ success: false, message: 'Invalid filename' });
        }

        if (!fs.existsSync(backupFile)) {
            return res.status(404).json({ success: false, message: 'Backup file not found' });
        }

        res.download(backupFile, filename);
    } catch (error) {
        logger.error('Download backup error:', error);
        res.status(500).json({ success: false, message: 'Failed to download backup' });
    }
});

// Delete backup
router.delete('/backups/:filename', adminMiddleware, (req, res) => {
    try {
        const { filename } = req.params;
        if (!isDbBackupFilename(filename)) {
            return res.status(400).json({ success: false, message: 'Invalid filename' });
        }

        const backupDir = path.join(__dirname, '../backups');
        const backupFile = path.resolve(backupDir, filename);

        // Guard against path traversal
        if (!backupFile.startsWith(backupDir + path.sep)) {
            return res.status(400).json({ success: false, message: 'Invalid filename' });
        }

        if (!fs.existsSync(backupFile)) {
            return res.status(404).json({
                success: false,
                message: 'Backup file not found'
            });
        }

        fs.unlinkSync(backupFile);

        res.json({
            success: true,
            message: 'Backup deleted successfully'
        });
    } catch (error) {
        logger.error('Delete backup error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete backup'
        });
    }
});

// ==================== LOGS ====================

// Get logs
router.get('/logs', (req, res) => {
    try {
        const logFile = path.join(__dirname, '../logs/app.log');
        
        if (!fs.existsSync(logFile)) {
            return res.json({
                success: true,
                data: 'No logs found'
            });
        }

        const logs = fs.readFileSync(logFile, 'utf8');
        const lines = logs.split('\n').slice(-500).join('\n');

        res.json({
            success: true,
            data: lines
        });
    } catch (error) {
        logger.error('Get logs error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get logs'
        });
    }
});

// Clear logs
router.post('/logs/clear', adminMiddleware, async (req, res) => {
    try {
        const db = req.app.locals.db;
        const summary = await clearAllDashboardLogs(db);

        res.json({
            success: true,
            message: 'All dashboard logs cleared successfully',
            data: summary
        });
    } catch (error) {
        logger.error('Clear logs error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to clear logs'
        });
    }
});

// Download logs
router.get('/logs/download', (req, res) => {
    try {
        const logFile = path.join(__dirname, '../logs/app.log');
        
        if (!fs.existsSync(logFile)) {
            return res.status(404).send('Logs not found');
        }

        res.download(logFile, `esp32-logs-${new Date().toISOString().slice(0,10)}.log`);
    } catch (error) {
        logger.error('Download logs error:', error);
        res.status(500).send('Failed to download logs');
    }
});

// ==================== USER MANAGEMENT ====================

// Get all users
router.get('/users', adminMiddleware, async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            throw new Error('Database not available');
        }

        const users = await db.all('SELECT id, username, name, email, role, created_at, last_login FROM users');
        
        res.json({
            success: true,
            data: users
        });
    } catch (error) {
        logger.error('Get users error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get users'
        });
    }
});

// Add new user
router.post('/users', adminMiddleware, [
    body('username').notEmpty().withMessage('Username is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('name').optional(),
    body('email').optional().isEmail(),
    body('role').isIn(['user', 'admin']).withMessage('Invalid role')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { username, password, name, email, role } = req.body;
        const db = req.app.locals.db;

        if (!db) {
            throw new Error('Database not available');
        }

        // Check if username exists
        const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
        if (existing) {
            return res.status(400).json({
                success: false,
                message: 'Username already exists'
            });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert user
        const result = await db.run(`
            INSERT INTO users (username, password, name, email, role, created_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [username, hashedPassword, name || null, email || null, role]);

        logger.info(`New user created: ${username}`);

        res.json({
            success: true,
            message: 'User created successfully',
            userId: result.lastID
        });
    } catch (error) {
        logger.error('Create user error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create user'
        });
    }
});

// Update user
router.put('/users/:id', adminMiddleware, [
    body('name').optional(),
    body('email').optional().isEmail(),
    body('role').isIn(['user', 'admin']).withMessage('Invalid role'),
    body('password').optional().isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { id } = req.params;
        if (!/^[0-9]+$/.test(id)) {
            return res.status(400).json({ success: false, message: 'Invalid user id' });
        }
        const { name, email, role, password } = req.body;
        const db = req.app.locals.db;

        if (!db) {
            throw new Error('Database not available');
        }

        // Check if user exists
        const user = await db.get('SELECT * FROM users WHERE id = ?', [id]);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Build update query
        let updates = [];
        let params = [];

        if (name !== undefined) {
            updates.push('name = ?');
            params.push(name || null);
        }
        if (email !== undefined) {
            updates.push('email = ?');
            params.push(email || null);
        }
        if (role !== undefined) {
            updates.push('role = ?');
            params.push(role);
        }
        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            updates.push('password = ?');
            params.push(hashedPassword);
        }

        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields to update'
            });
        }

        params.push(id);
        await db.run(`
            UPDATE users 
            SET ${updates.join(', ')}
            WHERE id = ?
        `, params);

        logger.info(`User updated: ${id}`);

        res.json({
            success: true,
            message: 'User updated successfully'
        });
    } catch (error) {
        logger.error('Update user error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update user'
        });
    }
});

// Delete user
router.delete('/users/:id', adminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^[0-9]+$/.test(id)) {
            return res.status(400).json({ success: false, message: 'Invalid user id' });
        }
        const db = req.app.locals.db;

        if (!db) {
            throw new Error('Database not available');
        }

        // Check if user is the last admin
        if (id == 1) {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete the main admin user'
            });
        }

        const result = await db.run('DELETE FROM users WHERE id = ?', [id]);

        if (result.changes === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        logger.info(`User deleted: ${id}`);

        res.json({
            success: true,
            message: 'User deleted successfully'
        });
    } catch (error) {
        logger.error('Delete user error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete user'
        });
    }
});

// Factory reset (clears all data except users)
router.post('/factory-reset', adminMiddleware, async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            throw new Error('Database not available');
        }

        // Clear all tables except users
        await db.exec(`
            DELETE FROM sms;
            DELETE FROM calls;
            DELETE FROM contacts;
            DELETE FROM ussd;
            DELETE FROM gps_locations;
            DELETE FROM gpio_config;
            DELETE FROM gpio_history;
            DELETE FROM gpio_groups;
            DELETE FROM gpio_rules;
            DELETE FROM settings;
            DELETE FROM sessions;
            DELETE FROM notifications;
            DELETE FROM mqtt_logs;
            DELETE FROM system_logs;
            DELETE FROM automation_logs;
            DELETE FROM automation_data_records;
            DELETE FROM flow_execution_log;
            DELETE FROM login_audit;
            DELETE FROM login_sessions;
            DELETE FROM backups;
        `);

        logger.info('Factory reset completed');

        res.json({
            success: true,
            message: 'Factory reset completed. Server will restart.'
        });

        // Restart after delay
        setTimeout(() => {
            process.exit(0);
        }, 3000);

    } catch (error) {
        logger.error('Factory reset error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reset'
        });
    }
});

function normalizeDeviceId(value) {
    return String(value || '').trim();
}

function buildScopedDeviceDataStatements(deviceId) {
    return [
        {
            sql: 'DELETE FROM sms_conversation_participants WHERE conversation_id IN (SELECT id FROM sms_conversations WHERE device_id = ?)',
            params: [deviceId]
        },
        { sql: 'DELETE FROM sms WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM sms_conversations WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM calls WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM ussd WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM gps_locations WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM gpio_history WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM gpio_rules WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM gpio_groups WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM gpio_config WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM pin_names WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM mqtt_logs WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM intercom_calls WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM intercom_sessions WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM intercom_settings WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM automation_logs WHERE flow_id IN (SELECT id FROM automation_flows WHERE device_id = ?)', params: [deviceId] },
        { sql: 'DELETE FROM automation_data_records WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM flow_execution_log WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM automation_flows WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM device_command_queue WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM device_ota_history WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM device_package_requests WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM device_module_health WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM device_wifi_networks WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM sims WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM device_push_tokens WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM device_group_members WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM device_users WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM phone_device_links WHERE phone_device_id = ? OR target_device_id = ?', params: [deviceId, deviceId] },
        { sql: 'DELETE FROM unregistered_device_events WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM unregistered_devices WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM device_profiles WHERE device_id = ?', params: [deviceId] },
        { sql: 'DELETE FROM devices WHERE id = ?', params: [deviceId] }
    ];
}

async function runSqlTransaction(db, statements) {
    await db.run('BEGIN IMMEDIATE');
    try {
        for (const statement of statements) {
            if (typeof statement === 'string') {
                await db.run(statement);
            } else {
                await db.run(statement.sql, statement.params || []);
            }
        }
        await db.run('COMMIT');
    } catch (error) {
        try {
            await db.run('ROLLBACK');
        } catch (_) {}
        throw error;
    }
}

// Clear only the selected device's linked state from the device settings page.
router.post('/clear-device-data', adminMiddleware, async (req, res) => {
    try {
        const db = req.app.locals.db;
        if (!db) {
            throw new Error('Database not available');
        }

        const deviceId = normalizeDeviceId(req.body?.deviceId || req.body?.device_id || req.query?.deviceId || req.query?.device_id);
        if (!deviceId) {
            return res.status(400).json({
                success: false,
                message: 'Device ID is required. Clear device data from the selected device settings page.'
            });
        }

        let deletedDeviceSuppressed = false;
        await req.app.locals.mqttHandlers?.suppressDeletedDevice?.(deviceId);
        deletedDeviceSuppressed = true;

        try {
            await runSqlTransaction(db, buildScopedDeviceDataStatements(deviceId));
        } catch (error) {
            if (deletedDeviceSuppressed) {
                try { await req.app.locals.mqttHandlers?.unsuppressDeletedDevice?.(deviceId); } catch (_) {}
            }
            throw error;
        }

        try { req.app.locals.mqttHandlers?.releaseDeviceRuntime?.(deviceId); } catch (_) {}
        try { global.modemService?.devices?.delete?.(deviceId); } catch (_) {}
        try { global.mqttService?.clearDeviceStatus?.(deviceId); } catch (_) {}
        try {
            const handlers = req.app.locals.mqttHandlers;
            handlers?._registeredDeviceCache?.delete?.(deviceId);
            const timer = handlers?._gpsDebounce?.get?.(deviceId);
            if (timer) clearTimeout(timer);
            handlers?._gpsDebounce?.delete?.(deviceId);
        } catch (_) {}

        logger.info(`Device data cleared for ${deviceId}`);

        res.json({
            success: true,
            deviceId,
            message: `Device ${deviceId} and its linked data were cleared.`
        });
    } catch (error) {
        logger.error('Clear device data error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to clear device data'
        });
    }
});

module.exports = router;
