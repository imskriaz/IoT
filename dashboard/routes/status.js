const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const modemService = require('../services/modemService');
const { resolveDeviceId } = require('../utils/deviceResolver');
const {
    getDeviceCapabilities,
    inferCapabilitiesFromStatus,
    mergeCapabilities
} = require('../utils/deviceCapabilities');
const { getDeviceModuleHealth } = require('../utils/moduleHealth');
const { buildDashboardDeviceStatus } = require('../utils/dashboardStatus');
const { hydrateDeviceStatusFromCache, readFreshDeviceStatusCache } = require('../utils/deviceStatusCache');
const { readHttpSmsStatusSnapshot } = require('../utils/httpSmsDeviceStatus');
const { normalizeSsid } = require('../utils/hostWifiDiagnostics');
const {
    publishWifiConfigPersistence,
    publishWifiConnectSequence
} = require('../utils/runtimeWifiConnect');
const { readStoredSimRows, applyStoredSimFallback } = require('../services/storedSimService');

const STATUS_REFRESH_COOLDOWN_MS = 3000;
const inflightStatusRefreshes = new Map();
const lastStatusRefreshAt = new Map();

function wantsLiveRefresh(req) {
    const requested = String(req.query.refresh || req.query.live || req.query.force || '').trim().toLowerCase();
    return requested === '1' || requested === 'true' || requested === 'yes';
}

function resolveRequestDeviceId(req) {
    return resolveDeviceId(req, DEFAULT_DEVICE_ID);
}

