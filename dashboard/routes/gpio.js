const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { resolveDeviceId } = require('../utils/deviceResolver');

// GPIO Pin Configuration Store
let pinConfigs = new Map(); // deviceId -> { pin: config }
let pinStates = new Map(); // deviceId -> { pin: value }
let pinHistory = new Map(); // deviceId -> { pin: [{timestamp, value}] }
let pinGroups = new Map(); // deviceId -> { groupName: [pins] }
let pinRules = new Map(); // deviceId -> [{id, condition, action, enabled}]

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

function buildGpioCommandOptions(command, options = {}) {
    const normalized = String(command || '').trim().toLowerCase();
    const merged = {
        source: 'dashboard-gpio',
        ...options
    };

    if (!merged.domain) {
        if (normalized === 'gpio-status' || normalized === 'gpio-read') {
            merged.domain = 'status';
        } else if (normalized.startsWith('gpio-')) {
            merged.domain = 'control';
        }
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
            buildGpioCommandOptions(command, options)
        );
        return await eventPromise;
    } catch (error) {
        eventPromise.catch(() => {});
        throw error;
    }
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
            if (!pinConfigs.has(device_id)) pinConfigs.set(device_id, {});
            if (!pinStates.has(device_id))  pinStates.set(device_id, {});
            pinConfigs.get(device_id)[pin] = { name, mode, pull, frequency };
            pinStates.get(device_id)[pin]  = value || 0;
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
                    enabled: enabled === 1 || enabled === true,
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

// Waveshare ESP32-S3-A7670E-4G Pin Mapping
// Schematic: ESP32-S3-A-SIM7670X-4G V2.0
// Reserved/fixed-function pins must not be configured as GPIO outputs.
const RESERVED_PINS = new Set([6, 7, 8, 9, 10, 11,  // Internal SPI flash / board-reserved — DO NOT USE
    17, 18,   // A7670E UART via TXB0104PWR — DO NOT USE
    19, 20,   // USB D−/D+ — DO NOT USE
    26, 27, 28, 29, 30, 31, 32, // Internal flash/PSRAM — DO NOT USE
    38,       // WS2812B RGB LED data
    40,       // Legacy board-reserved pin
    43,       // UART0 TX (USB serial console)
    44,       // UART0 RX (USB serial console)
    45        // Legacy board-reserved pin
]);

// Active reservation map for the current V2 firmware/device profile.
const ACTIVE_RESERVED_PINS = new Set([6, 7, 8, 9,
    10, 11, 12, 13,
    15, 16,
    17, 18,
    19, 20,
    21,
    26, 27, 28, 29, 30, 31, 32,
    38,
    40, 43, 44, 45
]);

