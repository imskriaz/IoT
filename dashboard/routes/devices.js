'use strict';
const express = require('express');
const router = express.Router();
const http = require('http');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { body, validationResult } = require('express-validator');
const logger = require('../utils/logger');
const { hasRole, requireDeviceAccess, withEffectiveRole } = require('../middleware/auth');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { resolveDeviceId } = require('../utils/deviceResolver');
const { buildDeviceSpecs } = require('../utils/deviceSpecsCatalog');
const { parseCapabilities } = require('../utils/deviceCapabilities');
const { buildDashboardDeviceStatus } = require('../utils/dashboardStatus');
const { getDeviceModuleHealth } = require('../utils/moduleHealth');
const { encodeProvisioningToken } = require('../utils/provisioningToken');
const packageService = require('../services/packageService');
const paymentGatewayService = require('../services/paymentGatewayService');
const hostHotspotService = require('../services/hostHotspotService');
const { readStoredSimRows, applyStoredSimFallback } = require('../services/storedSimService');
const { normalizeSsid, readHostScanSummary } = require('../utils/hostWifiDiagnostics');
const { setupApIp } = require('../config/onboarding');

const DEFAULT_MQTT_PORT = 1883;
const DEFAULT_TOPIC_PREFIX = normalizeTopicPrefix(process.env.MQTT_TOPIC_PREFIX || 'device');
const PACKAGE_PAYMENT_METHOD = 'bKash';
const PACKAGE_PAYMENT_NUMBER = '01628301525';
const DEVICE_PACKAGE_OFFERS = Object.freeze([
    {
        code: 'starter',
        name: 'Starter',
        priceBdt: 499,
        limits: {
            sms_per_day: 250,
            sms_per_month: 5000,
            api_requests_per_minute: 30,
            assigned_users: 2
        }
    },
    {
        code: 'growth',
        name: 'Growth',
        priceBdt: 999,
        limits: {
            sms_per_day: 1000,
            sms_per_month: 25000,
            api_requests_per_minute: 90,
            assigned_users: 5
        }
    },
    {
        code: 'business',
        name: 'Business',
        priceBdt: 1999,
        limits: {
            sms_per_day: 5000,
            sms_per_month: 100000,
            api_requests_per_minute: 240,
            assigned_users: 20
        }
    }
]);

function normalizeDeviceId(value) {
    return String(value || '').trim();
}

function normalizeTopicPrefix(value) {
    return String(value || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\/+/g, '/') || 'device';
}

function normalizeDeviceTypeToken(value) {
    return String(value || '').trim().toLowerCase();
}

function isAndroidDeviceId(value) {
    return /^android(?:[-_]|$)/i.test(String(value || '').trim());
}

function inferDeviceListType(row = {}, live = {}, caps = {}) {
    const deviceIdTokens = [row.id, row.device_id].map(normalizeDeviceTypeToken).filter(Boolean);
    if (deviceIdTokens.some(isAndroidDeviceId)) {
        return 'android';
    }

    const tokens = [
        live?.platform,
        live?.device?.platform,
        live?.device?.bridge,
        caps.bridge,
        caps.bridge_type,
        caps.platform,
        caps.board,
        row.board,
        row.type
    ].map(normalizeDeviceTypeToken).filter(Boolean);

    const firmwareHints = [
        live?.activePath,
        live?.active_path,
        live?.wifi?.ssid,
        live?.wifi_ssid,
        live?.modem_operator,
        live?.modem_network_type,
        live?.mqtt?.connected,
        live?.mqtt_connected,
        live?.task_count,
        live?.storage_total_bytes
    ].map(value => String(value ?? '').trim().toLowerCase()).filter(Boolean);

    if (tokens.some(token => token.includes('esp32') || token.includes('a7670') || token === 'firmware') ||
        firmwareHints.length > 0) {
        return 'esp32';
    }

    if (tokens.some(token => token.includes('android'))) {
        return 'android';
    }

    return row.type || '';
}

function hasAnyOwnKey(source, keys) {
    if (!source || typeof source !== 'object') return false;
    return keys.some((key) => Object.prototype.hasOwnProperty.call(source, key));
}

function pickEspAssignmentType(identity = {}, requestedType = '', existing = {}) {
    const candidates = [
        existing.type,
        existing.board,
        identity.device_type,
        identity.deviceType,
        identity.model,
        identity.board,
        requestedType
    ].map(normalizeDeviceTypeToken).filter(Boolean);

    return candidates.find((token) => token.includes('esp32') || token.includes('a7670')) || 'esp32';
}

function inferUnregisteredAssignmentType(identity = {}, requestedType = '', existing = {}, deviceId = '') {
    const normalizedRequested = normalizeDeviceTypeToken(requestedType);
    const tokens = [
        deviceId,
        identity.device_id,
        identity.deviceId,
        identity.id,
        identity.platform,
        identity.device_type,
        identity.deviceType,
        identity.model,
        identity.board,
        identity.bridge,
        identity.bridge_type,
        identity.transport
    ].map(normalizeDeviceTypeToken).filter(Boolean);

    if (
        tokens.some((token) => isAndroidDeviceId(token) || token.includes('android')) ||
        hasAnyOwnKey(identity, ['android_id', 'androidId', 'install_id', 'installId'])
    ) {
        return 'android';
    }

    const espToken = tokens.find((token) =>
        token.includes('esp32') ||
        token.includes('a7670') ||
        token.includes('simcom') ||
        token === 'firmware'
    );
    if (espToken) {
        return pickEspAssignmentType(identity, requestedType, existing);
    }

    const espTelemetryKeys = [
        'active_path',
        'activePath',
        'wifi_configured',
        'wifi_started',
        'wifi_connected',
        'wifi_ip_assigned',
        'wifi_ssid',
        'free_heap_bytes',
        'largest_free_block_bytes',
        'internal_free_heap_bytes',
        'free_psram_bytes',
        'sd_mounted',
        'storage_media_mounted',
        'storage_queue_depth',
        'modem_operator',
        'modem_network_type',
        'imei'
    ];
    if (
        identity.type === 'device_status' ||
        identity.type === 'status' ||
        hasAnyOwnKey(identity, espTelemetryKeys)
    ) {
        return normalizedRequested && normalizedRequested !== 'android'
            ? normalizedRequested
            : pickEspAssignmentType(identity, requestedType, existing);
    }

    if (normalizedRequested && normalizedRequested !== 'device_status' && normalizedRequested !== 'status') {
        return normalizedRequested;
    }

    return 'esp32';
}

function sortDeviceList(devices, activeDeviceId = '') {
    const activeId = String(activeDeviceId || '').trim();

    return devices.sort((left, right) => {
        if (activeId) {
            if (left.id === activeId && right.id !== activeId) return -1;
            if (right.id === activeId && left.id !== activeId) return 1;
        }
        if (Boolean(left.online) !== Boolean(right.online)) {
            return left.online ? -1 : 1;
        }

        const leftSeen = Date.parse(left.lastSeen || left.last_seen || '') || 0;
        const rightSeen = Date.parse(right.lastSeen || right.last_seen || '') || 0;
        if (leftSeen !== rightSeen) {
            return rightSeen - leftSeen;
        }

        const leftCreated = Date.parse(left.created_at || left.createdAt || '') || 0;
        const rightCreated = Date.parse(right.created_at || right.createdAt || '') || 0;
        return leftCreated - rightCreated;
    });
}

function normalizePublicBaseUrl(req) {
    const configured = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
    return `${protocol}://${req.get('host')}`.replace(/\/+$/, '');
}

function classifyDeviceLane(device = {}) {
    const deviceIdTokens = [device.id, device.device_id].map(normalizeDeviceTypeToken).filter(Boolean);
    if (deviceIdTokens.some(isAndroidDeviceId)) {
        return 'android';
    }

    const caps = parseJsonObject(device.capabilities, {});
    const tokens = [
        device.type,
        device.board,
        caps.bridge,
        caps.bridge_type,
        caps.platform
    ].map(normalizeDeviceTypeToken).filter(Boolean);
    if (tokens.some(token => token.includes('android') || (token.includes('http') && token.includes('sms')))) {
        return 'android';
    }
    return 'esp32';
}

function generateApiKey() {
    return `edk_${crypto.randomBytes(32).toString('hex')}`;
}

function hashApiKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

function requireAdmin(req, res) {
    const effectiveUser = withEffectiveRole(req.user || req.session?.user);
    if (!hasRole(effectiveUser?.role, 'admin')) {
        res.status(403).json({ success: false, message: 'Admin access required' });
        return false;
    }
    req.user = effectiveUser;
    return true;
}

function requireSuperAdmin(req, res) {
    const effectiveUser = withEffectiveRole(req.user || req.session?.user);
    if (effectiveUser?.role !== 'superadmin') {
        res.status(403).json({ success: false, message: 'Superadmin access required' });
        return false;
    }
    req.user = effectiveUser;
    return true;
}

