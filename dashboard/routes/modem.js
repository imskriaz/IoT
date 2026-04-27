const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { setupApIp, setupApExampleLabel } = require('../config/onboarding');
const { resolveDeviceId } = require('../utils/deviceResolver');
const hostHotspotService = require('../services/hostHotspotService');
const { normalizeSsid, readHostScanSummary } = require('../utils/hostWifiDiagnostics');

const runtimeCapabilities = Object.freeze({
    mobile: {
        remoteToggle: true,
        remoteApn: true
    },
    wifiClient: {
        scan: true,
        remoteToggle: true,
        remoteConnect: true,
        remoteDisconnect: true,
        retrySaved: true,
        configPath: 'device-settings'
    },
    hotspot: {
        remoteToggle: false,
        remoteConfigure: false,
        remoteClientBlock: false,
        remoteClientLimit: false
    },
    usb: {
        remoteToggle: false
    },
    routing: {
        remoteConfigure: true,
        remoteFailover: true,
        remoteLoadBalancing: false,
        remoteNat: false,
        remoteFirewall: false,
        preferModemData: true
    },
    dataUsage: {
        remoteReset: false
    }
});

function emitDeviceEvent(deviceId, event, payload) {
    const normalizedDeviceId = String(deviceId || '').trim();
    if (!global.io) return;
    if (normalizedDeviceId) {
        const room = global.io.to?.('device:' + normalizedDeviceId);
        if (room?.emit) room.emit(event, payload);
        else global.io.emit?.(event, payload);
    } else {
        global.io.emit?.(event, payload);
    }
}

// Internet Connection State (initialized with defaults)
let connectionState = {
    mobile: {
        enabled: false,
        connected: false,
        operator: '',
        operatorName: '',
        networkType: '',
        signalStrength: 0,
        ipAddress: '',
        dataUsage: {
            sent: 0,
            received: 0,
            total: 0
        },
        apn: {
            name: 'internet',
            username: '',
            password: '',
            auth: 'none'
        },
        imei: '',
        iccid: '',
        simNumber: '',
        simStatus: 'absent'
    },
    
    wifiClient: {
        enabled: false,
        connected: false,
        configured: false,
        started: false,
        ssid: '',
        bssid: '',
        signalStrength: 0,
        ipAddress: '',
        security: '',
        channel: 0,
        selectedSsid: '',
        selectedPasswordSet: false,
        desiredSsid: '',
        desiredPasswordSet: false,
        reconnectSuppressed: false,
        connectAttemptCount: 0,
        reconnectCount: 0,
        lastDisconnectReason: 0,
        lastDisconnectReasonText: '',
        lastScanVisibleCount: 0,
        lastScanElapsedMs: 0,
        lastScanSummary: '',
        dataUsage: {
            sent: 0,
            received: 0
        }
    },
    
    wifiHotspot: {
        enabled: false,
        ssid: setupApExampleLabel,
        password: '',
        security: 'WPA2-PSK',
        band: '2.4GHz',
        channel: 0,
        maxClients: 0,
        connectedClients: 0,
        hidden: false,
        ipAddress: setupApIp,
        clients: []
    },
    
    usb: {
        enabled: false,
        connected: false,
        interface: 'usb0',
        ipAddress: '',
        clientIp: ''
    },
    
    routing: {
        defaultGateway: '',
        primarySource: 'none',
        preferModemData: false,
        failover: false,
        loadBalancing: false,
        nat: true,
        firewall: true,
        connectedDevices: 0
    },
    
    system: {
        temperature: 0,
        uptime: null,
        firmware: 'unknown'
    }
};

// Cache for storing real data from device
let deviceCache = new Map(); // deviceId -> { timestamp, data }

function getStateForDevice(deviceId) {
    const cachedState = deviceCache.get(deviceId)?.state;
    return cachedState ? cachedState : JSON.parse(JSON.stringify(connectionState));
}

function isTransportNetworkLabel(value) {
    const text = String(value || '').trim().toLowerCase();
    return text === 'wifi'
        || text === 'wi-fi'
        || text === 'wifi standby'
        || text === 'wi-fi standby'
        || text === 'unknown'
        || text === 'offline'
        || text === 'no service'
        || text === 'no device';
}

function normalizeModemActivePath(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'mobile') return 'modem';
    return normalized;
}

function resolveRoutingPrimarySource(activePath, state) {
    const normalized = normalizeModemActivePath(activePath);
    if (normalized === 'modem' && state.mobile.connected) {
        return 'mobile';
    }
    if (normalized === 'wifi' && state.wifiClient.connected) {
        return 'wifi';
    }
    if (normalized === 'usb' && state.usb.connected) {
        return 'usb';
    }

    if (state.wifiClient.connected && !state.mobile.connected && !state.usb.connected) {
        return 'wifi';
    }
    if (state.mobile.connected && !state.wifiClient.connected && !state.usb.connected) {
        return 'mobile';
    }
    if (state.usb.connected && !state.mobile.connected && !state.wifiClient.connected) {
        return 'usb';
    }

    if (state.wifiClient.connected) {
        return 'wifi';
    }
    if (state.mobile.connected) {
        return 'mobile';
    }
    if (state.usb.connected) {
        return 'usb';
    }

    return 'none';
}

function wifiSignalPercentFromRssi(rssi) {
    const numeric = Number(rssi);
    if (!Number.isFinite(numeric)) {
        return null;
    }

    return Math.min(100, Math.max(0, Math.round((numeric + 100) * 2)));
}

function mapHostScanNetworks(networks = []) {
    return (Array.isArray(networks) ? networks : [])
        .map((network) => {
            const ssid = normalizeSsid(network?.ssid) || 'Hidden Network';
            const signal = Number.isFinite(Number(network?.signal)) ? Number(network.signal) : 0;
            const channel = Number.isFinite(Number(network?.channel)) ? Number(network.channel) : 0;
            const bssids = Array.isArray(network?.bssids) ? network.bssids : [];
            const security = String(network?.authentication || network?.encryption || '').trim() || 'open';
            const band = String(network?.band || '').trim();

            return {
                ssid,
                bssid: String(bssids[0] || '').trim(),
                signal: Math.min(100, Math.max(0, signal)),
                security,
                channel,
                band,
                encrypted: !isOpenWifiSecurity(security, network?.encryption),
                scanSource: 'dashboard_host'
            };
        })
        .filter((network) => network.ssid);
}

function resolveCellularNetworkType(...values) {
    for (const value of values) {
        const text = String(value || '').trim();
        if (!text || isTransportNetworkLabel(text)) {
            continue;
        }
        return text;
    }

    return null;
}

function resolveConnectedFlag(value, fallback = false) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (value === 1 || value === '1') {
        return true;
    }
    if (value === 0 || value === '0') {
        return false;
    }
    return fallback;
}

function setStateForDevice(deviceId, state) {
    const entry = deviceCache.get(deviceId) || {};
    entry.timestamp = Date.now();
    entry.state = state;
    deviceCache.set(deviceId, entry);
}

function resolveRequestDeviceId(req) {
    return resolveDeviceId(req, DEFAULT_DEVICE_ID);
}

async function readStoredWifiProfile(req, deviceId) {
    const db = req.app?.locals?.db;
    if (!db || typeof db.get !== 'function') {
        return { selectedSsid: '', selectedPasswordSet: false, lastSimNumber: '' };
    }

    const profile = await db.get(
        `SELECT wifi_ssid, wifi_pass, last_sim_number, apn
         FROM device_profiles
         WHERE device_id = ?`,
        [deviceId]
    ) || {};

    return {
        selectedSsid: normalizeSsid(profile.wifi_ssid),
        selectedPassword: String(profile.wifi_pass || ''),
        selectedPasswordSet: String(profile.wifi_pass || '').length > 0,
        lastSimNumber: String(profile.last_sim_number || '').trim(),
        modemApn: String(profile.apn || '').trim()
    };
}

