'use strict';

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const http = require('http');
const crypto = require('crypto');
const QRCode = require('qrcode');
const logger = require('../utils/logger');
const { encodeProvisioningToken } = require('../utils/provisioningToken');
const { setupApIp, setupApLabel, setupApExampleLabel, bleNamePrefixes } = require('../config/onboarding');
const { getWifiDisconnectReasonText } = require('../utils/wifiDisconnectReason');
const DEFAULT_MQTT_PORT = 1883;
const DEFAULT_TOPIC_PREFIX = normalizeTopicPrefix(process.env.MQTT_TOPIC_PREFIX || 'device');

function buildSetupApErrorMessage(errorMessage) {
    return errorMessage === 'timeout'
        ? `Device did not respond - is your computer connected to the ${setupApExampleLabel} WiFi network?`
        : `Could not reach device at ${setupApIp}. Connect to the device setup WiFi first.`;
}

function clean(value) {
    return String(value || '').trim();
}

function normalizeTopicPrefix(value) {
    return clean(value)
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\/+/g, '/') || 'device';
}

function normalizeServerUrl(value) {
    return clean(value).replace(/\/+$/, '');
}

function normalizePublicBaseUrl(req) {
    const configured = normalizeServerUrl(process.env.PUBLIC_BASE_URL || '');
    if (configured) return configured;
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
    return normalizeServerUrl(`${protocol}://${req.get('host')}`);
}

function normalizeMacToken(value) {
    const token = clean(value).replace(/[^a-fA-F0-9]/g, '').toLowerCase();
    return token.length === 12 ? token : '';
}

function normalizeHardwareUid(value) {
    return normalizeMacToken(value);
}

function buildEspDeviceIdFromMac(value) {
    const mac = normalizeMacToken(value);
    return mac ? `ws-a7670e-${mac.slice(-6)}` : '';
}

