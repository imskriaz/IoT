const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { resolveDeviceId } = require('../utils/deviceResolver');
const { authorizeDeviceAccess, requireDeviceAccess } = require('../middleware/auth');

// The active ESP32-S3/A7670E firmware exposes one bounded diagnostic lane.
// Keep this contract deny-by-default so board pins used by flash, SD, USB, the
// modem, battery gauge and RGB LED cannot become writable from a generic map.
const ACTIVE_GPIO_CONTRACT = Object.freeze({
    pins: Object.freeze([2]),
    mode: 'input_output',
    capabilities: Object.freeze({
        digital: true,
        read: true,
        write: true,
        pulse: true,
        pwm: false,
        analog: false,
        touch: false,
        dac: false
    }),
    pulseMinMs: 50,
    pulseMaxMs: 10000
});

function isActiveGpioPin(pin) {
    return ACTIVE_GPIO_CONTRACT.pins.includes(Number(pin));
}

function gpioActionPayload(response) {
    if (!response || response.success !== true || response.result !== 'completed') return null;
    const payload = response.payload && typeof response.payload === 'object' && !Array.isArray(response.payload)
        ? response.payload
        : response;
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
}

function normalizeFirmwarePin(payload, fallbackPin = ACTIVE_GPIO_CONTRACT.pins[0]) {
    if (!payload || typeof payload !== 'object') return null;
    const pin = payload.pin;
    if (!Number.isInteger(pin) || !isActiveGpioPin(pin) || pin !== Number(fallbackPin)) return null;
    const rawValue = payload.level ?? payload.final_level ?? payload.value;
    const value = rawValue === true ? 1 : rawValue === false ? 0 : rawValue;
    if (value !== 0 && value !== 1) return null;
    return {
        pin,
        value,
        level: value,
        mode: ACTIVE_GPIO_CONTRACT.mode,
        config: { mode: ACTIVE_GPIO_CONTRACT.mode, pull: 'none' },
        capabilities: { ...ACTIVE_GPIO_CONTRACT.capabilities }
    };
}

function normalizeFirmwarePins(response) {
    const payload = gpioActionPayload(response);
    if (!payload) return [];
    const sourcePins = Array.isArray(payload.pins) ? payload.pins : [payload];
    return sourcePins.map(pin => normalizeFirmwarePin(pin)).filter(Boolean);
}

// GPIO Pin Configuration Store
let pinConfigs = new Map(); // deviceId -> { pin: config }
let pinStates = new Map(); // deviceId -> { pin: value }
let pinHistory = new Map(); // deviceId -> { pin: [{timestamp, value}] }
let pinGroups = new Map(); // deviceId -> { groupName: [pins] }
let pinRules = new Map(); // deviceId -> [{id, condition, action, enabled}]
const pinObservedAt = new Map();
const GPIO_FRESH_MS = 60000;

function runQueuedDeviceOperation(deviceId, task) {
    if (global.mqttService && typeof global.mqttService.runDeviceOperation === 'function') {
        return global.mqttService.runDeviceOperation(deviceId, task);
    }
    return task();
}

// ==================== DB PERSISTENCE ====================

/**
 * Persist current pinConfigs + pinStates for a device to gpio_config table.
 * Fires-and-forgets errors to avoid blocking the calling path.
 */
async function saveGpioToDB(deviceId) {
    try {
        const db = global.app && global.app.locals.db;
        if (!db) return;
        const configs = pinConfigs.get(deviceId) || {};
        const states  = pinStates.get(deviceId)  || {};
        const pins = new Set([...Object.keys(configs), ...Object.keys(states)]);
        for (const pin of pins) {
            const cfg = configs[pin] || {};
            await db.run(`
                INSERT INTO gpio_config (device_id, pin, name, mode, pull, frequency, value, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(device_id, pin) DO UPDATE SET
                    name      = excluded.name,
                    mode      = excluded.mode,
                    pull      = excluded.pull,
                    frequency = excluded.frequency,
                    value     = excluded.value,
                    updated_at = CURRENT_TIMESTAMP
            `, [
                deviceId, parseInt(pin),
                cfg.name  || null,
                cfg.mode  || 'input',
                cfg.pull  || 'none',
                cfg.frequency || 1000,
                states[pin] !== undefined ? states[pin] : 0
            ]);
        }
    } catch (e) {
        logger.error(`GPIO saveGpioToDB error for ${deviceId}:`, e.message);
    }
}

/**
 * Load pinConfigs + pinStates for all devices from gpio_config table.
 * Called once after the DB is ready.
 */
async function loadGpioFromDB() {
    try {
        const db = global.app && global.app.locals.db;
        if (!db) return;
        const rows = await db.all(`SELECT device_id, pin, name, mode, pull, frequency, value FROM gpio_config`);
        for (const row of rows) {
            const { device_id, pin, name, mode, pull, frequency, value } = row;
            if (!isActiveGpioPin(pin)) continue;
            if (!pinConfigs.has(device_id)) pinConfigs.set(device_id, {});
            if (!pinStates.has(device_id))  pinStates.set(device_id, {});
            pinConfigs.get(device_id)[pin] = { name, mode: ACTIVE_GPIO_CONTRACT.mode, pull: 'none' };
            if (!pinObservedAt.has(device_id)) {
                pinStates.get(device_id)[pin] = value === 0 || value === 1 ? value : null;
            }
        }
        if (rows.length > 0) logger.info(`✅ GPIO: loaded ${rows.length} pin(s) from DB`);
    } catch (e) {
        logger.error('GPIO loadGpioFromDB error:', e.message);
    }
}

/**
 * Load all GPIO rules from the DB into the pinRules Map.
 * Uses the DB integer id (as string) as the in-memory rule id.
 */
async function loadRulesFromDB() {
    try {
        const db = global.app && global.app.locals.db;
        if (!db) return;
        const rows = await db.all(
            `SELECT id, device_id, name, condition, cron_expr, action, enabled, trigger_count, last_triggered, created_at
             FROM gpio_rules ORDER BY created_at ASC`
        );
        for (const row of rows) {
            const { device_id, id, name, condition, cron_expr, action, enabled, trigger_count, last_triggered, created_at } = row;
            if (!pinRules.has(device_id)) pinRules.set(device_id, []);
            // Avoid duplicates on reload
            const existing = pinRules.get(device_id);
            if (!existing.find(r => r.id === String(id))) {
                existing.push({
                    id: String(id),
                    name,
                    condition: condition || '',
                    cron_expr: cron_expr || null,
                    action,
                    enabled: (enabled === 1 || enabled === true) && isSupportedGpioRuleAction(action),
                    triggerCount: trigger_count || 0,
                    lastTriggered: last_triggered || null,
                    createdAt: created_at
                });
            }
        }
        if (rows.length) logger.info(`✅ GPIO: loaded ${rows.length} rule(s) from DB`);
    } catch (e) {
        logger.error('GPIO loadRulesFromDB error:', e.message);
    }
}

// Defer load until the DB is initialised (app.locals.db is set after server starts)
setTimeout(async () => {
    await loadGpioFromDB();
    await loadRulesFromDB();
}, 3000);

// ==================== GPIO CONFIGURATION ====================

/**
 * @swagger
 * tags:
 *   name: GPIO
 *   description: GPIO pin control and monitoring
 */

/**
 * @swagger
 * /gpio/status:
 *   get:
 *     summary: Get all GPIO pin states for a device
 *     tags: [GPIO]
 *     parameters:
 *       - in: query
 *         name: deviceId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Pin state map
 */
router.get('/status', requireDeviceAccess(), async (req, res) => {
    const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);

    try {
        if (!global.mqttService || !global.mqttService.connected) {
            return res.json({
                success: true,
                data: {
                    pins: getLocalPinStates(deviceId),
                    allowedPins: [...ACTIVE_GPIO_CONTRACT.pins],
                    contract: ACTIVE_GPIO_CONTRACT,
                    groups: Array.from(pinGroups.get(deviceId) || []),
                    rules: Array.from(pinRules.get(deviceId) || []),
                    online: false,
                    cached: true,
                    error: 'MQTT not connected'
                }
            });
        }

        const response = await runQueuedDeviceOperation(deviceId, () =>
            global.mqttService.publishCommand(
                deviceId,
                'gpio-status',
                {},
                true,
                12000,
                { skipQueue: true, source: 'dashboard-gpio', domain: 'status' }
            )
        );
        const livePins = normalizeFirmwarePins(response);

        if (livePins.length) {
            // Update local cache
            updatePinStates(deviceId, livePins);
            
            res.json({
                success: true,
                data: {
                    pins: livePins,
                    allowedPins: [...ACTIVE_GPIO_CONTRACT.pins],
                    contract: ACTIVE_GPIO_CONTRACT,
                    groups: Array.from(pinGroups.get(deviceId) || []),
                    rules: Array.from(pinRules.get(deviceId) || []),
                    online: true,
                    cached: false,
                    timestamp: response.receivedAt || response.timestamp || new Date().toISOString()
                }
            });
        } else {
            throw new Error('Device returned no valid GPIO state');
        }
    } catch (error) {
        logger.error('GPIO status error:', error);
        res.json({
            success: true,
            data: {
                pins: getLocalPinStates(deviceId),
                allowedPins: [...ACTIVE_GPIO_CONTRACT.pins],
                contract: ACTIVE_GPIO_CONTRACT,
                groups: Array.from(pinGroups.get(deviceId) || []),
                rules: Array.from(pinRules.get(deviceId) || []),
                online: false,
                cached: true,
                error: 'Failed to get GPIO status'
            }
        });
    }
});