const ESP32_S3_PINS = {
    // Digital pins — GPIO0–48 (ESP32-S3; gaps at 22–25 which do not exist)
    digital: Array.from({ length: 49 }, (_, i) => ({
        pin: i,
        name: `GPIO${i}`,
        capabilities: {
            digital: true,
            // Board-exposed ADC path currently available on GPIO39 (BAT_ADC).
            analog: [39].includes(i),
            // LEDC PWM: any GPIO except flash/PSRAM (6–11, 26–32) and non-existent (22–25)
            pwm: ![6, 7, 8, 9, 10, 11, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32].includes(i),
            // Capacitive touch: GPIO1–14
            touch: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].includes(i)
            // Note: ESP32-S3 has NO hardware DAC (unlike classic ESP32)
        },
        reserved: ACTIVE_RESERVED_PINS.has(i),
        defaultMode: 'input',
        pullup: i !== 0,
        pulldown: i !== 0,
        voltage: 3.3,
        maxCurrent: 40 // mA
    })).filter(p => ![22, 23, 24, 25].includes(p.pin)), // GPIO22–25 do not exist on ESP32-S3

    // Special/reserved pins for this specific board
    special: [
        { pin: 0, name: 'GPIO0', note: 'Boot strapping pin — avoid driving low at boot' },
        { pin: 6, name: 'GPIO6', note: 'Internal Flash (SPI) — DO NOT USE' },
        { pin: 7, name: 'GPIO7', note: 'Internal Flash (SPI) — DO NOT USE' },
        { pin: 8, name: 'GPIO8', note: 'Internal Flash (SPI) — DO NOT USE' },
        { pin: 9, name: 'GPIO9', note: 'Internal Flash (SPI) — DO NOT USE' },
        { pin: 10, name: 'GPIO10', note: 'MicroSD SPI CS in current firmware — do not use as generic GPIO' },
        { pin: 11, name: 'GPIO11', note: 'MicroSD SPI MOSI in current firmware — do not use as generic GPIO' },
        { pin: 12, name: 'GPIO12', note: 'MicroSD SPI CLK in current firmware — do not use as generic GPIO' },
        { pin: 13, name: 'GPIO13', note: 'MicroSD SPI MISO in current firmware — do not use as generic GPIO' },
        { pin: 15, name: 'GPIO15', note: 'MAX17048 battery gauge SDA — do not use as generic GPIO' },
        { pin: 16, name: 'GPIO16', note: 'MAX17048 battery gauge SCL — do not use as generic GPIO' },
        { pin: 17, name: 'GPIO17', note: 'A7670E UART RX via TXB0104PWR — do not use as generic GPIO' },
        { pin: 18, name: 'GPIO18', note: 'A7670E UART TX via TXB0104PWR — do not use as generic GPIO' },
        { pin: 19, name: 'GPIO19', note: 'USB D− — DO NOT USE' },
        { pin: 20, name: 'GPIO20', note: 'USB D+ — DO NOT USE' },
        { pin: 21, name: 'GPIO21', note: 'A7670E level-shifter enable — do not use as generic GPIO' },
        { pin: 39, name: 'GPIO39', note: 'BAT_ADC / analog input; keep read-only unless board wiring is confirmed otherwise' },
        { pin: 38, name: 'GPIO38', note: 'WS2812B RGB LED data — send LED commands via MQTT' },
        { pin: 40, name: 'GPIO40', note: 'Legacy V1 board modem/UART path — keep reserved' },
        { pin: 43, name: 'GPIO43', note: 'UART0 TX — USB serial console output' },
        { pin: 44, name: 'GPIO44', note: 'UART0 RX — USB serial console input' },
        { pin: 45, name: 'GPIO45', note: 'Legacy V1 board modem/UART path — keep reserved' }
    ]
};

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
router.get('/status', async (req, res) => {
    const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
    const messageId = `gpio-status_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    try {
        if (!global.mqttService || !global.mqttService.connected) {
            return res.json({
                success: true,
                data: {
                    pins: getLocalPinStates(deviceId),
                    groups: Array.from(pinGroups.get(deviceId) || []),
                    rules: Array.from(pinRules.get(deviceId) || []),
                    online: false
                }
            });
        }

        const response = await runQueuedDeviceOperation(deviceId, () =>
            publishAndWaitForMqttEvent(
                deviceId,
                'gpio:status',
                'gpio-status',
                {},
                12000,
                data => data?.messageId === messageId && Array.isArray(data?.pins),
                { skipQueue: true, messageId }
            )
        );

        if (response && Array.isArray(response.pins)) {
            // Update local cache
            updatePinStates(deviceId, response.pins);
            
            res.json({
                success: true,
                data: {
                    pins: response.pins,
                    groups: Array.from(pinGroups.get(deviceId) || []),
                    rules: Array.from(pinRules.get(deviceId) || []),
                    online: true
                }
            });
        } else {
            res.json({
                success: true,
                data: {
                    pins: getLocalPinStates(deviceId),
                    groups: Array.from(pinGroups.get(deviceId) || []),
                    rules: Array.from(pinRules.get(deviceId) || []),
                    online: false
                }
            });
        }
    } catch (error) {
        logger.error('GPIO status error:', error);
        res.json({
            success: true,
            data: {
                pins: getLocalPinStates(deviceId),
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
router.get('/pin/:pin', (req, res) => {
    try {
        const pin = parseInt(req.params.pin);
        if (isNaN(pin) || pin < 0 || pin > 48) {
            return res.status(400).json({ success: false, message: 'Invalid pin number' });
        }
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        
        const config = pinConfigs.get(deviceId)?.[pin] || {
            mode: 'input',
            pull: 'none',
            value: 0,
            analog: 0,
            pwm: 0,
            frequency: 1000,
            lastChange: null
        };

        const capabilities = ESP32_S3_PINS.digital.find(p => p.pin === pin)?.capabilities || {
            digital: true,
            analog: false,
            pwm: false,
            touch: false,
            dac: false
        };

        res.json({
            success: true,
            data: {
                pin,
                config,
                capabilities,
                currentValue: pinStates.get(deviceId)?.[pin] || 0,
                history: pinHistory.get(deviceId)?.[pin]?.slice(-10) || []
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
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { pin, mode, pull } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        // Save to local config
        if (!pinConfigs.has(deviceId)) {
            pinConfigs.set(deviceId, {});
        }
        const deviceConfig = pinConfigs.get(deviceId);
        deviceConfig[pin] = { ...deviceConfig[pin], mode, pull, updatedAt: new Date().toISOString() };
        pinConfigs.set(deviceId, deviceConfig);
        saveGpioToDB(deviceId);

        const response = await global.mqttService.publishCommand(
            deviceId,
            'gpio-mode',
            { pin, mode, pull },
            true,
            5000
        );

        if (response && response.success) {
            logger.info(`GPIO pin ${pin} mode set to ${mode}`);
            res.json({
                success: true,
                message: `Pin ${pin} configured as ${mode}`,
                data: { pin, mode, pull }
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to configure pin'
            });
        }
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
    body('value').custom(value => {
        if (typeof value === 'boolean') return true;
        if (typeof value === 'number') return value >= 0 && value <= 255;
        return false;
    }),
    body('type').optional().isIn(['digital', 'pwm', 'dac']),
    body('duration').optional().isInt({ min: 0, max: 3600000 }), // ms
    body('deviceId').optional()
], async (req, res) => {
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

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const command = {
            pin,
            value: type === 'digital' ? (value ? 1 : 0) : value,
            type
        };

        if (duration) {
            command.duration = duration;
        }

        const response = await global.mqttService.publishCommand(deviceId, 'gpio-write', command, true, 10000);

        if (response && response.success) {
            // Update local state
            if (!pinStates.has(deviceId)) {
                pinStates.set(deviceId, {});
            }
            pinStates.get(deviceId)[pin] = command.value;
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
                value: command.value,
                type
            });
            // Keep last 100 values
            if (pinHistory.get(deviceId)[pin].length > 100) {
                pinHistory.get(deviceId)[pin].shift();
            }

            logger.info(`GPIO pin ${pin} written with value ${value} (${type})`);
            
            // If duration set, schedule auto-reset
            if (duration) {
                setTimeout(async () => {
                    try {
                        await global.mqttService.publishCommand(
                            deviceId,
                            'gpio-write',
                            { pin, value: 0, type: 'digital' }
                        );
                        pinStates.get(deviceId)[pin] = 0;
                        saveGpioToDB(deviceId);
                        logger.info(`GPIO pin ${pin} auto-reset after ${duration}ms`);
                    } catch (err) {
                        logger.error('Auto-reset failed:', err);
                    }
                }, duration);
            }

            res.json({
                success: true,
                message: `Pin ${pin} set to ${value}`,
                data: { pin, value, type, duration }
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
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0]?.msg || "Validation failed", errors: errors.array() });
        }

        const { pin, duty, frequency = 1000 } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);

        if (ACTIVE_RESERVED_PINS.has(pin)) {
            return res.status(400).json({ success: false, message: `Pin ${pin} is reserved and cannot be used` });
        }

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({ success: false, message: 'MQTT not connected' });
        }

        const commandPayload = { pin, duty, freq: frequency, frequency };
        let response;
        try {
            response = await global.mqttService.publishCommand(
                deviceId,
                'gpio-pwm',
                commandPayload,
                true,
                3000
            );
        } catch (error) {
            if (!/timeout/i.test(error.message || '')) throw error;

            // PWM writes are idempotent for the same payload, so a single retry
            // smooths over the occasional back-to-back command race seen live.
            await new Promise(resolve => setTimeout(resolve, 250));
            response = await global.mqttService.publishCommand(
                deviceId,
                'gpio-pwm',
                commandPayload,
                true,
                5000
            );
        }

        if (response && response.success) {
            if (!pinStates.has(deviceId)) pinStates.set(deviceId, {});
            pinStates.get(deviceId)[pin] = duty;
            saveGpioToDB(deviceId);
            res.json({ success: true, message: `PWM on pin ${pin}: duty=${duty}, freq=${frequency}Hz`, data: { pin, duty, frequency } });
        } else {
            res.status(500).json({ success: false, message: response?.message || 'Failed to set PWM' });
        }
    } catch (error) {
        logger.error('GPIO PWM error:', error);
        res.status(500).json({ success: false, message: 'Failed to set PWM' });
    }
});

/**
 * Read from pin
 * GET /api/gpio/read/:pin?deviceId=1
 */
router.get('/read/:pin', async (req, res) => {
    const pin = parseInt(req.params.pin);

    try {
        if (isNaN(pin) || pin < 0 || pin > 48) {
            return res.status(400).json({ success: false, message: 'Invalid pin number' });
        }
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const type = req.query.type || 'digital'; // digital, analog

        if (!global.mqttService || !global.mqttService.connected) {
            const cached = pinStates.get(deviceId)?.[pin] || 0;
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
            publishAndWaitForMqttEvent(
                deviceId,
                'gpio:read',
                'gpio-read',
                { pin, type },
                12000,
                data => Number(data?.pin) === pin,
                { skipQueue: true }
            )
        );

        if (response && response.value !== undefined) {
            // Update cache
            if (!pinStates.has(deviceId)) {
                pinStates.set(deviceId, {});
            }
            pinStates.get(deviceId)[pin] = response.value;
            saveGpioToDB(deviceId);

            res.json({
                success: true,
                data: {
                    pin,
                    value: response.value,
                    type,
                    raw: response.raw,
                    voltage: response.voltage,
                    timestamp: response.timestamp
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
        const cached = pinStates.get(deviceId)?.[pin] || 0;
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
    body('pins').isArray(),
    body('deviceId').optional()
], (req, res) => {
    try {
        const { name, pins } = req.body;
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);

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
], async (req, res) => {
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

        const results = [];
        for (const pin of group.pins) {
            if (values[pin] !== undefined) {
                try {
                    await global.mqttService.publishCommand(
                        deviceId,
                        'gpio-write',
                        { pin, value: values[pin] }
                    );
                    results.push({ pin, success: true, value: values[pin] });
                } catch (err) {
                    logger.warn(`gpio group write failed for pin ${pin}:`, err.message);
                    results.push({ pin, success: false, error: 'Write failed' });
                }
            }
        }

        res.json({
            success: true,
            message: `Group "${name}" updated`,
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

    if (command === 'webhook') {
        if (!payload.url) throw new Error('Missing webhook URL');
        const method = String(payload.method || 'POST').toUpperCase();
        const requestInit = {
            method,
            headers: { 'Content-Type': 'application/json' }
        };

        if (!['GET', 'HEAD'].includes(method)) {
            requestInit.body = typeof payload.body === 'string' && payload.body
                ? payload.body
                : JSON.stringify({ deviceId, context: ctx });
        }

        const response = await fetch(payload.url, requestInit);
        if (!response.ok) throw new Error(`Webhook responded ${response.status}`);
        return { mode: 'webhook', status: response.status };
    }

    if (command === 'email') {
        throw new Error('Email automation is not configured yet');
    }

    if (!global.mqttService || !global.mqttService.connected) {
        throw new Error('MQTT not connected');
    }

    return global.mqttService.publishCommand(deviceId, command, payload, false);
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
], async (req, res) => {
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

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({ success: false, message: 'MQTT not connected' });
        }

        if (waitForResponse) {
            const response = await global.mqttService.publishCommand(deviceId, command, params, true, timeout);
            return res.json({
                success: response?.success !== false,
                deviceId,
                command,
                data: response
            });
        }

        await global.mqttService.publishCommand(deviceId, command, params, false);
        res.json({
            success: true,
            queued: true,
            deviceId,
            command,
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
router.get('/rules', async (req, res) => {
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
], async (req, res) => {
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
router.put('/rules/:id', async (req, res) => {
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
], async (req, res) => {
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
router.delete('/rules/:id', async (req, res) => {
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
 *       - sessionCookie: []
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
            id: 'battery_low_alert',
            name: 'Alert if battery < 20%',
            description: 'Turn the LED red when battery level drops below 20%',
            condition: 'battery < 20',
            action: JSON.stringify({ command: 'led', r: 255, g: 0, b: 0 }),
            tags: ['battery', 'alert', 'led']
        },
        {
            id: 'battery_ok',
            name: 'LED green when battery ≥ 80%',
            description: 'Turn the LED green when battery is fully charged',
            condition: 'battery >= 80',
            action: JSON.stringify({ command: 'led', r: 0, g: 255, b: 0 }),
            tags: ['battery', 'led']
        },
        {
            id: 'no_signal_led',
            name: 'Turn LED red on no signal',
            description: 'Turn the LED red when cellular signal strength drops to 0%',
            condition: 'signal <= 0',
            action: JSON.stringify({ command: 'led', r: 255, g: 0, b: 0 }),
            tags: ['signal', 'alert', 'led']
        },
        {
            id: 'weak_signal_led',
            name: 'LED amber on weak signal',
            description: 'Turn the LED amber when signal is below 20%',
            condition: 'signal > 0 && signal < 20',
            action: JSON.stringify({ command: 'led', r: 255, g: 140, b: 0 }),
            tags: ['signal', 'alert', 'led']
        },
        {
            id: 'gpio_high_on_pin',
            name: 'Set output pin HIGH when input goes HIGH',
            description: 'Mirror an input pin to an output pin',
            condition: 'pin33 === 1',
            action: JSON.stringify({ command: 'gpio-set', pin: 4, value: 1 }),
            tags: ['gpio', 'mirror']
        },
        {
            id: 'gpio_low_on_pin',
            name: 'Set output pin LOW when input goes LOW',
            description: 'Mirror an input LOW state to an output pin',
            condition: 'pin33 === 0',
            action: JSON.stringify({ command: 'gpio-set', pin: 4, value: 0 }),
            tags: ['gpio', 'mirror']
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
 *       - sessionCookie: []
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
router.get('/rules/:id/history', async (req, res) => {
    try {
        const { id } = req.params;
        const db = req.app.locals.db;
        const rows = await db.all(
            `SELECT id, rule_id, device_id, rule_name, condition_values, triggered_at
             FROM flow_execution_log
             WHERE rule_id = ?
             ORDER BY triggered_at DESC
             LIMIT 100`,
            [id]
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
], (req, res) => {
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
    if (!pinStates.has(deviceId)) {
        pinStates.set(deviceId, {});
    }
    const states = pinStates.get(deviceId);
    
    pins.forEach(pin => {
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
    return Object.entries(states).map(([pin, value]) => ({
        pin: parseInt(pin),
        value,
        config: pinConfigs.get(deviceId)?.[pin] || { mode: 'input' }
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

// ==================== CRON EXPRESSION MATCHER ====================
// Match a simple cron expression against the current local time.
// Format: "HH:MM"  or  "HH:MM:DOW" where DOW is comma-separated day abbreviations
// e.g.  "08:30"  — every day at 08:30
//       "08:30:Mon,Wed,Fri" — Mon/Wed/Fri at 08:30
//       "*\/5"  — every 5 minutes (minute divisible by 5, use star-slash in expr string)
// Returns true once per minute (checked every second; cooldown prevents multiple fires).
function matchCronExpr(expr) {
    if (!expr || typeof expr !== 'string') return false;
    const now = new Date();
    const hh = now.getHours();
    const mm = now.getMinutes();
    const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][now.getDay()];

    const parts = expr.trim().split(':');
    // "*/N" — every N minutes
    if (parts[0].startsWith('*/')) {
        const n = parseInt(parts[0].slice(2));
        return !isNaN(n) && n > 0 && mm % n === 0;
    }
    // "HH:MM" or "HH:MM:DOW,..."
    const exprHH = parseInt(parts[0]);
    const exprMM = parseInt(parts[1]);
    if (isNaN(exprHH) || isNaN(exprMM)) return false;
    if (exprHH !== hh || exprMM !== mm) return false;
    if (parts[2]) {
        const days = parts[2].toUpperCase().split(',').map(d => d.trim().slice(0, 3));
        return days.includes(dow.toUpperCase());
    }
    return true;
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
            gpio[pin] = value;
            ctxData[`pin${pin}`] = value;
            ctxData[`gpio${pin}`] = value;
        }

        for (const rule of rules) {
            if (!rule.enabled) continue;

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

            if (!cronMatched || !conditionMet) continue;

            // Fire action
            rule.lastTriggered = new Date().toISOString();
            rule.triggerCount = (rule.triggerCount || 0) + 1;

            try {
                const action = typeof rule.action === 'string' ? JSON.parse(rule.action) : rule.action;
                const cmd = action.command || 'gpio-write';
                const payload = action.command === 'led'
                    ? { r: action.r, g: action.g, b: action.b }
                    : { pin: action.pin, value: action.value };

                executeAutomationAction(deviceId, action, ctxData)
                    .then(() => {
                        logger.info(`GPIO rule fired: "${rule.name}" (${rule.id}) → ${cmd}`);
                        if (global.io) {
                            const room = global.io.to?.('device:' + deviceId);
                            if (room?.emit) room.emit('gpio:rule-triggered', { deviceId, ruleId: rule.id, ruleName: rule.name });
                            else global.io.emit?.('gpio:rule-triggered', { deviceId, ruleId: rule.id, ruleName: rule.name });
                        }
                    })
                    .catch(err => logger.warn(`GPIO rule action failed: ${err.message}`));

                // Persist to execution log + update trigger stats (fire-and-forget)
                const db = global.app && global.app.locals.db;
                if (db) {
                    // Update trigger stats in gpio_rules table (only for DB-backed rules)
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
router.get('/:deviceId/pin-names', async (req, res) => {
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
], async (req, res) => {
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
], async (req, res) => {
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
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0]?.msg || "Validation failed", errors: errors.array() });

        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({ success: false, message: 'MQTT not connected' });
        }

        let payload;
        if (req.body.enabled !== undefined) {
            payload = { enabled: req.body.enabled === true || req.body.enabled === 'true' };
        } else {
            payload = {
                r: req.body.r ?? 0,
                g: req.body.g ?? 0,
                b: req.body.b ?? 0
            };
        }

        const response = await global.mqttService.publishCommand(deviceId, 'led', payload, false);
        if (response && response.success === false) {
            return res.json({ success: false, message: response.message || 'Command failed' });
        }
        res.json({ success: true });
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
router.get('/compare', (req, res) => {
    try {
        const deviceList = (req.query.devices || '').split(',').map(d => d.trim()).filter(Boolean);
        if (!deviceList.length) {
            return res.status(400).json({ success: false, message: 'Provide ?devices=id1,id2' });
        }
        const result = {};
        for (const deviceId of deviceList.slice(0, 8)) { // cap at 8 devices
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
        logger.error('GPIO compare error:', err);
        res.status(500).json({ success: false, message: 'Compare failed' });
    }
});

module.exports = router;
