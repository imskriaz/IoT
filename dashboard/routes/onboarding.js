'use strict';

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const logger = require('../utils/logger');
const { encodeProvisioningToken } = require('../utils/provisioningToken');
const { createDeviceProvisioningApiKey } = require('../utils/apiKeyProvisioning');
const { resolvePublicBaseUrl } = require('../utils/publicBaseUrl');
const { setupApIp, setupApLabel, setupApExampleLabel, bleNamePrefixes } = require('../config/onboarding');
const { getWifiDisconnectReasonText } = require('../utils/wifiDisconnectReason');
const { validateDeviceIdPrefix } = require('../utils/deviceIdPolicy');
const DEFAULT_MQTT_PORT = 1883;
const DEFAULT_TOPIC_PREFIX = normalizeTopicPrefix(process.env.MQTT_TOPIC_PREFIX || 'device');
const ANDROID_APP_VARIANTS = Object.freeze([
    { abi: 'arm64-v8a', label: 'Android app', hint: 'Most phones' },
    { abi: 'armeabi-v7a', label: 'Android app 32-bit', hint: 'Older phones' },
    { abi: 'x86_64', label: 'Android app x86_64', hint: 'Emulators' }
]);
const ANDROID_APP_ABIS = new Set(ANDROID_APP_VARIANTS.map(item => item.abi));

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

function generateSmsEncryptionKey() {
    return `enc_${crypto.randomBytes(24).toString('hex')}`;
}

function normalizePublicBaseUrl(req) {
    return normalizeServerUrl(resolvePublicBaseUrl(req));
}