async function upsertDeviceProfileFields(req, deviceId, fields = {}) {
    const db = req.app?.locals?.db;
    if (!db || typeof db.run !== 'function') {
        return;
    }

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

    if (!updates.length) {
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

async function readStoredWifiNetwork(req, deviceId, ssid) {
    const db = req.app?.locals?.db;
    const normalizedSsid = normalizeSsid(ssid);
    if (!db || typeof db.get !== 'function' || !normalizedSsid) {
        return null;
    }

    const row = await db.get(
        `SELECT ssid, security, password, password_set, connection_count, last_selected_at, last_connected_at,
                last_signal, last_channel, last_bssid, created_at, updated_at
         FROM device_wifi_networks
         WHERE device_id = ? AND ssid = ?`,
        [deviceId, normalizedSsid]
    );

    if (!row) {
        return null;
    }

    return {
        ssid: normalizeSsid(row.ssid),
        security: String(row.security || '').trim(),
        password: String(row.password || ''),
        passwordSet: !!row.password_set,
        connectionCount: Number(row.connection_count || 0),
        lastSelectedAt: row.last_selected_at || null,
        lastConnectedAt: row.last_connected_at || null,
        lastSignal: row.last_signal == null ? null : Number(row.last_signal),
        lastChannel: row.last_channel == null ? null : Number(row.last_channel),
        lastBssid: String(row.last_bssid || '').trim() || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null
    };
}

async function readPreferredWifiNetwork(req, deviceId) {
    const db = req.app?.locals?.db;
    if (!db || typeof db.get !== 'function') {
        return null;
    }

    const row = await db.get(
        `SELECT ssid, security, password, password_set, connection_count, last_selected_at, last_connected_at,
                last_signal, last_channel, last_bssid, created_at, updated_at
         FROM device_wifi_networks
         WHERE device_id = ?
         ORDER BY
            CASE WHEN last_selected_at IS NOT NULL THEN 0 ELSE 1 END,
            COALESCE(last_selected_at, last_connected_at, updated_at, created_at) DESC,
            ssid COLLATE NOCASE ASC
         LIMIT 1`,
        [deviceId]
    );

    if (!row) {
        return null;
    }

    return {
        ssid: normalizeSsid(row.ssid),
        security: String(row.security || '').trim(),
        password: String(row.password || ''),
        passwordSet: !!row.password_set,
        connectionCount: Number(row.connection_count || 0),
        lastSelectedAt: row.last_selected_at || null,
        lastConnectedAt: row.last_connected_at || null,
        lastSignal: row.last_signal == null ? null : Number(row.last_signal),
        lastChannel: row.last_channel == null ? null : Number(row.last_channel),
        lastBssid: String(row.last_bssid || '').trim() || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null
    };
}

async function listStoredWifiNetworks(req, deviceId, profile = null) {
    const db = req.app?.locals?.db;
    const selectedSsid = normalizeSsid(profile?.selectedSsid);
    const rows = db && typeof db.all === 'function'
        ? await db.all(
            `SELECT ssid, security, password_set, connection_count, last_selected_at, last_connected_at,
                    last_signal, last_channel, last_bssid, created_at, updated_at
             FROM device_wifi_networks
             WHERE device_id = ?
             ORDER BY
                CASE WHEN ssid = ? THEN 0 ELSE 1 END,
                COALESCE(last_connected_at, last_selected_at, updated_at, created_at) DESC,
                ssid COLLATE NOCASE ASC`,
            [deviceId, selectedSsid || '']
        )
        : [];

    const savedNetworks = rows.map((row) => ({
        ssid: normalizeSsid(row.ssid),
        security: String(row.security || '').trim(),
        passwordSet: !!row.password_set,
        connectionCount: Number(row.connection_count || 0),
        lastSelectedAt: row.last_selected_at || null,
        lastConnectedAt: row.last_connected_at || null,
        lastSignal: row.last_signal == null ? null : Number(row.last_signal),
        lastChannel: row.last_channel == null ? null : Number(row.last_channel),
        lastBssid: String(row.last_bssid || '').trim() || null,
        updatedAt: row.updated_at || null,
        source: 'dashboard'
    })).filter((row) => row.ssid);

    if (selectedSsid && !savedNetworks.some((row) => row.ssid === selectedSsid)) {
        savedNetworks.unshift({
            ssid: selectedSsid,
            security: '',
            passwordSet: !!profile?.selectedPasswordSet,
            connectionCount: 0,
            lastSelectedAt: null,
            lastConnectedAt: null,
            lastSignal: null,
            lastChannel: null,
            lastBssid: null,
            updatedAt: null,
            source: 'legacy_profile'
        });
    }

    return savedNetworks;
}

async function persistKnownWifiNetwork(req, deviceId, details = {}) {
    const db = req.app?.locals?.db;
    const ssid = normalizeSsid(details.ssid);
    if (!db || typeof db.run !== 'function' || !ssid) {
        return;
    }

    const security = String(details.security || '').trim() || null;
    const passwordProvided = details.password !== undefined;
    const password = passwordProvided ? String(details.password || '') : '';
    const passwordSet = passwordProvided ? (password.length > 0 ? 1 : 0) : 0;
    const connected = details.connected === true;
    const selected = details.selected !== false;
    const countConnection = details.countConnection !== undefined
        ? details.countConnection === true
        : connected;
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

function isOpenWifiSecurity(...values) {
    return values.some((value) => {
        const normalized = String(value || '').trim().toLowerCase();
        return normalized === 'open'
            || normalized === 'none'
            || normalized === 'unsecured';
    });
}

async function buildWifiScanDiagnostic(req, deviceId) {
    const status = global.modemService?.getDeviceStatus?.(deviceId) || null;
    const wifi = status?.wifi || null;
    const profile = await readStoredWifiProfile(req, deviceId);
    const preferredNetwork = await readPreferredWifiNetwork(req, deviceId).catch(() => null);
    const selectedSsid = preferredNetwork?.ssid || profile.selectedSsid || normalizeSsid(wifi?.ssid);
    const hostScan = await readHostScanSummary(hostHotspotService, selectedSsid);

    let likelyCause = null;
    if (String(wifi?.lastDisconnectReasonText || '').trim() === 'no_ap_found') {
        likelyCause = hostScan.available && selectedSsid && hostScan.desiredVisible === false
            ? 'target_ssid_not_visible_from_dashboard_host'
            : 'target_ssid_not_found_by_device';
    }

    return {
        deviceId,
        selectedSsid: selectedSsid || null,
        selectedPasswordSet: profile.selectedPasswordSet,
        desiredSsid: selectedSsid || null,
        desiredPasswordSet: profile.selectedPasswordSet,
        likelyCause,
        deviceWifi: wifi ? {
            configured: !!wifi.configured,
            started: !!wifi.started,
            connected: !!wifi.connected,
            ssid: normalizeSsid(wifi.ssid) || null,
            ipAddress: String(wifi.ipAddress || '').trim() || null,
            connectAttemptCount: Number(wifi.connectAttemptCount || 0),
            reconnectCount: Number(wifi.reconnectCount || 0),
            lastDisconnectReason: Number(wifi.lastDisconnectReason || 0),
            lastDisconnectReasonText: String(wifi.lastDisconnectReasonText || '').trim() || null,
            lastScanVisibleCount: Number(wifi.lastScanVisibleCount || 0),
            lastScanElapsedMs: Number(wifi.lastScanElapsedMs || 0),
            lastScanSummary: String(wifi.lastScanSummary || '').trim() || null
        } : null,
        hostScan
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

function withTimeout(promise, timeoutMs, message) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
    });

    return Promise.race([
        Promise.resolve(promise).finally(() => {
            if (timer) clearTimeout(timer);
        }),
        timeout
    ]);
}

function normalizeWifiScanResult(data) {
    if (!data || typeof data !== 'object') {
        return null;
    }

    if (Array.isArray(data.networks)) {
        return data;
    }

    if (String(data.command || '').toLowerCase() !== 'wifi_scan') {
        return null;
    }

    let payload = data.payload;
    if (typeof payload === 'string' && payload.trim()) {
        try {
            payload = JSON.parse(payload);
        } catch (_) {
            payload = null;
        }
    }

    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.networks)) {
        return null;
    }

    return {
        networks: payload.networks,
        report: payload.report || null,
        success: data.success,
        messageId: data.messageId || data.action_id,
        detail: data.detail
    };
}

function waitForWifiScanResult(deviceId, timeoutMs) {
    return new Promise((resolve, reject) => {
        const mqttService = global.mqttService;
        if (!mqttService || typeof mqttService.on !== 'function') {
            reject(new Error('MQTT service unavailable'));
            return;
        }

        const cleanup = () => {
            clearTimeout(timer);
            if (typeof mqttService.off === 'function') {
                mqttService.off('wifi:scan', onWifiScan);
                mqttService.off('action:result', onActionResult);
            }
        };

        const maybeResolve = (incomingDeviceId, data) => {
            if (incomingDeviceId !== deviceId) return;
            if (String(data?.command || '').toLowerCase() === 'wifi_scan' && data.success === false) {
                cleanup();
                reject(new Error(`WiFi scan failed: ${data.detail || data.error || 'device_error'}`));
                return;
            }
            const normalized = normalizeWifiScanResult(data);
            if (!normalized) return;
            cleanup();
            resolve(normalized);
        };

        const onWifiScan = (incomingDeviceId, data) => maybeResolve(incomingDeviceId, data);
        const onActionResult = (incomingDeviceId, data) => maybeResolve(incomingDeviceId, data);
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('Timed out waiting for wifi scan result'));
        }, timeoutMs);
        timer.unref?.();

        mqttService.on('wifi:scan', onWifiScan);
        mqttService.on('action:result', onActionResult);
    });
}

function runQueuedDeviceOperation(deviceId, task) {
    if (global.mqttService && typeof global.mqttService.runDeviceOperation === 'function') {
        return global.mqttService.runDeviceOperation(deviceId, task);
    }
    return task();
}

function buildModemLiveCommandOptions(command, options = {}) {
    const normalized = String(command || '').trim().toLowerCase();
    const merged = {
        source: 'dashboard-modem',
        ...options
    };

    if (!merged.domain) {
        if (
            normalized === 'wifi-scan' ||
            normalized === 'hotspot-clients' ||
            normalized.startsWith('wifi-') ||
            normalized.startsWith('hotspot-') ||
            normalized.startsWith('mobile-') ||
            normalized.startsWith('modem-') ||
            normalized.startsWith('routing-')
        ) {
            merged.domain = 'network';
        } else {
            merged.domain = 'control';
        }
    }

    return merged;
}