function parseJsonObject(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function parseStoredPayload(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function formatUnregisteredDevice(row = {}) {
    const identity = parseStoredPayload(row.last_payload, {});
    const deviceType = inferUnregisteredAssignmentType(identity, '', {}, row.device_id);
    const model = String(
        identity.model ||
        identity.device_model ||
        identity.deviceModel ||
        identity.board ||
        ''
    ).trim();
    return {
        device_id: row.device_id,
        first_seen: row.first_seen || null,
        last_seen: row.last_seen || null,
        event_count: Number(row.event_count || 0),
        last_event_type: row.last_event_type || '',
        last_number: row.last_number || '',
        notes: row.notes || '',
        device_type: deviceType,
        model,
        identity
    };
}

function getDevicePackageOffer(packageCode) {
    const normalized = String(packageCode || '').trim().toLowerCase();
    return DEVICE_PACKAGE_OFFERS.find((offer) => offer.code === normalized) || null;
}

function serializePackageOffer(offer) {
    return {
        code: offer.code,
        name: offer.name,
        price_bdt: offer.priceBdt,
        limits: offer.limits
    };
}

function buildPaymentInstructions() {
    return {
        method: PACKAGE_PAYMENT_METHOD,
        number: PACKAGE_PAYMENT_NUMBER,
        message: `Send the package price to ${PACKAGE_PAYMENT_NUMBER} via bKash, then wait for admin approval.`
    };
}

function buildCurrentPackage(row) {
    const code = String(row?.current_package_code || '').trim();
    if (!code) {
        return null;
    }

    return {
        code,
        name: String(row?.current_package_name || '').trim() || code,
        price_bdt: Number(row?.current_package_price || 0),
        status: String(row?.current_package_status || 'approved').trim() || 'approved',
        approved_at: row?.current_package_approved_at || null,
        limits: parseJsonObject(row?.current_package_limits, {})
    };
}

function buildPackageRequest(row) {
    return {
        id: Number(row.id),
        device_id: row.device_id,
        user_id: Number(row.user_id),
        username: row.username || '',
        reviewer_name: row.reviewer_name || '',
        package_code: row.package_code,
        package_name: row.package_name,
        price_bdt: Number(row.price_bdt || 0),
        payment_method: row.payment_method || PACKAGE_PAYMENT_METHOD,
        payment_number: row.payment_number || PACKAGE_PAYMENT_NUMBER,
        payment_reference: row.payment_reference || '',
        notes: row.notes || '',
        status: row.status || 'pending',
        requested_at: row.requested_at || null,
        reviewed_at: row.reviewed_at || null,
        review_notes: row.review_notes || '',
        limits: parseJsonObject(row.limits_json, {})
    };
}

async function loadDevicePackageSnapshot(db, deviceId) {
    const profile = await db.get(
        `SELECT current_package_code, current_package_name, current_package_price,
                current_package_limits, current_package_status, current_package_approved_at
         FROM device_profiles
         WHERE device_id = ?`,
        [deviceId]
    );
    const requests = await db.all(
        `SELECT r.*,
                u.username,
                reviewer.username AS reviewer_name
         FROM device_package_requests r
         LEFT JOIN users u ON u.id = r.user_id
         LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
         WHERE r.device_id = ?
         ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.requested_at DESC, r.id DESC`,
        [deviceId]
    );

    return {
        currentPackage: buildCurrentPackage(profile),
        requests: (requests || []).map(buildPackageRequest)
    };
}

async function approveDevicePackageRequest(db, requestRow, reviewerId, reviewNotes) {
    const limitsJson = requestRow.limits_json || '{}';

    await db.run(
        `UPDATE device_package_requests
         SET status = 'approved',
             reviewed_at = CURRENT_TIMESTAMP,
             reviewed_by = ?,
             review_notes = ?
         WHERE id = ?`,
        [reviewerId || null, reviewNotes || null, requestRow.id]
    );

    await db.run(
        `UPDATE device_package_requests
         SET status = 'superseded',
             reviewed_at = CURRENT_TIMESTAMP,
             reviewed_by = ?,
             review_notes = COALESCE(review_notes, 'Superseded by a newer approved package')
         WHERE device_id = ?
           AND id != ?
           AND status = 'approved'`,
        [reviewerId || null, requestRow.device_id, requestRow.id]
    );

    await db.run(
        `INSERT INTO device_profiles
            (device_id, current_package_code, current_package_name, current_package_price,
             current_package_limits, current_package_status, current_package_approved_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'approved', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(device_id) DO UPDATE SET
             current_package_code = excluded.current_package_code,
             current_package_name = excluded.current_package_name,
             current_package_price = excluded.current_package_price,
             current_package_limits = excluded.current_package_limits,
             current_package_status = 'approved',
             current_package_approved_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP`,
        [
            requestRow.device_id,
            requestRow.package_code,
            requestRow.package_name,
            Number(requestRow.price_bdt || 0),
            limitsJson
        ]
    );
}

async function registerDevice(db, payload = {}, actorId = null) {
    const deviceId = normalizeDeviceId(payload.id || payload.device_id);
    if (!deviceId) throw new Error('Device ID required');

    const existing = await db.get(`SELECT name FROM devices WHERE id = ?`, [deviceId]);
    const name = String(payload.name || existing?.name || 'Device').trim();
    const type = String(payload.type || payload.model || 'esp32').trim().toLowerCase() || 'esp32';
    const capJson = payload.capabilities
        ? (typeof payload.capabilities === 'string' ? payload.capabilities : JSON.stringify(payload.capabilities))
        : null;

    await db.run(
        `INSERT INTO devices (id, name, type, status, created_at)
         VALUES (?, ?, ?, COALESCE(?, 'offline'), CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             type = excluded.type,
             status = COALESCE(excluded.status, devices.status)`,
        [deviceId, name, type, payload.status || 'offline']
    );

    await db.run(
        `INSERT INTO device_profiles
            (device_id, location, apn, mqtt_host, mqtt_user, mqtt_pass, local_ip, capabilities, board, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(device_id) DO UPDATE SET
             location = COALESCE(excluded.location, device_profiles.location),
             apn = COALESCE(excluded.apn, device_profiles.apn),
             mqtt_host = COALESCE(excluded.mqtt_host, device_profiles.mqtt_host),
             mqtt_user = COALESCE(excluded.mqtt_user, device_profiles.mqtt_user),
             mqtt_pass = COALESCE(excluded.mqtt_pass, device_profiles.mqtt_pass),
             local_ip = COALESCE(excluded.local_ip, device_profiles.local_ip),
             capabilities = COALESCE(excluded.capabilities, device_profiles.capabilities),
             board = COALESCE(excluded.board, device_profiles.board),
             updated_at = CURRENT_TIMESTAMP`,
        [
            deviceId,
            payload.location || null,
            payload.apn || null,
            payload.mqtt_host || null,
            payload.mqtt_user || null,
            payload.mqtt_pass || null,
            payload.local_ip || null,
            capJson,
            payload.board || payload.model || null
        ]
    );

    if (actorId) {
        await db.run(
            `INSERT OR IGNORE INTO device_users (device_id, user_id, can_write) VALUES (?, ?, 1)`,
            [deviceId, actorId]
        );
    }

    return {
        id: deviceId,
        name,
        type,
        status: payload.status || 'offline'
    };
}

async function cleanupDeviceAssociations(db, deviceId) {
    await db.run(`UPDATE sms SET device_id = NULL WHERE device_id = ?`, [deviceId]);
    await db.run(`UPDATE calls SET device_id = NULL WHERE device_id = ?`, [deviceId]);
    await db.run(`UPDATE ussd SET device_id = NULL WHERE device_id = ?`, [deviceId]);

    const deleteStatements = [
        `DELETE FROM intercom_settings WHERE device_id = ?`,
        `DELETE FROM intercom_calls WHERE device_id = ?`,
        `DELETE FROM intercom_sessions WHERE device_id = ?`,
        `DELETE FROM automation_flows WHERE device_id = ?`,
        `DELETE FROM storage_files WHERE device_id = ?`,
        `DELETE FROM mqtt_logs WHERE device_id = ?`,
        `DELETE FROM gps_locations WHERE device_id = ?`,
        `DELETE FROM gpio_config WHERE device_id = ?`,
        `DELETE FROM gpio_history WHERE device_id = ?`,
        `DELETE FROM gpio_rules WHERE device_id = ?`,
        `DELETE FROM gpio_groups WHERE device_id = ?`,
        `DELETE FROM pin_names WHERE device_id = ?`,
        `DELETE FROM device_module_health WHERE device_id = ?`,
        `DELETE FROM device_wifi_networks WHERE device_id = ?`,
        `DELETE FROM device_push_tokens WHERE device_id = ?`,
        `DELETE FROM sms_conversations WHERE device_id = ?`,
        `DELETE FROM phone_device_links WHERE phone_device_id = ? OR target_device_id = ?`,
        `DELETE FROM device_group_members WHERE device_id = ?`,
        `DELETE FROM device_users WHERE device_id = ?`,
        `DELETE FROM device_profiles WHERE device_id = ?`,
        `DELETE FROM unregistered_device_events WHERE device_id = ?`,
        `DELETE FROM unregistered_devices WHERE device_id = ?`
    ];

    for (const sql of deleteStatements) {
        const params = sql.includes('target_device_id') ? [deviceId, deviceId] : [deviceId];
        try {
            await db.run(sql, params);
        } catch (error) {
            logger.debug(`Cleanup skipped for ${deviceId}: ${error.message}`);
        }
    }
}

async function upsertDeviceProfileFields(db, deviceId, fields = {}) {
    const columns = ['device_id'];
    const placeholders = ['?'];
    const updates = [];
    const values = [deviceId];

    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) {
            continue;
        }

        columns.push(key);
        placeholders.push('?');
        values.push(value === '' ? null : value);
        updates.push(`${key} = excluded.${key}`);
    }

    if (updates.length === 0) {
        return;
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    await db.run(
        `INSERT INTO device_profiles (${columns.join(', ')}, updated_at)
         VALUES (${placeholders.join(', ')}, CURRENT_TIMESTAMP)
         ON CONFLICT(device_id) DO UPDATE SET ${updates.join(', ')}`,
        values
    );
}

async function getFirstAccessibleDeviceId(db, req) {
    const effectiveUser = withEffectiveRole(req.user || req.session?.user);
    const userRole = effectiveUser?.role;
    const userId = effectiveUser?.id;

    if (hasRole(userRole, 'admin')) {
        const row = await db.get(`
            SELECT id
            FROM devices
            ORDER BY
                CASE WHEN status = 'online' THEN 0 ELSE 1 END,
                COALESCE(last_seen, created_at) DESC,
                created_at ASC
            LIMIT 1
        `);
        return row?.id || '';
    }

    const row = await db.get(
        `SELECT d.id
         FROM devices d
         INNER JOIN device_users du ON du.device_id = d.id
         WHERE du.user_id = ?
         ORDER BY
             CASE WHEN d.status = 'online' THEN 0 ELSE 1 END,
             COALESCE(d.last_seen, d.created_at) DESC,
             d.created_at ASC
         LIMIT 1`,
        [userId]
    );
    return row?.id || '';
}

async function persistSessionDeviceId(req, deviceId) {
    const normalizedDeviceId = String(deviceId || '').trim();
    if (!req?.session) {
        return normalizedDeviceId;
    }

    if (!normalizedDeviceId) {
        delete req.session.deviceId;
        if (typeof req.session.save === 'function') {
            await new Promise((resolve, reject) => {
                req.session.save((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        }
        return '';
    }

    req.session.deviceId = normalizedDeviceId;

    if (typeof req.session.save === 'function') {
        await new Promise((resolve, reject) => {
            req.session.save((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    }

    return normalizedDeviceId;
}

function buildMqttUri(host, port) {
    const trimmedHost = String(host || '').trim();
    const parsedPort = parseInt(port, 10) || DEFAULT_MQTT_PORT;

    if (!trimmedHost) return '';
    if (/^[a-z]+:\/\//i.test(trimmedHost)) return trimmedHost;
    return `mqtt://${trimmedHost}:${parsedPort}`;
}

function normalizeOptionalText(value) {
    const text = String(value || '').trim();
    return text || '';
}

async function buildStoredSimSnapshot(db, deviceId, live = {}) {
    const storedSimRows = await readStoredSimRows(db, deviceId).catch(() => []);
    const normalizedStatus = applyStoredSimFallback(
        buildDashboardDeviceStatus(live || {}, Boolean(live?.online)),
        storedSimRows
    );

    return {
        simNumber: normalizedStatus.simNumber || null,
        subscriberNumber: normalizedStatus.subscriberNumber || null,
        operator: normalizedStatus.operator || null,
        simSlots: Array.isArray(normalizedStatus.simSlots) ? normalizedStatus.simSlots : [],
        simSlotCount: Number(normalizedStatus.simSlotCount || 0),
        dualSim: Boolean(normalizedStatus.dualSim),
        activeSimSlotIndex: normalizedStatus.activeSimSlotIndex ?? normalizedStatus?.sim?.activeSlotIndex ?? null,
        sim: normalizedStatus.sim || {
            slots: [],
            slotCount: 0
        }
    };
}

function resolveProvisioningMqttConfig(profile = {}) {
    const deviceHost = normalizeOptionalText(profile.mqtt_host);
    const deviceUser = normalizeOptionalText(profile.mqtt_user);
    const devicePassword = normalizeOptionalText(profile.mqtt_pass);
    const devicePasswordSet = Boolean(profile.mqtt_pass_set || devicePassword);
    const systemHost = normalizeOptionalText(process.env.MQTT_HOST);
    const systemUser = normalizeOptionalText(process.env.MQTT_USER);
    const systemPassword = normalizeOptionalText(process.env.MQTT_PASSWORD);
    const systemPasswordSet = Boolean(process.env.MQTT_PASSWORD);
    const uri = deviceHost
        ? buildMqttUri(deviceHost, process.env.MQTT_PORT)
        : buildMqttUri(systemHost, process.env.MQTT_PORT);
    const username = deviceUser || systemUser || '';
    const password = devicePassword || systemPassword || '';
    const sourceUri = deviceHost ? 'device' : (systemHost ? 'system' : 'unset');
    const sourceUser = deviceUser ? 'device' : (systemUser ? 'system' : 'unset');
    const sourcePassword = devicePasswordSet ? 'device' : (systemPasswordSet ? 'system' : 'unset');

    return {
        uri,
        username,
        password,
        configured: Boolean(uri),
        passwordSet: Boolean(devicePassword || systemPassword),
        source: sourceUri === 'device' || sourceUser === 'device' || sourcePassword === 'device'
            ? 'device_override'
            : (uri ? 'system_defaults' : 'unset'),
        sources: {
            uri: sourceUri,
            username: sourceUser,
            password: sourcePassword
        }
    };
}

function buildEffectiveMqttConfig(profile = {}) {
    const resolved = resolveProvisioningMqttConfig(profile);

    return {
        configured: resolved.configured,
        uri: resolved.uri,
        username: resolved.username,
        passwordSet: resolved.passwordSet,
        source: resolved.source,
        sources: resolved.sources
    };
}

function buildRuntimeConfigCompatibilityNotice(result = {}) {
    const skippedFields = Array.isArray(result.skippedFields) ? result.skippedFields : [];
    if (!skippedFields.length) {
        return {
            partialApplied: false,
            compatibilityWarning: null
        };
    }

    const mqttRelatedFields = new Set([
        'mqttUri',
        'mqttUsername',
        'mqttPassword',
        'mqttEnabled',
        'modemFallbackEnabled'
    ]);
    const skippedMqttFields = skippedFields.filter((field) => mqttRelatedFields.has(field));

    if (skippedMqttFields.length) {
        return {
            partialApplied: true,
            compatibilityWarning: 'Device accepted a legacy config schema. Wi-Fi/APN were applied, but MQTT runtime settings were skipped on the device. Flash the current main firmware before relying on MQTT-only dashboard operations.',
            skippedMqttFields
        };
    }

    return {
        partialApplied: true,
        compatibilityWarning: 'Device accepted only part of the requested runtime config.',
        skippedMqttFields: []
    };
}

function buildSetupApPayload(config = {}) {
    const payload = {
        wifi_ssid: config.wifiSsid || '',
        wifi_password: config.wifiPassword || '',
        modem_apn: config.modemApn || '',
        mqtt_uri: config.mqttUri || buildMqttUri(process.env.MQTT_HOST || '', process.env.MQTT_PORT),
        mqtt_username: config.mqttUsername ?? process.env.MQTT_USER ?? '',
        mqtt_password: config.mqttPassword ?? process.env.MQTT_PASSWORD ?? '',
        mqtt_enabled: config.mqttEnabled !== undefined ? !!config.mqttEnabled : true,
        modem_fallback_enabled: config.modemFallbackEnabled !== undefined ? !!config.modemFallbackEnabled : true
    };

    if (config.deviceIdOverride !== undefined) {
        payload.device_id_override = config.deviceIdOverride || '';
    }

    return payload;
}

function setupApRequest(method, path, payload, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const requestBody = payload ? JSON.stringify(payload) : null;
        const req = http.request({
            hostname: setupApIp,
            port: 80,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(requestBody ? { 'Content-Length': Buffer.byteLength(requestBody) } : {})
            },
            timeout: timeoutMs
        }, (response) => {
            let data = '';
            response.on('data', chunk => { data += chunk; });
            response.on('end', () => {
                let body = data;
                try { body = data ? JSON.parse(data) : null; } catch (_) {}
                resolve({ status: response.statusCode, body });
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        req.on('error', reject);
        if (requestBody) req.write(requestBody);
        req.end();
    });
}

async function applyRuntimeConfigViaSetupWifi(config) {
    const result = await setupApRequest(
        'POST',
        '/api/config',
        buildSetupApPayload(config),
        parseInt(process.env.RUNTIME_CONFIG_WIFI_TIMEOUT_MS || '5000', 10)
    );
    if (result.status >= 200 && result.status < 300) {
        let reboot = null;
        if (result.body?.restart_required) {
            reboot = await setupApRequest('POST', '/api/reboot', {}, 5000).catch(error => ({ error: error.message }));
        }
        return {
            ok: true,
            restartRequired: !!result.body?.restart_required,
            applied: [
                ['device_id_override', config.deviceIdOverride],
                ['wifi_ssid', config.wifiSsid],
                ['wifi_password', config.wifiPassword],
                ['modem_apn', config.modemApn],
                ['mqtt_uri', config.mqttUri],
                ['mqtt_username', config.mqttUsername],
                ['mqtt_password', config.mqttPassword],
                ['mqtt_enabled', config.mqttEnabled],
                ['modem_fallback_enabled', config.modemFallbackEnabled]
            ].filter(([, value]) => value !== undefined).map(([key]) => key),
            response: result.body,
            reboot: reboot?.body || reboot || null
        };
    }

    throw new Error(`Setup Wi-Fi returned HTTP ${result.status}`);
}

async function getRuntimeConfigViaSetupWifi() {
    const result = await setupApRequest(
        'GET',
        '/api/config',
        null,
        parseInt(process.env.RUNTIME_CONFIG_WIFI_TIMEOUT_MS || '5000', 10)
    );
    if (result.status < 200 || result.status >= 300) {
        throw new Error(`Setup Wi-Fi returned HTTP ${result.status}`);
    }

    const config = result.body?.config;
    if (!config || typeof config !== 'object') {
        throw new Error('Setup Wi-Fi config response missing config');
    }

    return {
        schemaVersion: Number(result.body?.meta?.schema_version || 0) || null,
        deviceIdOverride: config.device_id_override || '',
        wifiSsid: config.wifi_ssid || '',
        wifiPasswordSet: !!(result.body?.meta?.wifi_password_set || config.wifi_password_set || config.stored_wifi_password_set),
        modemApn: config.modem_apn || result.body?.meta?.modem_apn || ''
    };
}

async function applyRuntimeConfigViaMqtt(deviceId, config) {
    if (!global.mqttService?.connected || typeof global.mqttService.publishCommand !== 'function') {
        throw new Error('MQTT not connected');
    }

    const updates = [
        ['wifi_ssid', config.wifiSsid],
        ['wifi_password', config.wifiPassword],
        ['modem_apn', config.modemApn],
        ['device_id_override', config.deviceIdOverride],
        ['mqtt_uri', config.mqttUri],
        ['mqtt_username', config.mqttUsername],
        ['mqtt_password', config.mqttPassword],
        ['mqtt_enabled', config.mqttEnabled],
        ['modem_fallback_enabled', config.modemFallbackEnabled]
    ].filter(([, value]) => value !== undefined && String(value).length > 0);
    const wifiConfigTouched = config.wifiSsid !== undefined || config.wifiPassword !== undefined;

    if (!updates.length) throw new Error('No runtime config fields supplied');

    const responses = [];
    for (const [key, value] of updates) {
        responses.push(await global.mqttService.publishCommand(
            deviceId,
            'config-set',
            { key, value: String(value ?? '') },
            true,
            10000,
            { source: 'dashboard-config', skipPersistentQueue: true }
        ));
    }

    if (wifiConfigTouched) {
        responses.push(await global.mqttService.publishCommand(
            deviceId,
            'wifi-reconnect',
            {},
            true,
            10000,
            { source: 'dashboard-config', skipPersistentQueue: true }
        ));
    }

    return {
        ok: true,
        restartRequired: responses.some(response => response?.restart_required || response?.payload?.restart_required),
        applied: updates.map(([key]) => key),
        responses
    };
}

function buildLegacyRuntimeConfig(config = {}) {
    return {
        ...(config.deviceIdOverride !== undefined ? { deviceIdOverride: config.deviceIdOverride } : {}),
        ...(config.wifiSsid !== undefined ? { wifiSsid: config.wifiSsid } : {}),
        ...(config.wifiPassword !== undefined ? { wifiPassword: config.wifiPassword } : {}),
        ...(config.modemApn !== undefined ? { modemApn: config.modemApn } : {})
    };
}

function shouldRetryLegacySerialConfig(error) {
    const message = String(error?.message || error || '');
    return /not_supported|unsupported|detail=key|Device rejected config update|^key$/i.test(message);
}

async function applyRuntimeConfigViaSerial(serialBridge, config, options) {
    try {
        return await serialBridge.applyRuntimeConfig(config, options);
    } catch (error) {
        if (!shouldRetryLegacySerialConfig(error)) {
            throw error;
        }

        const legacyConfig = buildLegacyRuntimeConfig(config);
        if (Object.keys(legacyConfig).length === Object.keys(config || {}).length) {
            throw error;
        }

        const result = await serialBridge.applyRuntimeConfig(legacyConfig, options);
        return {
            ...result,
            compatibilityMode: 'legacy_serial_config',
            skippedFields: Object.keys(config || {}).filter((key) => legacyConfig[key] === undefined)
        };
    }
}

async function applyRuntimeConfigWithFallback(req, deviceId, config) {
    const serialBridge = req.app.locals.serialBridge;
    const attempts = [];
    const bluetoothPort = String(process.env.BLUETOOTH_SERIAL_PORT || '').trim();
    const serialPort = String(process.env.SERIAL_PORT || '').trim();
    const wifiFallbackEnabled = process.env.RUNTIME_CONFIG_WIFI_ENABLED === 'true' || !!process.env.DEVICE_SETUP_AP_IP;

    async function tryTransport(name, task) {
        try {
            const result = await task();
            return { transport: name, result };
        } catch (error) {
            attempts.push({ transport: name, error: error.message || String(error) });
            return null;
        }
    }

    if (serialBridge && typeof serialBridge.applyRuntimeConfig === 'function' && serialPort) {
        const result = await tryTransport('serial', () => applyRuntimeConfigViaSerial(serialBridge, config));
        if (result) return { ...result, attempts };
    } else {
        attempts.push({ transport: 'serial', skipped: true, reason: serialPort ? 'unavailable' : 'not_configured' });
    }

    if (serialBridge && typeof serialBridge.applyRuntimeConfig === 'function' && bluetoothPort && bluetoothPort !== serialPort) {
        const result = await tryTransport('bluetooth', () => applyRuntimeConfigViaSerial(serialBridge, config, { portPath: bluetoothPort }));
        if (result) return { ...result, attempts };
    } else {
        attempts.push({ transport: 'bluetooth', skipped: true, reason: bluetoothPort ? 'unavailable' : 'not_configured' });
    }

    if (wifiFallbackEnabled) {
        const wifiResult = await tryTransport('wifi', () => applyRuntimeConfigViaSetupWifi(config));
        if (wifiResult) return { ...wifiResult, attempts };
    } else {
        attempts.push({ transport: 'wifi', skipped: true, reason: 'not_configured' });
    }

    const mqttResult = await tryTransport('mqtt', () => applyRuntimeConfigViaMqtt(deviceId, config));
    if (mqttResult) return { ...mqttResult, attempts };

    return { transport: 'stored_only', result: null, attempts };
}

async function getRuntimeConfigWithFallback(req) {
    const serialBridge = req.app.locals.serialBridge;
    const attempts = [];
    const bluetoothPort = String(process.env.BLUETOOTH_SERIAL_PORT || '').trim();
    const serialPort = String(process.env.SERIAL_PORT || '').trim();
    const wifiFallbackEnabled = process.env.RUNTIME_CONFIG_WIFI_ENABLED === 'true' || !!process.env.DEVICE_SETUP_AP_IP;

    async function tryTransport(name, task) {
        try {
            const result = await task();
            return { transport: name, result };
        } catch (error) {
            attempts.push({ transport: name, error: error.message || String(error) });
            return null;
        }
    }

    if (serialBridge && typeof serialBridge.getRuntimeConfig === 'function' && serialPort) {
        const result = await tryTransport('serial', () => serialBridge.getRuntimeConfig());
        if (result) return { ...result, attempts };
    } else {
        attempts.push({ transport: 'serial', skipped: true, reason: serialPort ? 'unavailable' : 'not_configured' });
    }

    if (serialBridge && typeof serialBridge.getRuntimeConfig === 'function' && bluetoothPort && bluetoothPort !== serialPort) {
        const result = await tryTransport('bluetooth', () => serialBridge.getRuntimeConfig({ portPath: bluetoothPort }));
        if (result) return { ...result, attempts };
    } else {
        attempts.push({ transport: 'bluetooth', skipped: true, reason: bluetoothPort ? 'unavailable' : 'not_configured' });
    }

    if (wifiFallbackEnabled) {
        const result = await tryTransport('wifi', getRuntimeConfigViaSetupWifi);
        if (result) return { ...result, attempts };
    } else {
        attempts.push({ transport: 'wifi', skipped: true, reason: 'not_configured' });
    }

    attempts.push({ transport: 'mqtt', skipped: true, reason: 'config_read_not_supported' });
    return { transport: 'unavailable', result: null, attempts };
}

/**
 * @swagger
 * tags:
 *   name: Devices
 *   description: Device registry and user assignment
 */

/**
 * @swagger
 * /devices:
 *   get:
 *     summary: List devices
 *     description: Admins see all devices; operators/viewers see only their assigned devices. Live telemetry (signal, battery) is merged from the in-memory modem service.
 *     tags: [Devices]
 *     security:
 *       - sessionCookie: []
 *     responses:
 *       200:
 *         description: Device list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 devices:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Device' }
 */
// GET /api/devices — list devices (all for admin; assigned-only for operator/viewer)
router.get('/', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const effectiveUser = withEffectiveRole(req.user || req.session?.user);
        const userRole = effectiveUser?.role;
        const userId   = effectiveUser?.id;

        let rows;
        if (hasRole(userRole, 'admin')) {
            // Admins see all devices + assignment counts
            rows = await db.all(`
                SELECT d.*,
                       dp.capabilities, dp.model, dp.board, dp.location, dp.local_ip,
                       dp.has_gps, dp.has_battery, dp.has_sd, dp.has_camera, dp.has_audio,
                       dp.has_display, dp.has_nfc, dp.has_rfid, dp.has_touch, dp.has_keyboard,
                       (SELECT COUNT(*) FROM device_users du WHERE du.device_id = d.id) AS assigned_users
                FROM devices d
                LEFT JOIN device_profiles dp ON dp.device_id = d.id
                ORDER BY d.created_at ASC
            `);
        } else {
            // Operators and viewers see only their assigned devices
            rows = await db.all(`
                SELECT d.*, du.can_write,
                       dp.capabilities, dp.model, dp.board, dp.location, dp.local_ip,
                       dp.has_gps, dp.has_battery, dp.has_sd, dp.has_camera, dp.has_audio,
                       dp.has_display, dp.has_nfc, dp.has_rfid, dp.has_touch, dp.has_keyboard
                FROM devices d
                INNER JOIN device_users du ON du.device_id = d.id
                LEFT JOIN device_profiles dp ON dp.device_id = d.id
                WHERE du.user_id = ?
                ORDER BY d.created_at ASC
            `, [userId]);
        }

        // Merge with live modem state
        const modemService = global.modemService;
        const activeDeviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const devices = rows.map(row => {
            const live = modemService?.getStatus(row.id);
            const caps = parseCapabilities(row);
            const inferredType = inferDeviceListType(row, live, caps);
            return {
                ...row,
                type: inferredType || row.type,
                deviceType: inferredType || row.type || '',
                model: live?.model || row.model || caps.model || caps.deviceModel || null,
                board: row.board || caps.board || row.type || null,
                capabilities: caps,
                online: live?.online || false,
                signal: live?.signal ?? null,
                signalDbm: live?.signalDbm ?? null,
                battery: live?.battery ?? null,
                network: live?.network || null,
                operator: live?.operator || null,
                activePath: live?.activePath || null,
                wifi: live?.wifi || null,
                mqtt: live?.mqtt || null,
                sync: live?.sync || null,
                storage: live?.storage || null,
                queueState: {
                    device: live?.queues || null
                },
                lastSeen: live?.lastSeen || row.last_seen
            };
        });

        res.json({ success: true, devices: sortDeviceList(devices, activeDeviceId) });
    } catch (error) {
        logger.error('GET /api/devices error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch devices' });
    }
});

router.post('/', [
    body('id').optional().trim().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Device ID may only contain letters, numbers, hyphens and underscores').isLength({ max: 64 }),
    body('device_id').optional().trim().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Device ID may only contain letters, numbers, hyphens and underscores').isLength({ max: 64 }),
    body('name').optional().trim().isLength({ max: 100 }).withMessage('Name too long'),
    body('type').optional().trim().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Invalid device type').isLength({ max: 32 }),
    body('location').optional({ nullable: true }).trim().isLength({ max: 200 }),
    body('apn').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('mqtt_host').optional({ nullable: true }).trim().isLength({ max: 200 }),
    body('mqtt_user').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('mqtt_pass').optional({ nullable: true }).isLength({ max: 200 }),
    body('local_ip').optional({ nullable: true }).trim().matches(/^(\d{1,3}\.){3}\d{1,3}$|^$/).withMessage('Invalid IPv4 address')
], async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const deviceId = normalizeDeviceId(req.body.id || req.body.device_id);
        if (!deviceId) {
            return res.status(400).json({ success: false, message: 'Device ID required' });
        }

        const db = req.app.locals.db;
        const device = await registerDevice(db, req.body, req.user?.id || req.session?.user?.id || null);
        await req.app.locals.mqttHandlers?.unsuppressDeletedDevice?.(device.id);

        if (global.io) global.io.emit('device:created', device);
        res.status(201).json({ success: true, device });
    } catch (error) {
        logger.error('POST /api/devices error:', error);
        res.status(500).json({ success: false, message: 'Failed to create device' });
    }
});

// GET /api/devices/active — current active device for this session/browser
router.get('/active', async (req, res) => {
    try {
        const db = req.app.locals.db;
        let deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);

        if (deviceId && db) {
            const effectiveUser = withEffectiveRole(req.user || req.session?.user);
            const userRole = effectiveUser?.role;
            const userId = effectiveUser?.id;
            const device = hasRole(userRole, 'admin')
                ? await db.get(`SELECT id FROM devices WHERE id = ?`, [deviceId])
                : await db.get(
                    `SELECT d.id
                     FROM devices d
                     INNER JOIN device_users du ON du.device_id = d.id
                     WHERE d.id = ? AND du.user_id = ?`,
                    [deviceId, userId]
                );

            if (!device) {
                deviceId = '';
                await persistSessionDeviceId(req, '');
            }
        }

        if (!deviceId && db) {
            deviceId = await getFirstAccessibleDeviceId(db, req);
            await persistSessionDeviceId(req, deviceId);
        }

        res.json({
            success: true,
            deviceId
        });
    } catch (error) {
        logger.error('GET /api/devices/active error:', error);
        res.status(500).json({ success: false, message: 'Failed to resolve active device' });
    }
});

// POST /api/devices/active — persist the selected device in the session
router.post('/active', [
    body('deviceId').trim().notEmpty().isLength({ max: 64 }).withMessage('Valid deviceId required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const { deviceId } = req.body;
        const db = req.app.locals.db;
        const effectiveUser = withEffectiveRole(req.user || req.session?.user);
        const userRole = effectiveUser?.role;
        const userId = effectiveUser?.id;

        let device = null;
        if (hasRole(userRole, 'admin')) {
            device = await db.get(`SELECT id FROM devices WHERE id = ?`, [deviceId]);
        } else {
            device = await db.get(
                `SELECT d.id
                 FROM devices d
                 INNER JOIN device_users du ON du.device_id = d.id
                 WHERE d.id = ? AND du.user_id = ?`,
                [deviceId, userId]
            );
        }

        if (!device) {
            return res.status(404).json({ success: false, message: 'Device not found or not assigned to this user' });
        }

        await persistSessionDeviceId(req, deviceId);
        res.json({ success: true, deviceId });
    } catch (error) {
        logger.error('POST /api/devices/active error:', error);
        res.status(500).json({ success: false, message: 'Failed to save active device' });
    }
});

// GET /api/devices/:id/specs — merged device/about payload for the About page
router.get('/package-offers', async (req, res) => {
    try {
        const offers = await packageService.loadPackageOffers(req.app.locals.db);
        const payment = await paymentGatewayService.loadPaymentInstructions(req.app.locals.db);
        res.json({
            success: true,
            offers: offers.map(packageService.serializeOffer),
            payment
        });
    } catch (error) {
        logger.error('GET /api/devices/package-offers error:', error);
        res.status(500).json({ success: false, message: 'Failed to load package offers' });
    }
});

router.put('/package-offers', [
    body('offers').isArray({ min: 1 }).withMessage('At least one package offer is required')
], async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const offers = await packageService.savePackageOffers(
            req.app.locals.db,
            req.body.offers,
            req.session?.user?.id || req.user?.id || null
        );
        const payment = await paymentGatewayService.loadPaymentInstructions(req.app.locals.db);
        res.json({
            success: true,
            offers: offers.map(packageService.serializeOffer),
            payment
        });
    } catch (error) {
        logger.error('PUT /api/devices/package-offers error:', error);
        res.status(500).json({ success: false, message: error.message || 'Failed to save package offers' });
    }
});

router.get('/package-requests', async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
        const db = req.app.locals.db;
        const status = String(req.query.status || '').trim().toLowerCase();
        const where = [];
        const params = [];
        if (status) {
            where.push('r.status = ?');
            params.push(status);
        }

        const rows = await db.all(
            `SELECT r.*,
                    d.name AS device_name,
                    u.username,
                    reviewer.username AS reviewer_name
             FROM device_package_requests r
             LEFT JOIN devices d ON d.id = r.device_id
             LEFT JOIN users u ON u.id = r.user_id
             LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
             ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.requested_at DESC, r.id DESC`,
            params
        );

        res.json({
            success: true,
            requests: rows.map((row) => ({
                ...packageService.buildPackageRequest(row),
                device_name: row.device_name || row.device_id
            }))
        });
    } catch (error) {
        logger.error('GET /api/devices/package-requests error:', error);
        res.status(500).json({ success: false, message: 'Failed to load package requests' });
    }
});

router.get('/unregistered', async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;

    try {
        const rows = await req.app.locals.db.all(
            `SELECT device_id, first_seen, last_seen, event_count, last_event_type, last_number, last_payload, notes
             FROM unregistered_devices
             ORDER BY datetime(last_seen) DESC, device_id ASC`
        );
        res.json({
            success: true,
            devices: rows.map(formatUnregisteredDevice)
        });
    } catch (error) {
        logger.error('GET /api/devices/unregistered error:', error);
        res.status(500).json({ success: false, message: 'Failed to load unregistered devices' });
    }
});