/**
 * Get pin configuration
 * GET /api/gpio/pin/:pin?deviceId=1
 */
router.get('/pin/:pin', requireDeviceAccess(), (req, res) => {
    try {
        const pin = Number(req.params.pin);
        if (isNaN(pin) || pin < 0 || pin > 48) {
            return res.status(400).json({ success: false, message: 'Invalid pin number' });
        }
        if (!isActiveGpioPin(pin)) {
            return res.status(422).json({
                success: false,
                message: `GPIO${pin} is not exposed by the active firmware`,
                allowedPins: [...ACTIVE_GPIO_CONTRACT.pins]
            });
        }
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        
        const config = pinConfigs.get(deviceId)?.[pin] || {
            mode: ACTIVE_GPIO_CONTRACT.mode,
            pull: 'none',
            value: 0,
            analog: 0,
            pwm: 0,
            frequency: 1000,
            lastChange: null
        };

        const capabilities = { ...ACTIVE_GPIO_CONTRACT.capabilities };

        res.json({
            success: true,
            data: {
                pin,
                config,
                capabilities,
                currentValue: pinStates.get(deviceId)?.[pin] ?? null,
                history: pinHistory.get(deviceId)?.[pin]?.slice(-10) || [],
                cached: true,
                observedAt: pinObservedAt.get(deviceId) || null
            }
        });
    } catch (error) {
        logger.error('GPIO pin error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get pin info'
        });
    }
});

/**
 * Configure pin mode
 * POST /api/gpio/mode
 */
router.post('/mode', [
    body('pin').isInt({ min: 0, max: 48 }),
    body('mode').isIn(['input', 'output', 'input_pullup', 'input_pulldown', 'open_drain']),
    body('pull').optional().isIn(['none', 'up', 'down']),
    body('deviceId').optional()
], requireDeviceAccess(undefined, true), async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        return res.status(501).json({
            success: false,
            message: 'Runtime GPIO mode changes are not implemented by the active firmware; GPIO2 is managed as a bounded digital diagnostic pin'
        });
    } catch (error) {
        logger.error('GPIO mode error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to set pin mode'
        });
    }
});

/**
 * @swagger
 * /gpio/write:
 *   post:
 *     summary: Set a GPIO pin value
 *     tags: [GPIO]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pin, value]
 *             properties:
 *               pin:      { type: integer, minimum: 0, maximum: 48 }
 *               value:    { type: integer, enum: [0, 1] }
 *               deviceId: { type: string }
 *     responses:
 *       200:
 *         description: Pin set successfully
 *       400:
 *         description: Invalid pin or value
 */
router.post('/write', [
    body('pin').isInt({ min: 0, max: 48 }),
    body('value').custom(value => value === true || value === false || value === 0 || value === 1),
    body('type').optional().equals('digital'),
    body('duration').optional().isInt({ min: 0, max: ACTIVE_GPIO_CONTRACT.pulseMaxMs }).toInt()
        .custom(value => value === 0 || value >= ACTIVE_GPIO_CONTRACT.pulseMinMs),
    body('deviceId').optional()
], requireDeviceAccess(undefined, true), async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { pin, value, type = 'digital', duration } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);

        if (!isActiveGpioPin(pin)) {
            return res.status(422).json({
                success: false,
                message: `GPIO${pin} is not exposed by the active firmware`,
                allowedPins: [...ACTIVE_GPIO_CONTRACT.pins]
            });
        }

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const command = {
            pin: Number(pin),
            value: value ? 1 : 0
        };

        const commandName = duration ? 'gpio-pulse' : 'gpio-write';
        if (duration) command.ttl_ms = duration;

        const response = await global.mqttService.publishCommand(deviceId, commandName, command, true, 15000, {
            source: 'dashboard-gpio',
            domain: 'control'
        });
        const confirmed = normalizeFirmwarePin(gpioActionPayload(response), pin);

        if (response && response.success && confirmed) {
            // Update local state
            if (!pinStates.has(deviceId)) {
                pinStates.set(deviceId, {});
            }
            pinStates.get(deviceId)[pin] = confirmed.value;
            pinObservedAt.set(deviceId, Date.now());
            saveGpioToDB(deviceId);

            // Add to history
            if (!pinHistory.has(deviceId)) {
                pinHistory.set(deviceId, {});
            }
            if (!pinHistory.get(deviceId)[pin]) {
                pinHistory.get(deviceId)[pin] = [];
            }
            pinHistory.get(deviceId)[pin].push({
                timestamp: new Date().toISOString(),
                value: confirmed.value,
                type
            });
            // Keep last 100 values
            if (pinHistory.get(deviceId)[pin].length > 100) {
                pinHistory.get(deviceId)[pin].shift();
            }

            logger.info(`GPIO pin ${pin} written with value ${value} (${type})`);
            
            res.json({
                success: true,
                message: duration ? `GPIO${pin} pulse completed; final level ${confirmed.value}` : `GPIO${pin} confirmed at ${confirmed.value}`,
                data: { ...confirmed, type, duration: duration || 0, command: commandName }
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to write to pin'
            });
        }
    } catch (error) {
        logger.error('GPIO write error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to write to pin'
        });
    }
});

/**
 * Set PWM duty cycle on a pin
 * POST /api/gpio/pwm
 * Body: { pin, duty (0-255), frequency (Hz, optional), deviceId }
 */
router.post('/pwm', [
    body('pin').isInt({ min: 0, max: 48 }),
    body('duty').isInt({ min: 0, max: 255 }),
    body('frequency').optional().isInt({ min: 1, max: 40000000 }),
    body('deviceId').optional()
], requireDeviceAccess(undefined, true), async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0]?.msg || "Validation failed", errors: errors.array() });
        }

        return res.status(501).json({
            success: false,
            message: 'PWM is not implemented by the active firmware GPIO contract'
        });
    } catch (error) {
        logger.error('GPIO PWM error:', error);
        res.status(500).json({ success: false, message: 'Failed to set PWM' });
    }
});

/**
 * Read from pin
 * GET /api/gpio/read/:pin?deviceId=1
 */
router.get('/read/:pin', requireDeviceAccess(), async (req, res) => {
    const pin = Number(req.params.pin);

    try {
        if (isNaN(pin) || pin < 0 || pin > 48) {
            return res.status(400).json({ success: false, message: 'Invalid pin number' });
        }
        if (!isActiveGpioPin(pin)) {
            return res.status(422).json({
                success: false,
                message: `GPIO${pin} is not exposed by the active firmware`,
                allowedPins: [...ACTIVE_GPIO_CONTRACT.pins]
            });
        }
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const type = req.query.type || 'digital';
        if (type !== 'digital') {
            return res.status(422).json({ success: false, message: 'Only digital GPIO reads are implemented' });
        }

        if (!global.mqttService || !global.mqttService.connected) {
            const cached = pinStates.get(deviceId)?.[pin] ?? null;
            return res.json({
                success: true,
                data: {
                    pin,
                    value: cached,
                    type,
                    cached: true,
                    timestamp: new Date().toISOString()
                }
            });
        }

        const response = await runQueuedDeviceOperation(deviceId, () =>
            global.mqttService.publishCommand(
                deviceId,
                'gpio-status',
                { pin, type },
                true,
                12000,
                { skipQueue: true, source: 'dashboard-gpio', domain: 'status' }
            )
        );
        const confirmed = normalizeFirmwarePin(gpioActionPayload(response), pin);

        if (confirmed) {
            // Update cache
            if (!pinStates.has(deviceId)) {
                pinStates.set(deviceId, {});
            }
            pinStates.get(deviceId)[pin] = confirmed.value;
            pinObservedAt.set(deviceId, Date.now());
            saveGpioToDB(deviceId);

            res.json({
                success: true,
                data: {
                    pin,
                    value: confirmed.value,
                    type,
                    cached: false,
                    timestamp: response.receivedAt || response.timestamp || new Date().toISOString()
                }
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to read pin'
            });
        }
    } catch (error) {
        logger.error('GPIO read error:', error);
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const type = req.query.type || 'digital';
        const cached = pinStates.get(deviceId)?.[pin] ?? null;
        res.json({
            success: true,
            data: {
                pin,
                value: cached,
                type,
                cached: true,
                error: 'Failed to read pin',
                timestamp: new Date().toISOString()
            }
        });
    }
});