function publishModemRuntimeCommand(deviceId, command, payload, waitForResponse, timeoutMs, options = {}) {
    if (!global.mqttService) {
        return Promise.reject(new Error('MQTT service unavailable'));
    }

    const runtimeOptions = buildModemLiveCommandOptions(command, {
        skipPersistentQueue: true,
        ...options
    });

    if (typeof global.mqttService.publishRuntimeCommand === 'function') {
        return global.mqttService.publishRuntimeCommand(
            deviceId,
            command,
            payload,
            waitForResponse,
            timeoutMs,
            runtimeOptions
        ).then((response) => {
            if (!waitForResponse && response && response.messageId && response.success === undefined) {
                return {
                    success: true,
                    accepted: true,
                    queued: false,
                    messageId: response.messageId,
                    topic: response.topic,
                    payload: null
                };
            }
            return response;
        });
    }

    return global.mqttService.publishCommand(
        deviceId,
        command,
        payload,
        waitForResponse,
        timeoutMs,
        runtimeOptions
    ).then((response) => {
        if (!waitForResponse && response && response.messageId && response.success === undefined) {
            return {
                success: true,
                accepted: true,
                queued: false,
                messageId: response.messageId,
                topic: response.topic,
                payload: null
            };
        }
        return response;
    });
}

function buildStateFromModemService(deviceId) {
    const modemService = global.modemService;
    if (!modemService || typeof modemService.getStatus !== 'function') return null;

    const status = modemService.getStatus(deviceId);
    const rawDevice = modemService.devices?.get(deviceId) || {};
    if (!status) return null;

    const state = getStateForDevice(deviceId);
    const activePath = normalizeModemActivePath(status.activePath);
    const wifi = status.wifi || {};
    const sim = status.sim || {};
    const operatorName = sim.operatorName
        || status.operator
        || sim.operator
        || rawDevice.mobile?.operatorName
        || rawDevice.mobile?.operator
        || rawDevice.sim?.operatorName
        || rawDevice.sim?.operator
        || '';
    const simNumber = sim.number
        || sim.subscriberNumber
        || status.simNumber
        || status.modem_subscriber_number
        || rawDevice.mobile?.simNumber
        || rawDevice.mobile?.subscriberNumber
        || rawDevice.sim?.number
        || rawDevice.sim?.subscriberNumber
        || rawDevice.status?.modem_subscriber_number
        || '';
    const modemDataEnabled = Boolean(
        status.dataModeEnabled
        || sim.dataModeEnabled
        || rawDevice.status?.data_mode_enabled
        || rawDevice.status?.sim?.dataModeEnabled
        || rawDevice.status?.modem?.dataModeEnabled
    );
    const modemBearerReady = Boolean(
        sim.ipBearer
        || sim.dataSession
        || rawDevice.status?.modem_ip_bearer_ready
        || rawDevice.status?.sim?.ipBearer
        || rawDevice.status?.sim?.dataSession
        || rawDevice.status?.modem?.ipBearer
        || rawDevice.status?.modem?.dataSession
    );
    const modemDataIp = String(
        sim.dataIp
        || rawDevice.status?.modem_data_ip
        || rawDevice.status?.sim?.dataIp
        || rawDevice.status?.modem?.dataIp
        || rawDevice.mobile?.dataIp
        || ''
    ).trim();
    const mobileAvailable = Boolean(
        status.online && (
            activePath === 'modem'
            || activePath === 'mobile'
            || sim.registered
            || sim.ready
            || modemDataEnabled
            || status.operator
            || status.cellularSignal !== null
            || status.cellularSignalDbm !== null
        )
    );
    const mobileConnected = Boolean(status.online && (
        activePath === 'modem'
        || activePath === 'mobile'
        || (modemDataEnabled && (modemBearerReady || Boolean(modemDataIp)))
    ));
    const wifiEnabled = Boolean(
        status.online && (
            wifi.connected
            || wifi.started
            || wifi.mode === 'sta'
            || wifi.mode === 'ap+sta'
        )
    );
    const wifiConnected = Boolean(status.online && wifi.connected);
    const cellularNetworkType = mobileAvailable
        ? (
            resolveCellularNetworkType(
                activePath === 'modem' ? status.network : null,
                status.mobile?.networkType,
                rawDevice.mobile?.networkType,
                rawDevice.status?.mobile?.networkType,
                rawDevice.status?.networkType,
                rawDevice.status?.network
            ) || 'Cellular'
        )
        : '';

    state.mobile.enabled = modemDataEnabled;
    state.mobile.connected = mobileConnected;
    state.mobile.operator = operatorName;
    state.mobile.operatorName = operatorName;
    state.mobile.networkType = cellularNetworkType;
    state.mobile.signalStrength = mobileAvailable ? (status.cellularSignal ?? rawDevice.mobile?.signalStrength ?? 0) : 0;
    state.mobile.signalDbm = mobileAvailable ? (status.cellularSignalDbm ?? rawDevice.mobile?.signalDbm ?? null) : null;
    state.mobile.ipAddress = mobileConnected ? modemDataIp : '';
    state.mobile.dataUsage = {
        sent: Number(status.mobile?.dataUsage?.sent ?? rawDevice.mobile?.dataUsage?.sent ?? state.mobile.dataUsage?.sent ?? 0),
        received: Number(status.mobile?.dataUsage?.received ?? rawDevice.mobile?.dataUsage?.received ?? state.mobile.dataUsage?.received ?? 0),
        total: Number(status.mobile?.dataUsage?.total ?? rawDevice.mobile?.dataUsage?.total ?? state.mobile.dataUsage?.total ?? 0)
    };
    state.mobile.imei = status.imei || rawDevice.imei || '';
    state.mobile.simNumber = simNumber;
    state.mobile.number = simNumber;
    state.mobile.simStatus = sim.registered
        ? 'ready'
        : (sim.ready ? 'sim_ready' : (mobileAvailable ? 'unknown' : 'absent'));
    state.system.temperature = status.temperature ?? rawDevice.system?.temperature ?? 0;
    state.system.battery = status.battery ?? rawDevice.system?.battery ?? null;
    state.system.charging = status.charging ?? rawDevice.system?.charging ?? null;
    state.system.voltage_mV = status.voltageMv ?? rawDevice.system?.voltage_mV ?? null;
    state.system.fuelGaugeIc = rawDevice.system?.fuelGaugeIc || '';
    state.system.chargingIc = rawDevice.system?.chargingIc || '';
    state.system.solarChargingIc = rawDevice.system?.solarChargingIc || '';
    state.system.uptime = status.uptime || null;

    state.wifiClient.enabled = wifiEnabled;
    state.wifiClient.connected = wifiConnected;
    state.wifiClient.configured = !!wifi.configured;
    state.wifiClient.started = !!wifi.started;
    state.wifiClient.mode = wifi.mode || '';
    state.wifiClient.ssid = wifi.ssid || '';
    state.wifiClient.bssid = wifi.bssid || rawDevice.wifi?.bssid || '';
    state.wifiClient.security = wifi.security || rawDevice.wifi?.security || '';
    state.wifiClient.channel = Number(wifi.channel || rawDevice.wifi?.channel || 0);
    state.wifiClient.signalStrength = wifiConnected
        ? Math.max(0, Number(status.wifiSignal ?? rawDevice.wifi?.signalStrength ?? wifiSignalPercentFromRssi(rawDevice.wifi?.rssi) ?? 0))
        : 0;
    state.wifiClient.ipAddress = wifiConnected ? (wifi.ipAddress || '') : '';
    state.wifiClient.dataUsage = {
        sent: Number(status.wifi?.dataUsage?.sent ?? rawDevice.wifi?.dataUsage?.sent ?? state.wifiClient.dataUsage?.sent ?? 0),
        received: Number(status.wifi?.dataUsage?.received ?? rawDevice.wifi?.dataUsage?.received ?? state.wifiClient.dataUsage?.received ?? 0)
    };
    state.wifiClient.connectAttemptCount = Number(wifi.connectAttemptCount || 0);
    state.wifiClient.reconnectCount = Number(wifi.reconnectCount || 0);
    state.wifiClient.reconnectSuppressed = !!(
        wifi.reconnectSuppressed
        ?? rawDevice.wifi?.reconnectSuppressed
        ?? state.wifiClient.reconnectSuppressed
    );
    state.wifiClient.lastDisconnectReason = Number(wifi.lastDisconnectReason || 0);
    state.wifiClient.lastDisconnectReasonText = String(wifi.lastDisconnectReasonText || '').trim();
    state.wifiClient.lastScanVisibleCount = Number(wifi.lastScanVisibleCount || 0);
    state.wifiClient.lastScanElapsedMs = Number(wifi.lastScanElapsedMs || 0);
    state.wifiClient.lastScanSummary = String(wifi.lastScanSummary || '').trim();

    state.wifiHotspot.enabled = Boolean(status.online && wifi.apEnabled);
    state.wifiHotspot.ssid = wifi.apSsid || state.wifiHotspot.ssid;
    state.wifiHotspot.ipAddress = wifi.apIp || state.wifiHotspot.ipAddress;
    state.wifiHotspot.connectedClients = Number(wifi.clients || 0);

    state.routing.primarySource = resolveRoutingPrimarySource(activePath, state);
    state.routing.preferModemData = state.wifiClient.reconnectSuppressed;
    if (state.routing.primarySource === 'none' && state.wifiHotspot.enabled) {
        state.routing.primarySource = 'hotspot';
    }

    setStateForDevice(deviceId, state);
    return state;
}