router.get('/unregistered/:deviceId', async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;

    try {
        const db = req.app.locals.db;
        const deviceId = normalizeDeviceId(req.params.deviceId);
        if (!deviceId) {
            return res.status(400).json({ success: false, message: 'Device ID required' });
        }

        const row = await db.get(
            `SELECT device_id, first_seen, last_seen, event_count, last_event_type, last_number, last_payload, notes
             FROM unregistered_devices
             WHERE device_id = ?`,
            [deviceId]
        );
        if (!row) {
            return res.status(404).json({ success: false, message: 'Unregistered device not found' });
        }

        const logs = await db.all(
            `SELECT id, event_type, phone_number, payload, created_at
             FROM unregistered_device_events
             WHERE device_id = ?
             ORDER BY datetime(created_at) DESC, id DESC
             LIMIT 200`,
            [deviceId]
        );
        const users = await db.all(
            `SELECT id, username, name, role
             FROM users
             WHERE is_active = 1
             ORDER BY
                CASE role
                    WHEN 'superadmin' THEN 0
                    WHEN 'admin' THEN 1
                    WHEN 'operator' THEN 2
                    ELSE 3
                END,
                username ASC`
        );

        res.json({
            success: true,
            device: formatUnregisteredDevice(row),
            logs: (logs || []).map((entry) => ({
                id: Number(entry.id),
                event_type: entry.event_type || 'event',
                phone_number: entry.phone_number || '',
                created_at: entry.created_at || null,
                payload: parseStoredPayload(entry.payload, {})
            })),
            users: (users || []).map((user) => ({
                id: Number(user.id),
                username: user.username,
                name: user.name || '',
                role: user.role || 'viewer'
            }))
        });
    } catch (error) {
        logger.error('GET /api/devices/unregistered/:deviceId error:', error);
        res.status(500).json({ success: false, message: 'Failed to load unregistered device' });
    }
});