function firstFiniteNumber(...values) {
    for (const value of values) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function runtimeFromCachedStatus(cached) {
    if (!cached || typeof cached !== 'object') return null;
    const runtime = {
        heapTotal: firstFiniteNumber(cached.heap_total_bytes),
        heapUsed: firstFiniteNumber(cached.heap_used_bytes),
        heapFree: firstFiniteNumber(cached.heap_free_bytes, cached.free_heap_bytes),
        heapLargestFreeBlock: firstFiniteNumber(cached.heap_largest_free_block_bytes, cached.largest_free_block_bytes),
        runtimeRamTotal: firstFiniteNumber(cached.runtime_ram_total_bytes),
        runtimeRamUsed: firstFiniteNumber(cached.runtime_ram_used_bytes),
        runtimeRamFree: firstFiniteNumber(cached.runtime_ram_free_bytes, cached.internal_free_heap_bytes),
        runtimeRamLargestFreeBlock: firstFiniteNumber(cached.runtime_ram_largest_free_block_bytes, cached.internal_largest_free_block_bytes),
        psramTotal: firstFiniteNumber(cached.psram_total_bytes),
        psramUsed: firstFiniteNumber(cached.psram_used_bytes),
        psramFree: firstFiniteNumber(cached.psram_free_bytes, cached.free_psram_bytes),
        psramLargestFreeBlock: firstFiniteNumber(cached.psram_largest_free_block_bytes),
        otherHeapTotal: firstFiniteNumber(cached.other_heap_total_bytes),
        otherHeapUsed: firstFiniteNumber(cached.other_heap_used_bytes),
        otherHeapFree: firstFiniteNumber(cached.other_heap_free_bytes),
        freeHeap: firstFiniteNumber(cached.free_heap_bytes),
        freePsram: firstFiniteNumber(cached.free_psram_bytes),
        largestFreeBlock: firstFiniteNumber(cached.largest_free_block_bytes),
        rebootReason: cached.reboot_reason || null,
        degradedReason: cached.degraded_reason || null
    };
    return Object.values(runtime).some((value) => value !== null && value !== undefined) ? runtime : null;
}

function runQueuedDeviceOperation(deviceId, task) {
    if (global.mqttService && typeof global.mqttService.runDeviceOperation === 'function') {
        return global.mqttService.runDeviceOperation(deviceId, task);
    }
    return task();
}

function buildStatusCommandOptions(command, options = {}) {
    const normalized = String(command || '').trim().toLowerCase();
    const merged = {
        source: 'dashboard-status-panel',
        ...options
    };

    if (!merged.domain) {
        if (normalized === 'get-status' || normalized === 'gps-status' || normalized === 'storage-info') {
            merged.domain = 'status';
        } else if (normalized === 'wifi-reconnect' || normalized === 'config-set') {
            merged.domain = 'network';
        } else {
            merged.domain = 'control';
        }
    }

    if (normalized === 'get-status' && merged.bypassCompatibility == null) {
        merged.bypassCompatibility = true;
    }

    return merged;
}

async function readStoredWifiProfile(req, deviceId) {
    const db = req.app?.locals?.db;
    if (!db || typeof db.get !== 'function') {
        return { desiredSsid: '', desiredPassword: '', desiredPasswordSet: false };
    }

    const profile = await db.get(
        `SELECT wifi_ssid, wifi_pass
         FROM device_profiles
         WHERE device_id = ?`,
        [deviceId]
    ) || {};

    const desiredPassword = String(profile.wifi_pass || '');

    return {
        desiredSsid: normalizeSsid(profile.wifi_ssid),
        desiredPassword,
        desiredPasswordSet: desiredPassword.length > 0
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

function isWifiConnectObserved(status, targetSsid) {
    if (!status || typeof status !== 'object') {
        return false;
    }

    const observedSsid = normalizeSsid(status.wifi_ssid || status.wifi?.ssid || status.wifiSsid);
    const desiredSsid = normalizeSsid(targetSsid);
    const wifiOnline = status.wifi_connected === true
        || status.wifi?.connected === true
        || String(status.active_path || status.activePath || '').trim().toLowerCase() === 'wifi';

    if (observedSsid && desiredSsid) {
        return observedSsid === desiredSsid && wifiOnline;
    }

    return wifiOnline;
}

function getLiveDeviceStatusSnapshot(deviceId) {
    const liveStatus = global.modemService?.getDeviceStatus?.(deviceId);
    if (liveStatus && typeof liveStatus === 'object') {
        return liveStatus;
    }

    const cachedEntry = global.mqttService?.deviceStatus?.get(deviceId);
    return cachedEntry?.lastStatus || cachedEntry || null;
}

function getLiveWifiSsid(status) {
    return normalizeSsid(status?.wifi_ssid || status?.wifi?.ssid || status?.wifiSsid);
}

async function persistWifiConfigToDevice(deviceId, ssid, password) {
    try {
        await runQueuedDeviceOperation(deviceId, () => publishWifiConfigPersistence({
            mqttService: global.mqttService,
            deviceId,
            ssid,
            password,
            waitForResponse: true,
            timeoutMs: 10000,
            commandOptionsFactory: (command, options = {}) => buildStatusCommandOptions(command, options)
        }));
    } catch (error) {
        logger.warn('Status Wi-Fi config persistence failed:', {
            deviceId,
            ssid,
            code: error?.code,
            detail: error?.detail || error?.message
        });
    }
}

async function requestFreshStatus(deviceId, timeoutMs = 8000, ignoreCooldown = false) {
    const mqttService = global.mqttService;
    if (!mqttService) {
        throw new Error('MQTT service unavailable');
    }

    const existing = inflightStatusRefreshes.get(deviceId);
    if (existing) {
        return existing;
    }

    const lastRefreshAt = Number(lastStatusRefreshAt.get(deviceId) || 0);
    if (!ignoreCooldown && (Date.now() - lastRefreshAt) < STATUS_REFRESH_COOLDOWN_MS) {
        return null;
    }

    const refreshPromise = (async () => {
        const messageId = `status_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const eventPromise = waitForMqttEvent('status', deviceId, timeoutMs, data => (
            data?.messageId === messageId
            || data?.action_id === messageId
            || data?.type === 'device_status'
        ));
        eventPromise.catch(() => null);
        try {
            await mqttService.publishCommand(
                deviceId,
                'get-status',
                {},
                false,
                timeoutMs,
                {
                    messageId,
                    source: 'dashboard-status',
                    domain: 'status',
                    bypassCompatibility: true
                }
            );
            const response = await eventPromise;
            lastStatusRefreshAt.set(deviceId, Date.now());
            return response;
        } catch (error) {
            throw error;
        } finally {
            if (inflightStatusRefreshes.get(deviceId) === refreshPromise) {
                inflightStatusRefreshes.delete(deviceId);
            }
        }
    })();

    inflightStatusRefreshes.set(deviceId, refreshPromise);
    return refreshPromise;
}

async function readStoredSimNumber(db, deviceId) {
    if (!db || typeof db.get !== 'function') {
        return null;
    }

    const profile = await db.get(
        `SELECT last_sim_number
         FROM device_profiles
         WHERE device_id = ?`,
        [deviceId]
    ) || {};

    return String(profile.last_sim_number || '').trim() || null;
}

async function buildStatusEnvelope(req, deviceId) {
    const db = req.app.locals.db;
    await hydrateDeviceStatusFromCache(db, modemService, deviceId).catch(() => null);
    const cachedStatus = await readFreshDeviceStatusCache(db, deviceId).catch(() => null);
    let status = modemService.getDeviceStatus(deviceId);
    if (!status?.online) {
        const httpSmsStatus = await readHttpSmsStatusSnapshot(db, deviceId).catch(() => null);
        if (httpSmsStatus) {
            status = httpSmsStatus;
            if (httpSmsStatus.online) {
                modemService.updateDeviceStatus(deviceId, httpSmsStatus);
            }
        }
    }
    const storedSimRows = await readStoredSimRows(db, deviceId).catch(() => []);
    let deviceStatus = buildDashboardDeviceStatus(status, status.online);
    const cachedRuntime = runtimeFromCachedStatus(cachedStatus);
    if (cachedRuntime) {
        deviceStatus.systemRuntime = {
            ...(deviceStatus.systemRuntime || {}),
            ...cachedRuntime
        };
    }
    deviceStatus = applyStoredSimFallback(deviceStatus, storedSimRows);

    if (!deviceStatus.simNumber) {
        const storedSimNumber = await readStoredSimNumber(db, deviceId).catch(() => null);
        if (storedSimNumber) {
            deviceStatus.simNumber = storedSimNumber;
            deviceStatus.subscriberNumber = deviceStatus.subscriberNumber || storedSimNumber;
            deviceStatus.sim = {
                ...(deviceStatus.sim || {}),
                number: deviceStatus.sim?.number || storedSimNumber,
                subscriberNumber: deviceStatus.sim?.subscriberNumber || storedSimNumber
            };
        }
    }

    let dashboardQueue = null;
    try {
        if (global.mqttService?.getDeviceQueueState) {
            dashboardQueue = await global.mqttService.getDeviceQueueState(deviceId);
        }
    } catch (_) {}

    deviceStatus.queueState = {
        dashboard: dashboardQueue,
        device: status.queues || null
    };

    let caps = inferCapabilitiesFromStatus(deviceStatus);
    let moduleHealth = [];
    try {
        if (db) {
            const capabilityData = await getDeviceCapabilities(db, deviceId);
            caps = mergeCapabilities(capabilityData.caps, caps);
            moduleHealth = await getDeviceModuleHealth(db, deviceId, caps, {
                mqttConnected: global.mqttService?.connected,
                live: deviceStatus
            });
        }
    } catch (_) {}

    if (!moduleHealth.length) {
        moduleHealth = await getDeviceModuleHealth(null, deviceId, caps, {
            mqttConnected: global.mqttService?.connected,
            live: deviceStatus
        });
    }

    return {
        success: true,
        data: deviceStatus,
        caps,
        moduleHealth,
        deviceId
    };
}

async function runHeaderModuleAction(req, deviceId, moduleKey) {
    if (!global.mqttService || !global.mqttService.connected) {
        const error = new Error('MQTT not connected');
        error.statusCode = 503;
        throw error;
    }

    switch (moduleKey) {
        case 'wifi': {
            const storedProfile = await readStoredWifiProfile(req, deviceId);
            const liveStatus = getLiveDeviceStatusSnapshot(deviceId);
            const liveWifiSsid = getLiveWifiSsid(liveStatus);
            const targetSsid = storedProfile.desiredSsid || liveWifiSsid;
            const useDeviceLastKnownWifi = !storedProfile.desiredPasswordSet
                && !!liveWifiSsid
                && targetSsid === liveWifiSsid;

            if (!targetSsid) {
                const error = new Error('No saved or live last-known Wi-Fi profile is available for this device.');
                error.statusCode = 409;
                throw error;
            }
            if (!storedProfile.desiredPasswordSet && !useDeviceLastKnownWifi) {
                const error = new Error(`Saved Wi-Fi profile ${targetSsid} is missing a password in Device Settings.`);
                error.statusCode = 409;
                throw error;
            }

            const statusProbe = waitForMqttEvent(
                'status',
                deviceId,
                15000,
                (payload) => isWifiConnectObserved(payload, targetSsid)
            ).catch(() => null);

            await runQueuedDeviceOperation(deviceId, () => (
                useDeviceLastKnownWifi
                    ? global.mqttService.publishCommand(
                        deviceId,
                        'wifi-reconnect',
                        {},
                        false,
                        10000,
                        buildStatusCommandOptions('wifi-reconnect', { skipPersistentQueue: true })
                    )
                    : publishWifiConnectSequence({
                        mqttService: global.mqttService,
                        deviceId,
                        ssid: targetSsid,
                        password: storedProfile.desiredPassword,
                        waitForResponse: false,
                        timeoutMs: 10000,
                        commandOptionsFactory: (command, options = {}) => buildStatusCommandOptions(command, options)
                    })
            ));

            const observedStatus = await statusProbe;
            const observedWifiConnected = isWifiConnectObserved(observedStatus, targetSsid);
            if (observedWifiConnected && !useDeviceLastKnownWifi) {
                await persistWifiConfigToDevice(deviceId, targetSsid, storedProfile.desiredPassword);
            }
            return {
                message: observedWifiConnected
                    ? `${useDeviceLastKnownWifi ? 'Last-known' : 'Saved'} Wi-Fi profile ${targetSsid} is active.`
                    : `Requested Wi-Fi reconnect using ${useDeviceLastKnownWifi ? 'last-known' : 'saved'} profile ${targetSsid}.`
            };
        }

        case 'gps': {
            const messageId = `gps-status_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            await runQueuedDeviceOperation(deviceId, () => {
                const eventPromise = waitForMqttEvent(
                    'gps:status',
                    deviceId,
                    10000,
                    (data) => data?.messageId === messageId
                );
                return global.mqttService.publishCommand(
                    deviceId,
                    'gps-status',
                    {},
                    false,
                    10000,
                    buildStatusCommandOptions('gps-status', { skipQueue: true, messageId })
                ).then(() => eventPromise);
            });
            return { message: 'Requested live GPS status from the device.' };
        }

        case 'storage': {
            await runQueuedDeviceOperation(deviceId, () => {
                const eventPromise = waitForMqttEvent('storage:info', deviceId, 10000);
                return global.mqttService.publishCommand(
                    deviceId,
                    'storage-info',
                    {},
                    false,
                    10000,
                    buildStatusCommandOptions('storage-info', { skipQueue: true })
                ).then(() => eventPromise);
            });
            return { message: 'Requested live storage status from the device.' };
        }

        case 'mqtt':
        case 'modem':
        case 'display':
        case 'camera':
        case 'audio':
        case 'nfc':
        case 'rfid':
        case 'touch':
        case 'keyboard':
        default:
            await requestFreshStatus(deviceId, 8000, true);
            return {
                message: moduleKey === 'mqtt'
                    ? 'Requested live device MQTT status.'
                    : moduleKey === 'modem'
                        ? 'Requested live modem status.'
                        : `Requested live ${moduleKey} status from the device.`
            };
    }
}

function buildNoDeviceStatus() {
    return {
        online: false,
        signal: null,
        signalDbm: null,
        battery: null,
        voltageMv: null,
        charging: null,
        network: 'No Device',
        operator: 'No device selected',
        ip: '0.0.0.0',
        temperature: null,
        uptime: null,
        imei: null,
        sim: null,
        queues: null,
        wifi: null,
        lastSeen: null,
        firstSeen: null,
        queueState: {
            dashboard: null,
            device: null
        },
        activePath: null,
        mqtt: null,
        sync: null,
        storage: null,
        systemRuntime: null,
        call: {
            active: false,
            status: null,
            number: null,
            transportSuspended: false
        },
        transport: {
            voiceSessionActive: false,
            mqttCommandAccepting: false,
            reason: null
        }
    };
}

/**
 * @swagger
 * tags:
 *   name: Status
 *   description: Device connection and sensor status
 */

/**
 * @swagger
 * /status:
 *   get:
 *     summary: Get current device status
 *     tags: [Status]
 *     parameters:
 *       - in: query
 *         name: deviceId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Device status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data: { $ref: '#/components/schemas/Device' }
 */
router.get('/', async (req, res) => {
    try {
        const deviceId = resolveRequestDeviceId(req);
        if (!deviceId) {
            return res.json({
                success: true,
                data: buildNoDeviceStatus(),
                caps: null,
                moduleHealth: [],
                deviceId: ''
            });
        }

        const deviceBusy =
            global.mqttService?.isDeviceBusy?.(deviceId) === true ||
            global.mqttService?.hasDeviceQueueActivity?.(deviceId) === true;
        if (wantsLiveRefresh(req) && !deviceBusy) {
            if (global.mqttService?.connected && global.mqttService?.isDeviceOnline?.(deviceId)) {
                try {
                    await requestFreshStatus(deviceId, 8000);
                } catch (_) {}
            }
        }
        res.json(await buildStatusEnvelope(req, deviceId));
    } catch (error) {
        logger.error('API status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch device status'
        });
    }
});

router.post('/module-action', async (req, res) => {
    try {
        const deviceId = resolveRequestDeviceId(req);
        const moduleKey = String(req.body?.moduleKey || '').trim().toLowerCase();

        if (!deviceId) {
            return res.status(400).json({
                success: false,
                message: 'No active device selected'
            });
        }

        if (!moduleKey) {
            return res.status(400).json({
                success: false,
                message: 'Module key is required'
            });
        }

        const actionResult = await runHeaderModuleAction(req, deviceId, moduleKey);
        const envelope = await buildStatusEnvelope(req, deviceId);

        return res.json({
            success: true,
            message: actionResult.message,
            action: {
                moduleKey
            },
            envelope
        });
    } catch (error) {
        const statusCode = Number(error?.statusCode) || 500;
        logger.error(`API module action error: ${error.message}`);
        return res.status(statusCode).json({
            success: false,
            message: error?.message || 'Failed to run module action'
        });
    }
});

// Get all devices
router.get('/devices', (req, res) => {
    try {
        const devices = modemService.getAllDevices();
        res.json({
            success: true,
            data: devices
        });
    } catch (error) {
        logger.error('API devices error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch devices'
        });
    }
});

// Get device history
router.get('/history/:deviceId', (req, res) => {
    try {
        const { deviceId } = req.params;
        // In production, this would query a database
        res.json({
            success: true,
            data: [] // Placeholder for history data
        });
    } catch (error) {
        logger.error('API history error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch history'
        });
    }
});

module.exports = router;