// ==================== PIN GROUPS ====================

/**
 * Create pin group
 * POST /api/gpio/groups
 */
router.post('/groups', [
    body('name').notEmpty(),
    body('pins').isArray({ min: 1 }).custom(pins => pins.every(isActiveGpioPin)),
    body('deviceId').optional()
], requireDeviceAccess(undefined, true), (req, res) => {
    try {
        const { name, pins } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(422).json({
                success: false,
                message: 'A GPIO group may contain only firmware-exposed GPIO2',
                allowedPins: [...ACTIVE_GPIO_CONTRACT.pins]
            });
        }

        if (!pinGroups.has(deviceId)) {
            pinGroups.set(deviceId, new Map());
        }
        
        pinGroups.get(deviceId).set(name, {
            pins,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });

        logger.info(`GPIO group created: ${name} with pins ${pins.join(',')}`);

        res.json({
            success: true,
            message: `Group "${name}" created`,
            data: { name, pins }
        });
    } catch (error) {
        logger.error('GPIO group error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create group'
        });
    }
});

/**
 * Write to group
 * POST /api/gpio/groups/:name/write
 */
router.post('/groups/:name/write', [
    body('values').isObject(),
    body('deviceId').optional()
], requireDeviceAccess(undefined, true), async (req, res) => {
    try {
        const { name } = req.params;
        const { values } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);

        const group = pinGroups.get(deviceId)?.get(name);
        if (!group) {
            return res.status(404).json({
                success: false,
                message: 'Group not found'
            });
        }
        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({ success: false, message: 'MQTT not connected' });
        }

        const results = [];
        for (const pin of group.pins) {
            if (values[pin] !== undefined) {
                if (!isActiveGpioPin(pin) || ![0, 1, false, true].includes(values[pin])) {
                    results.push({ pin, success: false, error: 'Unsupported pin or value' });
                    continue;
                }
                try {
                    const response = await global.mqttService.publishCommand(
                        deviceId,
                        'gpio-write',
                        { pin, value: values[pin] ? 1 : 0 },
                        true,
                        15000,
                        { source: 'dashboard-gpio-group', domain: 'control' }
                    );
                    const confirmed = normalizeFirmwarePin(gpioActionPayload(response), pin);
                    if (!confirmed) throw new Error('Device did not confirm GPIO state');
                    results.push({ pin, success: true, value: confirmed.value });
                } catch (err) {
                    logger.warn(`gpio group write failed for pin ${pin}:`, err.message);
                    results.push({ pin, success: false, error: 'Write failed' });
                }
            }
        }

        const allSucceeded = results.length > 0 && results.every(result => result.success);
        res.status(allSucceeded ? 200 : 502).json({
            success: allSucceeded,
            message: allSucceeded ? `Group "${name}" updated` : `Group "${name}" was not fully confirmed by the device`,
            data: results
        });
    } catch (error) {
        logger.error('GPIO group write error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to write to group'
        });
    }
});

// ==================== AUTOMATION RULES ====================

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function coerceBoolean(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
}

function coerceNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function escapeJsString(value) {
    return JSON.stringify(value == null ? '' : String(value));
}

function normalizeConditionValue(value) {
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    if (trimmed.toLowerCase() === 'true') return true;
    if (trimmed.toLowerCase() === 'false') return false;
    return trimmed;
}

function safeParseAction(action) {
    if (isPlainObject(action)) return action;
    if (typeof action !== 'string' || !action.trim()) return {};
    try {
        const parsed = JSON.parse(action);
        return isPlainObject(parsed) ? parsed : { value: parsed };
    } catch (_) {
        return { command: action };
    }
}

function serializeAction(action) {
    if (typeof action === 'string') return action;
    return JSON.stringify(action || {});
}

function isSupportedGpioRuleAction(action) {
    const parsed = safeParseAction(action);
    const command = String(parsed.command || 'gpio-write').trim().toLowerCase();
    return command === 'gpio-write'
        && isActiveGpioPin(parsed.pin)
        && [0, 1, false, true].includes(parsed.value);
}

function extractActionPayload(actionType, actionObj = {}) {
    switch (actionType) {
    case 'gpio_write':
        return { pin: actionObj.pin, value: actionObj.value };
    case 'gpio_pwm':
        return { pin: actionObj.pin, duty: actionObj.duty, freq: actionObj.freq, resolution: actionObj.resolution };
    case 'led':
        return { r: actionObj.r, g: actionObj.g, b: actionObj.b, enabled: actionObj.enabled };
    case 'send_sms':
        return { to: actionObj.to, message: actionObj.message };
    case 'send_ussd':
        return { code: actionObj.code };
    case 'gps_toggle':
        return { enabled: actionObj.enabled };
    case 'ota':
        return { url: actionObj.url };
    case 'webhook':
        return { url: actionObj.url, method: actionObj.method, body: actionObj.body };
    case 'email':
        return { to: actionObj.to, subject: actionObj.subject, body: actionObj.body };
    case 'restart':
        return {};
    default:
        return Object.fromEntries(
            Object.entries(actionObj).filter(([key]) => !['command', 'meta'].includes(key))
        );
    }
}

function inferActionType(actionObj = {}) {
    const cmd = actionObj.command || actionObj.action || '';
    switch (cmd) {
    case 'gpio-write':
    case 'gpio-set':
        return 'gpio_write';
    case 'gpio-pwm':
        return 'gpio_pwm';
    case 'led':
        return 'led';
    case 'send-sms':
        return 'send_sms';
    case 'send-ussd':
        return 'send_ussd';
    case 'gps-set-enabled':
        return 'gps_toggle';
    case 'restart':
        return 'restart';
    case 'ota':
    case 'ota-update':
        return 'ota';
    case 'webhook':
        return 'webhook';
    case 'email':
        return 'email';
    case 'ai-action':
        return 'ai_action';
    default:
        return cmd || 'custom';
    }
}

function inferTriggerType(rule = {}, meta = {}) {
    if (meta.triggerType) return meta.triggerType;
    if (rule.cron_expr) {
        if (String(rule.cron_expr).startsWith('@every:')) return 'interval';
        if (/^\d{2}:\d{2}(?::.+)?$/.test(String(rule.cron_expr))) return 'time_of_day';
        return 'schedule';
    }
    const condition = String(rule.condition || '');
    if (/battery/i.test(condition)) return 'battery';
    if (/signal/i.test(condition)) return 'signal';
    if (/pin\d+|gpio\d+/i.test(condition)) return 'gpio_condition';
    return condition ? 'condition' : 'schedule';
}

function mapFieldToExpression(field) {
    if (!field) return null;
    if (field === 'battery') return 'battery';
    if (field === 'signal') return 'signal';
    if (field === 'uptime') return 'uptime';
    if (field === 'gps.lat') return '(gps && gps.lat)';
    if (field === 'gps.lng') return '(gps && gps.lng)';
    if (field === 'sms.from') return '(sms && sms.from)';
    if (field === 'sms.body') return '(sms && sms.body)';
    if (/^gpio\.\d+$/.test(field)) return `(gpio && gpio[${field.split('.')[1]}])`;
    if (/^gpio\d+$/.test(field)) return field;
    return null;
}

function buildConditionExpression(fieldExpr, op, value) {
    const normalized = normalizeConditionValue(value);
    const literal = typeof normalized === 'string'
        ? escapeJsString(normalized)
        : JSON.stringify(normalized);

    switch (op) {
    case 'eq':
        return `${fieldExpr} === ${literal}`;
    case 'ne':
        return `${fieldExpr} !== ${literal}`;
    case 'lt':
        return `Number(${fieldExpr} ?? 0) < Number(${literal})`;
    case 'lte':
        return `Number(${fieldExpr} ?? 0) <= Number(${literal})`;
    case 'gt':
        return `Number(${fieldExpr} ?? 0) > Number(${literal})`;
    case 'gte':
        return `Number(${fieldExpr} ?? 0) >= Number(${literal})`;
    case 'between': {
        const [minRaw, maxRaw] = String(value ?? '').split(',').map(part => part.trim());
        const min = JSON.stringify(normalizeConditionValue(minRaw));
        const max = JSON.stringify(normalizeConditionValue(maxRaw));
        return `Number(${fieldExpr} ?? 0) >= Number(${min}) && Number(${fieldExpr} ?? 0) <= Number(${max})`;
    }
    case 'contains':
        return `String(${fieldExpr} ?? '').toLowerCase().includes(String(${literal}).toLowerCase())`;
    case 'starts_with':
        return `String(${fieldExpr} ?? '').toLowerCase().startsWith(String(${literal}).toLowerCase())`;
    case 'regex':
        return `(new RegExp(${literal})).test(String(${fieldExpr} ?? ''))`;
    case 'changed':
        return 'false';
    default:
        return `${fieldExpr} === ${literal}`;
    }
}