router.post('/unregistered/:deviceId/assign', [
    body('name').optional({ nullable: true }).trim().isLength({ max: 100 }).withMessage('Name too long'),
    body('location').optional({ nullable: true }).trim().isLength({ max: 200 }).withMessage('Location too long'),
    body('type').optional({ nullable: true }).trim().matches(/^[a-zA-Z0-9_-]+$/).withMessage('Invalid device type').isLength({ max: 32 }),
    body('board').optional({ nullable: true }).trim().isLength({ max: 64 }).withMessage('Board too long'),
    body('user_id').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Invalid user')
], async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;

    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const db = req.app.locals.db;
        const deviceId = normalizeDeviceId(req.params.deviceId);
        if (!deviceId) {
            return res.status(400).json({ success: false, message: 'Device ID required' });
        }

        const quarantineRow = await db.get(`SELECT * FROM unregistered_devices WHERE device_id = ?`, [deviceId]);
        if (!quarantineRow) {
            return res.status(404).json({ success: false, message: 'Unregistered device not found' });
        }

        const identity = parseStoredPayload(quarantineRow.last_payload, {});
        const userId = req.body.user_id ? Number.parseInt(String(req.body.user_id), 10) : null;
        if (userId) {
            const userRow = await db.get(`SELECT id FROM users WHERE id = ? AND is_active = 1`, [userId]);
            if (!userRow) {
                return res.status(404).json({ success: false, message: 'Selected user not found' });
            }
        }

        const existingDevice = await db.get(
            `SELECT d.type, dp.board
             FROM devices d
             LEFT JOIN device_profiles dp ON dp.device_id = d.id
             WHERE d.id = ?`,
            [deviceId]
        ).catch(() => null);

        const type = inferUnregisteredAssignmentType(identity, req.body.type, existingDevice || {}, deviceId);

        const device = await registerDevice(db, {
            id: deviceId,
            name: req.body.name || identity.name || deviceId,
            type,
            board: req.body.board || identity.board || identity.model || existingDevice?.board || null,
            location: req.body.location || null,
            status: 'offline'
        }, null);

        if (userId) {
            await db.run(
                `INSERT INTO device_users (device_id, user_id, can_write, assigned_at)
                 VALUES (?, ?, 1, CURRENT_TIMESTAMP)
                 ON CONFLICT(device_id, user_id) DO UPDATE SET
                    can_write = 1,
                    assigned_at = CURRENT_TIMESTAMP`,
                [deviceId, userId]
            );
        }

        await db.run(`DELETE FROM unregistered_device_events WHERE device_id = ?`, [deviceId]);
        await db.run(`DELETE FROM unregistered_devices WHERE device_id = ?`, [deviceId]);
        await req.app.locals.mqttHandlers?.unsuppressDeletedDevice?.(deviceId);

        if (global.io) {
            global.io.emit('device:created', device);
        }

        res.json({
            success: true,
            message: 'Device assigned successfully',
            device
        });
    } catch (error) {
        logger.error('POST /api/devices/unregistered/:deviceId/assign error:', error);
        res.status(500).json({ success: false, message: 'Failed to assign unregistered device' });
    }
});