async function hydrateStateFromInternetStatus(deviceId, timeout = 5000) {
    const response = await getDeviceData(deviceId, 'internet-status', {}, timeout);
    if (response && response.success && response.data) {
        updateStateFromDevice(deviceId, response.data);
        return response.data;
    }
    return null;
}

function respondUnsupported(res, message) {
    return res.status(501).json({
        success: false,
        supported: false,
        message
    });
}

// ==================== HELPER FUNCTIONS ====================

/**
 * Get real device data via MQTT
 */
async function getDeviceData(deviceId, command, params = {}, timeout = 5000) {
    if (!global.mqttService || !global.mqttService.connected) {
        return { success: false, error: 'MQTT not connected' };
    }

    try {
        const response = await global.mqttService.publishCommand(
            deviceId,
            command,
            params,
            true,
            timeout
        );

        return response || { success: false, error: 'No response' };
    } catch (error) {
        if (typeof error?.message === 'string' && error.message.toLowerCase().includes('timeout')) {
            logger.debug(`MQTT timeout for ${command}`);
        } else {
            logger.error(`MQTT error for ${command}:`, error);
        }
        return { success: false, error: 'MQTT command failed' };
    }
}

/**
 * Update connection state with real data
 */
function updateStateFromDevice(deviceId, data) {
    if (!data) return;
    const state = getStateForDevice(deviceId);
    const activePath = normalizeModemActivePath(data.activePath || data.active_path);
    const wifiPayload = data.wifi || null;
    const wifiConnectedFlag = wifiPayload?.connected ?? data.wifi_connected;
    const wifiStarted = wifiPayload?.started ?? data.wifi_started;
    const wifiConfigured = wifiPayload?.configured ?? data.wifi_configured;
    const wifiSsid = wifiPayload?.ssid ?? data.wifi_ssid;
    const wifiIpAddress = wifiPayload?.ipAddress ?? data.wifi_ip_address;
    const wifiSecurity = wifiPayload?.security ?? data.wifi_security;
    const wifiReconnectSuppressed = wifiPayload?.reconnectSuppressed
        ?? wifiPayload?.reconnect_suppressed
        ?? data.wifi_reconnect_suppressed;
    const modemDataEnabled = data.mobile?.enabled
        ?? data.data_mode_enabled
        ?? state.mobile.enabled;
    const modemBearerReady = data.mobile?.ipBearerReady
        ?? data.mobile?.dataSession
        ?? data.modem_ip_bearer_ready
        ?? false;
    const modemDataIp = String(
        data.mobile?.dataIp
        || data.mobile?.ipAddress
        || data.modem_data_ip
        || data.modem_ip_address
        || ''
    ).trim();

    // Update cache
    deviceCache.set(deviceId, {
        timestamp: Date.now(),
        data,
        state
    });

    // Mobile data
    if (data.mobile) {
        state.mobile = {
            ...state.mobile,
            ...data.mobile
        };
    }

    // WiFi client
    if (data.wifi) {
        state.wifiClient = {
            ...state.wifiClient,
            ...data.wifi
        };
    }
    if (wifiConfigured !== undefined) {
        state.wifiClient.configured = !!wifiConfigured;
    }
    if (wifiStarted !== undefined) {
        state.wifiClient.started = !!wifiStarted;
        state.wifiClient.enabled = !!wifiStarted;
    }
    if (wifiSsid !== undefined) {
        state.wifiClient.ssid = String(wifiSsid || '');
    }
    if (wifiIpAddress !== undefined) {
        state.wifiClient.ipAddress = String(wifiIpAddress || '');
    }
    if (wifiSecurity !== undefined) {
        state.wifiClient.security = String(wifiSecurity || '');
    }

    // WiFi hotspot
    if (data.hotspot) {
        state.wifiHotspot = {
            ...state.wifiHotspot,
            ...data.hotspot
        };
    }

    // USB
    if (data.usb) {
        state.usb = {
            ...state.usb,
            ...data.usb
        };
    }

    // System
    if (data.system) {
        state.system = {
            ...state.system,
            ...data.system
        };
    }

    // Determine internet availability
    state.mobile.enabled = Boolean(modemDataEnabled);
    state.mobile.connected = Boolean(
        state.mobile.enabled
        && resolveConnectedFlag(
            data.mobile?.connected,
            activePath === 'modem'
            || activePath === 'mobile'
            || modemBearerReady
            || Boolean(modemDataIp)
        )
    );
    state.mobile.ipAddress = state.mobile.connected ? modemDataIp : '';
    state.wifiClient.connected = state.wifiClient.enabled && resolveConnectedFlag(
        wifiConnectedFlag,
        activePath === 'wifi' || state.wifiClient.ipAddress !== ''
    );
    state.wifiClient.reconnectSuppressed = !!(
        wifiReconnectSuppressed
        ?? state.wifiClient.reconnectSuppressed
    );

    // Update routing
    state.routing.primarySource = resolveRoutingPrimarySource(activePath, state);
    state.routing.preferModemData = state.wifiClient.reconnectSuppressed;

    setStateForDevice(deviceId, state);
}

// ==================== MAIN STATUS ENDPOINT ====================

/**
 * Get complete internet status (real data from device)
 * GET /api/modem/status?deviceId=1
 */
router.get('/status', async (req, res) => {
    try {
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const liveState = buildStateFromModemService(deviceId);

        if (!liveState) {
            // Try to get real data from device only when we have no modem snapshot.
            const hydrated = await hydrateStateFromInternetStatus(deviceId, 5000);
            if (!hydrated) {
                const cached = deviceCache.get(deviceId);
                if (cached?.data && (Date.now() - cached.timestamp) < 30000) {
                    updateStateFromDevice(deviceId, cached.data);
                }
            }
        }

        const state = getStateForDevice(deviceId);
        const storedWifiProfile = await readStoredWifiProfile(req, deviceId).catch(() => ({
            selectedSsid: '',
            selectedPassword: '',
            selectedPasswordSet: false,
            lastSimNumber: '',
            modemApn: ''
        }));
        const savedNetworks = await listStoredWifiNetworks(req, deviceId, storedWifiProfile).catch(() => []);
        const preferredWifiNetwork = savedNetworks.find((network) => network.lastSelectedAt) || savedNetworks[0] || null;
        state.wifiClient.selectedSsid = preferredWifiNetwork?.ssid || storedWifiProfile.selectedSsid || '';
        state.wifiClient.selectedPasswordSet = preferredWifiNetwork?.passwordSet ?? !!storedWifiProfile.selectedPasswordSet;
        state.wifiClient.desiredSsid = state.wifiClient.selectedSsid;
        state.wifiClient.desiredPasswordSet = state.wifiClient.selectedPasswordSet;
        state.wifiClient.savedNetworks = savedNetworks;
        state.mobile.apn.name = storedWifiProfile.modemApn || state.mobile.apn.name || 'internet';
        if (!state.mobile.simNumber && storedWifiProfile.lastSimNumber) {
            state.mobile.simNumber = storedWifiProfile.lastSimNumber;
            state.mobile.number = storedWifiProfile.lastSimNumber;
        }

        const internetAvailable = state.mobile.connected || 
                                 state.wifiClient.connected || 
                                 state.usb.connected;

        res.json({
            success: true,
            data: {
                capabilities: runtimeCapabilities,
                internet: {
                    available: internetAvailable,
                    activeSource: state.routing.primarySource,
                    sources: {
                        mobile: state.mobile.connected,
                        wifi: state.wifiClient.connected,
                        usb: state.usb.connected
                    }
                },
                sharing: {
                    hotspot: state.wifiHotspot.enabled,
                    usb: state.usb.enabled && state.usb.connected,
                    connectedDevices: state.wifiHotspot.connectedClients
                },
                routing: state.routing,
                mobile: state.mobile,
                wifiClient: state.wifiClient,
                wifiHotspot: state.wifiHotspot,
                usb: state.usb,
                system: state.system
            }
        });
    } catch (error) {
        logger.error('API internet status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get internet status'
        });
    }
});

// ==================== MOBILE DATA ====================

/**
 * Get mobile data status
 * GET /api/modem/mobile/status?deviceId=1
 */
router.get('/mobile/status', async (req, res) => {
    try {
        const deviceId = resolveRequestDeviceId(req);
        const liveState = buildStateFromModemService(deviceId);

        if (!liveState) {
            await hydrateStateFromInternetStatus(deviceId, 5000);
        }

        res.json({
            success: true,
            data: getStateForDevice(deviceId).mobile
        });
    } catch (error) {
        logger.error('API mobile status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get mobile data status'
        });
    }
});

/**
 * Toggle mobile data
 * POST /api/modem/mobile/toggle
 */