function compileAdditionalConditions(conditions = []) {
    const expressions = [];
    for (const condition of conditions) {
        if (!isPlainObject(condition)) continue;
        const fieldExpr = mapFieldToExpression(condition.field);
        if (!fieldExpr) continue;
        expressions.push(`(${buildConditionExpression(fieldExpr, condition.op || 'eq', condition.value)})`);
    }
    return expressions.join(' && ');
}

function buildGeofenceExpression(triggerType, triggerPayload = {}) {
    const lat = Number(triggerPayload.lat);
    const lng = Number(triggerPayload.lng);
    const radius = Math.max(1, Number(triggerPayload.radius || 500));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const baseExpr = `geofence(gps && gps.lat, gps && gps.lng, ${lat}, ${lng}, ${radius})`;
    return triggerType === 'gps_exit' ? `!${baseExpr}` : baseExpr;
}

function buildTriggerDefinition(triggerType, triggerPayload = {}) {
    const payload = isPlainObject(triggerPayload) ? triggerPayload : {};

    switch (triggerType) {
    case 'schedule':
        return {
            condition: '',
            cron_expr: String(payload.cronExpression || '').trim() || null,
            supported: true
        };
    case 'interval': {
        const intervalValue = Math.max(1, coerceNumber(payload.intervalValue, 30));
        const intervalUnit = String(payload.intervalUnit || 'minutes').trim().toLowerCase();
        return {
            condition: '',
            cron_expr: `@every:${intervalValue}:${intervalUnit}`,
            supported: true
        };
    }
    case 'time_of_day': {
        const time = String(payload.time || '').trim();
        const days = Array.isArray(payload.days) ? payload.days.filter(Boolean).join(',') : '';
        return {
            condition: '',
            cron_expr: time ? (days ? `${time}:${days}` : time) : null,
            supported: true
        };
    }
    case 'gpio_condition': {
        const pin = Math.max(0, coerceNumber(payload.pin, 0));
        const state = String(payload.state || 'HIGH').toUpperCase() === 'LOW' ? 0 : 1;
        return {
            condition: `(gpio && gpio[${pin}] !== undefined ? gpio[${pin}] : pin${pin}) === ${state}`,
            cron_expr: null,
            supported: true
        };
    }
    case 'battery':
        return {
            condition: buildConditionExpression('battery', payload.op || 'lt', payload.level ?? 20),
            cron_expr: null,
            supported: true
        };
    case 'signal':
        return {
            condition: buildConditionExpression('signal', payload.op || 'lt', payload.level ?? 20),
            cron_expr: null,
            supported: true
        };
    case 'gps_entry':
    case 'gps_exit':
        return {
            condition: buildGeofenceExpression(triggerType, payload),
            cron_expr: null,
            supported: true
        };
    case 'sms':
    case 'mqtt':
    case 'ai_condition':
        return {
            condition: null,
            cron_expr: null,
            supported: false,
            note: `${triggerType} triggers are not wired into the runtime evaluator yet`
        };
    default:
        return { condition: null, cron_expr: null, supported: false, note: 'Unsupported trigger type' };
    }
}

function buildActionDefinition(actionType, actionPayload = {}) {
    const payload = isPlainObject(actionPayload) ? actionPayload : {};

    switch (actionType) {
    case 'gpio_write':
        return { command: 'gpio-write', pin: coerceNumber(payload.pin), value: String(payload.value || '0') === '1' ? 1 : 0 };
    case 'gpio_pwm':
        return {
            command: 'gpio-pwm',
            pin: coerceNumber(payload.pin),
            duty: coerceNumber(payload.duty, 128),
            freq: coerceNumber(payload.freq, 5000),
            resolution: coerceNumber(payload.resolution, 8)
        };
    case 'led':
        return {
            command: 'led',
            r: coerceNumber(payload.r, 0),
            g: coerceNumber(payload.g, 255),
            b: coerceNumber(payload.b, 0)
        };
    case 'send_sms':
        return { command: 'send-sms', to: String(payload.to || '').trim(), message: String(payload.message || '').trim() };
    case 'send_ussd':
        return { command: 'send-ussd', code: String(payload.code || '').trim() };
    case 'gps_toggle':
        return { command: 'gps-set-enabled', enabled: coerceBoolean(payload.enabled, true) };
    case 'restart':
        return { command: 'restart' };
    case 'ota':
        return { command: 'ota-update', url: String(payload.url || '').trim() };
    case 'webhook':
        return {
            command: 'webhook',
            url: String(payload.url || '').trim(),
            method: String(payload.method || 'POST').trim().toUpperCase(),
            body: payload.body ?? ''
        };
    case 'email':
        return {
            command: 'email',
            to: String(payload.to || '').trim(),
            subject: String(payload.subject || '').trim(),
            body: String(payload.body || '').trim()
        };
    case 'ai_action':
        return { command: 'ai-action', description: String(payload.description || '').trim() };
    default:
        return isPlainObject(actionPayload) ? { ...actionPayload } : {};
    }
}

function normalizeRuleInput(body = {}, existingRule = null) {
    const name = String(body.name ?? existingRule?.name ?? '').trim();
    const enabled = coerceBoolean(body.enabled, existingRule?.enabled ?? true);
    const conditions = Array.isArray(body.conditions)
        ? body.conditions.filter(item => isPlainObject(item) && item.field)
        : Array.isArray(existingRule?.conditions)
            ? existingRule.conditions
            : [];

    const rawAction = body.action !== undefined ? body.action : existingRule?.action;
    const parsedExistingAction = safeParseAction(existingRule?.action);
    let actionObj = safeParseAction(rawAction);

    let triggerType = body.triggerType || parsedExistingAction?.meta?.triggerType || null;
    let triggerPayload = isPlainObject(body.triggerPayload)
        ? body.triggerPayload
        : (parsedExistingAction?.meta?.triggerPayload || {});
    let actionType = body.actionType || parsedExistingAction?.meta?.actionType || null;
    let actionPayload = isPlainObject(body.actionPayload)
        ? body.actionPayload
        : (parsedExistingAction?.meta?.actionPayload || {});

    let condition = body.condition !== undefined
        ? String(body.condition || '').trim()
        : String(existingRule?.condition || '').trim();
    let cron_expr = body.cron_expr !== undefined
        ? (String(body.cron_expr || '').trim() || null)
        : (existingRule?.cron_expr || null);
    let supported = true;
    const notes = [];

    if (triggerType) {
        const triggerDef = buildTriggerDefinition(triggerType, triggerPayload);
        if (triggerDef.condition !== null) condition = triggerDef.condition;
        if (triggerDef.cron_expr !== undefined) cron_expr = triggerDef.cron_expr;
        supported = supported && triggerDef.supported !== false;
        if (triggerDef.note) notes.push(triggerDef.note);
    }

    const extraCondition = compileAdditionalConditions(conditions);
    if (extraCondition) {
        condition = condition ? `(${condition}) && (${extraCondition})` : extraCondition;
    }

    if (actionType) {
        actionObj = buildActionDefinition(actionType, actionPayload);
    } else if (!Object.keys(actionObj).length && isPlainObject(body.actionPayload)) {
        actionObj = { ...body.actionPayload };
    }

    if (body.action !== undefined && !actionType && !Object.keys(actionObj).length && typeof body.action === 'string') {
        actionObj = { command: body.action };
        actionType = inferActionType(actionObj);
        actionPayload = extractActionPayload(actionType, actionObj);
    }

    if (!actionType) {
        actionType = inferActionType(actionObj);
        actionPayload = extractActionPayload(actionType, actionObj);
    }

    if (!Object.keys(actionObj || {}).length) {
        throw new Error('Provide an action');
    }

    if (!isSupportedGpioRuleAction(actionObj)) {
        throw new Error('Unsupported GPIO rule action; active firmware rules may only write GPIO2 with value 0 or 1');
    }

    const referencedPins = [...String(condition || '').matchAll(/\bpin(\d+)\b|\bgpio(?:\s*&&\s*gpio)?\[(\d+)\]/gi)]
        .map(match => Number(match[1] ?? match[2]));
    if (referencedPins.some(pin => !isActiveGpioPin(pin))) {
        throw new Error('Unsupported GPIO rule condition; active firmware exposes GPIO2 only');
    }

    if (!cron_expr && !condition) {
        throw new Error('Provide either a trigger or a condition');
    }

    actionObj.meta = {
        ...(isPlainObject(actionObj.meta) ? actionObj.meta : {}),
        triggerType: triggerType || inferTriggerType({ condition, cron_expr }, {}),
        triggerPayload,
        actionType,
        actionPayload,
        conditions,
        supported,
        notes
    };

    return {
        name,
        condition,
        cron_expr,
        action: actionObj,
        enabled,
        triggerType: actionObj.meta.triggerType,
        actionType,
        triggerPayload,
        actionPayload,
        conditions,
        supported,
        notes
    };
}

