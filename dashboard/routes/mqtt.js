const express = require('express');
const router = express.Router();
const mqttService = require('../services/mqttService');
const logger = require('../utils/logger');
const { body, validationResult } = require('express-validator');
const { admin: adminMiddleware } = require('../middleware/auth');
const { queueSmsForDelivery } = require('../services/smsQueue');
const { formatPhoneNumber, isShortCode } = require('../utils/phoneNumber');
const { resolveRequestSimScope } = require('../utils/simScope');
const { validateSmsMessageSize } = require('../utils/smsLimits');

function normalizeSmsRecipients(value) {
    const entries = (Array.isArray(value) ? value : [value])
        .flatMap((item) => String(item || '').split(/[\n,;]+/))
        .map((item) => item.trim())
        .filter(Boolean);
    const seen = new Set();
    const recipients = [];
    const invalid = [];
    entries.forEach((entry) => {
        const formatted = formatPhoneNumber(entry);
        if (!formatted) {
            invalid.push(entry);
            return;
        }
        if (seen.has(formatted)) return;
        seen.add(formatted);
        recipients.push(formatted);
    });
    return { recipients, invalid };
}

// Get MQTT connection status
router.get('/status', (req, res) => {
    try {
        const status = mqttService.getStatus();
        res.json({
            success: true,
            ...status,
            broker: process.env.MQTT_HOST || status.host || 'localhost'
        });
    } catch (error) {
        logger.error('MQTT status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get MQTT status'
        });
    }
});