function selectedMqttHost() {
    return clean(process.env.MQTT_HOST || '');
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

function resolveAndroidApkPath(abi = 'arm64-v8a') {
    const normalizedAbi = ANDROID_APP_ABIS.has(clean(abi)) ? clean(abi) : 'arm64-v8a';
    const apkRoot = path.resolve(__dirname, '..', '..', 'firmware', 'android', 'app', 'build', 'outputs', 'apk');
    const candidates = [
        {
            buildType: 'release',
            filename: `app-${normalizedAbi}-release.apk`,
            apkPath: path.join(apkRoot, 'release', `app-${normalizedAbi}-release.apk`)
        },
        {
            buildType: 'debug',
            filename: `app-${normalizedAbi}-debug.apk`,
            apkPath: path.join(apkRoot, 'debug', `app-${normalizedAbi}-debug.apk`)
        }
    ];
    const selected = candidates.find(candidate => fs.existsSync(candidate.apkPath)) || candidates[0];
    return { abi: normalizedAbi, ...selected, available: fs.existsSync(selected.apkPath) };
}

function buildAndroidAppDownloadOptions() {
    return ANDROID_APP_VARIANTS.map(item => {
        const resolved = resolveAndroidApkPath(item.abi);
        return {
            ...item,
            available: resolved.available,
            buildType: resolved.available ? resolved.buildType : null,
            url: `/api/onboard/android-app/download?abi=${encodeURIComponent(item.abi)}`
        };
    });
}

function isAndroidBridge(body) {
    return clean(body.bridge_type) === 'android' || clean(body.model) === 'android-sms-bridge';
}

function isHttpSmsBridge(body) {
    const bridgeType = clean(body.bridge_type).toLowerCase();
    const model = clean(body.model).toLowerCase();
    return bridgeType === 'httpsms' || model === 'httpsms-bridge';
}

async function buildAndroidProvisioning(req, db, userId, body) {
    const transportMode = 'auto';
    const serverUrl = normalizePublicBaseUrl(req);
    const encryptionKey = clean(body.encryption_key) || generateSmsEncryptionKey();
    let apiKey = '';
    let apiKeyName = '';

    if (userId) {
        apiKeyName = clean(body.name || body.device_id || 'Android Bridge');
        const provisionedKey = await createDeviceProvisioningApiKey(db, {
            userId,
            name: apiKeyName,
            deviceId: clean(body.device_id),
            scopes: 'write',
            rateLimitRpm: 120
        });
        apiKey = provisionedKey.key;
    }

    const payload = {
        schema: 'iot.android-bridge.v1',
        generated_at: new Date().toISOString(),
        transport: {
            mode: transportMode
        },
        server_url: serverUrl,
        api_key: apiKey,
        sms: {
            encryption_key: encryptionKey,
            encrypt_received: false
        },
        device: {
            id: clean(body.device_id),
            name: clean(body.name),
            topic_prefix: normalizeTopicPrefix(body.topic_prefix || DEFAULT_TOPIC_PREFIX)
        },
        mqtt: {
            host: selectedMqttHost(),
            port: selectedMqttPort(process.env.MQTT_PORT),
            protocol: selectedMqttProtocol(),
            username: clean(process.env.MQTT_USER || ''),
            password: String(process.env.MQTT_PASSWORD ?? '')
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
            encryption_key: encryptionKey,
            mqtt_configured: Boolean(payload.mqtt.host),
            api_key_name: apiKeyName
        }
    };
}

async function buildHttpSmsProvisioning(req, db, userId, body) {
    const serverUrl = normalizePublicBaseUrl(req);
    const encryptionKey = clean(body.encryption_key) || generateSmsEncryptionKey();
    let apiKey = '';
    let apiKeyName = '';

    if (userId) {
        apiKeyName = clean(body.name || body.device_id || 'httpSMS');
        const provisionedKey = await createDeviceProvisioningApiKey(db, {
            userId,
            name: apiKeyName,
            deviceId: clean(body.device_id),
            scopes: 'write',
            rateLimitRpm: 120,
            apiKeyPrefix: 'pk_'
        });
        apiKey = provisionedKey.key;
    }

    return {
        type: 'httpsms',
        qr_data_url: apiKey ? await QRCode.toDataURL(apiKey, {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 320
        }) : '',
        setup: {
            base_url: serverUrl,
            api_base_url: `${serverUrl}/v1`,
            api_key: apiKey,
            encryption_key: encryptionKey,
            device_id: clean(body.device_id)
        },
        summary: {
            transport_mode: 'http',
            device_id: clean(body.device_id),
            server_url: serverUrl,
            api_base_url: `${serverUrl}/v1`,
            encryption_key: encryptionKey,
            api_key_name: apiKeyName,
            requires_https: true,
            server_url_https: serverUrl.toLowerCase().startsWith('https://')
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
    const mqttUri = buildMqttUri(process.env.MQTT_HOST || '', process.env.MQTT_PORT);

    if (body.device_id) {
        payload.device_id_override = body.device_id;
    }
    payload.wifi_ssid = body.wifi_ssid || '';
    payload.wifi_password = body.wifi_pass || '';
    payload.mqtt_uri = mqttUri;
    payload.mqtt_username = process.env.MQTT_USER || '';
    payload.mqtt_password = process.env.MQTT_PASSWORD || '';

    return payload;
}

function normalizeSetupApProbe(result) {
    const body = result?.body;

    if (result?.status >= 200 && result?.status < 300 && body && typeof body === 'object' && body.meta && body.config) {
        return {
            success: true,
            reachable: true,
            protocol: 'api-config',
            device: {
                device_id: body.meta.device_id || '',
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

router.get('/api/onboard/android-app/download', (req, res) => {
    try {
        const { abi, apkPath, buildType, available } = resolveAndroidApkPath(req.query.abi);
        if (!available) {
            return res.status(404).json({
                success: false,
                message: `Android app APK for ${abi} is not built yet`
            });
        }

        res.download(apkPath, `device-bridge-${abi}-${buildType}.apk`);
    } catch (error) {
        logger.error('Android app download error:', error);
        res.status(500).json({ success: false, message: 'Failed to download Android app' });
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
            mqtt_host: process.env.MQTT_HOST || '',
            mqtt_port: parseInt(process.env.MQTT_PORT, 10) || DEFAULT_MQTT_PORT,
            mqtt_user: process.env.MQTT_USER || '',
            mqtt_pass: process.env.MQTT_PASSWORD || '',
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
            title: 'Add Device',
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
            mqttTopicPrefix: DEFAULT_TOPIC_PREFIX,
            androidAppDownloads: buildAndroidAppDownloadOptions()
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
            apn,
            wifi_ssid,
            wifi_pass,
            capabilities
        } = req.body;
        const prefixError = validateDeviceIdPrefix(device_id, req.body);
        if (prefixError) {
            return res.status(400).json({ success: false, message: prefixError });
        }

        const db = req.app.locals.db;
        const dashboardMqttHost = selectedMqttHost();
        const dashboardMqttPort = selectedMqttPort(process.env.MQTT_PORT);
        const dashboardMqttUser = clean(process.env.MQTT_USER || '');
        const dashboardMqttPass = String(process.env.MQTT_PASSWORD ?? '');

        await db.run(
            `INSERT INTO devices (id, name, type, status, created_at)
             VALUES (?, ?, ?, 'offline', CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 type = COALESCE(excluded.type, type)`,
            [device_id, name, model || 'esp32']
        );

        const capJson = capabilities
            ? (typeof capabilities === 'string' ? capabilities : JSON.stringify(capabilities))
            : null;

        await db.run(
            `INSERT INTO device_profiles (device_id, location, apn, mqtt_host, mqtt_user, mqtt_pass, wifi_ssid, wifi_pass, capabilities, board, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
                 updated_at = excluded.updated_at`,
            [device_id, location || null, apn || null, dashboardMqttHost || null, dashboardMqttUser || null, dashboardMqttPass || null, wifi_ssid || null, wifi_pass || null, capJson, model || null]
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
            mqtt_host: dashboardMqttHost,
            mqtt_port: dashboardMqttPort,
            mqtt_user: dashboardMqttUser,
            mqtt_pass: dashboardMqttPass,
            transport_mode: 'auto'
        };
        const userId = req.session?.user?.id || req.user?.id || null;
        const provisioning = isAndroidBridge(bodyForProvisioning)
            ? await buildAndroidProvisioning(req, db, userId, bodyForProvisioning)
            : (isHttpSmsBridge(bodyForProvisioning)
                ? await buildHttpSmsProvisioning(req, db, userId, bodyForProvisioning)
                : null);

        logger.info(`Device registered via onboarding wizard: ${device_id} (${name})`);
        res.json({ success: true, device_id, provisioning });
    } catch (error) {
        logger.error('POST /api/onboard/register error:', error);
        res.status(500).json({ success: false, message: 'Failed to register device' });
    }
});

module.exports = router;