function describeRule(rule, deviceId) {
    const actionObj = safeParseAction(rule.action);
    const meta = isPlainObject(actionObj.meta) ? actionObj.meta : {};
    const triggerType = inferTriggerType(rule, meta);
    const actionType = meta.actionType || inferActionType(actionObj);

    return {
        id: rule.id,
        device_id: deviceId,
        name: rule.name,
        condition: rule.condition || '',
        cron_expr: rule.cron_expr || null,
        enabled: rule.enabled !== false,
        trigger_type: triggerType,
        trigger_payload: meta.triggerPayload || {},
        action_type: actionType,
        action_payload: meta.actionPayload || extractActionPayload(actionType, actionObj),
        conditions: Array.isArray(meta.conditions) ? meta.conditions : [],
        action: actionType,
        action_raw: actionObj,
        supported: meta.supported !== false,
        notes: meta.notes || [],
        last_triggered: rule.lastTriggered || null,
        trigger_count: rule.triggerCount || 0,
        created_at: rule.createdAt || null,
        updated_at: rule.updatedAt || null
    };
}

function parseDayOfWeek(value) {
    const normalized = String(value).trim().toUpperCase();
    const map = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
    if (normalized in map) return map[normalized];
    const numeric = Number(normalized);
    if (Number.isInteger(numeric)) return numeric === 7 ? 0 : numeric;
    return null;
}

function matchCronField(field, value, min, max, parser = Number) {
    const normalized = String(field || '*').trim();
    if (!normalized || normalized === '*') return true;

    return normalized.split(',').some(segment => {
        const part = segment.trim();
        if (!part) return false;

        if (part.includes('/')) {
            const [base, stepRaw] = part.split('/');
            const step = Number(stepRaw);
            if (!Number.isFinite(step) || step <= 0) return false;

            if (base === '*' || !base) {
                return (value - min) % step === 0;
            }

            if (base.includes('-')) {
                const [startRaw, endRaw] = base.split('-');
                const start = parser(startRaw);
                const end = parser(endRaw);
                return Number.isFinite(start) && Number.isFinite(end) && value >= start && value <= end && (value - start) % step === 0;
            }

            const start = parser(base);
            return Number.isFinite(start) && value >= start && value <= max && (value - start) % step === 0;
        }

        if (part.includes('-')) {
            const [startRaw, endRaw] = part.split('-');
            const start = parser(startRaw);
            const end = parser(endRaw);
            return Number.isFinite(start) && Number.isFinite(end) && value >= start && value <= end;
        }

        const parsed = parser(part);
        return Number.isFinite(parsed) && parsed === value;
    });
}

function intervalToMs(value, unit) {
    const amount = Math.max(1, Number(value) || 1);
    switch (String(unit || 'minutes').toLowerCase()) {
    case 'seconds':
    case 'second':
        return amount * 1000;
    case 'hours':
    case 'hour':
        return amount * 60 * 60 * 1000;
    case 'days':
    case 'day':
        return amount * 24 * 60 * 60 * 1000;
    case 'minutes':
    case 'minute':
    default:
        return amount * 60 * 1000;
    }
}

function getCronMatchKey(expr, now = new Date()) {
    if (!expr || typeof expr !== 'string') return null;
    const trimmed = expr.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('@every:')) {
        const [, valueRaw, unitRaw] = trimmed.split(':');
        const intervalMs = intervalToMs(valueRaw, unitRaw);
        return `${trimmed}:${Math.floor(now.getTime() / intervalMs)}`;
    }

    if (/^\*\/\d+$/.test(trimmed)) {
        const step = Number(trimmed.slice(2));
        return step > 0 && now.getMinutes() % step === 0
            ? `${trimmed}:${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`
            : null;
    }

    if (/^\d{2}:\d{2}(:.+)?$/.test(trimmed)) {
        const [hhRaw, mmRaw, daysRaw] = trimmed.split(':');
        const hh = Number(hhRaw);
        const mm = Number(mmRaw);
        if (now.getHours() !== hh || now.getMinutes() !== mm) return null;

        if (daysRaw) {
            const allowedDays = daysRaw
                .split(',')
                .map(parseDayOfWeek)
                .filter(day => Number.isInteger(day));
            if (allowedDays.length && !allowedDays.includes(now.getDay())) return null;
        }

        return `${trimmed}:${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    }

    const fields = trimmed.split(/\s+/);
    if (fields.length === 5) {
        const [minuteField, hourField, dayField, monthField, dayOfWeekField] = fields;
        const matches =
            matchCronField(minuteField, now.getMinutes(), 0, 59) &&
            matchCronField(hourField, now.getHours(), 0, 23) &&
            matchCronField(dayField, now.getDate(), 1, 31) &&
            matchCronField(monthField, now.getMonth() + 1, 1, 12) &&
            matchCronField(dayOfWeekField, now.getDay(), 0, 6, parseDayOfWeek);

        return matches
            ? `${trimmed}:${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`
            : null;
    }

    return null;
}

async function executeAutomationAction(deviceId, action, ctx = {}) {
    if (!isPlainObject(action)) {
        throw new Error('Invalid rule action');
    }

    const command = action.command || 'gpio-write';
    const payload = Object.fromEntries(
        Object.entries(action).filter(([key]) => !['command', 'meta'].includes(key))
    );

    if (!isSupportedGpioRuleAction({ command, ...payload })) {
        throw new Error('Unsupported GPIO automation action');
    }

    if (!global.mqttService || !global.mqttService.connected) {
        throw new Error('MQTT not connected');
    }

    const response = await global.mqttService.publishCommand(
        deviceId,
        'gpio-write',
        { pin: 2, value: payload.value ? 1 : 0 },
        true,
        15000,
        { source: 'dashboard-gpio-rule', domain: 'control' }
    );
    const confirmed = normalizeFirmwarePin(gpioActionPayload(response), 2);
    if (!confirmed) throw new Error('Device did not confirm GPIO automation result');
    return confirmed;
}

/**
 * Generic device command proxy
 * POST /api/gpio/command
 */
router.post('/command', [
    body('deviceId').optional(),
    body('command').trim().notEmpty().withMessage('Command is required'),
    body('params').optional().custom(value => value === undefined || isPlainObject(value)).withMessage('params must be an object'),
    body('waitForResponse').optional().isBoolean(),
    body('timeout').optional().isInt({ min: 1000, max: 120000 })
], requireDeviceAccess(undefined, true), async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const command = String(req.body.command || '').trim();
        const params = isPlainObject(req.body.params) ? req.body.params : {};
        const waitForResponse = coerceBoolean(req.body.waitForResponse, false);
        const timeout = coerceNumber(req.body.timeout, 15000);
        const normalizedCommand = command.toLowerCase();
        const allowedCommands = new Set(['gpio-status', 'gpio-write', 'gpio-pulse']);

        if (!allowedCommands.has(normalizedCommand)) {
            return res.status(422).json({
                success: false,
                message: `Command ${command} is not exposed by the active GPIO contract`
            });
        }
        if (normalizedCommand !== 'gpio-status' && params.pin === undefined) {
            return res.status(400).json({ success: false, message: 'GPIO pin is required' });
        }
        if (params.pin !== undefined && !isActiveGpioPin(params.pin)) {
            return res.status(422).json({
                success: false,
                message: `GPIO${params.pin} is not exposed by the active firmware`,
                allowedPins: [...ACTIVE_GPIO_CONTRACT.pins]
            });
        }
        if (normalizedCommand !== 'gpio-status' && params.value !== 0 && params.value !== 1 && params.value !== false && params.value !== true) {
            return res.status(400).json({ success: false, message: 'GPIO value must be 0 or 1' });
        }
        // Build only the supported firmware payload. Arbitrary fields must not
        // override command identity or introduce a second duration interpretation.
        const commandParams = {};
        if (params.pin !== undefined) commandParams.pin = Number(params.pin);
        if (normalizedCommand !== 'gpio-status') commandParams.value = Number(params.value);
        if (normalizedCommand === 'gpio-pulse') {
            if (params.ttl_ms !== undefined && params.duration !== undefined && Number(params.ttl_ms) !== Number(params.duration)) {
                return res.status(400).json({ success: false, message: 'Conflicting GPIO pulse durations' });
            }
            const pulseMs = Number(params.ttl_ms ?? params.duration ?? 0);
            if (!Number.isInteger(pulseMs) || pulseMs < ACTIVE_GPIO_CONTRACT.pulseMinMs || pulseMs > ACTIVE_GPIO_CONTRACT.pulseMaxMs) {
                return res.status(400).json({
                    success: false,
                    message: `GPIO pulse must be ${ACTIVE_GPIO_CONTRACT.pulseMinMs}-${ACTIVE_GPIO_CONTRACT.pulseMaxMs} ms`
                });
            }
            commandParams.ttl_ms = pulseMs;
        }

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({ success: false, message: 'MQTT not connected' });
        }

        if (waitForResponse) {
            const response = await global.mqttService.publishCommand(deviceId, normalizedCommand, commandParams, true, timeout);
            return res.json({
                success: response?.success === true && response?.result === 'completed',
                deviceId,
                command: normalizedCommand,
                data: response
            });
        }

        await global.mqttService.publishCommand(deviceId, normalizedCommand, commandParams, false);
        res.json({
            success: true,
            queued: true,
            deviceId,
            command: normalizedCommand,
            message: 'Command sent to broker'
        });
    } catch (error) {
        logger.error('GPIO generic command error:', error);
        if (/timeout/i.test(error.message || '')) {
            return res.json({
                success: true,
                queued: true,
                pending: true,
                message: 'Command sent, awaiting device acknowledgement'
            });
        }
        res.status(500).json({ success: false, message: 'Failed to send command' });
    }
});

/**
 * List automation rules
 * GET /api/gpio/rules
 */
router.get('/rules', requireDeviceAccess(), async (req, res) => {
    try {
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const rules = pinRules.get(deviceId) || [];
        res.json({
            success: true,
            data: rules.map(rule => describeRule(rule, deviceId))
        });
    } catch (error) {
        logger.error('GPIO rules list error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch rules' });
    }
});

/**
 * Create automation rule
 * POST /api/gpio/rules
 */
router.post('/rules', [
    body('name').notEmpty(),
    body('condition').optional().default(''),
    body('cron_expr').optional().trim(),
    body('action').optional(),
    body('enabled').optional().isBoolean(),
    body('deviceId').optional()
], requireDeviceAccess(undefined, true), async (req, res) => {
    try {
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const normalized = normalizeRuleInput(req.body);

        if (!pinRules.has(deviceId)) {
            pinRules.set(deviceId, []);
        }

        // Persist to DB first to get the integer id
        const db = req.app.locals.db;
        const actionStr = serializeAction(normalized.action);
        let dbId = null;
        if (db) {
            const result = await db.run(
                `INSERT INTO gpio_rules (device_id, name, condition, cron_expr, action, enabled)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [deviceId, normalized.name, normalized.condition || '', normalized.cron_expr || null, actionStr, normalized.enabled ? 1 : 0]
            );
            dbId = result.lastID;
        }

        const rule = {
            id: dbId ? String(dbId) : (Date.now().toString(36) + Math.random().toString(36).substr(2)),
            name: normalized.name,
            condition: normalized.condition || '',
            cron_expr: normalized.cron_expr || null,
            action: actionStr,
            enabled: normalized.enabled,
            createdAt: new Date().toISOString(),
            lastTriggered: null,
            triggerCount: 0
        };

        pinRules.get(deviceId).push(rule);

        logger.info(`GPIO rule created: ${normalized.name} (id=${rule.id})`);

        res.json({
            success: true,
            message: `Rule "${normalized.name}" created`,
            data: describeRule(rule, deviceId)
        });
    } catch (error) {
        logger.error('GPIO rule error:', error);
        res.status(/Provide|Unsupported/i.test(error.message || '') ? 400 : 500).json({
            success: false,
            message: error.message || 'Failed to create rule'
        });
    }
});