router.delete('/unregistered/:deviceId', async (req, res) => {
    if (!requireSuperAdmin(req, res)) return;

    try {
        const db = req.app.locals.db;
        const deviceId = normalizeDeviceId(req.params.deviceId);
        if (!deviceId) {
            return res.status(400).json({ success: false, message: 'Device ID required' });
        }

        const existing = await db.get(
            `SELECT device_id
             FROM unregistered_devices
             WHERE device_id = ?`,
            [deviceId]
        );
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Unregistered device not found' });
        }

        await db.run(`DELETE FROM unregistered_device_events WHERE device_id = ?`, [deviceId]);
        await db.run(`DELETE FROM unregistered_devices WHERE device_id = ?`, [deviceId]);

        res.json({
            success: true,
            message: 'Unregistered device deleted'
        });
    } catch (error) {
        logger.error('DELETE /api/devices/unregistered/:deviceId error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete unregistered device' });
    }
});

router.post('/package-requests/:requestId/approve', [
    body('review_notes').optional({ nullable: true }).trim().isLength({ max: 500 })
], async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
        const db = req.app.locals.db;
        const requestId = Number.parseInt(req.params.requestId, 10);
        if (!Number.isFinite(requestId) || requestId <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid request ID' });
        }

        const requestRow = await db.get(
            `SELECT * FROM device_package_requests WHERE id = ?`,
            [requestId]
        );
        if (!requestRow) {
            return res.status(404).json({ success: false, message: 'Package request not found' });
        }
        if (String(requestRow.status || '').trim() !== 'pending') {
            return res.status(400).json({ success: false, message: 'Only pending requests can be approved' });
        }

        await packageService.approveDevicePackageRequest(
            db,
            requestRow,
            req.session?.user?.id || req.user?.id || null,
            req.body.review_notes || null
        );
        res.json({ success: true, message: 'Package request approved' });
    } catch (error) {
        logger.error('POST /api/devices/package-requests/:requestId/approve error:', error);
        res.status(500).json({ success: false, message: 'Failed to approve package request' });
    }
});

router.post('/package-requests/:requestId/reject', [
    body('review_notes').optional({ nullable: true }).trim().isLength({ max: 500 })
], async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
        const db = req.app.locals.db;
        const requestId = Number.parseInt(req.params.requestId, 10);
        if (!Number.isFinite(requestId) || requestId <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid request ID' });
        }

        const requestRow = await db.get(
            `SELECT id, status FROM device_package_requests WHERE id = ?`,
            [requestId]
        );
        if (!requestRow) {
            return res.status(404).json({ success: false, message: 'Package request not found' });
        }
        if (String(requestRow.status || '').trim() !== 'pending') {
            return res.status(400).json({ success: false, message: 'Only pending requests can be rejected' });
        }

        await db.run(
            `UPDATE device_package_requests
             SET status = 'rejected',
                 reviewed_at = CURRENT_TIMESTAMP,
                 reviewed_by = ?,
                 review_notes = ?
             WHERE id = ?`,
            [req.session?.user?.id || req.user?.id || null, req.body.review_notes || null, requestId]
        );
        res.json({ success: true, message: 'Package request rejected' });
    } catch (error) {
        logger.error('POST /api/devices/package-requests/:requestId/reject error:', error);
        res.status(500).json({ success: false, message: 'Failed to reject package request' });
    }
});

router.get('/:id/package', requireDeviceAccess('id'), async (req, res) => {
    try {
        const db = req.app.locals.db;
        const offers = await packageService.loadPackageOffers(db);
        const snapshot = await packageService.loadDevicePackageSnapshot(db, req.params.id);
        const quota = await packageService.getDeviceQuotaState(db, req.params.id);
        const payment = await paymentGatewayService.loadPaymentInstructions(db);
        const assignedUsers = await db.get(
            `SELECT COUNT(*) AS count FROM device_users WHERE device_id = ?`,
            [req.params.id]
        );

        res.json({
            success: true,
            device_id: req.params.id,
            offers: offers.map(packageService.serializeOffer),
            payment,
            current_package: snapshot.currentPackage,
            requests: snapshot.requests,
            quota: {
                sms_day_used: quota.usage.day,
                sms_month_used: quota.usage.month,
                sms_day_limit: Number(quota.limits?.sms_per_day || 0),
                sms_month_limit: Number(quota.limits?.sms_per_month || 0),
                api_requests_per_minute: Number(quota.limits?.api_requests_per_minute || 0),
                assigned_users_limit: Number(quota.limits?.assigned_users || 0),
                assigned_users_used: Number(assignedUsers?.count || 0)
            }
        });
    } catch (error) {
        logger.error('GET /api/devices/:id/package error:', error);
        res.status(500).json({ success: false, message: 'Failed to load device package details' });
    }
});