router.post('/mobile/toggle', [
    body('enabled').isBoolean(),
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

        const { enabled } = req.body;
        const deviceId = resolveRequestDeviceId(req);

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        buildStateFromModemService(deviceId);
        await hydrateStateFromInternetStatus(deviceId, 3000).catch(() => null);
        const state = getStateForDevice(deviceId);
        if (!enabled && !state.wifiClient.connected) {
            return res.status(409).json({
                success: false,
                message: 'Connect Wi-Fi first before turning mobile data off'
            });
        }
        const disablingActiveModemPath = !enabled && state.routing.primarySource === 'mobile' && state.mobile.connected;
        const response = await publishModemRuntimeCommand(
            deviceId,
            'mobile-toggle',
            { enabled },
            !disablingActiveModemPath,
            enabled ? 20000 : 12000,
            { skipQueue: true }
        );

        if (response && response.success) {
            state.mobile.enabled = enabled;
            state.mobile.connected = response.payload?.connected === true ? true : (enabled ? state.mobile.connected : false);
            state.mobile.ipAddress = response.payload?.ip_address || (state.mobile.connected ? state.mobile.ipAddress : '');
            if (!enabled) {
                state.mobile.connected = false;
                state.mobile.ipAddress = '';
                if (state.routing.primarySource === 'mobile') {
                    state.routing.primarySource = state.wifiClient.connected
                        ? 'wifi'
                        : (state.usb.connected ? 'usb' : 'none');
                }
            }
            setStateForDevice(deviceId, state);

            emitDeviceEvent(deviceId, 'internet:mobile', {
                enabled,
                connected: state.mobile.connected,
                deviceId
            });

            res.json({
                success: true,
                message: disablingActiveModemPath
                    ? 'Mobile data disable requested. The device may drop modem MQTT while switching paths.'
                    : `Mobile data ${enabled ? 'enabled' : 'disabled'}`,
                data: {
                    enabled,
                    connected: state.mobile.connected,
                    ipAddress: state.mobile.ipAddress || '',
                    cutoverSensitive: disablingActiveModemPath
                }
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to toggle mobile data'
            });
        }
    } catch (error) {
        logger.error('API mobile toggle error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to toggle mobile data'
        });
    }
});

/**
 * Configure APN
 * POST /api/modem/mobile/apn
 */
router.post('/mobile/apn', [
    body('apn').trim().notEmpty().isLength({ max: 63 }),
    body('username').optional().trim().isLength({ max: 64 }),
    body('password').optional().isLength({ max: 64 }),
    body('auth').optional().isIn(['none', 'pap', 'chap'])
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { apn, username, password, auth } = req.body;
        const deviceId = resolveRequestDeviceId(req);

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const apnConfig = {
            apn,
            username: username || '',
            password: password || '',
            auth: auth || 'none'
        };

        buildStateFromModemService(deviceId);
        await hydrateStateFromInternetStatus(deviceId, 3000).catch(() => null);
        const state = getStateForDevice(deviceId);
        const activeModemPath = state.routing.primarySource === 'mobile' && state.mobile.connected;
        const response = await publishModemRuntimeCommand(
            deviceId,
            'mobile-apn',
            apnConfig,
            !activeModemPath,
            20000,
            { skipQueue: true }
        );

        if (response && response.success) {
            await upsertDeviceProfileFields(req, deviceId, { apn });
            state.mobile.apn = {
                ...state.mobile.apn,
                name: apn,
                username: '',
                password: '',
                auth: auth || 'none'
            };
            setStateForDevice(deviceId, state);

            res.json({
                success: true,
                message: activeModemPath
                    ? 'APN update requested. The modem bearer may restart while applying it.'
                    : 'APN configured successfully',
                data: {
                    ...apnConfig,
                    appliedUsername: '',
                    appliedPasswordSet: false,
                    cutoverSensitive: activeModemPath
                }
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to configure APN'
            });
        }
    } catch (error) {
        logger.error('API APN error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to configure APN'
        });
    }
});

// ==================== WIFI CLIENT ====================

/**
 * Scan WiFi networks (real scan)
 * GET /api/modem/wifi/client/scan?deviceId=1
 */
router.get('/wifi/client/scan', async (req, res) => {
    const deviceId = resolveRequestDeviceId(req);
    const scanTimeoutMs = 75000;
    const firmwareTimeoutMs = 65000;
    const publishAckTimeoutMs = 5000;

    try {
        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const data = await runQueuedDeviceOperation(deviceId, async () => {
            const scanResult = waitForWifiScanResult(deviceId, scanTimeoutMs);

            try {
                const publishPromise = global.mqttService.publishCommand(
                    deviceId,
                    'wifi-scan',
                    { timeout: firmwareTimeoutMs },
                    false,
                    scanTimeoutMs,
                    buildModemLiveCommandOptions('wifi-scan', { skipQueue: true })
                );
                publishPromise.catch(error => {
                    logger.warn(`WiFi scan publish eventually failed: ${error.message}`);
                });

                try {
                    await withTimeout(
                        publishPromise,
                        publishAckTimeoutMs,
                        'Timed out waiting for wifi-scan publish ACK'
                    );
                } catch (error) {
                    if (error.message !== 'Timed out waiting for wifi-scan publish ACK') {
                        throw error;
                    }
                    logger.warn(`WiFi scan publish ACK timeout; waiting for device result: ${deviceId}`);
                }

                return await scanResult;
            } catch (error) {
                scanResult.catch(() => {});
                throw error;
            }
        });

        if (data && Array.isArray(data.networks)) {
            const networks = data.networks.map(net => ({
                band: Number(net.frequency || 0) >= 5000 || Number(net.channel || 0) > 14 ? '5GHz' : '2.4GHz',
                ssid: net.ssid || 'Hidden Network',
                bssid: net.bssid || '',
                signal: net.rssi ? Math.min(100, Math.max(0, (net.rssi + 100) * 2)) : 0,
                security: net.encryption || 'open',
                channel: net.channel || 0,
                encrypted: net.encryption !== 'open'
            }));

            res.json({
                success: true,
                data: networks
            });
        } else {
            res.json({
                success: true,
                data: [] // No networks found
            });
        }
    } catch (error) {
        if (typeof error?.message === 'string' && (
            error.message.includes('Timed out waiting for wifi:scan') ||
            error.message.includes('Timed out waiting for wifi scan result') ||
            error.message.includes('WiFi scan failed:')
        )) {
            logger.warn(`API WiFi scan timeout: ${error.message}`);
            const diagnostic = await buildWifiScanDiagnostic(req, deviceId).catch(() => null);
            const selectedSsid = diagnostic?.selectedSsid || diagnostic?.desiredSsid;
            const hostScan = diagnostic?.hostScan || null;
            const fallbackNetworks = mapHostScanNetworks(hostScan?.networks || hostScan?.sampleNetworks || []);
            const targetInvisible = selectedSsid
                && hostScan?.available
                && hostScan.desiredVisible === false;
            const message = targetInvisible
                ? `Selected network ${selectedSsid} was not visible from the dashboard host during a local Wi-Fi scan.`
                : 'Device did not publish WiFi scan results before timeout.';

            if (fallbackNetworks.length > 0) {
                return res.json({
                    success: true,
                    data: fallbackNetworks,
                    scanSource: 'dashboard_host',
                    degraded: true,
                    message,
                    diagnostic
                });
            }

            return res.status(504).json({
                success: false,
                message,
                diagnostic,
                data: fallbackNetworks,
                scanSource: fallbackNetworks.length > 0 ? 'dashboard_host' : null
            });
        }

        logger.error('API WiFi scan error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to scan WiFi networks'
        });
    }
});

/**
 * Connect to WiFi network
 * POST /api/modem/wifi/client/connect
 */