/**
 * Update rule
 * PUT /api/gpio/rules/:id
 */
router.put('/rules/:id', requireDeviceAccess(undefined, true), async (req, res) => {
    try {
        const { id } = req.params;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);

        const rules = pinRules.get(deviceId);
        if (!rules) {
            return res.status(404).json({ success: false, message: 'No rules found' });
        }

        const index = rules.findIndex(r => r.id === id);
        if (index === -1) {
            return res.status(404).json({ success: false, message: 'Rule not found' });
        }

        const normalized = normalizeRuleInput(req.body, rules[index]);
        rules[index] = {
            ...rules[index],
            name: normalized.name,
            condition: normalized.condition || '',
            cron_expr: normalized.cron_expr || null,
            action: serializeAction(normalized.action),
            enabled: normalized.enabled,
            updatedAt: new Date().toISOString()
        };

        // Persist to DB
        const db = req.app.locals.db;
        if (db && /^\d+$/.test(id)) {
            const r = rules[index];
            const actionStr = serializeAction(r.action);
            await db.run(
                `UPDATE gpio_rules SET name=?, condition=?, cron_expr=?, action=?, enabled=?
                 WHERE id=?`,
                [r.name, r.condition || '', r.cron_expr || null, actionStr, r.enabled ? 1 : 0, parseInt(id)]
            );
        }

        res.json({ success: true, message: 'Rule updated', data: describeRule(rules[index], deviceId) });
    } catch (error) {
        logger.error('GPIO rule update error:', error);
        res.status(/Provide|Unsupported/i.test(error.message || '') ? 400 : 500).json({
            success: false,
            message: error.message || 'Failed to update rule'
        });
    }
});

/**
 * Toggle rule enabled state
 * PATCH /api/gpio/rules/:id
 */
router.patch('/rules/:id', [
    body('enabled').isBoolean().withMessage('enabled must be boolean')
], requireDeviceAccess(undefined, true), async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const { id } = req.params;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const rules = pinRules.get(deviceId);
        if (!rules) {
            return res.status(404).json({ success: false, message: 'No rules found' });
        }

        const rule = rules.find(item => item.id === id);
        if (!rule) {
            return res.status(404).json({ success: false, message: 'Rule not found' });
        }

        rule.enabled = coerceBoolean(req.body.enabled, rule.enabled);
        rule.updatedAt = new Date().toISOString();

        const db = req.app.locals.db;
        if (db && /^\d+$/.test(id)) {
            await db.run(`UPDATE gpio_rules SET enabled = ? WHERE id = ?`, [rule.enabled ? 1 : 0, parseInt(id)]);
        }

        res.json({ success: true, message: 'Rule updated', data: describeRule(rule, deviceId) });
    } catch (error) {
        logger.error('GPIO rule patch error:', error);
        res.status(500).json({ success: false, message: 'Failed to update rule' });
    }
});

/**
 * Delete rule
 * DELETE /api/gpio/rules/:id
 */
router.delete('/rules/:id', requireDeviceAccess(undefined, true), async (req, res) => {
    try {
        const { id } = req.params;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);

        const rules = pinRules.get(deviceId);
        if (!rules) {
            return res.status(404).json({ success: false, message: 'No rules found' });
        }

        const exists = rules.some(r => r.id === id);
        if (!exists) return res.status(404).json({ success: false, message: 'Rule not found' });

        pinRules.set(deviceId, rules.filter(r => r.id !== id));

        // Remove from DB
        const db = req.app.locals.db;
        if (db && /^\d+$/.test(id)) {
            await db.run(`DELETE FROM gpio_rules WHERE id = ?`, [parseInt(id)]);
        }

        res.json({ success: true, message: 'Rule deleted' });
    } catch (error) {
        logger.error('GPIO rule delete error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete rule' });
    }
});

/**
 * @swagger
 * /gpio/templates:
 *   get:
 *     summary: List flow rule templates
 *     description: Returns pre-built automation rule templates that can be imported into the flow editor.
 *     tags: [Automation]
 *     security:
 *       - apiKey: []
 *     responses:
 *       200:
 *         description: Array of templates
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/FlowTemplate' }
 */
/**
 * Flow templates — pre-built rules ready to import
 * GET /api/gpio/templates
 */
