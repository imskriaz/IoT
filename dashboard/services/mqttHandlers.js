const logger = require('../utils/logger');
const smsCache = require('./smsCache');
const notificationService = require('./notificationService');
const pushNotificationService = require('./pushNotificationService');
const { attachSmsToConversation } = require('./smsConversations');
const {
    formatPhoneNumber,
    getPhoneLookupKeys,
    sqlNormalizePhone,
    sqlPhoneLastDigits
} = require('../utils/phoneNumber');
const {
    markModuleFailure,
    markModuleSuccess,
    upsertModuleHealth
} = require('../utils/moduleHealth');
const { buildDashboardDeviceStatus } = require('../utils/dashboardStatus');
const { sanitizeStoredCapabilities, isCapabilityAvailable } = require('../utils/deviceCapabilities');
const { persistDeviceStatusCache } = require('../utils/deviceStatusCache');
const {
    saveCapture
} = require('./webcamCaptureService');
const { syncDeviceSimInventory } = require('./simInventoryService');
const { parseUssdMenuOptions } = require('../utils/ussdSession');
const { extractSimScope, appendSimScopeCondition } = require('../utils/simScope');
const { normalizeSmsDeliveryPayload, normalizeSmsDeliveryReport, parseSmsMessageReference } = require('../utils/smsDeliveryReports');
const { normalizeMultipartMetadata, normalizeMultipartTimestamp } = require('../utils/smsMultipart');

const INITIAL_STATUS_PRIME_DELAY_MS = 20000;
const INITIAL_STATUS_PRIME_SPREAD_MS = 1000;

function normalizeStoredWifiSsid(value) {
    return String(value || '').trim();
}

async function readStoredWifiProfile(db, deviceId) {
    if (!db || typeof db.get !== 'function') {
        return null;
    }

    const profile = await db.get(
        `SELECT wifi_ssid, wifi_pass
         FROM device_profiles
         WHERE device_id = ?`,
        [deviceId]
    );

    if (!profile) {
        return null;
    }

    return {
        ssid: normalizeStoredWifiSsid(profile.wifi_ssid),
        password: String(profile.wifi_pass || ''),
        passwordSet: String(profile.wifi_pass || '').length > 0
    };
}

async function persistKnownWifiNetwork(db, deviceId, details = {}) {
    const ssid = normalizeStoredWifiSsid(details.ssid);
    if (!db || typeof db.run !== 'function' || !ssid) {
        return;
    }

    const security = String(details.security || '').trim() || null;
    const passwordProvided = details.password !== undefined;
    const password = passwordProvided ? String(details.password || '') : '';
    const passwordSet = passwordProvided ? (password.length > 0 ? 1 : 0) : 0;
    const connected = details.connected === true;
    const selected = details.selected === true;
    const countConnection = details.countConnection === true;
    const connectionCount = countConnection ? 1 : 0;
    const lastSignal = details.lastSignal == null ? null : Number(details.lastSignal);
    const lastChannel = details.lastChannel == null ? null : Number(details.lastChannel);
    const lastBssid = String(details.lastBssid || '').trim() || null;

    if (passwordProvided) {
        await db.run(
            `INSERT INTO device_wifi_networks
                (device_id, ssid, security, password, password_set, connection_count,
                 last_selected_at, last_connected_at, last_signal, last_channel, last_bssid, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
                     CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(device_id, ssid) DO UPDATE SET
                 security = COALESCE(excluded.security, device_wifi_networks.security),
                 password = excluded.password,
                 password_set = excluded.password_set,
                 connection_count = CASE
                     WHEN ? THEN device_wifi_networks.connection_count + 1
                     ELSE device_wifi_networks.connection_count
                 END,
                 last_selected_at = CASE
                     WHEN ? THEN CURRENT_TIMESTAMP
                     ELSE device_wifi_networks.last_selected_at
                 END,
                 last_connected_at = CASE
                     WHEN ? THEN CURRENT_TIMESTAMP
                     ELSE device_wifi_networks.last_connected_at
                 END,
                 last_signal = COALESCE(excluded.last_signal, device_wifi_networks.last_signal),
                 last_channel = COALESCE(excluded.last_channel, device_wifi_networks.last_channel),
                 last_bssid = COALESCE(excluded.last_bssid, device_wifi_networks.last_bssid),
                 updated_at = CURRENT_TIMESTAMP`,
            [
                deviceId,
                ssid,
                security,
                password,
                passwordSet,
                connectionCount,
                selected ? 1 : 0,
                connected ? 1 : 0,
                lastSignal,
                lastChannel,
                lastBssid,
                countConnection ? 1 : 0,
                selected ? 1 : 0,
                connected ? 1 : 0
            ]
        );
        return;
    }

    await db.run(
        `INSERT INTO device_wifi_networks
            (device_id, ssid, security, connection_count,
             last_selected_at, last_connected_at, last_signal, last_channel, last_bssid, updated_at)
         VALUES (?, ?, ?, ?, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
                 CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(device_id, ssid) DO UPDATE SET
             security = COALESCE(excluded.security, device_wifi_networks.security),
             connection_count = CASE
                 WHEN ? THEN device_wifi_networks.connection_count + 1
                 ELSE device_wifi_networks.connection_count
             END,
             last_selected_at = CASE
                 WHEN ? THEN CURRENT_TIMESTAMP
                 ELSE device_wifi_networks.last_selected_at
             END,
             last_connected_at = CASE
                 WHEN ? THEN CURRENT_TIMESTAMP
                 ELSE device_wifi_networks.last_connected_at
             END,
             last_signal = COALESCE(excluded.last_signal, device_wifi_networks.last_signal),
             last_channel = COALESCE(excluded.last_channel, device_wifi_networks.last_channel),
             last_bssid = COALESCE(excluded.last_bssid, device_wifi_networks.last_bssid),
             updated_at = CURRENT_TIMESTAMP`,
        [
            deviceId,
            ssid,
            security,
            connectionCount,
            selected ? 1 : 0,
            connected ? 1 : 0,
            lastSignal,
            lastChannel,
            lastBssid,
            countConnection ? 1 : 0,
            selected ? 1 : 0,
            connected ? 1 : 0
        ]
    );
}

// Decode UCS-2 BE hex string to Unicode text (used for SMS messages from modem PDU encoding)
function decodeUcs2Hex(hex) {
    if (typeof hex !== 'string') return hex;
    const clean = hex.trim();
    if (!/^[0-9A-Fa-f]+$/.test(clean) || clean.length % 4 !== 0 || clean.length < 4) return hex;
    try {
        const buf = Buffer.from(clean, 'hex');
        // Swap bytes from BE to LE for Node's utf16le decoder
        const le = Buffer.alloc(buf.length);
        for (let i = 0; i < buf.length; i += 2) le.writeUInt16LE(buf.readUInt16BE(i), i);
        const decoded = le.toString('utf16le');
        // Only use decoded if it looks like real text (no replacement chars, has printable content)
        if (!decoded.includes('\uFFFD') && /\S/.test(decoded)) return decoded;
    } catch (_) { /* ignore */ }
    return hex;
}

function normalizeSmsTimestamp(value) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) {
            const parsedMs = parseSmsTimestampMs(trimmed);
            if (Number.isFinite(parsedMs)) {
                const parsed = new Date(parsedMs);
                if (parsed.getFullYear() >= 2020) {
                    return parsed.toISOString();
                }
            }
        }
    }

    return new Date().toISOString();
}

function getSmsActionMessageIds(messageId) {
    const normalized = String(messageId || '').trim();
    if (!normalized) {
        return { messageId: '', baseMessageId: '', isPartMessage: false };
    }
    const baseMessageId = normalized.replace(/_p\d+$/i, '');
    return {
        messageId: normalized,
        baseMessageId,
        isPartMessage: baseMessageId !== normalized
    };
}

function parseSmsTimestampMs(value) {
    const text = String(value || '').trim();
    if (!text) return NaN;

    const isoLikeWithoutZone = text.replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(isoLikeWithoutZone)) {
        return Date.parse(`${isoLikeWithoutZone}Z`);
    }

    return Date.parse(text);
}

function formatUptime(seconds) {
    if (seconds === null || seconds === undefined || seconds === '') return null;
    if (typeof seconds === 'string') {
        const text = seconds.trim();
        if (!text) return null;
        if (/[dhms]/i.test(text)) return text;
        if (!/^\d+$/.test(text)) return null;
        seconds = Number(text);
    }
    if (Number.isNaN(Number(seconds))) return null;
    const s = Math.floor(Number(seconds));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60) % 60;
    const h = Math.floor(s / 3600) % 24;
    const d = Math.floor(s / 86400);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function extractSubscriberNumberFromText(text) {
    if (typeof text !== 'string') return null;

    const candidates = [text, decodeUcs2Hex(text)]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean);

    for (const candidateText of candidates) {
        // Do not let a newline join the phone number with a USSD menu index.
        const matches = candidateText.match(/\+?\d[\d \t()-]{6,}\d/g) || [];
        for (const candidate of matches) {
            const normalized = formatPhoneNumber(candidate);
            if (normalized) {
                return normalized;
            }
        }
    }

    return null;
}

const CALL_PHONE_SQL = sqlNormalizePhone('phone_number');
const CALL_LAST10_SQL = sqlPhoneLastDigits('phone_number');

function cleanText(value) {
    return String(value || '').trim();
}

function isSyncPayload(data = {}) {
    const detail = cleanText(data.detail).toLowerCase();
    const type = cleanText(data.type).toLowerCase();
    return data.sync === true ||
        cleanText(data.sync).toLowerCase() === 'true' ||
        detail === 'incoming_sms_pull' ||
        type === 'sms_sync' ||
        type === 'sms_sync_message';
}

function boolFromPayload(value, fallback = false) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    const text = cleanText(value).toLowerCase();
    if (['true', '1', 'yes', 'read'].includes(text)) return true;
    if (['false', '0', 'no', 'unread'].includes(text)) return false;
    return fallback;
}

function smsExternalId(data = {}) {
    const raw = cleanText(data.external_id || data.externalId || data.message_id || data.messageId || data.local_id || data.localId);
    return raw || null;
}