router.post('/wifi/client/connect', [
    body('ssid').trim().notEmpty().isLength({ max: 64 }),
    body('password').optional().isLength({ max: 64 }),
    body('security').optional({ nullable: true }).trim().isLength({ max: 64 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { ssid, password, security } = req.body;
        const deviceId = resolveRequestDeviceId(req);

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const targetSsid = normalizeSsid(ssid);
        const providedPassword = password === undefined
            ? undefined
            : (String(password).length > 0 ? String(password) : undefined);
        const storedNetwork = await readStoredWifiNetwork(req, deviceId, targetSsid);
        const storedProfile = await readStoredWifiProfile(req, deviceId);
        const matchedStoredProfile = storedProfile?.selectedSsid === targetSsid && storedProfile?.selectedPasswordSet;
        const resolvedSecurity = String(security || storedNetwork?.security || '').trim();
        const resolvedPassword = providedPassword !== undefined
            ? providedPassword
            : (storedNetwork?.passwordSet
                ? storedNetwork.password
                : (matchedStoredProfile
                    ? storedProfile.selectedPassword
                    : ''));
        const persistedPassword = providedPassword !== undefined
            ? providedPassword
            : (storedNetwork?.passwordSet
                ? storedNetwork.password
                : (matchedStoredProfile
                    ? storedProfile.selectedPassword
                    : undefined));

        if (!targetSsid) {
            return res.status(400).json({
                success: false,
                message: 'SSID is required'
            });
        }

        if (!isOpenWifiSecurity(resolvedSecurity) && !resolvedPassword) {
            return res.status(409).json({
                success: false,
                message: `Password required to switch ${targetSsid}. Save it once in the dashboard or enter it here.`,
                data: {
                    ssid: targetSsid,
                    savedPasswordSet: !!(storedNetwork?.passwordSet || matchedStoredProfile)
                }
            });
        }

        await persistKnownWifiNetwork(req, deviceId, {
            ssid: targetSsid,
            security: resolvedSecurity,
            password: persistedPassword,
            selected: true,
            connected: false
        });

        const statusProbe = waitForMqttEvent(
            'status',
            deviceId,
            20000,
            (payload) => payload && (
                normalizeSsid(payload.wifi_ssid) === targetSsid
                || payload.wifi_connected === true
                || String(payload.active_path || '').trim().toLowerCase() === 'wifi'
            )
        ).catch(() => null);

        const reconnectResponse = await runQueuedDeviceOperation(deviceId, async () => {
            await global.mqttService.publishCommand(
                deviceId,
                'config-set',
                { key: 'wifi_ssid', value: targetSsid },
                true,
                10000,
                buildModemLiveCommandOptions('config-set', { skipPersistentQueue: true })
            );

            await global.mqttService.publishCommand(
                deviceId,
                'config-set',
                { key: 'wifi_password', value: resolvedPassword },
                true,
                10000,
                buildModemLiveCommandOptions('config-set', { skipPersistentQueue: true })
            );

            return global.mqttService.publishCommand(
                deviceId,
                'wifi-reconnect',
                {},
                true,
                15000,
                buildModemLiveCommandOptions('wifi-reconnect', { skipPersistentQueue: true })
            );
        });

        const observedStatus = await statusProbe;
        const observedWifiConnected = Boolean(
            observedStatus?.wifi_connected
            || String(observedStatus?.active_path || '').trim().toLowerCase() === 'wifi'
        );

        if (observedWifiConnected) {
            await persistKnownWifiNetwork(req, deviceId, {
                ssid: targetSsid,
                security: resolvedSecurity,
                password: persistedPassword,
                selected: true,
                connected: true
            });
        }

        return res.json({
            success: true,
            message: observedWifiConnected
                ? `Connected to ${targetSsid}.`
                : `Switch requested for ${targetSsid}. Waiting for the device to move over to Wi-Fi.`,
            data: {
                ssid: targetSsid,
                selectedSsid: targetSsid,
                selectedPasswordSet: resolvedPassword.length > 0,
                desiredSsid: targetSsid,
                desiredPasswordSet: resolvedPassword.length > 0,
                observedWifiConnected,
                activePath: observedStatus?.active_path || null,
                reconnectAccepted: reconnectResponse?.success !== false
            }
        });
    } catch (error) {
        logger.error('API WiFi connect error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to connect to WiFi'
        });
    }
});

/**
 * Retry a saved WiFi network using dashboard-stored credentials.
 * POST /api/modem/wifi/client/retry
 */
router.post('/wifi/client/retry', [
    body('ssid').optional({ nullable: true }).trim().isLength({ max: 64 }),
    body('deviceId').optional()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || 'Validation failed',
                errors: errors.array()
            });
        }

        const deviceId = resolveRequestDeviceId(req);
        const requestedSsid = normalizeSsid(req.body?.ssid);
        const storedProfile = await readStoredWifiProfile(req, deviceId);
        const preferredNetwork = await readPreferredWifiNetwork(req, deviceId).catch(() => null);
        const retrySsid = requestedSsid || preferredNetwork?.ssid || storedProfile.selectedSsid;

        if (!retrySsid) {
            return res.status(409).json({
                success: false,
                message: 'No saved Wi-Fi network is stored for this device yet.'
            });
        }

        const storedNetwork = await readStoredWifiNetwork(req, deviceId, retrySsid).catch(() => null);
        if (requestedSsid && !storedNetwork) {
            return res.status(409).json({
                success: false,
                message: `No saved Wi-Fi network named ${requestedSsid} was found for this device.`,
                data: {
                    selectedSsid: storedProfile.selectedSsid || '',
                    selectedPasswordSet: storedProfile.selectedPasswordSet,
                    desiredSsid: storedProfile.selectedSsid || '',
                    desiredPasswordSet: storedProfile.selectedPasswordSet
                }
            });
        }

        const resolvedSecurity = String(storedNetwork?.security || '').trim();
        const retryAllowsOpenNetwork = isOpenWifiSecurity(resolvedSecurity);
        const profileMatchesTarget = storedProfile.selectedSsid === retrySsid;
        const resolvedPassword = storedNetwork?.passwordSet
            ? storedNetwork.password
            : (profileMatchesTarget && storedProfile.selectedPasswordSet ? storedProfile.selectedPassword : '');

        if (!resolvedPassword && !retryAllowsOpenNetwork) {
            return res.status(409).json({
                success: false,
                message: `Saved Wi-Fi network ${retrySsid} is missing a password.`,
                data: {
                    selectedSsid: retrySsid,
                    selectedPasswordSet: false,
                    desiredSsid: retrySsid,
                    desiredPasswordSet: false
                }
            });
        }

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const statusProbe = waitForMqttEvent(
            'status',
            deviceId,
            15000,
            (payload) => payload && (
                normalizeSsid(payload.wifi_ssid) === retrySsid
                || payload.wifi_connected === true
                || String(payload.active_path || '').trim().toLowerCase() === 'wifi'
            )
        ).catch(() => null);

        const reconnectResponse = await runQueuedDeviceOperation(deviceId, async () => {
            await global.mqttService.publishCommand(
                deviceId,
                'config-set',
                { key: 'wifi_ssid', value: retrySsid },
                true,
                10000,
                buildModemLiveCommandOptions('config-set', { skipPersistentQueue: true })
            );

            await global.mqttService.publishCommand(
                deviceId,
                'config-set',
                { key: 'wifi_password', value: resolvedPassword },
                true,
                10000,
                buildModemLiveCommandOptions('config-set', { skipPersistentQueue: true })
            );

            return global.mqttService.publishCommand(
                deviceId,
                'wifi-reconnect',
                {},
                true,
                10000,
                buildModemLiveCommandOptions('wifi-reconnect', { skipPersistentQueue: true })
            );
        });

        const observedStatus = await statusProbe;
        const observedWifiConnected = Boolean(
            observedStatus?.wifi_connected
            || String(observedStatus?.active_path || '').trim().toLowerCase() === 'wifi'
        );

        await persistKnownWifiNetwork(req, deviceId, {
            ssid: retrySsid,
            security: resolvedSecurity,
            password: resolvedPassword,
            selected: true,
            connected: observedWifiConnected
        });

        return res.json({
            success: true,
            message: observedWifiConnected
                ? `Saved Wi-Fi network ${retrySsid} is active.`
                : `Retry requested for saved Wi-Fi network ${retrySsid}. Waiting for the device to switch over.`,
            data: {
                selectedSsid: retrySsid,
                selectedPasswordSet: resolvedPassword.length > 0,
                desiredSsid: retrySsid,
                desiredPasswordSet: resolvedPassword.length > 0,
                openNetwork: retryAllowsOpenNetwork,
                observedWifiConnected,
                activePath: observedStatus?.active_path || null,
                reconnectAccepted: reconnectResponse?.success !== false
            }
        });
    } catch (error) {
        logger.error('API WiFi retry error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retry saved Wi-Fi network'
        });
    }
});

/**
 * Toggle WiFi client runtime state
 * POST /api/modem/wifi/client/toggle
 */
router.post('/wifi/client/toggle', [
    body('enabled').isBoolean(),
    body('deviceId').optional()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || 'Validation failed',
                errors: errors.array()
            });
        }

        const { enabled } = req.body;
        const deviceId = resolveRequestDeviceId(req);

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        buildStateFromModemService(deviceId);
        await hydrateStateFromInternetStatus(deviceId, 3000).catch(() => null);
        const state = getStateForDevice(deviceId);
        if (!enabled && !state.mobile.connected) {
            return res.status(409).json({
                success: false,
                message: 'Turn on mobile data and wait for it to connect before turning Wi-Fi off'
            });
        }

        const statusProbe = waitForMqttEvent(
            'status',
            deviceId,
            enabled ? 60000 : 12000,
            (payload) => payload && (
                enabled
                    ? (payload.wifi_started === true || payload.wifi_connected === true)
                    : (
                        payload.wifi_started === false
                        || String(payload.active_path || '').trim().toLowerCase() === 'modem'
                    )
            )
        ).catch(() => null);

        const cutoverSensitive = !enabled && state.routing.primarySource === 'wifi';
        const response = await publishModemRuntimeCommand(
            deviceId,
            'wifi-toggle',
            { enabled },
            false,
            enabled ? 10000 : 12000,
            { skipQueue: true }
        );

        if (!response || !response.success) {
            return res.status(500).json({
                success: false,
                message: response?.message || 'Failed to toggle Wi-Fi'
            });
        }

        const observedStatus = await statusProbe;
        if (observedStatus) {
            updateStateFromDevice(deviceId, observedStatus);
        } else {
            state.wifiClient.enabled = enabled;
            state.wifiClient.started = enabled;
            state.wifiClient.reconnectSuppressed = false;
            if (!enabled) {
                state.wifiClient.connected = false;
                state.wifiClient.ipAddress = '';
                if (state.routing.primarySource === 'wifi' && state.mobile.connected) {
                    state.routing.primarySource = 'mobile';
                }
            }
            setStateForDevice(deviceId, state);
        }

        const nextState = getStateForDevice(deviceId);
        emitDeviceEvent(deviceId, 'internet:wifi-client', {
            enabled: nextState.wifiClient.enabled,
            started: nextState.wifiClient.started,
            connected: nextState.wifiClient.connected,
            deviceId
        });

        return res.json({
            success: true,
            message: enabled
                ? (observedStatus?.wifi_started === true || nextState.wifiClient.started
                    ? 'Wi-Fi enabled'
                    : 'Wi-Fi enable requested')
                : (cutoverSensitive
                    ? 'Wi-Fi disabled. Device stayed online on mobile data.'
                    : 'Wi-Fi disabled'),
            data: {
                enabled: nextState.wifiClient.enabled,
                started: nextState.wifiClient.started,
                connected: nextState.wifiClient.connected,
                activePath: observedStatus?.active_path || nextState.routing.primarySource || null,
                cutoverSensitive
            }
        });
    } catch (error) {
        logger.error('API WiFi toggle error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to toggle Wi-Fi'
        });
    }
});