router.get('/templates', (req, res) => {
    const templates = [
        {
            id: 'battery_low_gpio2_high',
            name: 'GPIO2 HIGH if battery < 20%',
            description: 'Drive the implemented diagnostic pin HIGH when live battery telemetry crosses below 20%',
            condition: 'battery !== null && battery < 20',
            action: JSON.stringify({ command: 'gpio-write', pin: 2, value: 1 }),
            tags: ['battery', 'gpio2']
        },
        {
            id: 'battery_ok_gpio2_low',
            name: 'GPIO2 LOW if battery ≥ 80%',
            description: 'Drive the implemented diagnostic pin LOW when live battery telemetry crosses above 80%',
            condition: 'battery !== null && battery >= 80',
            action: JSON.stringify({ command: 'gpio-write', pin: 2, value: 0 }),
            tags: ['battery', 'gpio2']
        }
    ];
    res.json({ success: true, data: templates });
});

/**
 * @swagger
 * /gpio/rules/{id}/history:
 *   get:
 *     summary: Flow execution history for a rule
 *     description: Returns the last 100 times this automation rule was triggered.
 *     tags: [Automation]
 *     security:
 *       - apiKey: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Rule UUID
 *     responses:
 *       200:
 *         description: Execution log entries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/FlowExecutionLog' }
 */
/**
 * Flow execution history for a rule (last 100 entries)
 * GET /api/gpio/rules/:id/history
 */
router.get('/rules/:id/history', requireDeviceAccess(), async (req, res) => {
    try {
        const { id } = req.params;
        const deviceId = req.authorizedDeviceId;
        const db = req.app.locals.db;
        const rows = await db.all(
            `SELECT id, rule_id, device_id, rule_name, condition_values, triggered_at
             FROM flow_execution_log
             WHERE rule_id = ? AND device_id = ?
             ORDER BY triggered_at DESC
             LIMIT 100`,
            [id, deviceId]
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        logger.error('Flow history error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch flow history' });
    }
});

/**
 * Test rule condition
 * POST /api/gpio/rules/test
 */
router.post('/rules/test', [
    body('condition').notEmpty(),
    body('values').isObject()
], requireDeviceAccess(undefined, true), (req, res) => {
    try {
        const { condition, values } = req.body;
        
        // Simple condition evaluator
        const result = evaluateCondition(condition, values);
        
        res.json({
            success: true,
            data: {
                result,
                condition,
                values
            }
        });
    } catch (error) {
        logger.error('GPIO rule test error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to test condition'
        });
    }
});

// ==================== CALCULATIONS ====================

/**
 * Convert analog reading to meaningful values
 * POST /api/gpio/calculate
 */
router.post('/calculate', [
    body('pin').isInt(),
    body('value').isNumeric(),
    body('formula').optional()
], (req, res) => {
    try {
        const { pin, value, formula } = req.body;
        
        const conversions = {
            voltage: (val) => (val / 4095) * 3.3,
            temperature: (val) => ((val / 4095) * 3.3 - 0.5) * 100, // LM35
            light: (val) => 100 - (val / 4095 * 100), // LDR (inverse)
            distance: (val) => 12343.85 * Math.pow(val, -1.15), // Sharp IR
            battery: (val) => (val / 4095) * 3.3 * 2, // Voltage divider
            percentage: (val) => (val / 4095) * 100
        };

        const results = {};
        for (const [key, fn] of Object.entries(conversions)) {
            results[key] = fn(value);
        }

        if (formula) {
            try {
                // Safe eval with available variables
                const context = { val: value, pin, ...results };
                const func = new Function(...Object.keys(context), `return ${formula}`);
                results.custom = func(...Object.values(context));
            } catch (e) {
                results.custom = 'Invalid formula';
            }
        }

        res.json({
            success: true,
            data: {
                raw: value,
                pin,
                ...results
            }
        });
    } catch (error) {
        logger.error('GPIO calculate error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to calculate'
        });
    }
});

// ==================== HELPER FUNCTIONS ====================

function updatePinStates(deviceId, pins) {
    if (!Array.isArray(pins)) return;
    pinObservedAt.set(deviceId, Date.now());
    if (!pinStates.has(deviceId)) {
        pinStates.set(deviceId, {});
    }
    const states = pinStates.get(deviceId);
    
    pins.filter(pin => isActiveGpioPin(pin?.pin)).forEach(pin => {
        states[pin.pin] = pin.value;
        
        // Add to history
        if (!pinHistory.has(deviceId)) {
            pinHistory.set(deviceId, {});
        }
        if (!pinHistory.get(deviceId)[pin.pin]) {
            pinHistory.get(deviceId)[pin.pin] = [];
        }
        pinHistory.get(deviceId)[pin.pin].push({
            timestamp: new Date().toISOString(),
            value: pin.value,
            mode: pin.mode
        });
        // Keep last 100
        if (pinHistory.get(deviceId)[pin.pin].length > 100) {
            pinHistory.get(deviceId)[pin.pin].shift();
        }
    });
}

function getLocalPinStates(deviceId) {
    const states = pinStates.get(deviceId) || {};
    return ACTIVE_GPIO_CONTRACT.pins.map(pin => ({
        pin,
        value: states[pin] === 0 || states[pin] === 1 ? states[pin] : null,
        level: states[pin] === 0 || states[pin] === 1 ? states[pin] : null,
        cached: true,
        observedAt: pinObservedAt.get(deviceId) || null,
        config: pinConfigs.get(deviceId)?.[pin] || { mode: ACTIVE_GPIO_CONTRACT.mode, pull: 'none' },
        capabilities: { ...ACTIVE_GPIO_CONTRACT.capabilities }
    }));
}

function calculateDistanceMeters(lat1, lng1, lat2, lng2) {
    if (![lat1, lng1, lat2, lng2].every(value => Number.isFinite(Number(value)))) return Infinity;
    const toRad = deg => Number(deg) * (Math.PI / 180);
    const earthRadius = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadius * c;
}

function evaluateCondition(condition, values) {
    try {
        const context = {
            ...values,
            Math,
            geofence: (lat, lng, centerLat, centerLng, radiusMeters) =>
                calculateDistanceMeters(lat, lng, centerLat, centerLng) <= Number(radiusMeters || 0)
        };
        const keys = Object.keys(context);
        const values_list = Object.values(context);
        const func = new Function(...keys, `return Boolean(${condition})`);
        return func(...values_list);
    } catch (e) {
        logger.error('Condition evaluation error:', e);
        return false;
    }
}

// ==================== RULE EVALUATION LOOP ====================
// Runs every 1 second. Evaluates each enabled rule against current pin states
// and fires the action via MQTT if the condition is true and the cooldown has passed.

const RULE_COOLDOWN_MS = 5000; // minimum ms between consecutive fires of the same rule