router.post('/:id/package/apply', [
    body('package_code').trim().notEmpty().withMessage('Package code is required').isLength({ max: 64 }),
    body('payment_reference').optional({ nullable: true }).trim().isLength({ max: 120 }),
    body('notes').optional({ nullable: true }).trim().isLength({ max: 500 })
], requireDeviceAccess('id'), async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const db = req.app.locals.db;
        const offers = await packageService.loadPackageOffers(db);
        const payment = await paymentGatewayService.loadPaymentInstructions(db);
        const offer = packageService.getPackageOffer(offers, req.body.package_code);
        if (!offer) {
            return res.status(404).json({ success: false, message: 'Package plan not found' });
        }

        const actorId = req.session?.user?.id || req.user?.id || null;
        if (!actorId) {
            return res.status(401).json({ success: false, message: 'Login required' });
        }

        const existingPending = await db.get(
            `SELECT id FROM device_package_requests
             WHERE device_id = ? AND user_id = ? AND status = 'pending'`,
            [req.params.id, actorId]
        );
        if (existingPending) {
            return res.status(400).json({ success: false, message: 'You already have a pending package request for this device' });
        }

        await db.run(
            `INSERT INTO device_package_requests
                (device_id, user_id, package_code, package_name, price_bdt, limits_json,
                 payment_method, payment_number, payment_reference, notes, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [
                req.params.id,
                actorId,
                offer.code,
                offer.name,
                Number(offer.priceBdt || 0),
                JSON.stringify(offer.limits || {}),
                String(payment.method || packageService.DEFAULT_PACKAGE_PAYMENT.method).toLowerCase(),
                payment.number || packageService.DEFAULT_PACKAGE_PAYMENT.number,
                req.body.payment_reference || null,
                req.body.notes || null
            ]
        );

        res.json({
            success: true,
            message: `Package request submitted. Complete the ${payment.method || 'payment'} payment and wait for admin approval.`,
            payment
        });
    } catch (error) {
        logger.error('POST /api/devices/:id/package/apply error:', error);
        res.status(500).json({ success: false, message: 'Failed to submit package request' });
    }
});

router.get('/:id/specs', requireDeviceAccess('id'), async (req, res) => {
    try {
        const db = req.app.locals.db;
        const row = await db.get(
            `SELECT d.id, d.name, d.type, d.status, d.last_seen, d.created_at, d.description,
                    dp.location, dp.apn, dp.mqtt_host, dp.mqtt_user, dp.local_ip,
                    dp.capabilities, dp.firmware_version, dp.model, dp.board, dp.probed_at, dp.updated_at,
                    dp.has_gps, dp.has_battery, dp.has_sd, dp.has_camera, dp.has_audio,
                    dp.has_display, dp.has_nfc, dp.has_rfid, dp.has_touch, dp.has_keyboard
             FROM devices d
             LEFT JOIN device_profiles dp ON dp.device_id = d.id
             WHERE d.id = ?`,
            [req.params.id]
        );

        if (!row) {
            return res.status(404).json({ success: false, message: 'Device not found' });
        }

        const caps = parseCapabilities(row);

        const live = global.modemService?.getDeviceStatus?.(req.params.id)
            || global.modemService?.getStatus?.(req.params.id)
            || {};
        const simInventory = await buildStoredSimSnapshot(db, req.params.id, live);

        const specs = buildDeviceSpecs({
            device: row,
            profile: row,
            live,
            caps
        });

        const moduleHealth = await getDeviceModuleHealth(db, req.params.id, caps, {
            mqttConnected: global.mqttService?.connected,
            live
        });
        const reportedBuild = caps?.specs?.build || {};

        res.json({
            success: true,
            deviceId: req.params.id,
            caps,
            live,
            simInventory,
            specs,
            moduleHealth,
            metadata: {
                firmware: row.firmware_version || null,
                model: row.model || live?.model || null,
                board: row.board || null,
                localIp: row.local_ip || null,
                probed: !!row.probed_at,
                probedAt: row.probed_at || null,
                updatedAt: row.updated_at || null,
                specSource: specs.detectionSource || 'unknown',
                buildDate: reportedBuild.date || null,
                buildTime: reportedBuild.time || null,
                gitHash: reportedBuild.gitHash || reportedBuild.git || null
            }
        });
    } catch (error) {
        logger.error('GET /api/devices/:id/specs error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch device specs' });
    }
});

// GET /api/devices/:id — dashboard settings/detail payload
router.get('/:id', requireDeviceAccess('id'), async (req, res) => {
    try {
        const db = req.app.locals.db;
        const row = await db.get(
            `SELECT d.id, d.name, d.type, d.status, d.last_seen, d.created_at, d.description,
                    dp.location, dp.apn, dp.wifi_ssid, dp.wifi_pass, dp.mqtt_host, dp.mqtt_user,
                    CASE WHEN dp.mqtt_pass IS NOT NULL AND dp.mqtt_pass != '' THEN 1 ELSE 0 END AS mqtt_pass_set,
                    dp.local_ip, dp.model, dp.board, dp.firmware_version, dp.updated_at
             FROM devices d
             LEFT JOIN device_profiles dp ON dp.device_id = d.id
             WHERE d.id = ?`,
            [req.params.id]
        );

        if (!row) {
            return res.status(404).json({ success: false, message: 'Device not found' });
        }

        const live = global.modemService?.getDeviceStatus?.(req.params.id)
            || global.modemService?.getStatus?.(req.params.id)
            || {};
        const effectiveMqtt = buildEffectiveMqttConfig(row);
        const simInventory = await buildStoredSimSnapshot(db, req.params.id, live);

        res.json({
            success: true,
            device: {
                ...row,
                model: row.model || live.model || null,
                mqtt_pass_set: Boolean(row.mqtt_pass_set),
                mqtt_effective: effectiveMqtt,
                online: !!live.online,
                uptime: live.uptime || null,
                activePath: live.activePath || null,
                operator: live.operator || simInventory.operator || null,
                simNumber: simInventory.simNumber,
                subscriberNumber: simInventory.subscriberNumber,
                simSlots: simInventory.simSlots,
                simSlotCount: simInventory.simSlotCount,
                dualSim: simInventory.dualSim,
                activeSimSlotIndex: simInventory.activeSimSlotIndex,
                sim: simInventory.sim,
                wifi: live.wifi || null,
                mqtt: live.mqtt || null,
                storage: live.storage || null
            }
        });
    } catch (error) {
        logger.error('GET /api/devices/:id error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch device' });
    }
});

router.get('/:id/sims', requireDeviceAccess('id'), async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceRow = await db.get(`SELECT id FROM devices WHERE id = ?`, [req.params.id]);
        if (!deviceRow) {
            return res.status(404).json({ success: false, message: 'Device not found' });
        }

        const live = global.modemService?.getDeviceStatus?.(req.params.id)
            || global.modemService?.getStatus?.(req.params.id)
            || {};
        const simInventory = await buildStoredSimSnapshot(db, req.params.id, live);

        res.json({
            success: true,
            deviceId: req.params.id,
            ...simInventory
        });
    } catch (error) {
        logger.error('GET /api/devices/:id/sims error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch SIM inventory' });
    }
});

/**
 * @swagger
 * /devices/{id}:
 *   put:
 *     summary: Update device name / location
 *     tags: [Devices]
 *     security:
 *       - sessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:     { type: string }
 *               location: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: Updated
 *   delete:
 *     summary: Delete a device (admin only)
 *     tags: [Devices]
 *     security:
 *       - sessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Deleted
 *       403:
 *         description: Admin access required
 */
// PUT /api/devices/:id — update device name/location (admin or assigned write-access)
router.put('/:id', [
    body('name').optional().trim().notEmpty().withMessage('Name cannot be empty').isLength({ max: 100 }),
    body('location').optional({ nullable: true }).trim().isLength({ max: 200 }),
    body('apn').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('wifi_ssid').optional({ nullable: true }).trim().isLength({ max: 64 }),
    body('wifi_pass').optional({ nullable: true }).isLength({ max: 64 }),
    body('mqtt_host').optional({ nullable: true }).trim().isLength({ max: 200 })
], requireDeviceAccess('id', true), async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }
        const db = req.app.locals.db;
        const { name, location, apn, wifi_ssid, wifi_pass, mqtt_host } = req.body;
        if (name !== undefined) {
            const result = await db.run(`UPDATE devices SET name = ? WHERE id = ?`, [name, req.params.id]);
            if (!result.changes) return res.status(404).json({ success: false, message: 'Device not found' });
            logger.info(`Device ${req.params.id} renamed to "${name}"`);
        }
        if (location !== undefined || apn !== undefined || wifi_ssid !== undefined || wifi_pass !== undefined || mqtt_host !== undefined) {
            await upsertDeviceProfileFields(db, req.params.id, {
                location,
                apn,
                wifi_ssid,
                wifi_pass,
                mqtt_host
            });
        }
        if (global.io) global.io.emit('device:updated', { id: req.params.id, ...req.body });
        res.json({ success: true });
    } catch (error) {
        logger.error('PUT /api/devices/:id error:', error);
        res.status(500).json({ success: false, message: 'Failed to update device' });
    }
});

router.post('/:id/runtime-config/apply', [
    body('apn').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('wifi_ssid').optional({ nullable: true }).trim().isLength({ max: 64 }),
    body('wifi_pass').optional({ nullable: true }).isLength({ max: 64 }),
    body('device_id_override').optional({ nullable: true }).trim().isLength({ max: 128 })
], requireDeviceAccess('id', true), async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const db = req.app.locals.db;
        const deviceId = req.params.id;
        const { apn, wifi_ssid, wifi_pass, device_id_override } = req.body;

        await upsertDeviceProfileFields(db, deviceId, {
            apn,
            wifi_ssid,
            wifi_pass,
            device_id_override
        });

        const storedProfile = await db.get(
            `SELECT apn, wifi_ssid, wifi_pass, device_id_override, mqtt_host, mqtt_user, mqtt_pass
             FROM device_profiles
             WHERE device_id = ?`,
            [deviceId]
        ) || {};
        const provisioningMqtt = resolveProvisioningMqttConfig(storedProfile);

        const config = {
            wifiSsid: storedProfile.wifi_ssid || '',
            wifiPassword: storedProfile.wifi_pass || '',
            modemApn: storedProfile.apn || '',
            mqttUri: provisioningMqtt.uri,
            mqttUsername: provisioningMqtt.username,
            mqttPassword: provisioningMqtt.password,
            mqttEnabled: provisioningMqtt.configured,
            modemFallbackEnabled: true
        };

        if (device_id_override !== undefined) {
            config.deviceIdOverride = device_id_override || '';
        } else if (storedProfile.device_id_override) {
            config.deviceIdOverride = storedProfile.device_id_override;
        }

        const outcome = await applyRuntimeConfigWithFallback(req, deviceId, config);
        if (!outcome.result) {
            return res.status(202).json({
                success: true,
                stored: true,
                applied: false,
                transport: outcome.transport,
                attempts: outcome.attempts,
                message: 'Profile saved. No live config transport accepted the update yet.'
            });
        }

        const compatibility = buildRuntimeConfigCompatibilityNotice(outcome.result);

        res.json({
            success: true,
            stored: true,
            applied: true,
            transport: outcome.transport,
            attempts: outcome.attempts,
            restartRequired: !!outcome.result.restartRequired,
            appliedFields: outcome.result.applied || [],
            compatibilityMode: outcome.result.compatibilityMode || null,
            skippedFields: outcome.result.skippedFields || [],
            partialApplied: compatibility.partialApplied,
            compatibilityWarning: compatibility.compatibilityWarning || null,
            skippedMqttFields: compatibility.skippedMqttFields || []
        });
    } catch (error) {
        logger.error('POST /api/devices/:id/runtime-config/apply error:', error);
        res.status(500).json({ success: false, message: 'Failed to apply runtime config' });
    }
});

router.get('/:id/runtime-config/read', requireDeviceAccess('id'), async (req, res) => {
    try {
        const outcome = await getRuntimeConfigWithFallback(req);
        if (!outcome.result) {
            return res.status(503).json({
                success: false,
                transport: outcome.transport,
                attempts: outcome.attempts,
                message: 'No config read transport is available on this dashboard host.'
            });
        }

        const config = outcome.result;
        return res.json({
            success: true,
            transport: outcome.transport,
            attempts: outcome.attempts,
            data: {
                device_id_override: config.deviceIdOverride || '',
                wifi_ssid: config.wifiSsid || '',
                wifi_password_set: !!config.wifiPasswordSet,
                apn: config.modemApn || '',
                mqtt_enabled: config.mqttEnabled,
                modem_fallback_enabled: config.modemFallbackEnabled,
                mqtt_uri: config.mqttUri || '',
                mqtt_username: config.mqttUsername || '',
                mqtt_password_set: !!config.mqttPasswordSet,
                schema_version: config.schemaVersion
            }
        });
    } catch (error) {
        logger.warn(`Serial runtime config read failed for ${req.params.id}: ${error.message}`);
        return res.status(502).json({
            success: false,
            transport: 'serial',
            message: error.message || 'Failed to read runtime config over serial'
        });
    }
});

router.get('/:id/hotspot-diagnostics', requireDeviceAccess('id'), async (req, res) => {
    try {
        const db = req.app.locals.db;
        const profile = await db.get(
            `SELECT wifi_ssid, wifi_pass
             FROM device_profiles
             WHERE device_id = ?`,
            [req.params.id]
        );
        const desiredSsid = normalizeSsid(profile?.wifi_ssid);
        const desiredPassword = String(profile?.wifi_pass || '');
        const hostScan = await readHostScanSummary(hostHotspotService, desiredSsid);

        if (!hostHotspotService.getPlatformSupport().supported) {
            return res.status(501).json({
                success: false,
                platformSupport: hostHotspotService.getPlatformSupport(),
                data: {
                    platformSupport: hostHotspotService.getPlatformSupport(),
                    desiredSsid,
                    desiredPasswordSet: desiredPassword.length > 0,
                    hostScan
                },
                message: 'Host hotspot diagnostics are not implemented for this dashboard host platform yet.'
            });
        }

        const { hosted, security, support } = await hostHotspotService.readState();
        if (support?.supported === false) {
            return res.status(501).json({
                success: false,
                platformSupport: support,
                data: {
                    platformSupport: support,
                    desiredSsid,
                    desiredPasswordSet: desiredPassword.length > 0,
                    hostedSsid: hosted.ssid,
                    hostedStatus: hosted.status,
                    hostScan
                },
                message: 'This dashboard host cannot manage a Windows hosted-network hotspot with the current Wi-Fi adapter.'
            });
        }

        return res.json({
            success: true,
            data: {
                platformSupport: support,
                desiredSsid,
                hostedSsid: hosted.ssid,
                hostedStatus: hosted.status,
                matchesDesired: !!hosted.ssid && hosted.ssid === desiredSsid,
                desiredPasswordSet: desiredPassword.length > 0,
                hostedPasswordKnown: security.userSecurityKey.length > 0,
                passwordMatchesDesired: !!security.userSecurityKey && security.userSecurityKey === desiredPassword,
                hostScan
            }
        });
    } catch (error) {
        logger.warn(`Hotspot diagnostics failed for ${req.params.id}: ${error.message}`);
        return res.status(502).json({
            success: false,
            message: 'Failed to read host hotspot settings from this dashboard host.'
        });
    }
});

router.post('/:id/runtime-config/use-host-hotspot', [
    body('apply').optional().isBoolean()
], requireDeviceAccess('id', true), async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        if (!hostHotspotService.getPlatformSupport().supported) {
            return res.status(501).json({
                success: false,
                platformSupport: hostHotspotService.getPlatformSupport(),
                message: 'Host hotspot sync is not implemented for this dashboard host platform yet.'
            });
        }

        const { hosted, security, support } = await hostHotspotService.readState();
        if (support?.supported === false) {
            return res.status(501).json({
                success: false,
                platformSupport: support,
                message: 'This dashboard host cannot manage a Windows hosted-network hotspot with the current Wi-Fi adapter.'
            });
        }
        const hostedSsid = String(hosted.ssid || '').trim();
        const hostedPassword = String(security.userSecurityKey || '');
        const applyToDevice = req.body.apply === true;

        if (!hostedSsid) {
            return res.status(409).json({
                success: false,
                message: 'This dashboard host does not currently have a hotspot SSID configured.'
            });
        }

        if (!hostedPassword) {
            return res.status(409).json({
                success: false,
                message: 'This dashboard host does not currently expose a hotspot security key.'
            });
        }

        const db = req.app.locals.db;
        const existingProfile = await db.get(
            `SELECT apn, mqtt_host, mqtt_user, mqtt_pass
             FROM device_profiles
             WHERE device_id = ?`,
            [req.params.id]
        ) || {};
        const provisioningMqtt = resolveProvisioningMqttConfig(existingProfile);
        await upsertDeviceProfileFields(db, req.params.id, {
            wifi_ssid: hostedSsid,
            wifi_pass: hostedPassword
        });

        if (!applyToDevice) {
            return res.json({
                success: true,
                stored: true,
                applied: false,
                transport: 'stored_only',
                data: {
                    platformSupport: support,
                    wifi_ssid: hostedSsid,
                    wifi_password_set: true,
                    hosted_status: hosted.status || ''
                },
                message: 'Dashboard profile updated from this host hotspot.'
            });
        }

        const outcome = await applyRuntimeConfigWithFallback(req, req.params.id, {
            wifiSsid: hostedSsid,
            wifiPassword: hostedPassword,
            modemApn: String(existingProfile.apn || ''),
            mqttUri: provisioningMqtt.uri,
            mqttUsername: provisioningMqtt.username,
            mqttPassword: provisioningMqtt.password,
            mqttEnabled: provisioningMqtt.configured,
            modemFallbackEnabled: true
        });
        if (!outcome.result) {
            return res.status(202).json({
                success: true,
                stored: true,
                applied: false,
                transport: outcome.transport,
                attempts: outcome.attempts,
                data: {
                    platformSupport: support,
                    wifi_ssid: hostedSsid,
                    wifi_password_set: true,
                    hosted_status: hosted.status || ''
                },
                message: 'Dashboard profile updated from this host hotspot, but no live config transport accepted the update yet.'
            });
        }

        return res.json({
            success: true,
            stored: true,
            applied: true,
            transport: outcome.transport,
            attempts: outcome.attempts,
            restartRequired: !!outcome.result.restartRequired,
            appliedFields: outcome.result.applied || [],
            compatibilityMode: outcome.result.compatibilityMode || null,
            skippedFields: outcome.result.skippedFields || [],
            data: {
                platformSupport: support,
                wifi_ssid: hostedSsid,
                wifi_password_set: true,
                hosted_status: hosted.status || ''
            },
            message: `Dashboard profile updated from this host hotspot and applied to the device over ${outcome.transport}.`
        });
    } catch (error) {
        logger.warn(`Host hotspot sync failed for ${req.params.id}: ${error.message}`);
        return res.status(502).json({
            success: false,
            message: 'Failed to read host hotspot settings from this dashboard host.'
        });
    }
});

router.post('/:id/hotspot/configure-host', [
    body('start').optional().isBoolean()
], requireDeviceAccess('id', true), async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        if (!hostHotspotService.getPlatformSupport().supported) {
            return res.status(501).json({
                success: false,
                platformSupport: hostHotspotService.getPlatformSupport(),
                message: 'Host hotspot configuration is not implemented for this dashboard host platform yet.'
            });
        }

        const db = req.app.locals.db;
        const profile = await db.get(
            `SELECT wifi_ssid, wifi_pass
             FROM device_profiles
             WHERE device_id = ?`,
            [req.params.id]
        ) || {};

        const wifiSsid = String(profile.wifi_ssid || '').trim();
        const wifiPass = String(profile.wifi_pass || '');
        if (!wifiSsid) {
            return res.status(409).json({
                success: false,
                message: 'This device profile does not currently have a Wi-Fi SSID saved.'
            });
        }
        if (!wifiPass) {
            return res.status(409).json({
                success: false,
                message: 'This device profile does not currently have a Wi-Fi password saved.'
            });
        }

        const startHotspot = req.body.start === true;
        const result = await hostHotspotService.configure({
            ssid: wifiSsid,
            password: wifiPass,
            start: startHotspot
        });
        const { hosted, support } = await hostHotspotService.readState();

        return res.json({
            success: true,
            data: {
                platformSupport: support,
                wifi_ssid: wifiSsid,
                wifi_password_set: true,
                hosted_status: hosted.status || '',
                hosted_ssid: hosted.ssid || wifiSsid,
                started: result.started
            },
            message: startHotspot
                ? 'Host hotspot configured from the device profile and a start was attempted.'
                : 'Host hotspot configured from the device profile.'
        });
    } catch (error) {
        if (error.code === 'hosted_network_not_supported') {
            return res.status(501).json({
                success: false,
                platformSupport: {
                    platform: 'win32',
                    supported: false,
                    label: 'Windows hosted network',
                    reason: 'hosted_network_not_supported'
                },
                message: 'This Windows Wi-Fi adapter does not support the legacy hosted network API. Turn on Windows Mobile Hotspot manually, or use another Wi-Fi adapter.'
            });
        }

        logger.warn(`Host hotspot configure failed for ${req.params.id}: ${error.message}`);
        return res.status(502).json({
            success: false,
            message: 'Failed to configure host hotspot settings on this dashboard host.'
        });
    }
});

// DELETE /api/devices/:id — admin only
router.delete('/:id', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const deviceId = normalizeDeviceId(req.params.id);
    if (!deviceId) {
        return res.status(400).json({ success: false, message: 'Device ID required' });
    }
    let deletedDeviceSuppressed = false;
    try {
        const db = req.app.locals.db;
        await db.run('BEGIN');
        await cleanupDeviceAssociations(db, deviceId);
        await req.app.locals.mqttHandlers?.suppressDeletedDevice?.(deviceId);
        deletedDeviceSuppressed = true;
        const result = await db.run(`DELETE FROM devices WHERE id = ?`, [deviceId]);
        await db.run('COMMIT');
        await req.app.locals.mqttHandlers?.releaseDeviceRuntime?.(deviceId);
        if (result.changes) {
            logger.info(`Device record deleted: ${deviceId}`);
        } else {
            logger.info(`Device delete finalized with suppression only: ${deviceId}`);
        }
        if (global.io) global.io.emit('device:deleted', { id: deviceId });
        res.json({
            success: true,
            suppressed: true,
            deleted: Boolean(result.changes),
            message: result.changes ? 'Device deleted' : 'Device suppressed and any remaining state was cleared'
        });
    } catch (error) {
        try { await req.app.locals.db.run('ROLLBACK'); } catch (_) {}
        if (deletedDeviceSuppressed) {
            try { await req.app.locals.mqttHandlers?.unsuppressDeletedDevice?.(deviceId); } catch (_) {}
        }
        logger.error('DELETE /api/devices/:id error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete device' });
    }
});

router.put('/:id/push-token', [
    body('token').optional().trim().isLength({ max: 4096 }),
    body('pushToken').optional().trim().isLength({ max: 4096 }),
    body('platform').optional().trim().isIn(['android', 'ios', 'web', 'unknown']),
    body('appId').optional({ nullable: true }).trim().isLength({ max: 200 }),
    body('enabled').optional().isBoolean()
], requireDeviceAccess('id', true), async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: errors.array()[0].msg });
        }

        const db = req.app.locals.db;
        const token = String(req.body.token || req.body.pushToken || '').trim();
        const enabled = req.body.enabled !== false;

        if (!token) {
            await db.run(
                `UPDATE device_push_tokens
                 SET is_active = 0, updated_at = CURRENT_TIMESTAMP
                 WHERE device_id = ?`,
                [req.params.id]
            );
            return res.json({ success: true, message: 'Push tokens disabled for device' });
        }

        await db.run(
            `INSERT INTO device_push_tokens
                (device_id, push_token, platform, app_id, is_active, last_seen_at, updated_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(device_id, push_token) DO UPDATE SET
                platform = excluded.platform,
                app_id = COALESCE(excluded.app_id, device_push_tokens.app_id),
                is_active = excluded.is_active,
                last_seen_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP`,
            [
                req.params.id,
                token,
                req.body.platform || 'unknown',
                req.body.appId || null,
                enabled ? 1 : 0
            ]
        );

        res.json({ success: true, message: 'Push token saved' });
    } catch (error) {
        logger.error('PUT /api/devices/:id/push-token error:', error);
        res.status(500).json({ success: false, message: 'Failed to save push token' });
    }
});

router.put('/:id/link-to/:targetId', async (req, res) => {
    if (!requireAdmin(req, res)) return;

    try {
        const db = req.app.locals.db;
        const [phoneDevice, targetDevice] = await Promise.all([
            db.get(`SELECT id FROM devices WHERE id = ?`, [req.params.id]),
            db.get(`SELECT id FROM devices WHERE id = ?`, [req.params.targetId])
        ]);

        if (!phoneDevice || !targetDevice) {
            return res.status(404).json({ success: false, message: 'Source or target device not found' });
        }

        await db.run(
            `INSERT INTO phone_device_links (phone_device_id, target_device_id, updated_at)
             VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(phone_device_id, target_device_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`,
            [req.params.id, req.params.targetId]
        );

        res.json({
            success: true,
            link: {
                phoneDeviceId: req.params.id,
                targetDeviceId: req.params.targetId
            }
        });
    } catch (error) {
        logger.error('PUT /api/devices/:id/link-to/:targetId error:', error);
        res.status(500).json({ success: false, message: 'Failed to link devices' });
    }
});

// GET /api/devices/:id/users — list users assigned to this device (admin only)
router.get('/:id/users', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const db = req.app.locals.db;
        const users = await db.all(`
            SELECT u.id, u.username, u.name, u.role, du.can_write, du.assigned_at
            FROM device_users du
            INNER JOIN users u ON u.id = du.user_id
            WHERE du.device_id = ?
            ORDER BY du.assigned_at ASC
        `, [req.params.id]);
        res.json({ success: true, users });
    } catch (error) {
        logger.error('GET /api/devices/:id/users error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch device users' });
    }
});

// POST /api/devices/:id/users — assign a user to this device (admin only)
router.post('/:id/users', [
    body('user_id').isInt({ min: 1 }).withMessage('Valid user_id required'),
    body('can_write').optional().isBoolean()
], async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });

        const db = req.app.locals.db;
        const canWrite = req.body.can_write !== false ? 1 : 0;
        await db.run(
            `INSERT INTO device_users (device_id, user_id, can_write) VALUES (?, ?, ?)
             ON CONFLICT(device_id, user_id) DO UPDATE SET can_write = excluded.can_write`,
            [req.params.id, req.body.user_id, canWrite]
        );
        logger.info(`User ${req.body.user_id} assigned to device ${req.params.id} (can_write=${canWrite})`);
        res.json({ success: true });
    } catch (error) {
        logger.error('POST /api/devices/:id/users error:', error);
        res.status(500).json({ success: false, message: 'Failed to assign user' });
    }
});

// DELETE /api/devices/:id/users/:userId — unassign a user from this device (admin only)
router.delete('/:id/users/:userId', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(userId) || userId < 1) {
        return res.status(400).json({ success: false, message: 'Invalid user id' });
    }
    try {
        const db = req.app.locals.db;
        await db.run(
            `DELETE FROM device_users WHERE device_id = ? AND user_id = ?`,
            [req.params.id, userId]
        );
        res.json({ success: true });
    } catch (error) {
        logger.error('DELETE /api/devices/:id/users/:userId error:', error);
        res.status(500).json({ success: false, message: 'Failed to unassign user' });
    }
});

// ── Same-network direct WiFi ──────────────────────────────────────────────────

/**
 * @swagger
 * /devices/{id}/local-ip:
 *   get:
 *     summary: Get device local IP address
 *     tags: [Devices]
 *     security:
 *       - sessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Local IP and reachability status
 *   put:
 *     summary: Set device local IP address
 *     tags: [Devices]
 *     security:
 *       - sessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               local_ip: { type: string, example: "192.168.1.42" }
 *     responses:
 *       200:
 *         description: Saved
 */
router.get('/:id/local-ip', async (req, res) => {
    try {
        const row = await req.app.locals.db.get(
            `SELECT local_ip FROM device_profiles WHERE device_id = ?`,
            [req.params.id]
        );
        res.json({ success: true, data: { local_ip: row?.local_ip || null } });
    } catch (error) {
        logger.error('GET local-ip error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch local IP' });
    }
});

router.put('/:id/local-ip', [
    body('local_ip').optional({ nullable: true }).trim()
        .matches(/^(\d{1,3}\.){3}\d{1,3}$|^$/).withMessage('Invalid IPv4 address')
        .isLength({ max: 15 })
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });
    try {
        await req.app.locals.db.run(
            `INSERT INTO device_profiles (device_id, local_ip, updated_at)
             VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(device_id) DO UPDATE SET local_ip = excluded.local_ip, updated_at = CURRENT_TIMESTAMP`,
            [req.params.id, req.body.local_ip || null]
        );
        res.json({ success: true });
    } catch (error) {
        logger.error('PUT local-ip error:', error);
        res.status(500).json({ success: false, message: 'Failed to save local IP' });
    }
});

/**
 * @swagger
 * /devices/{id}/direct:
 *   get:
 *     summary: Proxy a GET request to device's local HTTP API
 *     description: |
 *       Server-side proxy: fetches `http://{local_ip}/{path}` and returns the response.
 *       Requires the local IP to be set first. The device must expose an HTTP API
 *       (e.g. when in WiFi-AP setup mode or when on the same LAN).
 *     tags: [Devices]
 *     security:
 *       - sessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: path
 *         schema: { type: string, default: "status" }
 *         description: Path on the device HTTP API (no leading slash)
 *     responses:
 *       200:
 *         description: Response from device
 *       502:
 *         description: Device unreachable
 *       404:
 *         description: No local IP configured
 */
router.get('/:id/direct', async (req, res) => {
    try {
        const row = await req.app.locals.db.get(
            `SELECT local_ip FROM device_profiles WHERE device_id = ?`,
            [req.params.id]
        );
        if (!row?.local_ip) {
            return res.status(404).json({ success: false, message: 'No local IP configured for this device' });
        }

        const urlPath = (req.query.path || 'status')
            .replace(/^\/+/, '')       // strip leading slashes
            .replace(/\.\./g, '')      // strip directory traversal
            .replace(/[^a-zA-Z0-9\-_./]/g, ''); // allow only safe chars
        const targetUrl = `http://${row.local_ip}/${urlPath}`;

        const http = require('http');
        const result = await new Promise((resolve) => {
            const request = http.get(targetUrl, { timeout: 5000 }, (response) => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => { body += chunk; });
                response.on('end', () => resolve({ status: response.statusCode, body }));
            });
            request.on('error', (err) => resolve({ status: 0, error: err.message }));
            request.on('timeout', () => { request.destroy(); resolve({ status: 0, error: 'Timeout' }); });
        });

        if (!result.status) {
            return res.status(502).json({ success: false, message: `Device unreachable: ${result.error}` });
        }

        let data;
        try { data = JSON.parse(result.body); } catch { data = result.body; }
        res.status(result.status).json({ success: true, data });
    } catch (error) {
        logger.error('GET /devices/:id/direct error:', error);
        res.status(500).json({ success: false, message: 'Proxy error' });
    }
});

// ── MQTT credentials ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /devices/{id}/mqtt-credentials:
 *   get:
 *     summary: Get per-device MQTT credentials (admin only)
 *     description: Returns mqtt_user; mqtt_pass is masked as "••••••••" when set.
 *     tags: [Devices]
 *     security:
 *       - sessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Credentials
 *   put:
 *     summary: Set per-device MQTT credentials (admin only)
 *     tags: [Devices]
 *     security:
 *       - sessionCookie: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mqtt_user: { type: string }
 *               mqtt_pass: { type: string }
 *     responses:
 *       200:
 *         description: Saved
 */
router.get('/:id/mqtt-credentials', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const row = await req.app.locals.db.get(
            `SELECT mqtt_user, mqtt_pass FROM device_profiles WHERE device_id = ?`,
            [req.params.id]
        );
        res.json({
            success: true,
            data: {
                mqtt_user: row?.mqtt_user || '',
                mqtt_pass_set: !!(row?.mqtt_pass)
            }
        });
    } catch (error) {
        logger.error('GET mqtt-credentials error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch credentials' });
    }
});