function normalizeSmsStorageIndex(data = {}) {
    const value = data.storage_index ?? data.sms_storage_index ?? data.modem_storage_index ?? data.index;
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

function normalizeFirmwareSmsStorageId(data = {}) {
    const value = data.storage_id ?? data.sms_storage_id ?? data.firmware_storage_id;
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function classifyCommandResult(data = {}) {
    const result = cleanText(data.result || data.status).toLowerCase();
    if (result === 'completed') {
        return { result, terminal: true, successful: true };
    }
    if (['failed', 'rejected', 'timeout', 'error'].includes(result)) {
        return { result, terminal: true, successful: false };
    }
    // A positive boolean is transport/envelope metadata, not execution proof.
    // Preserve the legacy explicit-failure fallback, but never promote a
    // missing, unknown, or progress result to terminal success.
    if (!result && data.success === false) {
        return { result, terminal: true, successful: false };
    }
    return { result, terminal: false, successful: false };
}

function normalizeEventTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        const millis = value > 100000000000 ? value : value * 1000;
        return new Date(millis).toISOString();
    }
    const raw = cleanText(value);
    if (!raw) return new Date().toISOString();
    if (/^\d+$/.test(raw)) {
        const numeric = Number(raw);
        const millis = numeric > 100000000000 ? numeric : numeric * 1000;
        return new Date(millis).toISOString();
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function toSqliteTimestamp(value) {
    return normalizeEventTimestamp(value).slice(0, 19).replace('T', ' ');
}

function normalizeCallStatus(value) {
    const status = cleanText(value).toLowerCase();
    if (!status) return 'ended';

    if (['online', 'active', 'offhook', 'in_call', 'incall'].includes(status)) {
        return 'connected';
    }

    if (['idle', 'hangup', 'hungup', 'disconnected', 'disconnect', 'completed'].includes(status)) {
        return 'ended';
    }

    return status;
}

async function upsertSyncedCallRecord(db, deviceId, data = {}, simScope = {}) {
    if (!db || !deviceId) return 0;

    const lookup = getPhoneLookupKeys(data.number);
    const storedNumber = lookup.formatted || cleanText(data.number) || 'Unknown';
    if (!storedNumber || storedNumber === 'Unknown') return 0;

    const status = normalizeCallStatus(data.status || 'ended');
    const direction = cleanText(data.direction).toLowerCase();
    const type = direction === 'outgoing' ? 'outgoing' : 'incoming';
    const duration = Number(data.duration ?? data.duration_seconds ?? 0);
    const nextDuration = Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : 0;
    const startTime = toSqliteTimestamp(data.start_time || data.timestamp || data.updatedAt);
    const startMillis = new Date(normalizeEventTimestamp(data.start_time || data.timestamp || data.updatedAt)).getTime();
    const terminalStatuses = ['ended', 'missed', 'rejected', 'busy', 'no_answer', 'blocked', 'voicemail'];
    const endTime = terminalStatuses.includes(status)
        ? new Date(startMillis + (nextDuration * 1000)).toISOString().slice(0, 19).replace('T', ' ')
        : null;
    const contactName = cleanText(data.contact_name || data.name);

    const conditions = ['device_id = ?', 'type = ?', 'start_time = ?'];
    const params = [deviceId, type, startTime];
    appendSimScopeCondition(conditions, params, simScope);
    if (lookup.digits) {
        conditions.push(`(${CALL_PHONE_SQL} = ? OR ${CALL_LAST10_SQL} = ?)`);
        params.push(lookup.digits, lookup.last10 || lookup.digits);
    } else {
        conditions.push('phone_number = ?');
        params.push(storedNumber);
    }

    const existing = await db.get(`
        SELECT id
        FROM calls
        WHERE ${conditions.join(' AND ')}
        ORDER BY id DESC
        LIMIT 1
    `, params);

    if (existing?.id) {
        const result = await db.run(`
            UPDATE calls
            SET phone_number = ?,
                contact_name = COALESCE(NULLIF(?, ''), contact_name),
                status = ?,
                duration = ?,
                end_time = ?,
                missed = ?,
                sim_slot = COALESCE(sim_slot, ?)
            WHERE id = ?
        `, [
            storedNumber,
            contactName,
            status,
            nextDuration,
            endTime,
            status === 'missed' ? 1 : 0,
            simScope.simSlot,
            existing.id
        ]);
        return result.changes || 0;
    }

    const result = await db.run(`
        INSERT INTO calls (device_id, phone_number, contact_name, type, status, start_time, end_time, duration, missed, sim_slot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        deviceId,
        storedNumber,
        contactName || null,
        type,
        status,
        startTime,
        endTime,
        nextDuration,
        status === 'missed' ? 1 : 0,
        simScope.simSlot
    ]);
    return result.lastID ? 1 : 0;
}

async function ensureIncomingCallRecord(db, deviceId, rawNumber, simScope = {}) {
    if (!db || !deviceId) return null;

    const lookup = getPhoneLookupKeys(rawNumber);
    const storedNumber = lookup.formatted || String(rawNumber || '').trim();
    if (!storedNumber) return null;

    let existing = null;
    if (lookup.digits) {
        const conditions = [
            'device_id = ?',
            "type = 'incoming'",
            "status IN ('ringing', 'connected', 'answered')",
            `(${CALL_PHONE_SQL} = ? OR ${CALL_LAST10_SQL} = ?)`
        ];
        const params = [deviceId, lookup.digits, lookup.last10 || lookup.digits];
        appendSimScopeCondition(conditions, params, simScope);
        existing = await db.get(`
            SELECT id
            FROM calls
            WHERE ${conditions.join(' AND ')}
            ORDER BY start_time DESC
            LIMIT 1
        `, params);
    } else {
        const conditions = [
            'device_id = ?',
            "type = 'incoming'",
            'phone_number = ?',
            "status IN ('ringing', 'connected', 'answered')"
        ];
        const params = [deviceId, storedNumber];
        appendSimScopeCondition(conditions, params, simScope);
        existing = await db.get(`
            SELECT id
            FROM calls
            WHERE ${conditions.join(' AND ')}
            ORDER BY start_time DESC
            LIMIT 1
        `, params);
    }

    if (existing?.id) return existing.id;

    const result = await db.run(`
        INSERT INTO calls (device_id, phone_number, type, status, start_time, missed, sim_slot)
        VALUES (?, ?, 'incoming', 'ringing', CURRENT_TIMESTAMP, 0, ?)
    `, [deviceId, storedNumber, simScope.simSlot]);

    return result.lastID || null;
}

async function updateLatestActiveCall(db, deviceId, data = {}) {
    if (!db || !deviceId) return 0;

    const simScope = extractSimScope(data);
    if (isSyncPayload(data)) {
        return upsertSyncedCallRecord(db, deviceId, data, simScope);
    }

    const status = normalizeCallStatus(data.status || 'ended');
    const duration = Number(data.duration);
    const nextDuration = Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : 0;
    const lookup = getPhoneLookupKeys(data.number);
    const hasPhoneMatch = Boolean(lookup.digits);
    const activeStatuses = `('dialing', 'ringing', 'connected', 'answered', 'ending', 'online')`;
    const setParts = ['status = ?', 'duration = ?'];
    const baseParams = [status, nextDuration];
    if (simScope.simSlot !== null) {
        setParts.push('sim_slot = COALESCE(sim_slot, ?)');
        baseParams.push(simScope.simSlot);
    }

    if (['ended', 'missed', 'rejected', 'busy', 'no_answer'].includes(status)) {
        setParts.push('end_time = CURRENT_TIMESTAMP');
    }
    if (status === 'missed') {
        setParts.push('missed = 1');
    }

    const runUpdate = async (includePhoneMatch) => {
        const conditions = ['device_id = ?', `status IN ${activeStatuses}`];
        const params = [...baseParams];
        const whereParams = [deviceId];
        appendSimScopeCondition(conditions, whereParams, simScope);

        if (includePhoneMatch && hasPhoneMatch) {
            conditions.push(`(${CALL_PHONE_SQL} = ? OR ${CALL_LAST10_SQL} = ?)`);
            whereParams.push(lookup.digits, lookup.last10 || lookup.digits);
        }
        params.push(...whereParams);

        return db.run(`
            UPDATE calls
            SET ${setParts.join(', ')}
            WHERE rowid = (
                SELECT rowid
                FROM calls
                WHERE ${conditions.join(' AND ')}
                ORDER BY start_time DESC
                LIMIT 1
            )
        `, params);
    };

    let result = await runUpdate(hasPhoneMatch);
    if (result.changes > 0) return result.changes;

    if (['ringing', 'answered', 'connected', 'missed', 'rejected'].includes(status)) {
        await ensureIncomingCallRecord(db, deviceId, data.number, simScope);
        result = await runUpdate(hasPhoneMatch);
        if (result.changes > 0) return result.changes;
    }

    result = await runUpdate(false);
    return result.changes || 0;
}

class MQTTHandlers {
    constructor(mqttService, io, app) {
        this.mqttService = mqttService;
        this.io = io;
        this.app = app;
        this.modemService = global.modemService;
        this.deletedDevices = new Set();
        // Debounce timers for high-frequency per-device events
        this._gpsDebounce = new Map(); // deviceId -> timeoutId
        this._registeredDeviceCache = new Map();
        this._lastConnectedWifiSsid = new Map();
        this._statusPrimeTimers = new Map();
    }

    hasFreshLiveDeviceState(deviceId) {
        const normalized = String(deviceId || '').trim();
        if (!normalized) {
            return false;
        }
        /* modemService may be hydrated from the database with a still-fresh
         * timestamp. Only mqttService has observed this device during the
         * current broker session, so cached online state must not suppress the
         * startup get-status prime after a dashboard restart. */
        return this.mqttService?.hasFreshStatusSnapshot?.(normalized) === true;
    }

    scheduleKnownDeviceStatusPrime(deviceId, delayMs) {
        const normalized = String(deviceId || '').trim();
        if (!normalized) {
            return;
        }

        const existingTimer = this._statusPrimeTimers.get(normalized);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
            this._statusPrimeTimers.delete(normalized);

            if (!this.mqttService.connected || this.hasFreshLiveDeviceState(normalized)) {
                return;
            }

            this.mqttService.requestStatus(normalized, {
                force: false,
                allowCompatibilitySnapshot: true,
                source: 'startup-prime'
            }).catch(() => {
                logger.debug(`Initial status request failed for ${normalized}`);
            });
        }, Math.max(0, Number(delayMs) || 0));

        if (typeof timer.unref === 'function') {
            timer.unref();
        }

        this._statusPrimeTimers.set(normalized, timer);
    }

    async persistWifiConnectionHistory(deviceId, wifi = {}) {
        const db = this.app?.locals?.db;
        const ssid = normalizeStoredWifiSsid(wifi?.ssid);
        if (!db || !ssid) {
            return;
        }

        const connected = wifi?.connected === true;
        const previousSsid = this._lastConnectedWifiSsid.get(deviceId) || '';
        const countConnection = connected && previousSsid !== ssid;

        if (connected) {
            this._lastConnectedWifiSsid.set(deviceId, ssid);
        } else if (!connected && previousSsid) {
            this._lastConnectedWifiSsid.delete(deviceId);
        }

        const storedProfile = await readStoredWifiProfile(db, deviceId).catch(() => null);
        const matchingProfile = storedProfile && storedProfile.ssid === ssid && storedProfile.passwordSet;

        await persistKnownWifiNetwork(db, deviceId, {
            ssid,
            security: wifi?.security,
            password: matchingProfile ? storedProfile.password : undefined,
            selected: false,
            connected,
            countConnection,
            lastSignal: wifi?.rssi ?? wifi?.signalStrength ?? null,
            lastChannel: wifi?.channel ?? null,
            lastBssid: wifi?.bssid ?? null
        }).catch(() => {});
    }

    async isRegisteredDevice(deviceId) {
        const normalized = String(deviceId || '').trim();
        if (!normalized) return false;

        const cached = this._registeredDeviceCache.get(normalized);
        const now = Date.now();
        if (cached && (now - cached.checkedAt) < 10000) {
            return cached.registered;
        }

        const db = this.app?.locals?.db;
        if (!db) return false;

        try {
            const row = await db.get(`SELECT id FROM devices WHERE id = ?`, [normalized]);
            const registered = Boolean(row?.id);
            this._registeredDeviceCache.set(normalized, { registered, checkedAt: now });
            return registered;
        } catch (error) {
            logger.debug(`Failed to check device registration for ${normalized}:`, error.message);
            return false;
        }
    }

    async noteUnregisteredDevice(deviceId, eventType, payload = {}) {
        const normalized = String(deviceId || '').trim();
        if (!normalized) return;

        const db = this.app?.locals?.db;
        if (!db) return;

        const number = String(
            payload?.number ||
            payload?.from ||
            payload?.to ||
            ''
        ).trim();

        let payloadText = '';
        try {
            payloadText = JSON.stringify(payload || {}).slice(0, 1000);
        } catch (_) {}

        try {
            await db.run(
                `INSERT INTO unregistered_devices
                    (device_id, first_seen, last_seen, event_count, last_event_type, last_number, last_payload)
                 VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, ?, ?, ?)
                 ON CONFLICT(device_id) DO UPDATE SET
                    last_seen = CURRENT_TIMESTAMP,
                    event_count = event_count + 1,
                    last_event_type = excluded.last_event_type,
                    last_number = excluded.last_number,
                    last_payload = excluded.last_payload`,
                [normalized, eventType || 'event', number || null, payloadText || null]
            );
        } catch (error) {
            logger.debug(`Failed to track unregistered device ${normalized}:`, error.message);
        }
    }

    async acknowledgeFirmwareSmsHistory(deviceId, firmwareStorageId) {
        const normalizedDeviceId = String(deviceId || '').trim();
        const normalizedStorageId = Number(firmwareStorageId);
        if (!normalizedDeviceId || !Number.isInteger(normalizedStorageId) || normalizedStorageId <= 0 ||
            typeof this.mqttService?.publishCommand !== 'function') {
            return false;
        }

        try {
            await this.mqttService.publishCommand(
                normalizedDeviceId,
                'delete-sms',
                { storage_id: normalizedStorageId },
                false,
                30000,
                {
                    source: 'dashboard-sms-history-ack',
                    domain: 'telephony',
                    persistent: true,
                    replaySafe: true,
                    maxAttempts: 3
                }
            );
            return true;
        } catch (error) {
            logger.warn(`Device SMS history acknowledgement queue failed for ${normalizedDeviceId}: ${error.message}`);
            return false;
        }
    }

    async loadDeletedDevices() {
        this.deletedDevices = new Set();
    }

    async suppressDeletedDevice(deviceId) {
        const normalized = String(deviceId || '').trim();
        if (!normalized) return;

        this.deletedDevices.add(normalized);
    }

    async unsuppressDeletedDevice(deviceId) {
        const normalized = String(deviceId || '').trim();
        if (!normalized) return;

        this.deletedDevices.delete(normalized);
    }

    isDeletedDevice(deviceId) {
        return this.deletedDevices.has(String(deviceId || '').trim());
    }

    releaseDeviceRuntime(deviceId) {
        const normalized = String(deviceId || '').trim();
        if (!normalized) return;

        this._onlineDevices?.delete?.(normalized);
        this._lowBatteryNotified?.delete?.(normalized);
        this._gpsDebounce?.delete?.(normalized);
        this.modemService?.devices?.delete?.(normalized);
        this.mqttService?.clearDeviceStatus?.(normalized);
    }

    async primeKnownDeviceStatus() {
        const db = this.app?.locals?.db;
        if (!db || !this.mqttService?.connected) return;

        try {
            const rows = await db.all(`
                SELECT id AS device_id, last_seen FROM devices
                UNION
                SELECT device_id, NULL AS last_seen FROM device_profiles
            `);

            const normalizedRows = rows
                .map(row => ({
                    deviceId: String(row.device_id || '').trim(),
                    lastSeen: row.last_seen || null
                }))
                .filter(row => row.deviceId);

            const hasSeenDevice = normalizedRows.some(row => row.lastSeen);
            const deviceIds = normalizedRows
                .filter(row => !hasSeenDevice || row.lastSeen)
                .sort((a, b) => {
                    if (a.lastSeen && b.lastSeen) {
                        return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
                    }
                    if (a.lastSeen) return -1;
                    if (b.lastSeen) return 1;
                    return a.deviceId.localeCompare(b.deviceId);
                })
                .map(row => row.deviceId);

            if (deviceIds.length === 0) return;

            deviceIds.forEach((deviceId, index) => {
                this.scheduleKnownDeviceStatusPrime(
                    deviceId,
                    INITIAL_STATUS_PRIME_DELAY_MS + (index * INITIAL_STATUS_PRIME_SPREAD_MS)
                );
            });
        } catch (error) {
            logger.debug('Failed to prime known device status:', error.message);
        }
    }

    _findRecentMatchingOutgoingSms(rows, incomingTimestamp, simSlot = null) {
        const incomingMs = parseSmsTimestampMs(incomingTimestamp);
        const timeWindowMs = 15 * 60 * 1000;
        const normalizedSimSlot = simSlot == null || simSlot === '' ? null : Number(simSlot);
        const candidates = Array.isArray(rows) ? rows : [];
        let best = null;

        for (const row of candidates) {
            const outgoingMs = parseSmsTimestampMs(row?.timestamp);
            const rowSimSlot = row?.sim_slot == null || row?.sim_slot === '' ? null : Number(row.sim_slot);

            if (normalizedSimSlot !== null && rowSimSlot !== null && rowSimSlot !== normalizedSimSlot) {
                continue;
            }

            if (Number.isFinite(incomingMs) && Number.isFinite(outgoingMs)) {
                if (outgoingMs > incomingMs + 60 * 1000) {
                    continue;
                }
                if (Math.abs(incomingMs - outgoingMs) > timeWindowMs) {
                    continue;
                }
            }

            if (!best) {
                best = row;
                continue;
            }

            const bestPriority = String(best.status || '').trim().toLowerCase();
            const rowPriority = String(row.status || '').trim().toLowerCase();
            if ((bestPriority !== 'failed' && bestPriority !== 'ambiguous') &&
                (rowPriority === 'failed' || rowPriority === 'ambiguous')) {
                best = row;
                continue;
            }

            if (Number(row.id || 0) > Number(best.id || 0)) {
                best = row;
            }
        }

        return best;
    }

    async reconcileOutgoingSmsFromIncoming(deviceId, details = {}) {
        const db = this.app?.locals?.db;
        const normalizedDeviceId = String(deviceId || '').trim();
        const normalizedFrom = formatPhoneNumber(details.from) || String(details.from || '').trim();
        const message = String(details.message || '');
        const incomingTimestamp = String(details.timestamp || '');
        const simSlot = details.simSlot == null || details.simSlot === '' ? null : Number(details.simSlot);

        if (!db || !normalizedDeviceId || !normalizedFrom || !message) {
            return null;
        }

        const candidates = await db.all(
            `SELECT id, conversation_id, external_id, status, timestamp, sim_slot
             FROM sms
             WHERE device_id = ?
               AND type = 'outgoing'
               AND to_number = ?
               AND message = ?
               AND status IN ('queued', 'sending', 'sent', 'failed', 'ambiguous')
             ORDER BY id DESC
             LIMIT 12`,
            [normalizedDeviceId, normalizedFrom, message]
        );
        const match = this._findRecentMatchingOutgoingSms(candidates, incomingTimestamp, simSlot);
        if (!match) {
            return null;
        }

        await db.run(
            `UPDATE sms
             SET status = 'delivered',
                 delivered_at = COALESCE(delivered_at, ?),
                 error = NULL
             WHERE id = ?`,
            [incomingTimestamp || new Date().toISOString(), match.id]
        );

        if (match.external_id && typeof this.mqttService?._markPersistentQueueCompleted === 'function') {
            const queueRow = await db.get(
                `SELECT *
                 FROM device_command_queue
                 WHERE device_id = ?
                   AND command IN ('send-sms', 'send-sms-multipart')
                   AND message_id = ?
                 ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
                 LIMIT 1`,
                [normalizedDeviceId, match.external_id]
            );

            if (queueRow && String(queueRow.status || '').trim().toLowerCase() !== 'completed') {
                await this.mqttService._markPersistentQueueCompleted(queueRow, {
                    success: true,
                    result: 'completed',
                    detail: 'sms_delivered_via_incoming_match',
                    evidence: 'incoming_sms_match',
                    action_id: match.external_id,
                    messageId: match.external_id,
                    deviceId: normalizedDeviceId,
                    to: normalizedFrom,
                    timestamp: incomingTimestamp || new Date().toISOString()
                });
            }
        }

        this.toDevice(normalizedDeviceId, 'sms:delivered', {
            deviceId: normalizedDeviceId,
            id: match.id,
            conversationId: Number(match.conversation_id || 0) || null,
            messageId: match.external_id || null,
            to: normalizedFrom,
            evidence: 'incoming_sms_match',
            status: 'delivered',
            timestamp: incomingTimestamp || new Date().toISOString()
        });

        return match;
    }

    initialize() {
        this.loadDeletedDevices();
        this.setupEventHandlers();
        this.setupPeriodicTasks();
        this.connect();
    }

    setupEventHandlers() {
        this.mqttService.on('connect', () => {
            this.io.emit('mqtt:status', this.mqttService.getStatus());
            this.primeKnownDeviceStatus();
        });

        this.mqttService.on('connecting', () => {
            this.io.emit('mqtt:status', this.mqttService.getStatus());
        });

        this.mqttService.on('reconnect', () => {
            this.io.emit('mqtt:status', this.mqttService.getStatus());
        });

        this.mqttService.on('close', () => {
            logger.warn('⚠️ MQTT connection closed');
            this.io.emit('mqtt:status', this.mqttService.getStatus());
        });

        this.mqttService.on('error', (error) => {
            logger.error(`❌ MQTT service error: ${error.message}`);
            // Sanitize before broadcasting — raw error may contain broker URL/credentials
            const msg = error.code === 'ECONNREFUSED' ? 'Broker unreachable'
                      : error.code === 'ETIMEDOUT'    ? 'Connection timed out'
                      : /not authorized|auth/i.test(error.message || '') ? 'MQTT auth failed'
                      : 'MQTT connection error';
            this.io.emit('mqtt:error', { message: msg });
            this.io.emit('mqtt:status', this.mqttService.getStatus());
        });

        this.mqttService.on('offline', () => {
            logger.warn('⚠️ MQTT offline');
            this.io.emit('mqtt:status', this.mqttService.getStatus());
        });

        this.mqttService.on('max_reconnect', () => {
            logger.error('❌ MQTT max reconnection attempts reached');
            this.io.emit('mqtt:error', { message: 'Max reconnection attempts reached' });
        });

        // Device heartbeats
        this.mqttService.on('heartbeat', (deviceId, data) => {
            if (this.isDeletedDevice(deviceId)) {
                logger.debug(`Ignoring heartbeat from deleted device ${deviceId}`);
                return;
            }
            this.modemService.handleHeartbeat(deviceId);
            this.toDevice(deviceId, 'device:heartbeat', {
                deviceId,
                timestamp: data.timestamp || new Date().toISOString()
            });
        });

        // Low-battery notification threshold (% SOC). Fire once per drop below threshold.
        this._lowBatteryNotified = new Set(); // deviceIds that have already been notified this session

        // Status updates
        this.mqttService.on('status', async (deviceId, data) => {
            if (this.isDeletedDevice(deviceId)) {
                logger.info(`Ignoring status from deleted device ${deviceId}`);
                this.modemService?.devices?.delete(deviceId);
                this.mqttService?.clearDeviceStatus?.(deviceId);
                return;
            }
            // Compatibility get-status may return the dashboard's cached
            // snapshot. It is useful to callers but is not a device heartbeat
            // and must not renew liveness or durable status freshness.
            if (data?.cached_status === true) {
                return;
            }
            const device = this.modemService.updateDeviceStatus(deviceId, data);

            // Register device in DB (upsert — no-op if already exists)
            const db = this.app.locals.db;
            if (db) {
                const registered = await this.isRegisteredDevice(deviceId);
                if (!registered) {
                    await this.noteUnregisteredDevice(deviceId, 'status', data);
                    return;
                }
                db.run(
                    `INSERT INTO devices (id, name, status, last_seen) VALUES (?, ?, 'online', CURRENT_TIMESTAMP)
                     ON CONFLICT(id) DO UPDATE SET status='online', last_seen=CURRENT_TIMESTAMP`,
                    [deviceId, deviceId]
                ).catch(err => logger.error(`Device upsert failed for ${deviceId}:`, err));
                markModuleSuccess(db, deviceId, 'modem', 'Status heartbeat received', {
                    signal: device?.mobile?.signalStrength ?? null,
                    network: device?.mobile?.networkType || null,
                    operator: device?.mobile?.operator || null
                }).catch(() => {});
                if (device?.wifi?.connected) {
                    this.persistWifiConnectionHistory(deviceId, device.wifi);
                    markModuleSuccess(db, deviceId, 'wifi', 'Wi-Fi connected', {
                        ssid: device.wifi.ssid || null,
                        ipAddress: device.wifi.ipAddress || null,
                        rssi: device.wifi.rssi ?? null
                    }).catch(() => {});
                } else if (device?.wifi?.apEnabled) {
                    upsertModuleHealth(db, {
                        deviceId,
                        moduleKey: 'wifi',
                        supported: true,
                        state: 'warning',
                        message: 'Hotspot active',
                        details: {
                            ssid: device.wifi.apSsid || null,
                            ipAddress: device.wifi.apIp || null,
                            clients: device.wifi.clients ?? 0
                        }
                    }).catch(() => {});
                } else if (device?.wifi) {
                    upsertModuleHealth(db, {
                        deviceId,
                        moduleKey: 'wifi',
                        supported: true,
                        state: 'warning',
                        message: 'Wi-Fi idle',
                        details: device.wifi
                    }).catch(() => {});
                }
                syncDeviceSimInventory(db, deviceId, data).catch((error) => {
                    logger.debug(`SIM inventory sync failed for ${deviceId}: ${error.message}`);
                });
                persistDeviceStatusCache(db, deviceId, data).catch((error) => {
                    logger.debug(`Status cache persist failed for ${deviceId}: ${error.message}`);
                });
            }

            // Fire device.online webhook on first heartbeat after offline (track per device)
            if (!this._onlineDevices) this._onlineDevices = new Set();
            if (!this._onlineDevices.has(deviceId)) {
                this._onlineDevices.add(deviceId);
                this.fireEvent('device.online', deviceId, { deviceId });
                notificationService.capture({
                    deviceId,
                    type: 'success',
                    severity: 'success',
                    category: 'device',
                    source: 'device',
                    title: 'Device online',
                    message: `Device ${deviceId} is online`,
                    actionUrl: '/devices/about',
                    eventKey: `device.online:${deviceId}`
                }).catch(() => {});
            }

            // Emit status update — use normalised device object (signal already % not raw RSSI)
            const liveStatus = buildDashboardDeviceStatus(
                this.modemService.getDeviceStatus(deviceId),
                true
            );
            this.toDevice(deviceId, 'device:status', {
                deviceId,
                ...liveStatus,
                timestamp: new Date().toISOString()
            });
            this.fireEvent('telemetry', deviceId, {
                deviceId,
                signal: device?.mobile?.signalStrength ?? null,
                signalDbm: device?.mobile?.signalDbm ?? null,
                battery: device?.system?.battery ?? null,
                charging: device?.system?.charging ?? null,
                temperature: device?.system?.temperature ?? null,
                voltageMv: device?.system?.voltage_mV ?? null,
                network: device?.mobile?.networkType || null,
                operator: device?.mobile?.operator || null,
                ip: device?.mobile?.ipAddress || null,
                wifi: device?.wifi || null,
                system: device?.system || null,
                mobile: device?.mobile || null,
                raw: data || null,
                timestamp: new Date().toISOString()
            });

            // Low battery notification (threshold: 20%)
            const battery = data.system?.battery;
            const charging = data.system?.charging;
            if (battery !== undefined && battery <= 20 && !charging) {
                if (!this._lowBatteryNotified.has(deviceId)) {
                    this._lowBatteryNotified.add(deviceId);
                    notificationService.notifyLowBattery(battery, {
                        deviceId,
                        eventKey: `device.low_battery:${deviceId}`
                    }).catch(() => {});
                }
            } else if (battery > 25) {
                // Reset so we notify again if battery drops again
                this._lowBatteryNotified.delete(deviceId);
            }

            logger.debug(`Device ${deviceId} status update`, {
                signal: data.mobile?.signalStrength,
                network: data.mobile?.networkType
            });
        });
        
        this.setupSMSHandlers();
        this.setupCallHandlers();
        this.setupUSSDHandlers();
        this.setupWebcamHandlers();
        this.setupIntercomHandlers();
        this.setupWiFiHandlers();
        this.setupLocationHandlers();
        this.setupActionResultHandlers();
        this.setupStorageHandlers();
        this.setupGPSHandlers();
        this.setupGPIOHandlers();
        this.setupPeripheralHandlers();
        this.setupTestHandlers();
        this.setupOTAHandlers();
        this.setupCapabilitiesHandlers();
    }

    setupWebcamHandlers() {
        this.mqttService.on('webcam:image', async (deviceId, data) => {
            logger.info(`📸 Webcam image from ${deviceId}`);
            const db = this.app.locals.db;
            if (!db || !data?.image) return;

            try {
                const metadata = {
                    ...data.metadata,
                    motionDetected: data.motionDetected ?? data.motion_detected,
                    faceDetected: data.faceDetected ?? data.face_detected,
                    faceCount: data.faceCount ?? data.face_count ?? data.faces?.length,
                    recognizedLabel: data.recognizedLabel ?? data.recognized_label ?? data.recognition?.name,
                    recognitionConfidence: data.recognitionConfidence ?? data.recognition_confidence ?? data.recognition?.confidence,
                    captureType: data.captureType || data.capture_type || 'event',
                    source: 'mqtt'
                };

                const capture = await saveCapture({
                    db,
                    deviceId,
                    imageBase64: data.image,
                    format: data.format || data.mimeType || 'jpeg',
                    mimeType: data.mimeType || data.contentType || '',
                    webcamId: data.webcamId || null,
                    relativeDir: 'uploads/webcam',
                    filenamePrefix: `webcam_${deviceId}`,
                    tags: data.tags || [],
                    metadata
                });

                await markModuleSuccess(db, deviceId, 'camera', 'Webcam capture received', {
                    captureId: capture.id,
                    faceDetected: capture.faceDetected,
                    faceCount: capture.faceCount,
                    recognizedLabel: capture.recognizedLabel || null
                });

                this.toDevice(deviceId, 'webcam:capture', {
                    deviceId,
                    ...capture
                });
            } catch (error) {
                logger.error('Webcam capture save failed:', error);
                markModuleFailure(db, deviceId, 'camera', 'Failed to persist webcam capture', {
                    error: error.message
                }).catch(() => {});
            }
        });
    }

    setupTestHandlers() {
        this.mqttService.on('test:result', async (deviceId, data) => {
            logger.info(`🧪 Test result from ${deviceId}: ${data.testId} = ${data.result}`);

            // Emit via Socket.IO
            this.toDevice(deviceId, 'test:result', { deviceId, ...data });
        });

        this.mqttService.on('test:progress', (deviceId, data) => {
            this.toDevice(deviceId, 'test:progress', { deviceId, ...data });
        });
    }

    setupGPIOHandlers() {
        this.mqttService.on('gpio:status', async (deviceId, data) => {

            // Update modem service
            if (this.modemService) {
                this.modemService.updateDeviceStatus(deviceId, { gpio: data });
            }

            // Emit via Socket.IO
            this.toDevice(deviceId, 'gpio:status', { deviceId, ...data });
        });

        this.mqttService.on('gpio:update', async (deviceId, data) => {
            logger.info(`⚡ GPIO update from ${deviceId}: pin ${data.pin} = ${data.value}`);

            // Save to database
            const db = this.app.locals.db;
            if (db) {
                await db.run(`
                INSERT INTO gpio_history (device_id, pin, value, type, timestamp)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [deviceId, data.pin, data.value, data.type || 'digital']);
            }

            // Emit via Socket.IO
            this.toDevice(deviceId, 'gpio:update', { deviceId, ...data });
        });
    }

    setupPeripheralHandlers() {
        this.mqttService.on('nfc:read', async (deviceId, data) => {
            if (this.isDeletedDevice(deviceId)) return;
            this.toDevice(deviceId, 'nfc:read', { deviceId, ...data });
            await upsertModuleHealth(this.app.locals.db, {
                deviceId,
                moduleKey: 'nfc',
                supported: true,
                state: 'ok',
                message: data?.uid ? `Tag ${data.uid}` : 'NFC event received',
                details: data || {}
            }).catch(() => {});
        });

        this.mqttService.on('rfid:scan', async (deviceId, data) => {
            if (this.isDeletedDevice(deviceId)) return;
            this.toDevice(deviceId, 'rfid:scan', { deviceId, ...data });
            await upsertModuleHealth(this.app.locals.db, {
                deviceId,
                moduleKey: 'rfid',
                supported: true,
                state: 'ok',
                message: data?.uid ? `Tag ${data.uid}` : 'RFID event received',
                details: data || {}
            }).catch(() => {});
        });

        this.mqttService.on('touch:event', async (deviceId, data) => {
            if (this.isDeletedDevice(deviceId)) return;
            this.toDevice(deviceId, 'touch:event', { deviceId, ...data });
            await upsertModuleHealth(this.app.locals.db, {
                deviceId,
                moduleKey: 'touch',
                supported: true,
                state: data?.touched ? 'ok' : 'warning',
                message: data?.pin != null ? `Pin ${data.pin} ${data.touched ? 'touched' : 'released'}` : 'Touch event received',
                details: data || {}
            }).catch(() => {});
        });

        this.mqttService.on('keyboard:key', async (deviceId, data) => {
            if (this.isDeletedDevice(deviceId)) return;
            this.toDevice(deviceId, 'keyboard:key', { deviceId, ...data });
            await upsertModuleHealth(this.app.locals.db, {
                deviceId,
                moduleKey: 'keyboard',
                supported: true,
                state: 'ok',
                message: data?.key ? `Key ${data.key}` : 'Keyboard event received',
                details: data || {}
            }).catch(() => {});
        });

        this.mqttService.on('sensor:value', async (deviceId, data) => {
            if (this.isDeletedDevice(deviceId)) return;
            this.toDevice(deviceId, 'sensor:value', { deviceId, ...data });
            await upsertModuleHealth(this.app.locals.db, {
                deviceId,
                moduleKey: data?.moduleKey || 'sensors',
                supported: true,
                state: 'ok',
                message: data?.label || data?.type || 'Sensor telemetry received',
                details: data || {}
            }).catch(() => {});
        });
    }

    setupGPSHandlers() {
        this.mqttService.on('gps:location', async (deviceId, data) => {
            if (this.isDeletedDevice(deviceId)) return;
            const lat = parseFloat(data.lat ?? data.latitude ?? 0);
            const lon = parseFloat(data.lng ?? data.lon ?? data.longitude ?? 0);

            // Reject clearly invalid coordinates
            if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) {
                logger.debug(`Skipping (0,0) GPS coordinate for device ${deviceId}`);
                return;
            }

            logger.info(`📍 GPS location from ${deviceId}: ${lat}, ${lon}`);

            try {
                const locationHandler = require('../routes/location');
                if (locationHandler && typeof locationHandler.handleGpsLocation === 'function') {
                    await locationHandler.handleGpsLocation(deviceId, data);
                }
            } catch (err) {
                logger.error('Error in GPS location handler:', err);
            }

            this.app.locals.db && markModuleSuccess(this.app.locals.db, deviceId, 'gps', 'GPS fix received', {
                latitude: lat,
                longitude: lon,
                satellites: data.satellites ?? null
            }).catch(() => {});

            // Fire webhooks + n8n (non-blocking, not debounced — fires on every fix)
            this.fireEvent('gps.location', deviceId, data);

            // Debounce Socket.IO emit: at most once per second per device
            if (this._gpsDebounce.has(deviceId)) return;
            this._gpsDebounce.set(deviceId, setTimeout(() => {
                this._gpsDebounce.delete(deviceId);
                this.toDevice(deviceId, 'gps:location', { deviceId, ...data });
            }, 1000));
        });

        this.mqttService.on('gps:status', async (deviceId, data) => {
            if (this.isDeletedDevice(deviceId)) return;
            logger.info(`🛰️ GPS status from ${deviceId}: ${data.fix ? 'Fix' : 'No Fix'}, ${data.satellites || 0} sats`);
            if (this.app.locals.db) {
                const update = data.fix
                    ? markModuleSuccess(this.app.locals.db, deviceId, 'gps', 'GPS fix active', data)
                    : upsertModuleHealth(this.app.locals.db, {
                        deviceId,
                        moduleKey: 'gps',
                        supported: true,
                        state: 'warning',
                        message: 'GPS enabled but no fix yet',
                        details: data
                    });
                update.catch(() => {});
            }
            this.toDevice(deviceId, 'gps:status', { deviceId, ...data });
        });
    }

    setupSMSHandlers() {
        this.mqttService.on('action:result', async (deviceId, data) => {
            if (this.isDeletedDevice(deviceId)) return;

            const command = String(data?.command || '').trim().toLowerCase();
            if (command !== 'send_sms' && command !== 'send-sms' && command !== 'send_sms_multipart' && command !== 'send-sms-multipart') {
                return;
            }

            const {
                messageId,
                baseMessageId,
                isPartMessage
            } = getSmsActionMessageIds(data?.messageId || data?.action_id || '');
            // Only an explicit terminal result settles execution. The result is
            // authoritative when a stale/conflicting `success` boolean is also
            // present; `{ success: true }` alone remains unresolved.
            const classification = classifyCommandResult(data);
            const nonTerminalAck = !classification.terminal;
            const successful = classification.successful;
            let smsRow = null;

            try {
                const db = this.app.locals.db;
                if (db && messageId) {
                    // Non-terminal ack keeps the row `sending`; only a terminal
                    // result settles it (sent / failed). Delivered is never
                    // downgraded.
                    const nextStatus = nonTerminalAck
                        ? 'sending'
                        : (successful ? (isPartMessage ? 'sending' : 'sent') : 'failed');
                    const nextError = successful || nonTerminalAck ? null : (data?.error || data?.message || data?.detail || 'SMS send failed');
                    if (isPartMessage) {
                        await db.run(
                            `UPDATE sms
                             SET status = CASE
                                     WHEN status = 'delivered' THEN status
                                     WHEN ? = 'sending' AND status IN ('sent', 'failed', 'ambiguous') THEN status
                                     ELSE ?
                                 END,
                                 error = CASE
                                     WHEN status = 'delivered' THEN NULL
                                     WHEN ? = 'sending' THEN error
                                     ELSE ?
                                 END
                             WHERE device_id = ?
                               AND external_id = ?`,
                            [nextStatus, nextStatus, nextStatus, nextError, deviceId, baseMessageId]
                        );
                    } else {
                        await db.run(
                            `UPDATE sms
                             SET status = CASE
                                     WHEN status = 'delivered' THEN status
                                     WHEN ? = 'sending' AND status IN ('sent', 'failed', 'ambiguous') THEN status
                                     ELSE ?
                                 END,
                                 error = CASE
                                     WHEN status = 'delivered' THEN NULL
                                     WHEN ? = 'sending' THEN error
                                     ELSE ?
                                 END
                             WHERE device_id = ?
                               AND external_id = ?`,
                            [nextStatus, nextStatus, nextStatus, nextError, deviceId, messageId]
                        );
                    }
                    smsRow = await db.get(
                        `SELECT id, conversation_id, to_number, external_id, sim_slot, status
                         FROM sms
                         WHERE device_id = ?
                           AND external_id IN (?, ?)
                         ORDER BY id DESC
                         LIMIT 1`,
                        [deviceId, messageId, baseMessageId || messageId]
                    );
                }
            } catch (error) {
                logger.error('Error syncing SMS action result:', error);
            }

            const storedStatus = String(smsRow?.status || '').trim().toLowerCase();
            const emittedStatus = nonTerminalAck
                ? 'sending'
                : (successful
                    ? (['sent', 'delivered'].includes(storedStatus) ? storedStatus : (isPartMessage ? 'sending' : 'sent'))
                    : 'failed');
            const smsError = successful || nonTerminalAck ? null : (data?.error || data?.message || data?.detail || 'SMS send failed');
            const smsRecipient = smsRow?.to_number || data?.number || data?.to || data?.payload?.number || data?.payload?.to || null;

            // Non-terminal ack: inform the UI the device owns the command now,
            // without claiming success.
            this.toDevice(deviceId, nonTerminalAck ? 'sms:accepted' : (successful ? 'sms:sent' : 'sms:send-failed'), {
                deviceId,
                id: Number(smsRow?.id || 0) || null,
                conversationId: Number(smsRow?.conversation_id || 0) || null,
                messageId: smsRow?.external_id || baseMessageId || messageId || null,
                to: smsRecipient,
                sim_slot: smsRow?.sim_slot ?? null,
                status: emittedStatus,
                error: smsError,
                terminal: !nonTerminalAck,
                timestamp: new Date().toISOString()
            });
            if (!successful && !nonTerminalAck) {
                notificationService.capture({
                    deviceId,
                    type: 'danger',
                    severity: 'danger',
                    category: 'sms',
                    source: 'device',
                    title: 'SMS send failed',
                    message: smsRecipient ? `To ${smsRecipient}: ${smsError}` : smsError,
                    actionUrl: '/sms',
                    metadata: {
                        messageId: smsRow?.external_id || baseMessageId || messageId || null,
                        to: smsRecipient,
                        error: smsError
                    },
                    eventKey: messageId ? `sms.failed:${deviceId}:${messageId}` : null
                }).catch(() => {});
            }
        });

        this.mqttService.on('sms:incoming', async (deviceId, data) => {
            if (this.isDeletedDevice(deviceId)) return;
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                logger.warn('Ignoring malformed incoming SMS payload', { deviceId });
                return;
            }
            const syncType = String(data?.type || '').trim().toLowerCase();
            if (syncType === 'sms_sync_start' || syncType === 'sms_sync_complete') {
                if (!await this.isRegisteredDevice(deviceId)) {
                    await this.noteUnregisteredDevice(deviceId, syncType, data);
                    return;
                }
                this.toDevice(deviceId, syncType === 'sms_sync_start' ? 'sms:sync-started' : 'sms:sync-completed', {
                    deviceId,
                    device_id: deviceId,
                    total: Number(data?.total || 0),
                    synced: Number(data?.synced || 0),
                    timestamp: data?.timestamp || new Date().toISOString()
                });
                return;
            }
            // Firmware may publish "text" (from mqtt_mgr) or "message" (from dashboard commands).
            // Accept both for compatibility.
            const message = data.message ?? data.text ?? '';
            const firmwarePayload = syncType === 'sms_incoming' && normalizeFirmwareSmsStorageId(data) !== null;
            const fromNumber = data.from || data.from_number || data.sender || '';
            const isOutgoing = data.outgoing === true || String(data.direction || '').trim().toLowerCase() === 'outgoing';
            const toNumber = data.to || data.to_number || '';
            logger.info('Incoming SMS event', { deviceId, firmware: firmwarePayload, bodyLength: typeof message === 'string' ? message.length : 0 });

            let emittedResponse = decodeUcs2Hex(String(data.response || '').trim()) || String(data.response || '');
            let emittedMenuOptions = parseUssdMenuOptions(emittedResponse);
            let emittedSessionActive = data.session_active === true || emittedMenuOptions.length > 0;
            let emittedSessionId = String(data.sessionId || data.session_id || '').trim() || null;
            let emittedMenuLevel = Number(data.menuLevel ?? data.menu_level ?? 0);
            let emittedStatus = String(data.status || '').trim().toLowerCase();

            try {
                const db = this.app.locals.db;
                if (db) {
                    if (!await this.isRegisteredDevice(deviceId)) {
                        await this.noteUnregisteredDevice(deviceId, 'sms:incoming', data);
                        return;
                    }
                    // Use a high-precision timestamp (device-provided or local ISO string) to
                    // avoid the UNIQUE(device_id, timestamp, from_number) collision when two
                    // SMS arrive within the same second.
                    const smsTimestamp = normalizeSmsTimestamp(data.timestamp);
                    const encrypted = boolFromPayload(data.encrypted, false);
                    // ESP32 publishes decoded UTF-8. Decoding hex-looking text a
                    // second time corrupts legitimate bodies such as "1234".
                    const decodedMessage = encrypted || firmwarePayload ? String(message || '') : decodeUcs2Hex(message);
                    const decodedFrom = firmwarePayload ? fromNumber : decodeUcs2Hex(fromNumber);
                    const decodedTo = firmwarePayload ? toNumber : decodeUcs2Hex(toNumber);
                    if (!cleanText(decodedMessage) || (isOutgoing ? !cleanText(decodedTo) : !cleanText(decodedFrom))) {
                        logger.warn('Ignoring incomplete incoming SMS payload', {
                            deviceId,
                            direction: isOutgoing ? 'outgoing' : 'incoming',
                            hasAddress: Boolean(cleanText(isOutgoing ? decodedTo : decodedFrom)),
                            hasMessage: Boolean(cleanText(decodedMessage))
                        });
                        return;
                    }
                    const simScope = extractSimScope(data);
                    const syncPayload = isSyncPayload(data);
                    const read = isOutgoing ? 1 : (boolFromPayload(data.read ?? data.is_read, syncPayload) ? 1 : 0);
                    const externalId = smsExternalId(data);
                    const multipart = normalizeMultipartMetadata(data, {
                        deviceId,
                        direction: isOutgoing ? 'outgoing' : 'incoming',
                        fromNumber: isOutgoing ? null : decodedFrom,
                        toNumber: isOutgoing ? decodedTo : (decodedTo || null),
                        simSlot: simScope.simSlot
                    });
                    const storageTimestamp = normalizeMultipartTimestamp(smsTimestamp, multipart);
                    const modemStorageIndex = normalizeSmsStorageIndex(data);
                    const firmwareStorageId = normalizeFirmwareSmsStorageId(data);
                    const result = await db.run(`
                        INSERT OR IGNORE INTO sms
                            (from_number, to_number, message, type, status, device_id, timestamp, read, source, sim_slot, external_id,
                             modem_storage_index, firmware_storage_id, multipart_ref, multipart_part_index, multipart_part_count, multipart_group_key, encrypted)
                        VALUES (?, ?, ?, ?, ?, COALESCE(?, ''), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        isOutgoing ? null : decodedFrom,
                        isOutgoing ? decodedTo : (decodedTo || null),
                        decodedMessage,
                        isOutgoing ? 'outgoing' : 'incoming',
                        isOutgoing ? 'sent' : 'received',
                        deviceId,
                        storageTimestamp,
                        read,
                        firmwarePayload ? (syncPayload ? 'esp32-mqtt-sync' : 'esp32-mqtt') : (syncPayload ? 'android-mqtt-sync' : 'android-mqtt'),
                        simScope.simSlot,
                        externalId,
                        modemStorageIndex,
                        firmwareStorageId,
                        multipart.multipart_ref,
                        multipart.multipart_part_index,
                        multipart.multipart_part_count,
                        multipart.multipart_group_key,
                        encrypted ? 1 : 0
                    ]);

                    logger.info(`✅ Saved incoming SMS from ${decodedFrom} (ID: ${result.lastID})`);

                    const inserted = Number(result?.changes || 0) > 0;
                    if (!inserted) {
                        logger.info(`Duplicate incoming SMS ignored from ${decodedFrom}`);
                        await this.acknowledgeFirmwareSmsHistory(deviceId, firmwareStorageId);
                        if (!isOutgoing && !syncPayload) {
                            await this.reconcileOutgoingSmsFromIncoming(deviceId, {
                                from: decodedFrom,
                                message: decodedMessage,
                                timestamp: smsTimestamp,
                                simSlot: simScope.simSlot
                            });
                        }
                        return;
                    }

                    const conversationId = await attachSmsToConversation(db, {
                        id: result.lastID,
                        device_id: deviceId,
                        from_number: isOutgoing ? null : decodedFrom,
                        to_number: isOutgoing ? decodedTo : (decodedTo || null),
                        type: isOutgoing ? 'outgoing' : 'incoming'
                    });
                    await this.acknowledgeFirmwareSmsHistory(deviceId, firmwareStorageId);

                    // Update in-memory unread count for this device.
                    if (!isOutgoing && !read) smsCache.increment(deviceId);

                    // Seed cache from DB if not yet initialised.
                    if (smsCache.get(deviceId) === null) {
                        const row = await db.get(
                            `SELECT COUNT(*) as count FROM sms WHERE device_id = ? AND read = 0 AND type = 'incoming'`,
                            [deviceId]
                        );
                        smsCache.set(row.count, deviceId);
                    }

                    this.toDevice(deviceId, 'sms:received', {
                        deviceId,
                        conversationId: Number(conversationId || 0) || null,
                        sync: syncPayload,
                        from: isOutgoing ? null : decodedFrom,
                        from_number: isOutgoing ? null : decodedFrom,
                        to_number: isOutgoing ? decodedTo : (decodedTo || null),
                        sim_slot: simScope.simSlot,
                        message: decodedMessage,
                        text: decodedMessage,
                        id: result.lastID,
                        type: isOutgoing ? 'outgoing' : 'incoming',
                        status: isOutgoing ? 'sent' : 'received',
                        read,
                        external_id: externalId,
                        modem_storage_index: modemStorageIndex,
                        firmware_storage_id: firmwareStorageId,
                        multipart_ref: multipart.multipart_ref,
                        multipart_part_index: multipart.multipart_part_index,
                        multipart_part_count: multipart.multipart_part_count,
                        multipart_group_key: multipart.multipart_group_key,
                        encrypted,
                        unreadCount: smsCache.get(deviceId),
                        timestamp: storageTimestamp
                    });

                    if (!isOutgoing && !syncPayload) {
                        await this.reconcileOutgoingSmsFromIncoming(deviceId, {
                            from: decodedFrom,
                            message: decodedMessage,
                            timestamp: smsTimestamp,
                            simSlot: simScope.simSlot
                        });
                        // Fire notification + webhooks (non-blocking)
                        notificationService.notifySms(fromNumber, decodedMessage, {
                            deviceId,
                            actionUrl: '/sms',
                            eventKey: externalId ? `sms.incoming:${deviceId}:${externalId}` : null
                        }).catch(() => {});
                        pushNotificationService.notifyLinkedDevices(deviceId, {
                            title: 'New SMS received',
                            body: `From ${decodedFrom}: ${decodedMessage}`,
                            data: {
                                type: 'sms.incoming',
                                deviceId,
                                from: decodedFrom
                            }
                        }).catch(() => {});
                        this.fireEvent('sms.incoming', deviceId, {
                            deviceId,
                            from: decodedFrom,
                            message: decodedMessage,
                            text: decodedMessage,
                            timestamp: smsTimestamp
                        });
                    }
                }
            } catch (error) {
                logger.error('❌ Error saving incoming SMS:', error);
                this.toDevice(deviceId, 'sms:save-error', { deviceId, from: fromNumber });
            }
        });

        this.mqttService.on('sms:delivered', async (deviceId, data) => {
            if (this.isDeletedDevice(deviceId)) return;
            if (typeof this.mqttService.processSmsDelivery === 'function') {
                try {
                    const result = await (data._deliveryResult || this.mqttService.processSmsDelivery(deviceId, { ...data, status: data.status || 'delivered' }));
                    this.toDevice(deviceId, result.status === 'delivered' ? 'sms:delivered' : result.status === 'failed' ? 'sms:send-failed' : 'sms:delivery', { deviceId, ...result });
                } catch (error) { logger.error('Error persisting SMS delivery:', error); }
                return;
            }
            logger.info(`✅ SMS delivered to ${data.to}`);

            try {
                const db = this.app.locals.db;
                if (db) {
                    const messageId = String(data?.messageId || data?.action_id || '').trim();
                    if (messageId) {
                        await db.run(
                            `UPDATE sms
                             SET status = 'delivered',
                                 delivered_at = CURRENT_TIMESTAMP,
                                 error = NULL
                             WHERE device_id = ?
                               AND external_id = ?`,
                            [deviceId, messageId]
                        );
                    } else {
                        await db.run(`
                            UPDATE sms SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP, error = NULL
                            WHERE rowid = (
                                SELECT rowid
                                FROM sms
                                WHERE device_id = ?
                                  AND to_number = ?
                                  AND status IN ('queued', 'sending', 'sent', 'ambiguous')
                                ORDER BY timestamp DESC
                                LIMIT 1
                            )
                        `, [deviceId, data.to]);
                    }
                }
            } catch (error) {
                logger.error('❌ Error updating SMS delivery status:', error);
            }

            this.toDevice(deviceId, 'sms:delivered', { deviceId, ...data });
        });

        this.mqttService.on('sms:delivery', async (deviceId, data = {}) => {
            if (this.isDeletedDevice(deviceId)) return;
            if (typeof this.mqttService.processSmsDelivery === 'function') {
                try {
                    const result = await (data._deliveryResult || this.mqttService.processSmsDelivery(deviceId, data));
                    this.toDevice(deviceId, result.status === 'delivered' ? 'sms:delivered' : result.status === 'failed' ? 'sms:send-failed' : 'sms:delivery', { deviceId, ...result });
                } catch (error) { logger.error('Error persisting SMS delivery:', error); }
                return;
            }

            const normalizedData = normalizeSmsDeliveryPayload(data);
            const deliveryReport = normalizeSmsDeliveryReport(normalizedData);
            const deliveryStatus = deliveryReport.status;
            const errorText = deliveryStatus === 'failed'
                ? (normalizedData?.error || normalizedData?.message || normalizedData?.detail || 'SMS delivery failed')
                : null;
            let correlationUnmatched = false;

            try {
                const db = this.app.locals.db;
                if (db && deliveryStatus !== 'pending') {
                    let messageId = String(normalizedData?.messageId || normalizedData?.action_id || '').trim();
                    let smsId = null;
                    if (!messageId && deliveryReport.messageReference !== null) {
                        const row = await this.mqttService._findPersistentSmsQueueRow?.(deviceId, normalizedData);
                        // The queue helper also supports a legacy destination fallback.
                        // A modem reference must match stored evidence, never that fallback.
                        const matchesReference = row && ['response_payload', 'payload'].some((field) => {
                            if (!row[field]) return false;
                            let value = row[field];
                            try { value = JSON.parse(value); } catch (_) {}
                            return parseSmsMessageReference(value) === deliveryReport.messageReference;
                        });
                        if (matchesReference && row.device_id === deviceId) {
                            let payload = {};
                            try { payload = JSON.parse(row.payload || '{}'); } catch (_) {}
                            const candidateId = Number(payload.smsId || payload.sms_id);
                            smsId = Number.isSafeInteger(candidateId) && candidateId > 0 ? candidateId : null;
                            messageId = String(payload.sms_base_message_id || row.message_id || '').trim();
                            if (messageId) normalizedData.messageId = messageId;
                            if (smsId) normalizedData.id = smsId;
                        }
                        correlationUnmatched = !smsId && !messageId;
                    }
                    if (correlationUnmatched) {
                        logger.warn('SMS delivery report has no verified message-reference correlation; SMS row unchanged');
                    } else if (smsId) {
                        await db.run(
                            `UPDATE sms SET status = ?,
                             delivered_at = CASE WHEN ? = 'delivered' THEN CURRENT_TIMESTAMP ELSE delivered_at END,
                             error = ? WHERE device_id = ? AND id = ?`,
                            [deliveryStatus, deliveryStatus, errorText, deviceId, smsId]
                        );
                    } else if (messageId) {
                        await db.run(
                            `UPDATE sms
                             SET status = ?,
                                 delivered_at = CASE WHEN ? = 'delivered' THEN CURRENT_TIMESTAMP ELSE delivered_at END,
                                 error = ?
                             WHERE device_id = ?
                               AND external_id = ?`,
                            [deliveryStatus, deliveryStatus, errorText, deviceId, messageId]
                        );
                    } else {
                        await db.run(`
                            UPDATE sms
                            SET status = ?,
                                delivered_at = CASE WHEN ? = 'delivered' THEN CURRENT_TIMESTAMP ELSE delivered_at END,
                                error = ?
                            WHERE rowid = (
                                SELECT rowid
                                FROM sms
                                WHERE device_id = ?
                                  AND to_number = ?
                                  AND status IN ('queued', 'sending', 'sent', 'ambiguous')
                                ORDER BY timestamp DESC
                                LIMIT 1
                            )
                        `, [deliveryStatus, deliveryStatus, errorText, deviceId, normalizedData.to || normalizedData.number || '']);
                    }
                }
            } catch (error) {
                logger.error('Error updating SMS delivery report status:', error);
            }

            this.toDevice(
                deviceId,
                correlationUnmatched ? 'sms:delivery' : deliveryStatus === 'delivered'
                    ? 'sms:delivered'
                    : (deliveryStatus === 'failed' ? 'sms:send-failed' : 'sms:delivery'),
                { deviceId, ...normalizedData, status: deliveryStatus, error: errorText,
                    ...(correlationUnmatched ? { correlation: 'unmatched' } : {}) }
            );
            if (deliveryStatus === 'failed') {
                notificationService.capture({
                    deviceId,
                    type: 'danger',
                    severity: 'danger',
                    category: 'sms',
                    source: 'device',
                    title: 'SMS delivery failed',
                    message: errorText || 'SMS delivery failed',
                    actionUrl: '/sms',
                    metadata: normalizedData,
                    eventKey: normalizedData?.messageId || normalizedData?.action_id
                        ? `sms.delivery_failed:${deviceId}:${normalizedData.messageId || normalizedData.action_id}`
                        : null
                }).catch(() => {});
            }
        });
    }

    setupCallHandlers() {
        this.mqttService.on('call:incoming', async (deviceId, data) => {
            if (this.isDeletedDevice(deviceId)) return;
            const syncPayload = isSyncPayload(data);
            logger.info(`📞 Incoming call from ${data.number}`);
            try {
                const db = this.app.locals.db;
                if (db) {
                    if (!await this.isRegisteredDevice(deviceId)) {
                        await this.noteUnregisteredDevice(deviceId, 'call:incoming', data);
                        return;
                    }
                    await ensureIncomingCallRecord(db, deviceId, data.number);
                }
            } catch (error) {
                logger.error('Error saving incoming call:', error);
            }
            if (!syncPayload) {
                this.toDevice(deviceId, 'call:incoming', { deviceId, ...data });
                pushNotificationService.notifyLinkedDevices(deviceId, {
                    title: 'Incoming call',
                    body: `From ${data.number || 'Unknown number'}`,
                    data: {
                        type: 'call.incoming',
                        deviceId,
                        number: data.number || null
                    }
                }).catch(() => {});
                this.fireEvent('call.incoming', deviceId, data);
            }
        });

        this.mqttService.on('call:status', async (deviceId, data) => {
            if (this.isDeletedDevice(deviceId)) return;
            const syncPayload = isSyncPayload(data);
            const syncType = String(data?.type || '').trim().toLowerCase();
            if (syncPayload && (syncType === 'call_sync_start' || syncType === 'call_sync_complete')) {
                return;
            }
            logger.info(`📞 Call status: ${data.status} for ${data.number}`);

            try {
                const db = this.app.locals.db;
                if (db) {
                    if (!await this.isRegisteredDevice(deviceId)) {
                        await this.noteUnregisteredDevice(deviceId, 'call:status', data);
                        return;
                    }
                    const formattedNumber = formatPhoneNumber(data.number || '') || data.number || null;
                    await updateLatestActiveCall(db, deviceId, {
                        ...data,
                        number: formattedNumber
                    });
                }
            } catch (error) {
                logger.error('❌ Error updating call status:', error);
                this.toDevice(deviceId, 'call:save-error', { deviceId, number: data.number });
            }

            if (!syncPayload) {
                this.toDevice(deviceId, 'call:status', { deviceId, ...data });
                this.fireEvent('call.status', deviceId, data);
            }
            if (!syncPayload && ['ended', 'missed', 'rejected', 'busy', 'no_answer'].includes(String(data.status || '').toLowerCase())) {
                this.mqttService.clearDeviceBusy(deviceId);
                this.fireEvent('call.ended', deviceId, data);
            }

            // Notify on missed call
            if (!syncPayload && data.status === 'missed') {
                notificationService.notifyMissedCall(data.number, {
                    deviceId,
                    actionUrl: '/calls',
                    eventKey: `call.missed:${deviceId}:${data.number || 'unknown'}`
                }).catch(() => {});
                pushNotificationService.notifyLinkedDevices(deviceId, {
                    title: 'Missed call',
                    body: `From ${data.number || 'Unknown number'}`,
                    data: {
                        type: 'call.missed',
                        deviceId,
                        number: data.number || null
                    }
                }).catch(() => {});
            }
        });
    }

    setupUSSDHandlers() {
        this.mqttService.on('action:result', async (deviceId, data) => {
            if (this.isDeletedDevice(deviceId)) return;

            const command = String(data?.command || '').trim().toLowerCase();
            if (command !== 'send_ussd' && command !== 'send-ussd') {
                return;
            }

            const successful = data?.success !== false
                && !['failed', 'rejected', 'timeout'].includes(String(data?.result || '').trim().toLowerCase());
            if (successful) {
                return;
            }

            this.mqttService.clearDeviceBusy(deviceId);

            try {
                const db = this.app.locals.db;
                if (!db) {
                    return;
                }

                const code = String(data?.payload?.code || data?.code || '').trim();
                const detail = data?.error || data?.message || data?.detail || 'USSD request failed';
                const simScope = extractSimScope(data?.payload || data);
                if (code) {
                    const conditions = ['device_id = ?', 'code = ?', "status = 'pending'"];
                    const params = [deviceId, code];
                    appendSimScopeCondition(conditions, params, simScope);
                    await db.run(`
                        UPDATE ussd SET response = ?, status = ?
                        WHERE rowid = (
                            SELECT rowid FROM ussd
                            WHERE ${conditions.join(' AND ')}
                            ORDER BY timestamp DESC LIMIT 1
                        )
                    `, [detail, 'failed', ...params]);
                } else {
                    const conditions = ['device_id = ?', "status = 'pending'"];
                    const params = [deviceId];
                    appendSimScopeCondition(conditions, params, simScope);
                    await db.run(`
                        UPDATE ussd SET response = ?, status = ?
                        WHERE rowid = (
                            SELECT rowid FROM ussd
                            WHERE ${conditions.join(' AND ')}
                            ORDER BY timestamp DESC LIMIT 1
                        )
                    `, [detail, 'failed', ...params]);
                }
            } catch (error) {
                logger.error('Error syncing USSD action result:', error);
            }
        });

        const handleUssdResult = async (deviceId, data) => {
            let emittedResponse = String(data?.response || '');
            let emittedMenuOptions = parseUssdMenuOptions(emittedResponse);
            let emittedSessionActive = data?.session_active === true || emittedMenuOptions.length > 0;
            let emittedSessionId = null;
            let emittedMenuLevel = 0;
            let emittedStatus = String(data?.status || '').trim().toLowerCase();
            let keepDeviceBusy = emittedSessionActive;
            if (this.isDeletedDevice(deviceId)) return;
            logger.info(`💬 USSD response from ${deviceId}`, { length: String(data.response || '').length });

            try {
                const db = this.app.locals.db;
                if (db) {
                    const rawResponse = String(data.response || '').trim();
                    const decodedResponse = decodeUcs2Hex(rawResponse);
                    const status = String(data.status || '').trim().toLowerCase();
                    const incomingCode = String(data.code || '').trim();
                    const sessionActive = data.session_active === true;
                    const failedStatus = ['failed', 'timeout', 'rejected', 'error'].includes(status);
                    const terminatedMarker = /^USSD session terminated$/i.test(decodedResponse);
                    const legacyTerminationOnly = !sessionActive && /^[0-5]$/.test(decodedResponse);
                    const hasRealPayload = !failedStatus && Boolean(decodedResponse) && !terminatedMarker && !legacyTerminationOnly;
                    const failedOnly = failedStatus;
                    const responseMenuOptions = hasRealPayload
                        ? parseUssdMenuOptions(decodedResponse)
                        : [];
                    const hasResponseMenuOptions = responseMenuOptions.length > 0;
                    const terminatedOnly = !hasRealPayload && (
                        data.session_active === false
                        || status === 'terminated'
                        || status === 'cancelled'
                        || legacyTerminationOnly
                        || terminatedMarker
                    );
                    const transientOnly = !hasRealPayload && !failedOnly && !terminatedOnly;
                    const simScope = extractSimScope(data);
                    // Firmware reports the single SIM as slot 0, while older
                    // dashboard requests stored NULL. Match that legacy form
                    // only for slot 0; never broaden slot 1 across SIMs.
                    const includeLegacyUnknownSlot = simScope.simSlot === 0;
                    const resolvedResponse = decodedResponse || (terminatedOnly ? 'USSD session terminated' : '');
                    const resolvedStatus = hasRealPayload
                        ? ((sessionActive || hasResponseMenuOptions) ? 'active' : 'success')
                        : (failedOnly ? 'failed' : (terminatedOnly ? 'cancelled' : 'pending'));
                    let targetRow = null;

                    if (incomingCode) {
                        const codeConditions = ['device_id = ?', 'code = ?', "status IN ('pending', 'active')"];
                        const codeParams = [deviceId, incomingCode];
                        appendSimScopeCondition(codeConditions, codeParams, simScope, { includeUnknown: includeLegacyUnknownSlot });
                        targetRow = await db.get(
                            `SELECT id, session_id, menu_level, response, status, description
                             FROM ussd
                             WHERE ${codeConditions.join(' AND ')}
                             ORDER BY id DESC
                             LIMIT 1`,
                            codeParams
                        );
                    }
                    if (!targetRow) {
                        const pendingConditions = ['device_id = ?', "status IN ('pending', 'active')"];
                        const pendingParams = [deviceId];
                        appendSimScopeCondition(pendingConditions, pendingParams, simScope, { includeUnknown: includeLegacyUnknownSlot });
                        targetRow = await db.get(
                            `SELECT id, session_id, menu_level, response, status, description
                             FROM ussd
                             WHERE ${pendingConditions.join(' AND ')}
                             ORDER BY id DESC
                             LIMIT 1`,
                            pendingParams
                        );
                    }

                    if (targetRow) {
                        const existingResponse = String(targetRow.response || '').trim();
                        const existingHasMenuOptions = existingResponse
                            ? parseUssdMenuOptions(existingResponse).length > 0
                            : false;
                        const nextResponse = (terminatedOnly || transientOnly) && existingResponse
                            ? existingResponse
                            : resolvedResponse;
                        const nextStatus = terminatedOnly && existingResponse
                            ? (existingHasMenuOptions ? 'active' : 'success')
                            : (transientOnly
                                ? (existingResponse
                                    ? (existingHasMenuOptions ? 'active' : 'success')
                                    : 'pending')
                                : resolvedStatus);

                        const nextSessionId = String(targetRow.session_id || targetRow.id);
                        const nextMenuLevel = Number(targetRow.menu_level || 0);

                        await db.run(
                            `UPDATE ussd
                             SET response = ?, status = ?, session_id = COALESCE(session_id, ?)
                             WHERE id = ?`,
                            [nextResponse, nextStatus, nextSessionId, targetRow.id]
                        );
                        const activeConditions = ['device_id = ?', "status = 'active'", 'id != ?'];
                        const activeParams = [deviceId, targetRow.id];
                        appendSimScopeCondition(activeConditions, activeParams, simScope, { includeUnknown: includeLegacyUnknownSlot });
                        await db.run(
                            `UPDATE ussd
                             SET status = 'success'
                             WHERE ${activeConditions.join(' AND ')}`,
                            activeParams
                        );

                        emittedResponse = nextResponse;
                        emittedMenuOptions = parseUssdMenuOptions(nextResponse);
                        emittedSessionActive = nextStatus === 'active';
                        emittedSessionId = nextSessionId;
                        emittedMenuLevel = nextMenuLevel;
                        emittedStatus = nextStatus;
                        keepDeviceBusy = nextStatus === 'pending' || nextStatus === 'active';
                    } else {
                        const insertResult = await db.run(
                            `INSERT INTO ussd (device_id, code, description, response, status, session_id, menu_level, timestamp, sim_slot)
                             VALUES (?, ?, ?, ?, ?, NULL, 0, CURRENT_TIMESTAMP, ?)`,
                            [deviceId, incomingCode, 'USSD Response', resolvedResponse, resolvedStatus, simScope.simSlot]
                        );

                        emittedResponse = resolvedResponse;
                        emittedMenuOptions = parseUssdMenuOptions(resolvedResponse);
                        emittedSessionActive = resolvedStatus === 'active';
                        emittedSessionId = insertResult?.lastID ? String(insertResult.lastID) : null;
                        emittedMenuLevel = 0;
                        emittedStatus = resolvedStatus;
                        keepDeviceBusy = resolvedStatus === 'pending' || resolvedStatus === 'active';
                    }

                    const ownNumberSetting = await db.get(`
                        SELECT ussd_code
                        FROM ussd_settings
                        WHERE service_key = 'ownNumber'
                        ORDER BY sort_order ASC, id ASC
                        LIMIT 1
                    `);
                    const recentOwnNumberRequest = await db.get(`
                        SELECT description
                        FROM ussd
                        WHERE device_id = ? AND code = ?
                        ORDER BY timestamp DESC
                        LIMIT 1
                    `, [deviceId, data.code || '']);
                    const configuredOwnNumberCode = String(ownNumberSetting?.ussd_code || '').trim();
                    const parsedSubscriberNumber = extractSubscriberNumberFromText(resolvedResponse);
                    const requestDescription = String(targetRow?.description || recentOwnNumberRequest?.description || '').trim().toLowerCase();
                    const isOwnNumberResponse = (configuredOwnNumberCode && incomingCode === configuredOwnNumberCode)
                        || requestDescription === 'sim number check';

                    if (isOwnNumberResponse && parsedSubscriberNumber) {
                        await db.run(`
                            INSERT INTO device_profiles (device_id, last_sim_number, updated_at)
                            VALUES (?, ?, CURRENT_TIMESTAMP)
                            ON CONFLICT(device_id) DO UPDATE SET
                                last_sim_number = excluded.last_sim_number,
                                updated_at = CURRENT_TIMESTAMP
                        `, [deviceId, parsedSubscriberNumber]);

                        if (this.modemService?.updateDeviceStatus) {
                            this.modemService.updateDeviceStatus(deviceId, {
                                modem_subscriber_number: parsedSubscriberNumber,
                                mobile: {
                                    simNumber: parsedSubscriberNumber,
                                    subscriberNumber: parsedSubscriberNumber
                                },
                                sim: {
                                    number: parsedSubscriberNumber,
                                    subscriberNumber: parsedSubscriberNumber
                                }
                            });
                        }
                    }
                }
            } catch (error) {
                logger.error('❌ Error updating USSD response:', error);
            }

            if (keepDeviceBusy) {
                this.mqttService.markDeviceBusy(deviceId, 'send-ussd', 120000);
            } else {
                this.mqttService.clearDeviceBusy(deviceId);
            }

            this.toDevice(deviceId, 'ussd:response', {
                deviceId,
                ...data,
                status: emittedStatus || data.status || '',
                response: emittedResponse,
                session_active: emittedSessionActive,
                sessionId: emittedSessionId,
                menuLevel: emittedMenuLevel,
                menuOptions: emittedMenuOptions
            });
        };

        this.mqttService.on('ussd:result', handleUssdResult);
        this.mqttService.on('ussd:response', handleUssdResult);
    }

    setupIntercomHandlers() {
        this.mqttService.on('intercom-signal', (deviceId, data) => {
            logger.info(`📹 Intercom signal from ${deviceId}: ${data.type}`);

            // Import intercom handler
            const intercomHandler = require('../routes/intercom');
            if (intercomHandler && intercomHandler.handleMqttMessage) {
                intercomHandler.handleMqttMessage(deviceId, 'intercom-signal', data);
            }
        });

        this.mqttService.on('intercom-call-status', (deviceId, data) => {
            logger.info(`📞 Intercom call status from ${deviceId}: ${data.inCall ? 'Active' : 'Ended'}`);

            const intercomHandler = require('../routes/intercom');
            if (intercomHandler && intercomHandler.handleMqttMessage) {
                intercomHandler.handleMqttMessage(deviceId, 'intercom-call-status', data);
            }
        });
    }

    setupWiFiHandlers() {
        this.mqttService.on('wifi:status-change', (deviceId, data) => {
            logger.info(`WiFi state from ${deviceId}: ${data.state || 'unknown'}`);

            if (this.modemService) {
                this.modemService.updateDeviceStatus(deviceId, {
                    wifi: {
                        mode: data.mode || 'off',
                        connected: !!data.connected,
                        ssid: data.ssid || '',
                        ipAddress: data.ipAddress || '',
                        apEnabled: !!data.apEnabled,
                        apSsid: data.apSsid || '',
                        apIp: data.apIp || '',
                        clients: Number(data.clients || 0)
                    }
                });
            }

            const db = this.app.locals.db;
            if (db) {
                this.persistWifiConnectionHistory(deviceId, data);
                const update = data.connected
                    ? markModuleSuccess(db, deviceId, 'wifi', 'Wi-Fi connected', data)
                    : upsertModuleHealth(db, {
                        deviceId,
                        moduleKey: 'wifi',
                        supported: true,
                        state: data.apEnabled ? 'warning' : 'error',
                        message: data.apEnabled ? 'Wi-Fi AP active' : 'Wi-Fi disconnected',
                        details: data
                    });
                update.catch(() => {});
            }

            this.toDevice(deviceId, 'modem:wifi-status-change', { deviceId, ...data });
        });
        this.mqttService.on('wifi:scan', (deviceId, data) => {
            logger.info(`📡 WiFi scan results from ${deviceId}: ${data.networks?.length || 0} networks`);

            if (this.modemService) {
                this.modemService.updateWifiNetworks(deviceId, data.networks || []);
            }

            this.toDevice(deviceId, 'modem:wifi-scan', { deviceId, networks: data.networks || [] });
        });

        this.mqttService.on('hotspot:clients', (deviceId, data) => {
            logger.info(`📱 Hotspot clients from ${deviceId}: ${data.clients?.length || 0} connected`);

            if (this.modemService) {
                this.modemService.updateHotspotClients(deviceId, data.clients || []);
            }

            this.toDevice(deviceId, 'modem:hotspot-clients', { deviceId, clients: data.clients || [] });
        });
    }

    setupLocationHandlers() {
        this.mqttService.on('location', (deviceId, data) => {
            logger.info(`📍 Location update from ${deviceId}: ${data.lat}, ${data.lng}`);
            this.toDevice(deviceId, 'device:location', { deviceId, ...data });
        });
    }

    setupActionResultHandlers() {
        this.mqttService.on('action:result', (deviceId, data) => {
            if (this.isDeletedDevice(deviceId)) return;

            const db = this.app.locals.db;
            const token = String(data?.command || data?.messageId || data?.action_id || '')
                .toLowerCase().replace(/_/g, '-');
            const moduleMap = [
                ['display', ['display-']],
                ['nfc', ['nfc-']],
                ['rfid', ['rfid-']],
                ['touch', ['touch-']],
                ['keyboard', ['keyboard-']],
                ['camera', ['camera-', 'intercom-', 'webcam-']]
            ];
            const matched = moduleMap.find(([, prefixes]) => prefixes.some(prefix => token.startsWith(prefix)));

            const classification = classifyCommandResult(data);
            if (db && matched && classification.terminal) {
                const [moduleKey] = matched;
                const update = classification.successful
                    ? markModuleSuccess(db, deviceId, moduleKey, data.message || 'Command completed', data)
                    : markModuleFailure(db, deviceId, moduleKey, data.error || data.message || 'Command failed', data);
                update.catch(() => {});
            }

            // Native ESP32 results have one wire and one browser event shape.
            this.toDevice(deviceId, 'action:result', { deviceId, ...data });
            this.fireEvent('command.ack', deviceId, data);
        });
    }

    setupStorageHandlers() {
        // Handle storage list response
        this.mqttService.on('storage:list', (deviceId, data) => {
            logger.info(`📁 Storage list from ${deviceId}: ${data.files?.length || 0} files`);
            const db = this.app.locals.db;

            // Update modemService with SD card info
            if (this.modemService && data.stats) {
                this.modemService.updateDeviceStatus(deviceId, {
                    sd: {
                        mounted: true,
                        total: data.stats.total,
                        used: data.stats.used,
                        free: data.stats.free
                    }
                });
            }

            if (db) {
                markModuleSuccess(db, deviceId, 'storage', 'Storage listing received', {
                    files: data.files?.length || 0,
                    stats: data.stats || null
                }).catch(() => {});
            }

            // Emit via Socket.IO
            if (this.io) {
                this.toDevice(deviceId, 'storage:list', { deviceId, ...data });
            }
        });

        // Handle storage info response
        this.mqttService.on('storage:info', (deviceId, data) => {
            logger.info(`💾 Storage info from ${deviceId}: ${data.total ? Math.round(data.total / 1024 / 1024 / 1024) + 'GB' : 'Unknown'}`);
            const db = this.app.locals.db;

            if (this.modemService) {
                this.modemService.updateDeviceStatus(deviceId, {
                    sd: {
                        mounted: data.mounted ?? data.success ?? false,  // firmware sends 'mounted'; legacy sends 'success'
                        total: data.total || 0,
                        used: data.used || 0,
                        free: data.free || 0,
                        type: data.type || 'SSD',
                        filesystem: data.filesystem || 'FAT32',
                        bus: data.bus || null
                    }
                });
            }

            if (db) {
                const mounted = data.mounted ?? data.success ?? false;
                const update = mounted
                    ? markModuleSuccess(db, deviceId, 'storage', 'Storage info refreshed', data)
                    : upsertModuleHealth(db, {
                        deviceId,
                        moduleKey: 'storage',
                        supported: true,
                        state: 'warning',
                        message: data.error || 'Storage not mounted',
                        details: data
                    });
                update.catch(() => {});
            }

            if (this.io) {
                this.toDevice(deviceId, 'storage:info', { deviceId, ...data });
            }
        });

        // Handle file read response
        this.mqttService.on('storage:read', (deviceId, data) => {
            logger.info(`📖 File read from ${deviceId}: ${data.path}`);
            this.app.locals.db && markModuleSuccess(this.app.locals.db, deviceId, 'storage', 'File read completed', {
                path: data.path
            }).catch(() => {});
            if (this.io) {
                this.toDevice(deviceId, 'storage:read', { deviceId, ...data });
            }
        });

        // Handle file write response
        this.mqttService.on('storage:write', (deviceId, data) => {
            logger.info(`📝 File written to ${deviceId}: ${data.path}`);
            this.app.locals.db && markModuleSuccess(this.app.locals.db, deviceId, 'storage', 'File write completed', {
                path: data.path,
                bytes: data.bytes || null
            }).catch(() => {});
            if (this.io) {
                this.toDevice(deviceId, 'storage:write', { deviceId, ...data });
            }
        });

        // Handle delete response
        this.mqttService.on('storage:delete', (deviceId, data) => {
            logger.info(`🗑️ Items deleted from ${deviceId}: ${data.items?.length || 0} items`);
            this.app.locals.db && markModuleSuccess(this.app.locals.db, deviceId, 'storage', 'Storage delete completed', data).catch(() => {});
            if (this.io) {
                this.toDevice(deviceId, 'storage:delete', { deviceId, ...data });
            }
        });

        // Handle rename response
        this.mqttService.on('storage:rename', (deviceId, data) => {
            logger.info(`✏️ Item renamed on ${deviceId}: ${data.oldPath} -> ${data.newName}`);
            this.app.locals.db && markModuleSuccess(this.app.locals.db, deviceId, 'storage', 'Storage rename completed', data).catch(() => {});
            if (this.io) {
                this.toDevice(deviceId, 'storage:rename', { deviceId, ...data });
            }
        });

        // Handle move response
        this.mqttService.on('storage:move', (deviceId, data) => {
            logger.info(`🚚 Items moved on ${deviceId}: ${data.items?.length || 0} items`);
            this.app.locals.db && markModuleSuccess(this.app.locals.db, deviceId, 'storage', 'Storage move completed', data).catch(() => {});
            if (this.io) {
                this.toDevice(deviceId, 'storage:move', { deviceId, ...data });
            }
        });

        // Handle copy response
        this.mqttService.on('storage:copy', (deviceId, data) => {
            logger.info(`📋 Items copied on ${deviceId}: ${data.items?.length || 0} items`);
            this.app.locals.db && markModuleSuccess(this.app.locals.db, deviceId, 'storage', 'Storage copy completed', data).catch(() => {});
            if (this.io) {
                this.toDevice(deviceId, 'storage:copy', { deviceId, ...data });
            }
        });

        // Handle mkdir response
        this.mqttService.on('storage:mkdir', (deviceId, data) => {
            logger.info(`📁 Directory created on ${deviceId}: ${data.path}`);
            this.app.locals.db && markModuleSuccess(this.app.locals.db, deviceId, 'storage', 'Directory created', data).catch(() => {});
            if (this.io) {
                this.toDevice(deviceId, 'storage:mkdir', { deviceId, ...data });
            }
        });
    }

    setupOTAHandlers() {
        // Device reports download+flash progress: { percent: 0-100, stage: 'downloading'|'flashing'|'verifying' }
        this.mqttService.on('ota:progress', (deviceId, data) => {
            logger.info(`🔄 OTA progress from ${deviceId}: ${data.percent ?? '?'}% (${data.stage || 'unknown'})`);
            this.toDevice(deviceId, 'ota:progress', { deviceId, ...data });
        });

        // This topic is advisory transport telemetry. It cannot prove which
        // image booted or that rollback protection was cleared; only the
        // durable OTA lifecycle may emit ota:complete/ota:error.
        this.mqttService.on('ota:status', (deviceId, data) => {
            if (data.success) {
                logger.info(`OTA transport status from ${deviceId}; awaiting verified boot`);
                this.toDevice(deviceId, 'ota:progress', {
                    deviceId, stage: 'awaiting-verified-boot', percent: 95,
                    reportedVersion: data.version || null
                });
            } else {
                logger.warn(`OTA transport reported an error on ${deviceId}; awaiting durable lifecycle result`);
                this.toDevice(deviceId, 'ota:progress', {
                    deviceId, stage: 'transport-error-reported', percent: null,
                    message: data.error || 'OTA transport reported an error'
                });
            }
        });
    }

    setupCapabilitiesHandlers() {
        this.mqttService.on('capabilities', async (deviceId, data) => {
            logger.info(`🔧 Capabilities from ${deviceId}: firmware=${data.firmware || '?'}`);

            const caps = data.caps || data.capabilities || {};
            const mergedCaps = sanitizeStoredCapabilities(caps);
            if (data.board) mergedCaps.board = data.board;
            if (data.specs && typeof data.specs === 'object') mergedCaps.specs = data.specs;
            const db = this.app?.locals?.db;

            if (db) {
                if (!await this.isRegisteredDevice(deviceId)) {
                    await this.noteUnregisteredDevice(deviceId, 'capabilities', data);
                    return;
                }
                await db.run(
                    `INSERT INTO device_profiles
                        (device_id, firmware_version, capabilities, board,
                         has_gps, has_battery, has_sd, has_camera, has_audio,
                         has_display, has_nfc, has_rfid, has_touch, has_keyboard,
                         probed_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                     ON CONFLICT(device_id) DO UPDATE SET
                         firmware_version = COALESCE(excluded.firmware_version, firmware_version),
                         capabilities     = excluded.capabilities,
                         board            = COALESCE(excluded.board, board),
                         has_gps          = excluded.has_gps,
                         has_battery      = excluded.has_battery,
                         has_sd           = excluded.has_sd,
                         has_camera       = excluded.has_camera,
                         has_audio        = excluded.has_audio,
                         has_display      = excluded.has_display,
                         has_nfc          = excluded.has_nfc,
                         has_rfid         = excluded.has_rfid,
                         has_touch        = excluded.has_touch,
                         has_keyboard     = excluded.has_keyboard,
                         probed_at        = CURRENT_TIMESTAMP,
                         updated_at       = CURRENT_TIMESTAMP`,
                    [
                        deviceId,
                        data.firmware || null,
                        JSON.stringify(mergedCaps),
                        data.board || mergedCaps.board || null,
                        mergedCaps.gps      ? 1 : 0,
                        mergedCaps.battery  ? 1 : 0,
                        mergedCaps.sd       ? 1 : 0,
                        mergedCaps.camera   ? 1 : 0,
                        mergedCaps.audio    ? 1 : 0,
                        mergedCaps.display  ? 1 : 0,
                        mergedCaps.nfc      ? 1 : 0,
                        mergedCaps.rfid     ? 1 : 0,
                        mergedCaps.touch    ? 1 : 0,
                        mergedCaps.keyboard ? 1 : 0,
                    ]
                ).catch(err => logger.error(`Failed to save capabilities for ${deviceId}: ${err.message}`));

                const moduleCapabilityMap = {
                    wifi: mergedCaps.wifi,
                    gps: mergedCaps.gps,
                    storage: isCapabilityAvailable(mergedCaps, 'storage'),
                    display: mergedCaps.display,
                    camera: mergedCaps.camera,
                    audio: mergedCaps.audio,
                    nfc: mergedCaps.nfc,
                    rfid: mergedCaps.rfid,
                    touch: mergedCaps.touch,
                    keyboard: mergedCaps.keyboard
                };

                await Promise.all(
                    Object.entries(moduleCapabilityMap).map(([moduleKey, supported]) =>
                        upsertModuleHealth(db, {
                            deviceId,
                            moduleKey,
                            supported: Boolean(supported),
                            state: supported ? 'unknown' : 'unsupported',
                            message: supported ? 'Capability reported by firmware' : 'Firmware support pending on active device'
                        }).catch(() => {})
                    )
                );
            }

            // Emit to UI so sidebar can update without page reload
            this.toDevice(deviceId, 'device:capabilities', {
                deviceId,
                firmware: data.firmware,
                board: data.board || mergedCaps.board || null,
                caps: mergedCaps
            });
        });
    }

    setupPeriodicTasks() {
        // Start periodic online status checker
        const timer = setInterval(() => {
            this.modemService.checkOnlineDevices();

            // Get all devices and emit their status
            const devices = this.modemService.getAllDevices();
            this.io.emit('devices:status', devices);

            // Fire device.offline webhook for devices that just went offline
            if (this._onlineDevices) {
                for (const dev of devices) {
                    const id = dev?.id;
                    if (!id) continue;
                    if (!dev.online && this._onlineDevices.has(id)) {
                        this._onlineDevices.delete(id);
                        this.fireEvent('device.offline', id, { deviceId: id });
                        notificationService.capture({
                            deviceId: id,
                            type: 'warning',
                            severity: 'warning',
                            category: 'device',
                            source: 'device',
                            title: 'Device offline',
                            message: `Device ${id} went offline`,
                            actionUrl: '/devices/about',
                            eventKey: `device.offline:${id}`
                        }).catch(() => {});
                        // Clear any pending GPS debounce timer for this device
                        if (this._gpsDebounce.has(id)) {
                            clearTimeout(this._gpsDebounce.get(id));
                            this._gpsDebounce.delete(id);
                        }
                    }
                }
            }

            // Cleanup old devices
            this.modemService.cleanupOfflineDevices();
        }, 30000); // Check every 30 seconds
        timer.unref?.();

    }

    /**
     * Fire an event through both webhookService and n8nService (non-blocking).
     */
    fireEvent(event, deviceId, payload) {
        this.app.locals.automationEngine?.onEvent?.(event, payload, deviceId);
        this.app.locals.webhookService?.fire(event, deviceId, payload).catch(() => {});
        this.app.locals.n8nService?.fire(event, deviceId, payload).catch(() => {});
    }

    /**
     * Emit a Socket.IO event to sockets subscribed to a device room.
     */
    toDevice(deviceId, event, data) {
        if (deviceId) {
            const room = this.io.to?.('device:' + deviceId);
            if (room?.emit) room.emit(event, data);
            else this.io.emit?.(event, data);
        }
    }

    connect() {
        // Connect to MQTT broker after a short delay
        setTimeout(() => {
            this.mqttService.connect();
        }, 3000);
    }

    disconnect() {
        this.mqttService.disconnect();
    }
}

module.exports = MQTTHandlers;
module.exports.updateLatestActiveCall = updateLatestActiveCall;
module.exports.normalizeCallStatus = normalizeCallStatus;