/**
 * Disconnect from WiFi
 * POST /api/modem/wifi/client/disconnect
 */
router.post('/wifi/client/disconnect', async (req, res) => {
    try {
        const deviceId = resolveRequestDeviceId(req);

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const statusProbe = waitForMqttEvent(
            'status',
            deviceId,
            12000,
            (payload) => payload && (
                payload.wifi_connected === false
                || String(payload.active_path || '').trim().toLowerCase() === 'modem'
                || payload.wifi_reconnect_suppressed === true
            )
        ).catch(() => null);

        await runQueuedDeviceOperation(deviceId, () => global.mqttService.publishCommand(
            deviceId,
            'wifi-disconnect',
            {},
            false,
            10000,
            buildModemLiveCommandOptions('wifi-disconnect', { skipPersistentQueue: true })
        ));

        const observedStatus = await statusProbe;
        if (observedStatus) {
            updateStateFromDevice(deviceId, observedStatus);
        } else {
            const state = getStateForDevice(deviceId);
            state.wifiClient.connected = false;
            state.wifiClient.reconnectSuppressed = true;
            state.routing.preferModemData = true;
            if (state.routing.primarySource === 'wifi' && state.mobile.connected) {
                state.routing.primarySource = 'mobile';
            }
            setStateForDevice(deviceId, state);
        }

        emitDeviceEvent(deviceId, 'internet:wifi-client', {
            deviceId,
            connected: false,
            reconnectSuppressed: true
        });

        res.json({
            success: true,
            message: observedStatus?.active_path === 'modem'
                ? 'Wi-Fi disconnected. Device is now using modem data.'
                : 'Wi-Fi disconnect requested. Modem fallback will stay active while Wi-Fi reconnect is suppressed.',
            data: {
                preferModemData: true,
                activePath: observedStatus?.active_path || null,
                reconnectSuppressed: true
            }
        });
    } catch (error) {
        logger.error('API WiFi disconnect error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to disconnect'
        });
    }
});

router.post('/routing/prefer-modem', [
    body('enabled').isBoolean(),
    body('deviceId').optional()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || 'Validation failed',
                errors: errors.array()
            });
        }

        const { enabled } = req.body;
        const deviceId = resolveRequestDeviceId(req);

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const command = enabled ? 'wifi-disconnect' : 'wifi-reconnect';
        const statusProbe = waitForMqttEvent(
            'status',
            deviceId,
            enabled ? 12000 : 15000,
            (payload) => payload && (
                enabled
                    ? (
                        payload.wifi_connected === false
                        || String(payload.active_path || '').trim().toLowerCase() === 'modem'
                        || payload.wifi_reconnect_suppressed === true
                    )
                    : (
                        payload.wifi_reconnect_suppressed === false
                        || payload.wifi_connected === true
                        || String(payload.active_path || '').trim().toLowerCase() === 'wifi'
                    )
            )
        ).catch(() => null);

        await runQueuedDeviceOperation(deviceId, () => global.mqttService.publishCommand(
            deviceId,
            command,
            {},
            false,
            enabled ? 10000 : 15000,
            buildModemLiveCommandOptions(command, { skipPersistentQueue: true })
        ));

        const observedStatus = await statusProbe;
        if (observedStatus) {
            updateStateFromDevice(deviceId, observedStatus);
        } else {
            const state = getStateForDevice(deviceId);
            state.wifiClient.reconnectSuppressed = enabled;
            state.routing.preferModemData = enabled;
            if (enabled) {
                state.wifiClient.connected = false;
                if (state.routing.primarySource === 'wifi' && state.mobile.connected) {
                    state.routing.primarySource = 'mobile';
                }
            }
            setStateForDevice(deviceId, state);
        }

        const state = getStateForDevice(deviceId);
        return res.json({
            success: true,
            message: enabled
                ? (observedStatus?.active_path === 'modem'
                    ? 'Prefer modem data enabled. Device switched away from Wi-Fi.'
                    : 'Prefer modem data enabled. Wi-Fi reconnect is now suppressed.')
                : (observedStatus?.active_path === 'wifi'
                    ? 'Wi-Fi preference resumed. Device is back on Wi-Fi.'
                    : 'Wi-Fi preference resumed. The device can reconnect to Wi-Fi when it becomes available.'),
            data: {
                preferModemData: enabled,
                reconnectSuppressed: !!state.wifiClient.reconnectSuppressed,
                activePath: observedStatus?.active_path || state.routing.primarySource || null
            }
        });
    } catch (error) {
        logger.error('API prefer modem data error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update preferred internet path'
        });
    }
});

// ==================== WIFI HOTSPOT ====================

/**
 * Toggle WiFi hotspot
 * POST /api/modem/wifi/hotspot/toggle
 */
router.post('/wifi/hotspot/toggle', [
    body('enabled').isBoolean()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { enabled } = req.body;
        const deviceId = resolveRequestDeviceId(req);
        return respondUnsupported(res, 'Remote hotspot toggle is not supported by the current firmware');

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const response = await global.mqttService.publishCommand(
            deviceId,
            'hotspot-toggle',
            { enabled },
            true,
            10000
        );

        if (response && response.success) {
            connectionState.wifiHotspot.enabled = enabled;

            emitDeviceEvent(deviceId, 'internet:hotspot', { deviceId, enabled });

            res.json({
                success: true,
                message: `WiFi hotspot ${enabled ? 'started' : 'stopped'}`,
                data: { enabled }
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to toggle hotspot'
            });
        }
    } catch (error) {
        const isTimeout = error.message?.includes('timeout') || error.message?.includes('Timeout');
        if (isTimeout) {
            logger.warn(`Hotspot toggle timeout — device did not respond (no WiFi hardware?)`);
        } else {
            logger.error(`Hotspot toggle error: ${error.message}`);
        }
        res.status(500).json({ success: false, message: isTimeout ? 'Device did not respond (WiFi not available)' : 'Failed to toggle hotspot' });
    }
});

/**
 * Configure WiFi hotspot
 * POST /api/modem/wifi/hotspot/configure
 */
router.post('/wifi/hotspot/configure', [
    body('ssid').trim().notEmpty().isLength({ max: 32 }),
    body('password').isLength({ min: 8, max: 64 }),
    body('security').isIn(['WPA2-PSK', 'WPA3', 'open']),
    body('band').isIn(['2.4GHz', '5GHz']),
    body('channel').isInt({ min: 1, max: 11 }),
    body('maxClients').isInt({ min: 1, max: 50 }),
    body('hidden').isBoolean()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { 
            ssid, password, security, band, channel, 
            maxClients, hidden
        } = req.body;
        const deviceId = resolveRequestDeviceId(req);
        return respondUnsupported(res, 'Remote hotspot configuration is not supported by the current firmware');

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const config = {
            ssid,
            password,
            security,
            band,
            channel: parseInt(channel),
            maxClients: parseInt(maxClients),
            hidden
        };

        const response = await global.mqttService.publishCommand(
            deviceId,
            'hotspot-configure',
            config,
            true,
            10000
        );

        if (response && response.success) {
            connectionState.wifiHotspot = {
                ...connectionState.wifiHotspot,
                ...config
            };

            res.json({
                success: true,
                message: 'Hotspot configured',
                data: config
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to configure'
            });
        }
    } catch (error) {
        const isTimeout = error.message?.includes('timeout') || error.message?.includes('Timeout');
        if (isTimeout) {
            logger.warn(`Hotspot configure timeout — device did not respond`);
        } else {
            logger.error(`Hotspot configure error: ${error.message}`);
        }
        res.status(500).json({ success: false, message: isTimeout ? 'Device did not respond' : 'Failed to configure hotspot' });
    }
});

/**
 * Get hotspot clients (real connected devices)
 * GET /api/modem/wifi/hotspot/clients?deviceId=1
 */