// Send SMS via MQTT
router.post('/send-sms', [
    body('deviceId').notEmpty().withMessage('Device ID required'),
    body('message').custom(validateSmsMessageSize)
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { deviceId, message } = req.body;
        const simScope = resolveRequestSimScope(req);
        const { recipients, invalid } = normalizeSmsRecipients(req.body.recipients ?? req.body.to);
        if (!recipients.length) {
            return res.status(400).json({ success: false, message: invalid.length ? `Invalid phone number format: ${invalid[0]}` : 'Phone number required' });
        }
        if (invalid.length) {
            return res.status(400).json({ success: false, message: `Invalid phone number format: ${invalid[0]}` });
        }

        const db = req.app.locals.db;
        const actorId = req.user?.id || req.session?.user?.id || null;
        if (!db) {
            throw new Error('Database not available');
        }
        const deviceRow = await db.get('SELECT id FROM devices WHERE id = ?', [deviceId]);
        if (!deviceRow) {
            return res.status(400).json({
                success: false,
                message: 'Device not registered'
            });
        }
        const batchId = recipients.length > 1 ? `sms_batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : null;
        const results = [];
        for (const to of recipients) {
            const queued = await queueSmsForDelivery({
                db,
                mqttService,
                deviceId,
                to,
                message,
                simSlot: simScope.simSlot,
                userId: actorId,
                source: 'mqtt-api',
                batchId
            });
            results.push(queued);
        }

        if (results.length === 1) {
            const queued = results[0];
            return res.json({
                success: true,
                queued: true,
                message: 'SMS queued for delivery',
                id: queued.id,
                to: queued.to,
                queueId: queued.queueId,
                messageId: queued.messageId,
                status: queued.status,
                simSlot: queued.simSlot
            });
        }

        res.json({
            success: true,
            queued: true,
            multiRecipient: true,
            batchId,
            count: results.length,
            recipients,
            results,
            simSlot: simScope.simSlot,
            message: `${results.length} SMS queued for delivery`
        });
    } catch (error) {
        logger.error('MQTT send SMS error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send SMS command'
        });
    }
});

// Make call via MQTT
router.post('/make-call', [
    body('deviceId').notEmpty(),
    body('number').notEmpty()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { deviceId, number } = req.body;
        const simScope = resolveRequestSimScope(req);
        
        if (!mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }
        
        const result = await mqttService.makeCall(deviceId, number, {
            simSlot: simScope.simSlot,
            source: 'dashboard:mqtt-api',
            domain: 'telephony'
        });

        // Save to database
        try {
            const db = req.app.locals.db;
            if (db) {
                await db.run(`
                    INSERT INTO calls (phone_number, type, status, device_id, start_time, sim_slot)
                    VALUES (?, 'outgoing', 'dialing', ?, CURRENT_TIMESTAMP, ?)
                `, [number, deviceId, simScope.simSlot]);
            }
        } catch (dbError) {
            logger.error('Failed to save call to database:', dbError);
        }

        res.json({
            success: true,
            message: 'Call command dispatched',
            queued: Boolean(result?.queued),
            queueId: result?.queueId || null,
            messageId: result?.messageId || null
        });
    } catch (error) {
        logger.error('MQTT make call error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send call command'
        });
    }
});

// Send USSD via MQTT
router.post('/send-ussd', [
    body('deviceId').notEmpty(),
    body('code').notEmpty()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { deviceId, code } = req.body;
        const simScope = resolveRequestSimScope(req);
        
        if (!mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }
        
        const result = await mqttService.sendUssd(deviceId, code, {
            simSlot: simScope.simSlot,
            source: 'dashboard:mqtt-api',
            domain: 'telephony'
        });

        // Save to database
        try {
            const db = req.app.locals.db;
            if (db) {
                await db.run(`
                    INSERT INTO ussd (code, status, device_id, timestamp, sim_slot)
                    VALUES (?, 'pending', ?, CURRENT_TIMESTAMP, ?)
                `, [code, deviceId, simScope.simSlot]);
            }
        } catch (dbError) {
            logger.error('Failed to save USSD to database:', dbError);
        }

        res.json({
            success: true,
            message: 'USSD command dispatched',
            queued: Boolean(result?.queued),
            queueId: result?.queueId || null,
            ussdId: result?.messageId || null
        });
    } catch (error) {
        logger.error('MQTT send USSD error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send USSD command'
        });
    }
});

// Request device status
router.post('/request-status/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        
        if (!mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }
        
        const result = await mqttService.requestStatus(deviceId);
        
        if (result.success) {
            res.json({
                success: true,
                message: 'Status request sent'
            });
        } else {
            res.status(500).json({
                success: false,
                message: result.error || 'Failed to request status'
            });
        }
    } catch (error) {
        logger.error('MQTT status request error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to request status'
        });
    }
});

// Capture image
router.post('/capture/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        
        if (!mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }
        
        const result = await mqttService.publishCommand(deviceId, 'capture', {}, true, 15000);
        
        if (result.success) {
            res.json({
                success: true,
                message: 'Capture command sent',
                captureId: result.messageId
            });
        } else {
            res.status(500).json({
                success: false,
                message: result.error || 'Failed to send capture command'
            });
        }
    } catch (error) {
        logger.error('MQTT capture error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send capture command'
        });
    }
});

router.post('/test', adminMiddleware, [
    body('host').notEmpty().withMessage('Host is required'),
    body('port').isInt({ min: 1, max: 65535 }).withMessage('Valid port required'),
    body('username').optional(),
    body('password').optional(),
    body('clientId').optional()
], (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { host, port, username, password, clientId } = req.body;
        
        logger.info('Testing MQTT connection to:', { host, port, username });
        
        // Create temporary client for testing
        const mqtt = require('mqtt');
        const connectOptions = {
            host: host,
            port: parseInt(port),
            protocol: 'mqtt',
            connectTimeout: 10000,
            reconnectPeriod: -1, // Don't auto reconnect
            clientId: clientId || process.env.MQTT_CLIENT_ID || `test_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`,
            clean: true,
            rejectUnauthorized: false
        };

        // Only add auth if username is provided
        if (username) {
            connectOptions.username = username;
            const effectivePassword = password || process.env.MQTT_PASSWORD;
            if (effectivePassword) {
                connectOptions.password = effectivePassword;
            }
        }

        const testClient = mqtt.connect(`mqtt://${host}:${port}`, connectOptions);
        let responded = false;

        function finish(result) {
            if (responded) return;
            responded = true;
            clearTimeout(timeout);
            testClient.end(true, () => {}); // force-close, ignore end errors
            res.json(result);
        }

        const timeout = setTimeout(() => {
            finish({
                success: false,
                message: 'Connection timeout - broker not responding'
            });
        }, 10000);

        testClient.on('connect', () => {
            logger.info('MQTT test connection successful');
            finish({ success: true, message: 'MQTT connection successful' });
        });

        testClient.on('error', (error) => {
            logger.error('MQTT test connection error:', error.message);

            let errorMessage = error.message;
            if (error.message.includes('not authorized')) {
                errorMessage = 'Authentication failed - check username and password';
            } else if (error.message.includes('ECONNREFUSED')) {
                errorMessage = 'Connection refused - broker may be down or port blocked';
            } else if (error.message.includes('ETIMEDOUT')) {
                errorMessage = 'Connection timeout - check network connectivity';
            }

            finish({ success: false, message: errorMessage });
        });

    } catch (error) {
        logger.error('MQTT test error:', error);
        res.status(500).json({
            success: false,
            message: 'MQTT test failed'
        });
    }
});

module.exports = router;