function parseCapabilities(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function resolveEspHardwareUid(body = {}) {
    const capabilities = parseCapabilities(body.capabilities);
    return normalizeHardwareUid(
        body.hardware_uid ||
        body.hardwareUid ||
        body.mac ||
        body.wifi_mac ||
        body.wifiMac ||
        body.base_mac ||
        body.baseMac ||
        capabilities.hardware_uid ||
        capabilities.hardwareUid ||
        capabilities.mac ||
        capabilities.wifi_mac ||
        capabilities.wifiMac ||
        capabilities.base_mac ||
        capabilities.baseMac
    );
}

async function findExistingEspHardwareUid(db, hardwareUid, proposedDeviceId) {
    const normalizedUid = normalizeHardwareUid(hardwareUid);
    const proposedId = clean(proposedDeviceId);
    if (!db || !normalizedUid) return null;

    const derivedDeviceId = buildEspDeviceIdFromMac(normalizedUid);
    if (derivedDeviceId && derivedDeviceId !== proposedId) {
        const derived = await db.get('SELECT id FROM devices WHERE id = ?', [derivedDeviceId]);
        if (derived?.id) return derived;
    }

    try {
        const row = await db.get(
            `SELECT d.id
             FROM device_profiles dp
             JOIN devices d ON d.id = dp.device_id
             WHERE dp.hardware_uid = ?
               AND dp.device_id <> ?
             LIMIT 1`,
            [normalizedUid, proposedId]
        );
        if (row?.id) return row;
    } catch (_) {
        // Older databases may not have hardware_uid until migrations run.
    }

    try {
        const row = await db.get(
            `SELECT d.id
             FROM device_profiles dp
             JOIN devices d ON d.id = dp.device_id
             WHERE lower(replace(replace(replace(COALESCE(dp.hardware_uid, ''), ':', ''), '-', ''), '.', '')) = ?
               AND dp.device_id <> ?
             LIMIT 1`,
            [normalizedUid, proposedId]
        );
        if (row?.id) return row;
    } catch (_) {
        // Keep capability fallback below as the final compatibility path.
    }

    try {
        const rows = await db.all(
            `SELECT dp.device_id AS id, dp.capabilities
             FROM device_profiles dp
             JOIN devices d ON d.id = dp.device_id
             WHERE dp.device_id <> ?
               AND dp.capabilities IS NOT NULL`,
            [proposedId]
        );
        return (rows || []).find((row) => resolveEspHardwareUid({ capabilities: row.capabilities }) === normalizedUid) || null;
    } catch (_) {
        return null;
    }
}

function generateApiKey() {
    return `edk_${crypto.randomBytes(32).toString('hex')}`;
}

function hashApiKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

function selectedMqttHost(value) {
    return clean(value || process.env.MQTT_HOST || '');
}

function selectedMqttPort(value) {
    const parsed = parseInt(value, 10);
    return parsed > 0 ? parsed : (parseInt(process.env.MQTT_PORT, 10) || DEFAULT_MQTT_PORT);
}

function selectedMqttProtocol() {
    return clean(process.env.MQTT_PROTOCOL || 'mqtt').toLowerCase() === 'mqtts' ? 'mqtts' : 'mqtt';
}

function selectedAndroidTransportMode(value) {
    const mode = clean(value).toLowerCase();
    if (mode === 'mqtt' || mode === 'http') return mode;
    return 'auto';
}

function isAndroidBridge(body) {
    return clean(body.bridge_type) === 'android' || clean(body.model) === 'android-sms-bridge';
}

async function buildAndroidProvisioning(req, db, userId, body) {
    const transportMode = 'auto';
    const serverUrl = normalizePublicBaseUrl(req);
    let apiKey = '';
    let apiKeyName = '';

    if (userId) {
        apiKeyName = clean(body.name || body.device_id || 'Android Bridge');
        apiKey = generateApiKey();
        const keyPrefix = apiKey.substring(0, 12);
        await db.run(
            `INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, device_ids, expires_at, rate_limit_rpm)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
            [userId, apiKeyName, hashApiKey(apiKey), keyPrefix, 'write', JSON.stringify([clean(body.device_id)]), 120]
        );
    }

    const payload = {
        schema: 'iot.android-bridge.v1',
        generated_at: new Date().toISOString(),
        transport: {
            mode: transportMode
        },
        server_url: serverUrl,
        api_key: apiKey,
        device: {
            id: clean(body.device_id),
            name: clean(body.name),
            topic_prefix: normalizeTopicPrefix(body.topic_prefix || DEFAULT_TOPIC_PREFIX)
        },
        mqtt: {
            host: selectedMqttHost(body.mqtt_host),
            port: selectedMqttPort(body.mqtt_port),
            protocol: selectedMqttProtocol(),
            username: clean(body.mqtt_user || process.env.MQTT_USER || ''),
            password: String(body.mqtt_pass ?? process.env.MQTT_PASSWORD ?? '')
        }
    };
    const setupToken = encodeProvisioningToken(payload);

    return {
        type: 'android',
        setup_token: setupToken,
        qr_data_url: await QRCode.toDataURL(setupToken, {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 320
        }),
        summary: {
            transport_mode: 'auto',
            device_id: payload.device.id,
            topic_prefix: payload.device.topic_prefix,
            server_url: serverUrl,
            mqtt_configured: Boolean(payload.mqtt.host),
            api_key_name: apiKeyName
        }
    };
}

function buildMqttUri(host, port) {
    const trimmedHost = String(host || '').trim();
    const parsedPort = parseInt(port, 10) || DEFAULT_MQTT_PORT;

    if (!trimmedHost) {
        return '';
    }
    if (/^[a-z]+:\/\//i.test(trimmedHost)) {
        return trimmedHost;
    }
    return `mqtt://${trimmedHost}:${parsedPort}`;
}

function buildFirmwareSetupPayload(body) {
    const payload = {};
    const mqttUri = buildMqttUri(body.mqtt_host || process.env.MQTT_HOST || '', body.mqtt_port || process.env.MQTT_PORT);

    if (body.device_id) {
        payload.device_id_override = body.device_id;
    }
    payload.wifi_ssid = body.wifi_ssid || '';
    payload.wifi_password = body.wifi_pass || '';
    payload.mqtt_uri = mqttUri;
    payload.mqtt_username = body.mqtt_user || '';
    payload.mqtt_password = body.mqtt_pass || '';

    return payload;
}

function normalizeSetupApProbe(result) {
    const body = result?.body;

    if (result?.status >= 200 && result?.status < 300 && body && typeof body === 'object' && body.meta && body.config) {
        const hardwareUid = body.meta.hardware_uid || body.meta.hardwareUid || body.meta.mac || body.meta.wifi_mac || '';
        const deviceId = body.meta.device_id || buildEspDeviceIdFromMac(hardwareUid);
        return {
            success: true,
            reachable: true,
            protocol: 'api-config',
            device: {
                device_id: deviceId,
                hardware_uid: hardwareUid,
                hotspot_ssid: body.meta.hotspot_ssid || '',
                hotspot_ip: body.meta.hotspot_ip || setupApIp,
                provisioning_active: !!body.meta.provisioning_active,
                rescue_portal_active: !!body.meta.rescue_portal_active,
                activation_reason: body.meta.activation_reason || '',
                wifi_configured: !!body.meta.wifi_configured,
                wifi_connected: !!body.meta.wifi_connected,
                wifi_disconnect_reason: Number(body.meta.wifi_disconnect_reason || 0),
                wifi_disconnect_reason_text: getWifiDisconnectReasonText(
                    Number(body.meta.wifi_disconnect_reason || 0),
                    body.meta.wifi_disconnect_reason_text
                ),
                wifi_seen_ssid: body.meta.wifi_seen_ssid || '',
                wifi_ip: body.meta.wifi_ip || '',
                config: body.config,
                runtime: body.runtime || {}
            }
        };
    }

    return {
        success: true,
        reachable: true,
        protocol: 'legacy-status',
        device: body
    };
}

// Probes or sends config to the device setup AP server-side, bypassing browser CORS restrictions.
function wifiRequest(method, path, payload, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const requestBody = payload ? JSON.stringify(payload) : null;
        const options = {
            hostname: setupApIp,
            port: 80,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(requestBody ? { 'Content-Length': Buffer.byteLength(requestBody) } : {})
            },
            timeout: timeoutMs
        };

        const req = http.request(options, (response) => {
            let data = '';
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => {
                try {
                    resolve({ status: response.statusCode, body: JSON.parse(data) });
                } catch {
                    resolve({ status: response.statusCode, body: data });
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        req.on('error', reject);

        if (requestBody) {
            req.write(requestBody);
        }
        req.end();
    });
}

router.get('/api/onboard/wifi-probe', async (_req, res) => {
    try {
        let result = null;

        try {
            result = await wifiRequest('GET', '/api/config', null, 5000);
        } catch (_) {
            result = await wifiRequest('GET', '/status', null, 5000);
        }

        res.json(normalizeSetupApProbe(result));
    } catch (err) {
        res.json({ success: true, reachable: false, reason: err.message });
    }
});

router.post('/api/onboard/wifi-send', [
    body('device_id').trim().notEmpty().matches(/^[a-zA-Z0-9_-]+$/),
    body('apn').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('mqtt_host').optional({ nullable: true }).trim().isLength({ max: 200 }),
    body('mqtt_port').optional().isInt({ min: 1, max: 65535 }),
    body('mqtt_user').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('mqtt_pass').optional({ nullable: true }).isLength({ max: 200 }),
    body('wifi_ssid').optional({ nullable: true }).trim().isLength({ max: 64 }),
    body('wifi_pass').optional({ nullable: true }).isLength({ max: 64 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const payload = {
            device_id: req.body.device_id,
            mqtt_host: req.body.mqtt_host || process.env.MQTT_HOST || '',
            mqtt_port: parseInt(req.body.mqtt_port, 10) || parseInt(process.env.MQTT_PORT, 10) || DEFAULT_MQTT_PORT,
            mqtt_user: req.body.mqtt_user || '',
            mqtt_pass: req.body.mqtt_pass || '',
            apn: req.body.apn || '',
            wifi_ssid: req.body.wifi_ssid || '',
            wifi_pass: req.body.wifi_pass || ''
        };

        let result = null;
        let reboot = null;

        try {
            result = await wifiRequest('POST', '/api/config', buildFirmwareSetupPayload(payload), 10000);
            if (result.status >= 200 && result.status < 300 && result.body?.restart_required) {
                reboot = await wifiRequest('POST', '/api/reboot', {}, 5000);
            }
        } catch (error) {
            logger.debug(`Current setup AP API failed, trying legacy path: ${error.message}`);
            result = await wifiRequest('POST', '/configure', payload, 10000);
        }

        if (result.status >= 200 && result.status < 300) {
            logger.info(`Onboarding WiFi config sent to setup AP for device ${payload.device_id}`);
            return res.json({
                success: true,
                response: result.body,
                reboot: reboot?.body || null
            });
        }

        res.status(502).json({ success: false, message: `Device returned HTTP ${result.status}` });
    } catch (err) {
        res.status(504).json({ success: false, message: buildSetupApErrorMessage(err.message) });
    }
});

router.get('/onboard', (req, res) => {
    try {
        res.render('pages/onboarding', {
            title: 'Device Onboarding',
            layout: 'layouts/main',
            showHeader: false,
            showSidebar: false,
            showStatusChrome: false,
            user: req.session.user,
            setupApIp,
            setupApLabel,
            setupApExampleLabel,
            bleNamePrefixes,
            mqttHost: process.env.MQTT_HOST || '',
            mqttPort: parseInt(process.env.MQTT_PORT, 10) || DEFAULT_MQTT_PORT,
            mqttUser: process.env.MQTT_USER || '',
            mqttPassword: process.env.MQTT_PASSWORD || '',
            mqttTopicPrefix: DEFAULT_TOPIC_PREFIX
        });
    } catch (error) {
        logger.error('Onboarding page error:', error);
        req.flash('error', 'Failed to load onboarding page');
        res.redirect('/devices');
    }
});

router.get('/api/onboard/check-id/:device_id', [
    param('device_id')
        .trim()
        .notEmpty().withMessage('Device ID required')
        .matches(/^[a-zA-Z0-9_-]+$/).withMessage('Device ID may only contain letters, numbers, hyphens and underscores')
        .isLength({ max: 64 }).withMessage('Device ID too long')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const db = req.app.locals.db;
        const row = await db.get('SELECT id FROM devices WHERE id = ?', [req.params.device_id]);
        res.json({ success: true, exists: !!row });
    } catch (error) {
        logger.error('GET /api/onboard/check-id error:', error);
        res.status(500).json({ success: false, message: 'Failed to check device ID' });
    }
});

router.get('/api/onboard/check-hardware/:hardware_uid', [
    param('hardware_uid')
        .trim()
        .notEmpty().withMessage('Hardware UID required')
        .isLength({ max: 64 }).withMessage('Hardware UID too long')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const hardwareUid = normalizeHardwareUid(req.params.hardware_uid);
        if (!hardwareUid) {
            return res.status(400).json({ success: false, message: 'Hardware UID must be a 12-digit MAC token' });
        }

        const db = req.app.locals.db;
        const existing = await findExistingEspHardwareUid(db, hardwareUid, req.query.device_id || '');
        res.json({
            success: true,
            exists: Boolean(existing),
            device_id: existing?.id || null
        });
    } catch (error) {
        logger.error('GET /api/onboard/check-hardware error:', error);
        res.status(500).json({ success: false, message: 'Failed to check hardware UID' });
    }
});

router.post('/api/onboard/register', [
    body('device_id')
        .trim()
        .notEmpty().withMessage('Device ID required')
        .matches(/^[a-zA-Z0-9_-]+$/).withMessage('Device ID may only contain letters, numbers, hyphens and underscores')
        .isLength({ max: 64 }).withMessage('Device ID too long'),
    body('name')
        .trim()
        .notEmpty().withMessage('Device name required')
        .isLength({ max: 100 }).withMessage('Name too long'),
    body('location')
        .optional({ nullable: true })
        .trim()
        .isLength({ max: 200 }).withMessage('Location too long'),
    body('model')
        .optional({ nullable: true })
        .trim()
        .isLength({ max: 100 }).withMessage('Model too long'),
    body('apn')
        .optional({ nullable: true })
        .trim()
        .isLength({ max: 100 }).withMessage('APN too long'),
    body('mqtt_user')
        .optional({ nullable: true })
        .trim()
        .isLength({ max: 100 }).withMessage('MQTT username too long'),
    body('mqtt_port')
        .optional({ nullable: true })
        .isInt({ min: 1, max: 65535 }).withMessage('MQTT port must be 1-65535'),
    body('mqtt_host')
        .optional({ nullable: true })
        .trim()
        .isLength({ max: 200 }).withMessage('MQTT host too long'),
    body('mqtt_pass')
        .optional({ nullable: true })
        .isLength({ max: 200 }).withMessage('MQTT password too long'),
    body('wifi_ssid')
        .optional({ nullable: true })
        .trim()
        .isLength({ max: 64 }).withMessage('WiFi SSID too long'),
    body('wifi_pass')
        .optional({ nullable: true })
        .isLength({ max: 64 }).withMessage('WiFi password too long'),
    body('hardware_uid')
        .optional({ nullable: true })
        .trim()
        .isLength({ max: 64 }).withMessage('Hardware UID too long'),
    body('transport_mode')
        .optional({ nullable: true })
        .trim()
        .isIn(['mqtt', 'http', 'auto']).withMessage('Android connection mode must be auto'),
    body('capabilities')
        .optional({ nullable: true })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const {
            device_id,
            name,
            location,
            model,
            bridge_type,
            hardware_uid,
            apn,
            mqtt_host,
            mqtt_port,
            mqtt_user,
            mqtt_pass,
            transport_mode,
            wifi_ssid,
            wifi_pass,
            capabilities
        } = req.body;
        const db = req.app.locals.db;
        const existing = await db.get('SELECT id FROM devices WHERE id = ?', [device_id]);
        if (existing) {
            return res.status(409).json({
                success: false,
                message: 'This device is already onboarded. Delete it first or use the existing device record.'
            });
        }

        const espHardwareUid = isAndroidBridge(req.body) ? '' : resolveEspHardwareUid({ ...req.body, hardware_uid });
        const existingHardware = await findExistingEspHardwareUid(db, espHardwareUid, device_id);
        if (existingHardware) {
            return res.status(409).json({
                success: false,
                message: `This ESP32 is already onboarded as ${existingHardware.id}. Use the existing device record instead of creating a duplicate.`
            });
        }

        await db.run(
            `INSERT INTO devices (id, name, type, status, created_at)
             VALUES (?, ?, ?, 'offline', CURRENT_TIMESTAMP)`,
            [device_id, name, model || 'esp32']
        );

        const capJson = capabilities
            ? (typeof capabilities === 'string' ? capabilities : JSON.stringify(capabilities))
            : null;

        await db.run(
            `INSERT INTO device_profiles (device_id, location, apn, mqtt_host, mqtt_user, mqtt_pass, wifi_ssid, wifi_pass, capabilities, board, hardware_uid, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(device_id) DO UPDATE SET
                 location = excluded.location,
                 apn = excluded.apn,
                 mqtt_host = excluded.mqtt_host,
                 mqtt_user = excluded.mqtt_user,
                 mqtt_pass = excluded.mqtt_pass,
                 wifi_ssid = excluded.wifi_ssid,
                 wifi_pass = excluded.wifi_pass,
                 capabilities = excluded.capabilities,
                 board = excluded.board,
                 hardware_uid = excluded.hardware_uid,
                 updated_at = excluded.updated_at`,
            [device_id, location || null, apn || null, mqtt_host || null, mqtt_user || null, mqtt_pass || null, wifi_ssid || null, wifi_pass || null, capJson, model || null, espHardwareUid || null]
        );

        if (req.session?.user?.id) {
            await db.run(
                'INSERT OR IGNORE INTO device_users (device_id, user_id, can_write) VALUES (?, ?, 1)',
                [device_id, req.session.user.id]
            );
        }

        if (req.session) {
            req.session.deviceId = device_id;
            req.session.save?.(() => {});
        }

        const bodyForProvisioning = {
            device_id,
            name,
            model,
            bridge_type,
            mqtt_host,
            mqtt_port,
            mqtt_user,
            mqtt_pass,
            transport_mode
        };
        const provisioning = isAndroidBridge(bodyForProvisioning)
            ? await buildAndroidProvisioning(req, db, req.session?.user?.id || req.user?.id || null, bodyForProvisioning)
            : null;

        logger.info(`Device registered via onboarding wizard: ${device_id} (${name})`);
        res.json({ success: true, device_id, provisioning });
    } catch (error) {
        logger.error('POST /api/onboard/register error:', error);
        res.status(500).json({ success: false, message: 'Failed to register device' });
    }
});

module.exports = router;
