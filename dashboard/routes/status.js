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
const {
    applyModuleRulesToCapabilities,
    applyModuleRulesToHealth
} = require('../utils/moduleRules');
const { buildDashboardDeviceStatus } = require('../utils/dashboardStatus');
const { normalizeSsid } = require('../utils/hostWifiDiagnostics');
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

async function requestFreshStatusViaSerial(req, deviceId) {
    const serialBridge = req.app?.locals?.serialBridge;
    if (!serialBridge || typeof serialBridge.refreshStatusSnapshot !== 'function') {
        return null;
    }
    if (typeof serialBridge.isStatusFallbackEnabled === 'function' &&
        serialBridge.isStatusFallbackEnabled() !== true) {
        return null;
    }

    return serialBridge.refreshStatusSnapshot({ deviceId });
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
    const status = modemService.getDeviceStatus(deviceId);
    const db = req.app.locals.db;
    const storedSimRows = await readStoredSimRows(db, deviceId).catch(() => []);
    let deviceStatus = buildDashboardDeviceStatus(status, status.online);
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

    const ruleStatus = {
        ...status,
        ...deviceStatus,
        rawStatus: status
    };
    let caps = inferCapabilitiesFromStatus(ruleStatus);
    let moduleHealth = [];
    try {
        if (db) {
            const capabilityData = await getDeviceCapabilities(db, deviceId);
            caps = mergeCapabilities(capabilityData.caps, caps);
            caps = applyModuleRulesToCapabilities(caps, ruleStatus, {
                mqttConnected: global.mqttService?.connected,
                rawStatus: status
            });
            moduleHealth = await getDeviceModuleHealth(db, deviceId, caps, {
                mqttConnected: global.mqttService?.connected,
                live: ruleStatus
            });
        }
    } catch (_) {}

    if (!moduleHealth.length) {
        caps = applyModuleRulesToCapabilities(caps, ruleStatus, {
            mqttConnected: global.mqttService?.connected,
            rawStatus: status
        });
        moduleHealth = await getDeviceModuleHealth(null, deviceId, caps, {
            mqttConnected: global.mqttService?.connected,
            live: ruleStatus
        });
    }
    moduleHealth = applyModuleRulesToHealth(moduleHealth, caps, ruleStatus, {
        mqttConnected: global.mqttService?.connected,
        rawStatus: status
    });

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
            if (!storedProfile.desiredSsid) {
                const error = new Error('No saved Wi-Fi profile is stored for this device. Update Device Settings first.');
                error.statusCode = 409;
                throw error;
            }
            if (!storedProfile.desiredPasswordSet) {
                const error = new Error(`Saved Wi-Fi profile ${storedProfile.desiredSsid} is missing a password in Device Settings.`);
                error.statusCode = 409;
                throw error;
            }

            const statusProbe = waitForMqttEvent(
                'status',
                deviceId,
                15000,
                (payload) => payload && (
                    normalizeSsid(payload.wifi_ssid) === storedProfile.desiredSsid
                    || payload.wifi_connected === true
                    || String(payload.active_path || '').trim().toLowerCase() === 'wifi'
                )
            ).catch(() => null);

            await runQueuedDeviceOperation(deviceId, async () => {
                await global.mqttService.publishCommand(
                    deviceId,
                    'config-set',
                    { key: 'wifi_ssid', value: storedProfile.desiredSsid },
                    true,
                    10000,
                    buildStatusCommandOptions('config-set', { skipPersistentQueue: true })
                );

                await global.mqttService.publishCommand(
                    deviceId,
                    'config-set',
                    { key: 'wifi_password', value: storedProfile.desiredPassword },
                    true,
                    10000,
                    buildStatusCommandOptions('config-set', { skipPersistentQueue: true })
                );

                await global.mqttService.publishCommand(
                    deviceId,
                    'wifi-reconnect',
                    {},
                    true,
                    10000,
                    buildStatusCommandOptions('wifi-reconnect', { skipPersistentQueue: true })
                );
            });

            const observedStatus = await statusProbe;
            return {
                message: observedStatus?.wifi_connected || String(observedStatus?.active_path || '').trim().toLowerCase() === 'wifi'
                    ? `Saved Wi-Fi profile ${storedProfile.desiredSsid} is active.`
                    : `Requested Wi-Fi reconnect using saved profile ${storedProfile.desiredSsid}.`
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