router.put('/:id/mqtt-credentials', [
    body('mqtt_host').optional({ nullable: true }).trim().isLength({ max: 200 }),
    body('mqtt_user').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('mqtt_pass').optional({ nullable: true }).isLength({ max: 200 })
], async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });
    try {
        const { mqtt_host, mqtt_user, mqtt_pass } = req.body;
        await req.app.locals.db.run(
            `INSERT INTO device_profiles (device_id, mqtt_host, mqtt_user, mqtt_pass, updated_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(device_id) DO UPDATE SET
                 mqtt_host  = COALESCE(excluded.mqtt_host, mqtt_host),
                 mqtt_user  = COALESCE(excluded.mqtt_user, mqtt_user),
                 mqtt_pass  = COALESCE(excluded.mqtt_pass, mqtt_pass),
                 updated_at = CURRENT_TIMESTAMP`,
            [req.params.id, mqtt_host || null, mqtt_user || null, mqtt_pass || null]
        );
        logger.info(`MQTT credentials updated for device ${req.params.id}`);
        res.json({ success: true });
    } catch (error) {
        logger.error('PUT mqtt-credentials error:', error);
        res.status(500).json({ success: false, message: 'Failed to save credentials' });
    }
});

function splitMqttUri(uri, fallbackPort = DEFAULT_MQTT_PORT) {
    const normalizedUri = buildMqttUri(uri, fallbackPort);
    if (!normalizedUri) {
        return { uri: '', protocol: 'mqtt', host: '', port: fallbackPort, username: '', password: '' };
    }

    try {
        const parsed = new URL(normalizedUri);
        return {
            uri: normalizedUri,
            protocol: String(parsed.protocol || 'mqtt:').replace(/:$/, '') || 'mqtt',
            host: parsed.hostname || '',
            port: parseInt(parsed.port, 10) || fallbackPort,
            username: parsed.username ? decodeURIComponent(parsed.username) : '',
            password: parsed.password ? decodeURIComponent(parsed.password) : ''
        };
    } catch (_) {
        return {
            uri: normalizedUri,
            protocol: 'mqtt',
            host: String(uri || '').replace(/^[a-z]+:\/\//i, '').split(':')[0],
            port: fallbackPort,
            username: '',
            password: ''
        };
    }
}

async function loadProvisioningDevice(db, deviceId) {
    return db.get(
        `SELECT d.id, d.name, d.type, d.status,
                p.board, p.mqtt_host, p.mqtt_user, p.mqtt_pass, p.capabilities
         FROM devices d
         LEFT JOIN device_profiles p ON p.device_id = d.id
         WHERE d.id = ?`,
        [deviceId]
    );
}

function parseProvisioningCapabilities(device) {
    try {
        return device?.capabilities ? JSON.parse(device.capabilities) : {};
    } catch (_) {
        return {};
    }
}

function buildAndroidRecoveryProvisioning(req, device, apiKey = '') {
    const transportMode = 'auto';
    const mqtt = resolveProvisioningMqttConfig(device);
    const parsedMqtt = splitMqttUri(mqtt.uri, process.env.MQTT_PORT || DEFAULT_MQTT_PORT);
    const mqttUsername = mqtt.username || parsedMqtt.username || '';
    const mqttPassword = mqtt.password || parsedMqtt.password || '';

    return {
        schema: 'iot.android-bridge.v1',
        generated_at: new Date().toISOString(),
        server_url: normalizePublicBaseUrl(req),
        api_key: apiKey,
        transport: {
            mode: transportMode
        },
        device: {
            id: device.id,
            name: device.name || device.id,
            topic_prefix: DEFAULT_TOPIC_PREFIX
        },
        mqtt: {
            uri: parsedMqtt.uri,
            host: parsedMqtt.host,
            ip: parsedMqtt.host,
            port: parsedMqtt.port,
            protocol: parsedMqtt.protocol,
            username: mqttUsername,
            password: mqttPassword
        }
    };
}

function buildAndroidProvisioningSummary(payload, apiKeyName = '') {
    return {
        transport_mode: payload?.transport?.mode || 'auto',
        device_id: payload?.device?.id || '',
        topic_prefix: payload?.device?.topic_prefix || DEFAULT_TOPIC_PREFIX,
        server_url: payload?.server_url || '',
        mqtt_configured: Boolean(payload?.mqtt?.host || payload?.mqtt?.uri),
        api_key_name: apiKeyName
    };
}

// GET /api/devices/:id/provisioning-qr - recovery QR for Android onboarding gaps
router.get('/:id/provisioning-qr', requireDeviceAccess('id'), async (req, res) => {
    try {
        const db = req.app.locals.db;
        const device = await loadProvisioningDevice(db, req.params.id);
        if (!device) {
            return res.status(404).json({ success: false, message: 'Device not found' });
        }

        const lane = classifyDeviceLane(device);
        const serverUrl = normalizePublicBaseUrl(req);
        if (lane === 'android') {
            let apiKey = '';
            let apiKeyName = '';
            const userId = req.session?.user?.id || req.user?.id;
            if (userId) {
                apiKey = generateApiKey();
                const keyPrefix = apiKey.substring(0, 12);
                apiKeyName = `Android ${device.name || device.id} recovery`;
                await db.run(
                    `INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, device_ids, expires_at, rate_limit_rpm)
                     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
                    [userId, apiKeyName, hashApiKey(apiKey), keyPrefix, 'write', JSON.stringify([device.id]), 120]
                );
            }
            const payload = buildAndroidRecoveryProvisioning(req, device, apiKey);
            const token = encodeProvisioningToken(payload);
            const qrDataUrl = await QRCode.toDataURL(token, {
                errorCorrectionLevel: 'M',
                margin: 1,
                width: 280
            });

            return res.json({
                success: true,
                lane,
                device_id: device.id,
                qr_data_url: qrDataUrl,
                qr_content_type: 'text/plain',
                setup_token: token,
                summary: buildAndroidProvisioningSummary(payload, apiKeyName)
            });
        }

        return res.json({
            success: true,
            lane,
            device_id: device.id,
            available: false,
            message: 'Recovery QR is only used for Android Bridge devices.'
        });
    } catch (error) {
        logger.error('GET provisioning-qr error:', error);
        res.status(500).json({ success: false, message: 'Failed to build provisioning QR' });
    }
});

// GET /api/devices/:id/capabilities — return capability profile for a device
router.get('/:id/capabilities', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const row = await db.get(
            `SELECT capabilities, firmware_version, board,
                    has_gps, has_battery, has_sd, has_camera, has_audio,
                    has_display, has_nfc, has_rfid, has_touch, has_keyboard,
                    probed_at, updated_at
             FROM device_profiles WHERE device_id = ?`,
            [req.params.id]
        );
        if (!row) {
            return res.json({ success: true, deviceId: req.params.id, caps: {}, probed: false });
        }
        const caps = parseCapabilities(row);
        res.json({
            success: true,
            deviceId: req.params.id,
            firmware: row.firmware_version,
            board: row.board,
            caps,
            probed: !!row.probed_at,
            probedAt: row.probed_at,
            updatedAt: row.updated_at
        });
    } catch (error) {
        logger.error('GET /api/devices/:id/capabilities error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch capabilities' });
    }
});

// PUT /api/devices/:id/capabilities — admin override of capability flags
router.put('/:id/capabilities', async (req, res) => {
    try {
        const db = req.app.locals.db;
        const deviceId = req.params.id;
        const caps = req.body; // { gps: true, battery: true, ... }
        const fields = ['has_gps','has_battery','has_sd','has_camera','has_audio','has_display','has_nfc','has_rfid','has_touch','has_keyboard'];
        const updates = [];
        const vals = [];
        for (const f of fields) {
            const key = f.replace('has_', '');
            if (key in caps) { updates.push(`${f} = ?`); vals.push(caps[key] ? 1 : 0); }
        }
        if (updates.length === 0) return res.status(400).json({ success: false, message: 'No valid capability fields provided' });
        vals.push(deviceId);
        await db.run(
            `INSERT INTO device_profiles (device_id, updated_at) VALUES (?, CURRENT_TIMESTAMP)
             ON CONFLICT(device_id) DO UPDATE SET ${updates.join(', ')}, updated_at=CURRENT_TIMESTAMP`,
            [...vals.slice(0, -1), deviceId]
        );
        if (global.io) {
            const room = global.io.to?.('device:' + deviceId);
            if (room?.emit) room.emit('device:capabilities-updated', { deviceId, caps });
            else global.io.emit?.('device:capabilities-updated', { deviceId, caps });
        }
        res.json({ success: true, message: 'Capabilities updated' });
    } catch (error) {
        logger.error('PUT /api/devices/:id/capabilities error:', error);
        res.status(500).json({ success: false, message: 'Failed to update capabilities' });
    }
});

module.exports = router;