router.get('/wifi/hotspot/clients', async (req, res) => {
    try {
        const deviceId = resolveRequestDeviceId(req);
        if (
            runtimeCapabilities.hotspot.remoteToggle !== true &&
            runtimeCapabilities.hotspot.remoteConfigure !== true &&
            runtimeCapabilities.hotspot.remoteClientBlock !== true &&
            runtimeCapabilities.hotspot.remoteClientLimit !== true
        ) {
            return res.json({
                success: true,
                data: [],
                count: 0
            });
        }

        if (!global.mqttService || !global.mqttService.connected) {
            return res.json({
                success: true,
                data: [],
                count: 0
            });
        }

        const data = await runQueuedDeviceOperation(deviceId, async () => {
            const clientsResult = waitForMqttEvent(
                'hotspot:clients',
                deviceId,
                10000,
                payload => payload && Array.isArray(payload.clients)
            );

            try {
                await global.mqttService.publishCommand(
                    deviceId,
                    'hotspot-clients',
                    {},
                    false,
                    10000,
                    buildModemLiveCommandOptions('hotspot-clients', { skipQueue: true })
                );

                return await clientsResult;
            } catch (error) {
                clientsResult.catch(() => {});
                throw error;
            }
        });

        if (data && Array.isArray(data.clients)) {
            const count = Number.isFinite(data.count) ? Number(data.count) : data.clients.length;
            connectionState.wifiHotspot.connectedClients = count;
            connectionState.wifiHotspot.clients = data.clients;

            res.json({
                success: true,
                data: data.clients,
                count
            });
        } else {
            res.json({
                success: true,
                data: [],
                count: 0
            });
        }
    } catch (error) {
        const isTimeout = error.message?.includes('timeout') || error.message?.includes('Timeout');
        logger[isTimeout ? 'warn' : 'error'](`Hotspot clients ${isTimeout ? 'timeout' : 'error'}: ${error.message}`);
        res.json({ success: true, data: [], count: 0 });
    }
});

/**
 * Block hotspot client
 * POST /api/modem/wifi/hotspot/clients/block
 */
router.post('/wifi/hotspot/clients/block', [
    body('mac').notEmpty()
], async (req, res) => {
    try {
        const { mac } = req.body;
        const deviceId = resolveRequestDeviceId(req);
        return respondUnsupported(res, 'Remote hotspot client blocking is not supported by the current firmware');

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const response = await global.mqttService.publishCommand(
            deviceId,
            'hotspot-block',
            { mac },
            true,
            5000
        );

        if (response && response.success) {
            // Remove from clients list
            connectionState.wifiHotspot.clients = 
                connectionState.wifiHotspot.clients.filter(c => c.mac !== mac);
            connectionState.wifiHotspot.connectedClients--;

            res.json({
                success: true,
                message: 'Client blocked'
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to block client'
            });
        }
    } catch (error) {
        logger.error('API block client error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to block client'
        });
    }
});

/**
 * Limit hotspot client bandwidth
 * POST /api/modem/wifi/hotspot/clients/limit
 */
router.post('/wifi/hotspot/clients/limit', [
    body('mac').notEmpty(),
    body('speed').isInt({ min: 1 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { mac, speed } = req.body;
        const deviceId = resolveRequestDeviceId(req);
        return respondUnsupported(res, 'Remote hotspot bandwidth limiting is not supported by the current firmware');

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const response = await global.mqttService.publishCommand(
            deviceId,
            'hotspot-limit',
            { mac, speed: parseInt(speed, 10) },
            true,
            5000
        );

        if (response && response.success) {
            return res.json({
                success: true,
                message: 'Client bandwidth limit applied'
            });
        }

        res.status(501).json({
            success: false,
            message: response?.message || 'Client speed limiting is not supported by current firmware'
        });
    } catch (error) {
        logger.error('API limit client error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to limit client'
        });
    }
});

// ==================== USB TETHERING ====================

/**
 * Toggle USB tethering
 * POST /api/modem/usb/toggle
 */
router.post('/usb/toggle', [
    body('enabled').isBoolean()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { enabled } = req.body;
        const deviceId = resolveRequestDeviceId(req);
        return respondUnsupported(res, 'USB tethering control is not supported by the current firmware');

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const response = await global.mqttService.publishCommand(
            deviceId,
            'usb-toggle',
            { enabled },
            true,
            10000
        );

        if (response && response.success) {
            connectionState.usb.enabled = enabled;

            emitDeviceEvent(deviceId, 'internet:usb', { deviceId, enabled });

            res.json({
                success: true,
                message: `USB tethering ${enabled ? 'enabled' : 'disabled'}`,
                data: { enabled }
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to toggle USB'
            });
        }
    } catch (error) {
        logger.error('API USB toggle error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to toggle USB'
        });
    }
});

// ==================== DATA USAGE ====================

/**
 * Get real data usage
 * GET /api/modem/data-usage?deviceId=1
 */
router.get('/data-usage', async (req, res) => {
    try {
        const deviceId = resolveRequestDeviceId(req);
        buildStateFromModemService(deviceId);
        await hydrateStateFromInternetStatus(deviceId, 5000);
        const state = getStateForDevice(deviceId);

        res.json({
            success: true,
            data: {
                mobile: state.mobile.dataUsage,
                wifi: state.wifiClient.dataUsage,
                total: {
                    sent: state.mobile.dataUsage.sent + state.wifiClient.dataUsage.sent,
                    received: state.mobile.dataUsage.received + state.wifiClient.dataUsage.received
                },
                supported: false,
                message: 'Data usage counters are not reported by the current firmware'
            }
        });
    } catch (error) {
        logger.error('API data usage error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get data usage'
        });
    }
});

/**
 * Reset data usage counters
 * POST /api/modem/data-usage/reset
 */
router.post('/data-usage/reset', async (req, res) => {
    try {
        const deviceId = resolveRequestDeviceId(req);
        return respondUnsupported(res, 'Data usage reset is not supported by the current firmware');

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        const response = await global.mqttService.publishCommand(
            deviceId,
            'data-usage-reset',
            {},
            true,
            5000
        );

        if (response && response.success) {
            connectionState.mobile.dataUsage = { sent: 0, received: 0, total: 0 };
            connectionState.wifiClient.dataUsage = { sent: 0, received: 0 };

            res.json({
                success: true,
                message: 'Data usage reset'
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to reset'
            });
        }
    } catch (error) {
        logger.error('API reset data error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reset data usage'
        });
    }
});

// ==================== ROUTING ====================

/**
 * Configure routing
 * POST /api/modem/routing/configure
 */
router.post('/routing/configure', [
    body('failover').optional().isBoolean(),
    body('loadBalancing').optional().isBoolean(),
    body('nat').optional().isBoolean(),
    body('firewall').optional().isBoolean()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { failover, loadBalancing, nat, firewall } = req.body;
        const deviceId = resolveRequestDeviceId(req);

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'MQTT not connected'
            });
        }

        if (loadBalancing === true || nat === true || firewall === true) {
            return res.status(400).json({
                success: false,
                message: 'Only failover routing is available at runtime on this device'
            });
        }

        const config = {};
        if (failover !== undefined) {
            config.failover = !!failover;
        }
        if (loadBalancing !== undefined) {
            config.loadBalancing = false;
        }
        if (nat !== undefined) {
            config.nat = false;
        }
        if (firewall !== undefined) {
            config.firewall = false;
        }

        const response = await global.mqttService.publishCommand(
            deviceId,
            'routing-configure',
            config,
            true,
            15000,
            buildModemLiveCommandOptions('routing-configure', { skipPersistentQueue: true })
        );

        if (response && response.success) {
            const payload = response.payload && typeof response.payload === 'object' ? response.payload : {};
            const state = getStateForDevice(deviceId);
            const nextFailover = payload.failover ?? config.failover ?? state.routing.failover;
            state.routing = {
                ...state.routing,
                failover: !!nextFailover,
                loadBalancing: false,
                nat: false,
                firewall: false
            };
            setStateForDevice(deviceId, state);

            res.json({
                success: true,
                message: 'Routing failover configured',
                data: {
                    failover: state.routing.failover,
                    loadBalancing: false,
                    nat: false,
                    firewall: false,
                    activePath: state.routing.primarySource
                }
            });
        } else {
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to configure'
            });
        }
    } catch (error) {
        logger.error('API routing config error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to configure routing'
        });
    }
});

// ==================== SIGNAL QUALITY ====================

/**
 * Get real-time signal quality
 * GET /api/modem/signal?deviceId=1
 */
router.get('/signal', async (req, res) => {
    try {
        const deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        const modemStatus = global.modemService?.getStatus?.(deviceId);
        const liveQuality = modemStatus?.signal ?? null;

        if (liveQuality !== null) {
            res.json({
                success: true,
                data: {
                    rssi: liveQuality,
                    ber: null,
                    quality: liveQuality,
                    bars: Math.max(0, Math.min(5, Math.round(liveQuality / 20))),
                    available: true,
                    error: null
                }
            });
        } else {
            await hydrateStateFromInternetStatus(deviceId, 3000);
            const quality = getStateForDevice(deviceId).mobile.signalStrength ?? null;
            const bars = quality == null ? null : Math.max(0, Math.min(5, Math.round(quality / 20)));
            res.json({
                success: true,
                data: {
                    rssi: quality,
                    ber: null,
                    quality,
                    bars,
                    available: quality !== null,
                    error: quality !== null ? null : 'Signal quality unavailable'
                }
            });
        }
    } catch (error) {
        logger.error('API signal error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get signal'
        });
    }
});

module.exports = router;