function evaluateRules() {
    if (!global.mqttService || !global.mqttService.connected) return;

    for (const [deviceId, rules] of pinRules) {
        if (!rules || !rules.length) continue;

        const states = pinStates.get(deviceId) || {};
        // Build a context object: pin0, pin1, ..., pin48 → current values
        const liveDevice = global.modemService?.devices instanceof Map
            ? global.modemService.devices.get(deviceId)
            : null;
        const liveStatus = global.modemService?.getStatus?.(deviceId) || {};
        if (liveStatus.online !== true) continue;
        if (!pinObservedAt.has(deviceId) || Date.now() - pinObservedAt.get(deviceId) > GPIO_FRESH_MS) continue;
        const gpio = {};
        const ctxData = {
            gpio,
            battery: liveDevice?.system?.battery ?? liveStatus.battery ?? null,
            signal: liveDevice?.mobile?.signalStrength ?? liveStatus.signal ?? null,
            uptime: coerceNumber(liveDevice?.system?.uptime, 0),
            online: liveStatus.online === true,
            network: liveDevice?.mobile?.networkType || liveStatus.network || null,
            operator: liveDevice?.mobile?.operator || liveStatus.operator || null,
            ip: liveDevice?.mobile?.ipAddress || liveStatus.ip || null,
            temperature: liveDevice?.system?.temperature ?? liveStatus.temperature ?? null,
            imei: liveDevice?.imei ?? liveStatus.imei ?? null,
            gps: {
                lat: liveDevice?.gps?.lat ?? liveDevice?.location?.lat ?? null,
                lng: liveDevice?.gps?.lng ?? liveDevice?.location?.lng ?? null,
                satellites: liveDevice?.gps?.satellites ?? null,
                hdop: liveDevice?.gps?.hdop ?? null
            },
            sms: liveDevice?.lastSms || {}
        };
        for (const [pin, value] of Object.entries(states)) {
            if (!isActiveGpioPin(pin) || (value !== 0 && value !== 1)) continue;
            gpio[pin] = value;
            ctxData[`pin${pin}`] = value;
            ctxData[`gpio${pin}`] = value;
        }

        for (const rule of rules) {
            if (!rule.enabled || rule._inFlight || Number(rule._retryAfter || 0) > Date.now()) continue;

            // Enforce cooldown
            if (rule.lastTriggered) {
                const elapsed = Date.now() - new Date(rule.lastTriggered).getTime();
                if (elapsed < RULE_COOLDOWN_MS) continue;
            }

            let cronMatched = true;
            let conditionMet = true;
            try {
                if (rule.cron_expr) {
                    const matchKey = getCronMatchKey(rule.cron_expr);
                    cronMatched = !!matchKey;
                    if (cronMatched && rule._lastCronMatchKey === matchKey) {
                        cronMatched = false;
                    } else if (cronMatched) {
                        rule._lastCronMatchKey = matchKey;
                    }
                }
                if (cronMatched && rule.condition) {
                    conditionMet = evaluateCondition(rule.condition, ctxData);
                }
            } catch (e) {
                // silently skip bad conditions
                continue;
            }

            if (!rule.cron_expr) {
                const alreadyTrue = rule._lastConditionMet === true;
                rule._lastConditionMet = conditionMet;
                if (alreadyTrue) continue;
            }
            if (!cronMatched || !conditionMet) continue;

            try {
                const action = typeof rule.action === 'string' ? JSON.parse(rule.action) : rule.action;
                const cmd = action.command || 'gpio-write';
                rule._inFlight = true;

                executeAutomationAction(deviceId, action, ctxData)
                    .then(() => {
                        rule.lastTriggered = new Date().toISOString();
                        rule.triggerCount = (rule.triggerCount || 0) + 1;
                        rule._retryAfter = 0;
                        logger.info(`GPIO rule fired: "${rule.name}" (${rule.id}) → ${cmd}`);
                        if (global.io) {
                            const room = global.io.to?.('device:' + deviceId);
                            if (room?.emit) room.emit('gpio:rule-triggered', { deviceId, ruleId: rule.id, ruleName: rule.name });
                            else global.io.emit?.('gpio:rule-triggered', { deviceId, ruleId: rule.id, ruleName: rule.name });
                        }
                        const db = global.app && global.app.locals.db;
                        if (db) {
                            if (/^\d+$/.test(rule.id)) {
                                db.run(
                                    `UPDATE gpio_rules SET trigger_count = ?, last_triggered = ? WHERE id = ?`,
                                    [rule.triggerCount, rule.lastTriggered, parseInt(rule.id)]
                                ).catch(() => {});
                            }
                            db.run(
                                `INSERT INTO flow_execution_log (rule_id, device_id, rule_name, condition_values)
                                 VALUES (?, ?, ?, ?)`,
                                [rule.id, deviceId, rule.name, JSON.stringify(ctxData)]
                            ).then(() => db.run(
                                `DELETE FROM flow_execution_log WHERE rule_id = ? AND id NOT IN (
                                     SELECT id FROM flow_execution_log WHERE rule_id = ?
                                     ORDER BY triggered_at DESC LIMIT 100
                                 )`,
                                [rule.id, rule.id]
                            )).catch(err => logger.warn(`Flow log write failed: ${err.message}`));
                        }
                    })
                    .catch(err => {
                        rule._retryAfter = Date.now() + 30000;
                        logger.warn(`GPIO rule action failed: ${err.message}`);
                    })
                    .finally(() => {
                        rule._inFlight = false;
                    });
            } catch (e) {
                logger.warn(`GPIO rule "${rule.name}" has invalid action:`, e.message);
            }
        }
    }
}

// Start the loop (1-second interval)
const gpioRuleTimer = setInterval(evaluateRules, 1000);
gpioRuleTimer.unref?.();

// ── Pin naming ────────────────────────────────────────────────────────────────

// GET /api/gpio/:deviceId/pin-names
router.get('/:deviceId/pin-names', requireDeviceAccess('deviceId'), async (req, res) => {
    try {
        const rows = await req.app.locals.db.all(
            `SELECT pin, name, color FROM pin_names WHERE device_id = ?`,
            [req.params.deviceId]
        );
        const map = {};
        rows.forEach(r => { map[r.pin] = { name: r.name, color: r.color }; });
        res.json({ success: true, data: map });
    } catch (error) {
        logger.error('GET pin-names error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch pin names' });
    }
});

// PUT /api/gpio/:deviceId/pin-names/:pin
router.put('/:deviceId/pin-names/:pin', [
    param('deviceId').trim().notEmpty().isLength({ max: 64 }),
    param('pin').isInt({ min: 0, max: 48 }),
    body('name').trim().isLength({ min: 1, max: 50 }).withMessage('Name required (max 50 chars)'),
    body('color').optional({ nullable: true }).matches(/^#[0-9a-fA-F]{6}$/).withMessage('Invalid color')
], requireDeviceAccess('deviceId', true), async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

        await req.app.locals.db.run(
            `INSERT INTO pin_names (device_id, pin, name, color, updated_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(device_id, pin) DO UPDATE SET
                 name = excluded.name, color = excluded.color, updated_at = excluded.updated_at`,
            [req.params.deviceId, parseInt(req.params.pin), req.body.name, req.body.color || null]
        );
        res.json({ success: true });
    } catch (error) {
        logger.error('PUT pin-names error:', error);
        res.status(500).json({ success: false, message: 'Failed to save pin name' });
    }
});

// DELETE /api/gpio/:deviceId/pin-names/:pin
router.delete('/:deviceId/pin-names/:pin', [
    param('deviceId').trim().notEmpty().isLength({ max: 64 }),
    param('pin').isInt({ min: 0, max: 48 })
], requireDeviceAccess('deviceId', true), async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });
        await req.app.locals.db.run(
            `DELETE FROM pin_names WHERE device_id = ? AND pin = ?`,
            [req.params.deviceId, parseInt(req.params.pin)]
        );
        res.json({ success: true });
    } catch (error) {
        logger.error('DELETE pin-names error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete pin name' });
    }
});

// POST /api/gpio/led — set NeoPixel colour or toggle LED on/off
// Body: { r, g, b, deviceId? }          → set colour
//    or { enabled, deviceId? }           → enable/disable LED
router.post('/led', [
    body('r').optional().isInt({ min: 0, max: 255 }),
    body('g').optional().isInt({ min: 0, max: 255 }),
    body('b').optional().isInt({ min: 0, max: 255 }),
    body('enabled').optional().isBoolean(),
    body('deviceId').optional()
], requireDeviceAccess(undefined, true), async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0]?.msg || "Validation failed", errors: errors.array() });
        return res.status(501).json({
            success: false,
            message: 'RGB LED control is not implemented by the active firmware contract'
        });
    } catch (error) {
        logger.error('LED command error:', error);
        res.status(500).json({ success: false, message: 'Failed to send LED command' });
    }
});

// ==================== MULTI-DEVICE COMPARE ====================
/**
 * GET /api/gpio/compare?devices=1,esp32-s3-2
 * Returns pin states for multiple devices side-by-side.
 */
router.get('/compare', async (req, res) => {
    try {
        if (typeof req.query.devices !== 'string') {
            return res.status(400).json({ success: false, message: 'Provide ?devices=id1,id2' });
        }
        const deviceList = [...new Set(req.query.devices.split(',').map(d => d.trim()).filter(Boolean))];
        if (!deviceList.length) {
            return res.status(400).json({ success: false, message: 'Provide ?devices=id1,id2' });
        }
        if (deviceList.length > 8) {
            return res.status(400).json({ success: false, message: 'Compare at most 8 devices at a time' });
        }
        // Authorize every requested device before constructing the response so
        // a mixed request cannot reveal which pins belong to another tenant.
        for (const deviceId of deviceList) {
            await authorizeDeviceAccess(req, deviceId, { write: false });
        }
        const result = Object.create(null);
        for (const deviceId of deviceList) {
            const states  = pinStates.get(deviceId) || {};
            const configs = pinConfigs.get(deviceId) || {};
            // Union of all known pins for this device
            const allPins = new Set([...Object.keys(states), ...Object.keys(configs)]);
            result[deviceId] = {};
            for (const pin of allPins) {
                result[deviceId][pin] = {
                    value: states[pin] !== undefined ? states[pin] : null,
                    mode:  configs[pin]?.mode || 'unknown',
                    name:  configs[pin]?.name || null
                };
            }
        }
        // Build union of all pin numbers across devices
        const allPins = [...new Set(Object.values(result).flatMap(d => Object.keys(d)))].sort((a, b) => +a - +b);
        res.json({ success: true, data: { devices: deviceList, pins: allPins, states: result } });
    } catch (err) {
        if (Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 500) {
            return res.status(err.statusCode).json({ success: false, message: err.message });
        }
        logger.error('GPIO compare error:', err);
        res.status(500).json({ success: false, message: 'Compare failed' });
    }
});

module.exports = router;
