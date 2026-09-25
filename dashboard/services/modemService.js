const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { getWifiDisconnectReasonText } = require('../utils/wifiDisconnectReason');
const sdStatus = require('../public/js/sd-status');

const DEVICE_ONLINE_GRACE_MS = 2 * 60 * 1000;

// A missing field is not a measurement of zero, false or null. Normalize only
// values actually reported so compact/partial packets cannot erase telemetry.
function reportedFields(source, aliases, nested = {}) {
    const result = { ...nested };
    for (const [name, keys] of Object.entries(aliases)) {
        const value = [nested[name], ...keys.map(key => source[key])].find(item => item !== undefined);
        if (value !== undefined) result[name] = value;
    }
    return result;
}

function mergeStatusSnapshot(previous, incoming) {
    const result = { ...previous, ...incoming };
    for (const key of ['mqtt', 'tasks', 'health', 'system', 'sensors', 'hardware', 'sdCard']) {
        if (incoming?.[key] && typeof incoming[key] === 'object' && !Array.isArray(incoming[key])) {
            result[key] = { ...previous?.[key], ...incoming[key] };
        }
    }
    return result;
}

const SYSTEM_ALIASES = {
    battery: ['battery'], charging: ['charging'], powerSource: ['power_source'], temperature: ['temperature'], uptime: ['uptime'],
    voltage_mV: ['voltage_mV', 'voltageMv'],
    heapTotal: ['heap_total_bytes'], heapUsed: ['heap_used_bytes'],
    heapFree: ['heap_free_bytes', 'free_heap_bytes'],
    heapLargestFreeBlock: ['heap_largest_free_block_bytes', 'largest_free_block_bytes'],
    runtimeRamTotal: ['runtime_ram_total_bytes'], runtimeRamUsed: ['runtime_ram_used_bytes'],
    runtimeRamFree: ['runtime_ram_free_bytes', 'internal_free_heap_bytes'],
    runtimeRamLargestFreeBlock: ['runtime_ram_largest_free_block_bytes', 'internal_largest_free_block_bytes'],
    psramTotal: ['psram_total_bytes'], psramUsed: ['psram_used_bytes'],
    psramFree: ['psram_free_bytes', 'free_psram_bytes'], psramLargestFreeBlock: ['psram_largest_free_block_bytes'],
    otherHeapTotal: ['other_heap_total_bytes'], otherHeapUsed: ['other_heap_used_bytes'], otherHeapFree: ['other_heap_free_bytes'],
    freeHeap: ['free_heap_bytes', 'heap_free_bytes'], freePsram: ['free_psram_bytes', 'psram_free_bytes'],
    largestFreeBlock: ['largest_free_block_bytes', 'heap_largest_free_block_bytes'],
    rebootReason: ['reboot_reason'], degradedReason: ['degraded_reason']
};

const MQTT_ALIASES = {
    configured: ['mqtt_configured'], connected: ['mqtt_connected'], subscribed: ['mqtt_subscribed'],
    reconnectCount: ['mqtt_reconnect_count'], publishedCount: ['mqtt_published_count'],
    publishFailures: ['mqtt_publish_failures'], commandMessages: ['mqtt_command_messages'],
    commandRejects: ['mqtt_command_rejects'], actionResultsPublished: ['mqtt_action_results_published'],
    actionResultFailures: ['mqtt_action_result_failures'], lastErrorText: ['mqtt_last_error_text']
};

function formatUptime(seconds) {
    if (seconds === null || seconds === undefined || seconds === '') return null;

    if (typeof seconds === 'string') {
        const text = seconds.trim();
        if (!text) return null;
        if (/[dhms]/i.test(text)) {
            return text;
        }
        if (!/^\d+$/.test(text)) {
            return null;
        }
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

/**
 * Convert AT+CSQ RSSI value (0-31, 99=unknown) to useful signal metrics.
 * Formula: dBm = (rssi * 2) - 113  (per 3GPP TS 27.007)
 */
function parseRssi(rssi) {
    const raw = parseInt(rssi);
    if (isNaN(raw) || raw === 99 || raw < 0) {
        return { percent: null, dbm: null, bars: 0, label: 'Unknown' };
    }
    const clamped = Math.min(31, Math.max(0, raw));
    const dbm = (clamped * 2) - 113;
    let bars;
    if (dbm >= -70) bars = 5;
    else if (dbm >= -80) bars = 4;
    else if (dbm >= -90) bars = 3;
    else if (dbm >= -100) bars = 2;
    else if (dbm >= -110) bars = 1;
    else bars = 0;

    const percent = Math.round(((dbm + 113) / 62) * 100);
    return { percent: Math.min(100, Math.max(0, percent)), dbm, bars, label: `${dbm} dBm` };
}

function parseWifiRssi(rssi) {
    const raw = parseInt(rssi, 10);
    // ESP-IDF publishes 0 before the first RSSI sample and after a link reset.
    // Real station RSSI is negative, so never turn the sentinel into 100%.
    if (isNaN(raw) || raw === 0 || raw > 0 || raw < -127) {
        return { percent: null, dbm: null, label: 'Unknown' };
    }

    const percent = Math.min(100, Math.max(0, Math.round((raw + 100) * 2)));
    return { percent, dbm: raw, label: `${raw} dBm` };
}

function normalizeOptionalNumber(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function normalizeSmsStorageTuple(data, prefix) {
    if (!data || data[`${prefix}_total`] === undefined) {
        return null;
    }

    return {
        name: data[`${prefix}_name`] || null,
        used: Number(data[`${prefix}_used`] || 0),
        total: Number(data[`${prefix}_total`] || 0)
    };
}

function normalizeSmsStorageSummary(data) {
    const primary = normalizeSmsStorageTuple(data, 'modem_sms_storage');
    if (!primary) {
        return null;
    }

    return {
        ...primary,
        read: normalizeSmsStorageTuple(data, 'modem_sms_read_storage') || primary,
        write: normalizeSmsStorageTuple(data, 'modem_sms_write_storage') || primary,
        report: normalizeSmsStorageTuple(data, 'modem_sms_report_storage') || primary
    };
}

function normalizeChargingState(charging, battery, voltageMv) {
    if (typeof charging !== 'boolean') {
        return null;
    }

    const normalizedBattery = normalizeOptionalNumber(battery);
    const normalizedVoltage = normalizeOptionalNumber(voltageMv);

    if (normalizedBattery === null && normalizedVoltage === null) {
        return null;
    }

    return charging;
}

function firstDefined(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && value !== '') {
            return value;
        }
    }

    return null;
}

function resolveModemConnection({ session, bearer, dataIp, activePath, legacyConnected } = {}) {
    const hasSession = typeof session === 'boolean';
    const hasBearer = typeof bearer === 'boolean';
    const hasDataIp = String(dataIp || '').trim() !== '';

    if (hasSession) {
        return session === true && bearer === true && hasDataIp;
    }
    if (hasBearer) {
        return bearer === true && hasDataIp;
    }
    if (String(activePath || '').trim().toLowerCase() === 'modem') {
        return hasDataIp;
    }
    return legacyConnected === true && hasDataIp;
}

// Prefer the modem-provided carrier name. If the device only reports a numeric
// operator code, surface that raw code instead of hardcoding a dashboard map.
const normalizeOperatorName = function normalizeOperatorName(value, explicitName) {
    const preferred = String(explicitName || '').trim();
    if (preferred && /[A-Za-z]/.test(preferred)) {
        return preferred;
    }

    const raw = String(value || '').trim();
    if (raw && /[A-Za-z]/.test(raw)) {
        return raw;
    }

    if (preferred) {
        return preferred;
    }

    return raw || null;
};

function resolveOperatorLabel(value, explicitName) {
    const preferred = String(explicitName || '').trim();
    if (preferred && /[A-Za-z]/.test(preferred)) {
        return preferred;
    }

    const raw = String(value || '').trim();
    if (raw && /[A-Za-z]/.test(raw)) {
        return raw;
    }

    if (preferred) {
        return preferred;
    }

    return raw || null;
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

function markStatusOffline(status) {
    if (!status || status.online !== false) {
        return status;
    }

    return {
        ...status,
        signal: null,
        signalDbm: null,
        wifiSignal: null,
        wifiSignalDbm: null,
        cellularSignal: null,
        cellularSignalDbm: null,
        battery: null,
        voltageMv: null,
        charging: null,
        network: 'Offline',
        operator: null,
        displayName: 'Offline',
        ip: null,
        temperature: null,
        uptime: null,
        wifi: status.wifi
            ? {
                ...status.wifi,
                connected: false,
                ipAddress: '',
                rssi: null
            }
            : null,
        activePath: 'offline',
        mqtt: status.mqtt
            ? {
                ...status.mqtt,
                connected: false,
                subscribed: false
            }
            : null,
        call: status.call
            ? {
                ...status.call,
                active: false,
                status: null,
                number: null,
                transportSuspended: true
            }
            : null,
        transport: status.transport
            ? {
                ...status.transport,
                voiceSessionActive: false,
                mqttCommandAccepting: false,
                reason: 'no_recent_heartbeat'
            }
            : {
                voiceSessionActive: false,
                mqttCommandAccepting: false,
                reason: 'no_recent_heartbeat'
            },
        statusFresh: false,
        staleReason: 'no_recent_heartbeat'
    };
}

class ModemService {
    constructor() {
        this.devices = new Map();
        this.wifiNetworks = [];
        this.hotspotClients = [];
    }

    getStatus(deviceId = DEFAULT_DEVICE_ID) {
        const device = this.devices.get(deviceId);

        if (!device) {
            return {
                online: false,
                signal: null,
                signalDbm: null,
                battery: null,
                voltageMv: null,
                charging: null,
                network: 'No Device',
                operator: 'Not Connected',
                ip: '0.0.0.0',
                temperature: null,
                uptime: null,
                imei: null,
                sim: null,
                telephonySupported: null,
                telephonyEnabled: null,
                dataModeEnabled: null,
                wifi: {
                    mode: 'off',
                    connected: false,
                    ssid: '',
                    ipAddress: '',
                    apEnabled: false,
                    apSsid: '',
                    apIp: '',
                    clients: 0,
                    rssi: null,
                    configured: false,
                    started: false,
                    ipAssigned: false,
                    connectAttemptCount: 0,
                    reconnectCount: 0,
                    lastDisconnectReason: 0,
                    lastDisconnectReasonText: ''
                },
                queues: null,
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
                },
                lastSeen: null,
                firstSeen: null
            };
        }

        const now = new Date();
        const lastSeen = new Date(device.lastSeen);
        const lastSeenMs = lastSeen.getTime();
        const heartbeatAgeMs = Number.isFinite(lastSeenMs) ? Math.max(0, now.getTime() - lastSeenMs) : null;
        device.online = heartbeatAgeMs !== null && heartbeatAgeMs <= DEVICE_ONLINE_GRACE_MS;
        const lastStatusMs = Date.parse(device.lastStatusAt || device.status?.lastUpdate || '');
        const statusAgeMs = Number.isFinite(lastStatusMs) ? Math.max(0, now.getTime() - lastStatusMs) : null;
        const statusFresh = device.online && statusAgeMs !== null && statusAgeMs <= DEVICE_ONLINE_GRACE_MS;
        const nestedSystem = device.status?.system || {};
        const nestedSensors = device.status?.sensors || {};
        const system = {
            battery: firstDefined(
                device.system?.battery,
                nestedSystem?.battery,
                nestedSensors?.batterySoc,
                nestedSensors?.battery_soc,
                device.status?.battery
            ),
            charging: firstDefined(
                device.system?.charging,
                nestedSystem?.charging,
                nestedSensors?.charging,
                device.status?.charging
            ),
            powerSource: firstDefined(
                device.system?.powerSource,
                device.system?.power_source,
                nestedSystem?.powerSource,
                nestedSystem?.power_source,
                device.status?.powerSource,
                device.status?.power_source
            ),
            voltage_mV: firstDefined(
                device.system?.voltage_mV,
                device.system?.voltageMv,
                nestedSystem?.voltage_mV,
                nestedSystem?.voltageMv,
                nestedSensors?.batteryVoltage_mV,
                nestedSensors?.battery_voltage_mV,
                device.status?.voltage_mV,
                device.status?.voltageMv
            ),
            temperature: firstDefined(
                device.system?.temperature,
                nestedSystem?.temperature,
                nestedSensors?.temperature_C,
                nestedSensors?.temperature_c,
                device.status?.temperature
            ),
            uptime: firstDefined(device.system?.uptime, nestedSystem?.uptime, device.status?.uptime),
            heapTotal: firstDefined(device.system?.heapTotal, nestedSystem?.heapTotal),
            heapUsed: firstDefined(device.system?.heapUsed, nestedSystem?.heapUsed),
            heapFree: firstDefined(device.system?.heapFree, nestedSystem?.heapFree),
            freeHeap: firstDefined(device.system?.freeHeap, nestedSystem?.freeHeap),
            heapLargestFreeBlock: firstDefined(device.system?.heapLargestFreeBlock, nestedSystem?.heapLargestFreeBlock),
            runtimeRamTotal: firstDefined(device.system?.runtimeRamTotal, nestedSystem?.runtimeRamTotal),
            runtimeRamUsed: firstDefined(device.system?.runtimeRamUsed, nestedSystem?.runtimeRamUsed),
            runtimeRamFree: firstDefined(device.system?.runtimeRamFree, nestedSystem?.runtimeRamFree),
            runtimeRamLargestFreeBlock: firstDefined(device.system?.runtimeRamLargestFreeBlock, nestedSystem?.runtimeRamLargestFreeBlock),
            psramTotal: firstDefined(device.system?.psramTotal, nestedSystem?.psramTotal),
            psramUsed: firstDefined(device.system?.psramUsed, nestedSystem?.psramUsed),
            psramFree: firstDefined(device.system?.psramFree, nestedSystem?.psramFree),
            freePsram: firstDefined(device.system?.freePsram, nestedSystem?.freePsram),
            psramLargestFreeBlock: firstDefined(device.system?.psramLargestFreeBlock, nestedSystem?.psramLargestFreeBlock),
            otherHeapTotal: firstDefined(device.system?.otherHeapTotal, nestedSystem?.otherHeapTotal),
            otherHeapUsed: firstDefined(device.system?.otherHeapUsed, nestedSystem?.otherHeapUsed),
            otherHeapFree: firstDefined(device.system?.otherHeapFree, nestedSystem?.otherHeapFree),
            largestFreeBlock: firstDefined(device.system?.largestFreeBlock, nestedSystem?.largestFreeBlock),
            rebootReason: firstDefined(device.system?.rebootReason, nestedSystem?.rebootReason),
            degradedReason: firstDefined(device.system?.degradedReason, nestedSystem?.degradedReason)
        };
        const statusModem = device.status?.modem || {};
        const statusStorage = device.status?.storage || null;
        const compatSd = device.sd || null;
        const activePath = String(device.status?.active_path || '').trim().toLowerCase();
        const wifiConnected = !!device.wifi?.connected;
        const wifiSignal = parseWifiRssi(device.wifi?.rssi);
        const useWifiSignal = wifiConnected || activePath === 'wifi';

        // When on modem data path, extract signal/operator from modem status fields
        // so the dashboard still shows cellular state consistently.
        const onModemPath = activePath === 'modem' || (!wifiConnected && device.mobile?.connected);
        const rawModemSignal = firstDefined(
            device.status?.modem_signal,
            statusModem?.signalStrength,
            statusModem?.signal,
            device.mobile?.signalRssi,
            device.mobile?.signalStrength
        );
        const modemSignal = rawModemSignal != null && Number(rawModemSignal) > 0
            ? parseRssi(rawModemSignal)
            : null;
        // Pull operator from multiple possible sources: flat status fields, nested mobile, or SIM
        const modemOperator = device.status?.modem_operator_name
            || device.status?.modem_operator
            || statusModem?.operatorName
            || statusModem?.operator
            || device.mobile?.operatorName
            || device.mobile?.operator
            || device.sim?.operatorName
            || device.sim?.operator
            || null;
        const modemSubscriberNumber = firstDefined(
            device.status?.modem_subscriber_number,
            statusModem?.subscriberNumber,
            device.sim?.number,
            device.sim?.subscriberNumber,
            device.mobile?.simNumber,
            device.mobile?.subscriberNumber
        );
        const modemDataIp = firstDefined(
            device.status?.modem_data_ip,
            device.status?.modem_ip_address,
            statusModem?.dataIp,
            statusModem?.ipAddress,
            device.sim?.dataIp
        );
        const modemPdpIp = firstDefined(
            device.status?.modem_pdp_ip_address,
            statusModem?.pdpIpAddress,
            statusModem?.pdpIp,
            device.sim?.pdpIp,
            device.mobile?.pdpIpAddress
        );
        const modemIp = modemDataIp || modemPdpIp;
        const modemRegistered = Boolean(
            device.status?.modem_registered
            || statusModem?.registered
            || device.mobile?.connected
        );
        const explicitModemBearer = firstDefined(
            device.status?.modem_ip_bearer_ready,
            statusModem?.ipBearer
        );
        const explicitModemSession = firstDefined(
            device.status?.modem_data_session_open,
            statusModem?.dataSession
        );
        const modemConnected = resolveModemConnection({
            session: explicitModemSession,
            bearer: explicitModemBearer,
            dataIp: modemDataIp,
            activePath,
            legacyConnected: device.mobile?.connected
        });
        const telephonySupported = firstDefined(
            device.status?.telephony_supported,
            device.status?.telephonySupported,
            statusModem?.telephonySupported,
            statusModem?.telephony_supported,
            device.sim?.telephonySupported,
            device.sim?.telephony_supported
        );
        const telephonyEnabled = firstDefined(
            device.status?.telephony_enabled,
            device.status?.telephonyEnabled,
            statusModem?.telephonyEnabled,
            statusModem?.telephony_enabled,
            device.sim?.telephonyEnabled,
            device.sim?.telephony_enabled
        );
        const dataModeEnabled = firstDefined(
            device.status?.data_mode_enabled,
            device.status?.dataModeEnabled,
            statusModem?.dataModeEnabled,
            statusModem?.data_mode_enabled,
            statusModem?.dataSession,
            device.sim?.dataModeEnabled,
            device.sim?.data_mode_enabled,
            device.sim?.dataSession
        );

        const storage = statusStorage || (compatSd
            ? {
                mounted: !!compatSd.mounted,
                mediaAvailable: !!compatSd.mounted,
                bufferedOnly: !!compatSd.bufferedOnly,
                queueDepth: Number(compatSd.queueDepth || 0),
                pendingUploads: Number(compatSd.pendingUploads || 0),
                totalBytes: Number(firstDefined(compatSd.totalBytes, compatSd.total) || 0),
                usedBytes: Number(firstDefined(compatSd.usedBytes, compatSd.used) || 0),
                freeBytes: Number(firstDefined(compatSd.freeBytes, compatSd.free) || 0),
                type: compatSd.type || 'SSD',
                filesystem: compatSd.filesystem || null,
                bus: compatSd.bus || null
            }
            : null);

        // Resolve the effective operator name, falling back to numeric MCC+MNC
        const effectiveOperator = resolveOperatorLabel(modemOperator, device.mobile?.operatorName)
            || resolveOperatorLabel(device.mobile?.operator, device.mobile?.operatorName)
            || null;

        const liveStatus = {
            online: device.online,
            signal: useWifiSignal ? wifiSignal.percent : (modemSignal?.percent ?? device.mobile?.signalStrength ?? null),
            signalDbm: useWifiSignal ? wifiSignal.dbm : (modemSignal?.dbm ?? device.mobile?.signalDbm ?? null),
            wifiSignal: wifiSignal.percent,
            wifiSignalDbm: wifiSignal.dbm,
            cellularSignal: modemSignal?.percent ?? device.mobile?.signalStrength ?? null,
            cellularSignalDbm: modemSignal?.dbm ?? device.mobile?.signalDbm ?? null,
            battery: normalizeOptionalNumber(system?.battery),
            voltageMv: normalizeOptionalNumber(system?.voltage_mV),
            charging: normalizeChargingState(
                system?.charging,
                system?.battery,
                system?.voltage_mV
            ),
            powerSource: firstDefined(system?.powerSource, system?.power_source) || null,
            network: useWifiSignal ? 'Wi-Fi' : (onModemPath ? 'Cellular' : (device.mobile?.networkType || 'No Service')),
            operator: effectiveOperator,
            simNumber: modemSubscriberNumber || null,
            wifiSsid: device.wifi?.ssid || null,
            displayName: useWifiSignal
                ? (device.wifi?.ssid || effectiveOperator || 'Wi-Fi')
                : (effectiveOperator || (onModemPath ? 'Cellular' : (device.mobile?.networkType || 'Cellular'))),
            ip: useWifiSignal ? (device.wifi?.ipAddress || '0.0.0.0') : (modemIp || device.mobile?.ipAddress || '0.0.0.0'),
            temperature: normalizeOptionalNumber(firstDefined(system?.temperature, device.status?.temperature)),
            uptime: formatUptime(firstDefined(system?.uptime, device.status?.uptime)),
            imei: device.imei ?? null,
            androidId: device.androidId ?? null,
            installId: device.installId ?? null,
            manufacturer: device.manufacturer ?? null,
            brand: device.brand ?? null,
            model: device.model ?? null,
            deviceName: device.deviceName ?? null,
            device: {
                platform: device.platform ?? null,
                manufacturer: device.manufacturer ?? null,
                brand: device.brand ?? null,
                model: device.model ?? null,
                deviceName: device.deviceName ?? null,
                androidId: device.androidId ?? null,
                installId: device.installId ?? null
            },
            sim: {
                ...(device.sim || {}),
                number: modemSubscriberNumber || device.sim?.number || null,
                operator: resolveOperatorLabel(
                    device.sim?.operator || effectiveOperator,
                    device.sim?.operatorName || effectiveOperator
                ),
                operatorName: resolveOperatorLabel(
                    device.sim?.operatorName || effectiveOperator,
                    device.sim?.operator || effectiveOperator
                )
            },
            telephonySupported: typeof telephonySupported === 'boolean' ? telephonySupported : null,
            telephonyEnabled: typeof telephonyEnabled === 'boolean' ? telephonyEnabled : null,
            dataModeEnabled: typeof dataModeEnabled === 'boolean' ? dataModeEnabled : null,
            mobile: {
                ...(device.mobile || {}),
                connected: modemConnected,
                networkType: device.mobile?.networkType || null,
                operator: device.mobile?.operator || null,
                operatorName: device.mobile?.operatorName || effectiveOperator || null,
                ipAddress: device.mobile?.ipAddress || modemIp || null,
                dataIp: modemDataIp || null,
                pdpIpAddress: modemPdpIp || null,
                ipBearerReady: typeof explicitModemBearer === 'boolean' ? explicitModemBearer : null,
                dataSession: explicitModemSession ?? null,
                signalStrength: device.mobile?.signalStrength ?? modemSignal?.percent ?? null,
                signalDbm: device.mobile?.signalDbm ?? modemSignal?.dbm ?? null
            },
            wifi: {
                mode: device.wifi?.mode || 'off',
                connected: !!device.wifi?.connected,
                ssid: device.wifi?.ssid || '',
                ipAddress: device.wifi?.ipAddress || '',
                security: device.wifi?.security || '',
                apEnabled: !!device.wifi?.apEnabled,
                apSsid: device.wifi?.apSsid || '',
                apIp: device.wifi?.apIp || '',
                clients: Number(device.wifi?.clients || 0),
                rssi: device.wifi?.rssi ?? null,
                configured: !!device.wifi?.configured,
                profilesRevision: device.wifi?.profilesRevision,
                profilesCount: device.wifi?.profilesCount,
                started: !!device.wifi?.started,
                ipAssigned: !!device.wifi?.ipAssigned,
                connectAttemptCount: Number(device.wifi?.connectAttemptCount || 0),
                reconnectCount: Number(device.wifi?.reconnectCount || 0),
                lastDisconnectReason: Number(device.wifi?.lastDisconnectReason || 0),
                lastDisconnectReasonText: device.wifi?.lastDisconnectReasonText || '',
                lastScanTargetVisible: typeof device.wifi?.lastScanTargetVisible === 'boolean' ? device.wifi.lastScanTargetVisible : null,
                lastScanVisibleCount: Number(device.wifi?.lastScanVisibleCount || 0),
                lastScanElapsedMs: Number(device.wifi?.lastScanElapsedMs || 0),
                lastScanSummary: device.wifi?.lastScanSummary || ''
            },
            queues: device.status?.queues || null,
            firmwareVersion: firstDefined(
                device.status?.firmware_version,
                device.status?.firmwareVersion
            ) || null,
            activePath: device.status?.active_path || null,
            mqtt: reportedFields(device.status || {}, MQTT_ALIASES, device.status?.mqtt || {}),
            sync: device.status?.sync || null,
            storage,
            sdCard: sdStatus.normalize(device.status || {}),
            hardware: device.status?.hardware || null,
            tasks: reportedFields(device.status || {}, {
                totalCount: ['task_count'], missingCount: ['missing_task_count'],
                stackTrackedCount: ['stack_tracked_task_count'], lowStackCount: ['low_stack_task_count'],
                minStackHighWaterBytes: ['min_stack_high_water_bytes'], minStackTaskName: ['min_stack_task_name']
            }, device.status?.tasks || {}),
            health: reportedFields(device.status || {}, {
                degraded: ['health_degraded'], moduleCount: ['health_module_count'],
                degradedModuleCount: ['degraded_module_count'], failedModuleCount: ['failed_module_count'],
                stubModuleCount: ['stub_module_count'], lastReason: ['health_last_reason']
            }, device.status?.health || {}),
            systemRuntime: {
                heapTotal: system?.heapTotal ?? null,
                heapUsed: system?.heapUsed ?? null,
                freeHeap: system?.freeHeap ?? system?.heapFree ?? null,
                heapFree: system?.heapFree ?? system?.freeHeap ?? null,
                heapLargestFreeBlock: system?.heapLargestFreeBlock ?? system?.largestFreeBlock ?? null,
                runtimeRamTotal: system?.runtimeRamTotal ?? null,
                runtimeRamUsed: system?.runtimeRamUsed ?? null,
                runtimeRamFree: system?.runtimeRamFree ?? null,
                runtimeRamLargestFreeBlock: system?.runtimeRamLargestFreeBlock ?? null,
                psramTotal: system?.psramTotal ?? null,
                psramUsed: system?.psramUsed ?? null,
                freePsram: system?.freePsram ?? system?.psramFree ?? null,
                psramFree: system?.psramFree ?? system?.freePsram ?? null,
                psramLargestFreeBlock: system?.psramLargestFreeBlock ?? null,
                otherHeapTotal: system?.otherHeapTotal ?? null,
                otherHeapUsed: system?.otherHeapUsed ?? null,
                otherHeapFree: system?.otherHeapFree ?? null,
                largestFreeBlock: system?.largestFreeBlock ?? system?.heapLargestFreeBlock ?? null,
                rebootReason: system?.rebootReason || null,
                degradedReason: system?.degradedReason || null
            },
            call: {
                active: !!device.status?.call?.active,
                status: device.status?.call?.status || null,
                number: device.status?.call?.number || null,
                transportSuspended: !!device.status?.call?.transportSuspended
            },
            transport: {
                voiceSessionActive: !!device.status?.transport?.voiceSessionActive,
                mqttCommandAccepting: device.status?.transport?.mqttCommandAccepting !== false,
                reason: device.status?.transport?.reason || null
            },
            statusFresh,
            statusAgeMs,
            staleReason: !device.online ? 'no_recent_heartbeat' : (statusFresh ? null : 'no_recent_status'),
            lastStatusAt: device.lastStatusAt || device.status?.lastUpdate || null,
            lastSeen: device.lastSeen,
            firstSeen: device.firstSeen
        };

        return markStatusOffline(liveStatus);
    }

    getDeviceStatus(deviceId = DEFAULT_DEVICE_ID) {
        return this.getStatus(deviceId);
    }

    isDeviceOnline(deviceId = DEFAULT_DEVICE_ID) {
        const device = this.devices.get(deviceId);
        if (!device) return false;

        const now = new Date();
        const lastSeen = new Date(device.lastSeen);
        const lastSeenMs = lastSeen.getTime();
        if (!Number.isFinite(lastSeenMs)) {
            return false;
        }

        return (now.getTime() - lastSeenMs) <= DEVICE_ONLINE_GRACE_MS;
    }

    updateDeviceStatus(deviceId, data, options = {}) {
        try {
            const existingDevice = this.devices.get(deviceId);
            const receivedAt = new Date().toISOString();
            // Cache reads restore the original server observation; they are not
            // heartbeats and must not extend a device's online grace period.
            const observedAtMs = Date.parse(options.observedAt);
            const observedAt = options.fromCache === true
                ? (existingDevice?.lastSeen || (Number.isFinite(observedAtMs)
                    ? new Date(Math.min(observedAtMs, Date.now())).toISOString()
                    : null))
                : receivedAt;
            const device = this.devices.get(deviceId) || {
                id: deviceId,
                firstSeen: new Date().toISOString(),
                lastSeen: observedAt,
                online: false,
                manufacturer: null,
                brand: null,
                model: null,
                deviceName: null,
                androidId: null,
                installId: null,
                mobile: {
                    signalStrength: null,
                    signalDbm: null,
                    networkType: 'Unknown',
                    operator: 'Unknown',
                    ipAddress: '',
                    connected: false
                },
                system: {
                    battery: null,
                    charging: null,
                    uptime: null,
                    temperature: null
                },
                sim: null,
                telephonySupported: null,
                telephonyEnabled: null,
                dataModeEnabled: null,
                wifi: {
                    mode: 'off',
                    connected: false,
                    ssid: '',
                    ipAddress: '',
                    apEnabled: false,
                    apSsid: '',
                    apIp: '',
                    clients: 0,
                    rssi: null,
                    configured: false,
                    started: false,
                    ipAssigned: false,
                    connectAttemptCount: 0,
                    reconnectCount: 0,
                    lastDisconnectReason: 0,
                    lastDisconnectReasonText: ''
                },
                status: {}
            };
            let derivedMobile = data?.mobile ? { ...data.mobile } : null;
            let derivedSim = data?.sim ? { ...data.sim } : null;

            device.lastSeen = observedAt;
            device.online = observedAt !== null
                && (Date.now() - Date.parse(observedAt)) <= DEVICE_ONLINE_GRACE_MS;
            device.lastStatusAt = options.fromCache === true
                ? (Number.isFinite(observedAtMs) ? new Date(Math.min(observedAtMs, Date.now())).toISOString() : null)
                : receivedAt;

            device.status = {
                ...mergeStatusSnapshot(device.status, data),
                cached_status: options.fromCache === true,
                lastUpdate: device.lastStatusAt
            };

            if (data.active_path !== undefined) {
                const activePath = String(data.active_path || '').trim().toLowerCase();
                const dataIp = data.modem_data_ip || data.modem_ip_address || derivedMobile?.dataIp || '';
                const connected = resolveModemConnection({
                    session: data.modem_data_session_open,
                    bearer: data.modem_ip_bearer_ready,
                    dataIp,
                    activePath,
                    legacyConnected: derivedMobile?.connected
                });
                const inferredCellularNetworkType = resolveCellularNetworkType(
                    derivedMobile?.networkType,
                    data.mobile?.networkType,
                    data.networkType,
                    device.mobile?.networkType,
                    data.network,
                    device.status?.network
                );
                derivedMobile = {
                    ...(derivedMobile || {}),
                    connected,
                    networkType: inferredCellularNetworkType
                        || (activePath === 'modem'
                            ? 'Cellular'
                            : (data.modem_registered || data.data_mode_enabled || data.modem_data_session_open ? 'Cellular' : 'Unknown')),
                    operator: data.modem_operator || data.operator || derivedMobile?.operator || device.mobile?.operator || null,
                    operatorName: data.modem_operator_name || data.operator_name || derivedMobile?.operatorName || device.mobile?.operatorName || null,
                    ipAddress: activePath === 'wifi'
                        ? (data.wifi_ip_address || derivedMobile?.ipAddress || '')
                        : (data.modem_data_ip || data.modem_ip_address || data.modem_pdp_ip_address || data.ip || derivedMobile?.ipAddress || '')
                };
            }

            if (
                data.modem_signal !== undefined ||
                data.modem_operator !== undefined ||
                data.modem_ip_address !== undefined ||
                data.modem_data_ip !== undefined ||
                data.modem_pdp_ip_address !== undefined ||
                data.signal !== undefined ||
                data.rssi !== undefined ||
                data.network !== undefined ||
                data.operator !== undefined ||
                data.ip !== undefined ||
                data.networkType !== undefined
            ) {
                const dataIp = data.modem_data_ip ?? data.modem_ip_address ?? derivedMobile?.dataIp ?? '';
                derivedMobile = {
                    ...(derivedMobile || {}),
                    connected: (data.modem_ip_bearer_ready !== undefined || data.modem_data_session_open !== undefined)
                        ? resolveModemConnection({
                            session: data.modem_data_session_open,
                            bearer: data.modem_ip_bearer_ready,
                            dataIp,
                            activePath: data.active_path,
                            legacyConnected: derivedMobile?.connected
                        })
                        : Boolean(
                            resolveModemConnection({
                                dataIp: dataIp || data.ip,
                                activePath: data.active_path,
                                legacyConnected: derivedMobile?.connected
                            })
                        ),
                    signalStrength: (data.signal === '' || data.signal === null || data.signal === undefined)
                        ? (data.modem_signal ?? data.rssi)
                        : data.signal,
                    networkType: resolveCellularNetworkType(
                        derivedMobile?.networkType,
                        data.networkType,
                        data.mobile?.networkType,
                        data.network
                    ) ?? (data.modem_registered || data.data_mode_enabled || data.modem_data_session_open ? 'Cellular' : undefined),
                    operator: data.modem_operator ?? data.operator ?? derivedMobile?.operator,
                    operatorName: data.modem_operator_name ?? data.operator_name ?? derivedMobile?.operatorName,
                    ipAddress: data.modem_data_ip ?? data.ip ?? data.modem_ip_address ?? data.modem_pdp_ip_address ?? data.ipAddress ?? derivedMobile?.ipAddress,
                    dataIp: data.modem_data_ip ?? data.modem_ip_address ?? derivedMobile?.dataIp ?? null,
                    pdpIpAddress: data.modem_pdp_ip_address ?? derivedMobile?.pdpIpAddress ?? null
                };
            }

            if (derivedMobile) {
                data = {
                    ...data,
                    mobile: derivedMobile
                };
            }

            if (
                data.modem_registered !== undefined ||
                data.modem_sim_ready !== undefined ||
                data.modem_operator !== undefined ||
                data.modem_subscriber_number !== undefined ||
                data.modem_data_session_open !== undefined ||
                data.modem_ip_bearer_ready !== undefined ||
                data.telephony_supported !== undefined ||
                data.telephony_enabled !== undefined ||
                data.data_mode_enabled !== undefined ||
                data.telephonySupported !== undefined ||
                data.telephonyEnabled !== undefined ||
                data.dataModeEnabled !== undefined
            ) {
                derivedSim = {
                    ...(derivedSim || {}),
                    ready: data.modem_sim_ready ?? derivedSim?.ready ?? null,
                    registered: data.modem_registered ?? derivedSim?.registered ?? null,
                    operator: resolveOperatorLabel(
                        data.modem_operator ?? derivedSim?.operator,
                        data.modem_operator_name ?? derivedSim?.operatorName
                    ),
                    operatorName: resolveOperatorLabel(
                        data.modem_operator_name ?? derivedSim?.operatorName,
                        data.modem_operator ?? derivedSim?.operator
                    ),
                    number: data.modem_subscriber_number || derivedSim?.number || null,
                    dataSession: data.modem_data_session_open || false,
                    ipBearer: data.modem_ip_bearer_ready || false,
                    dataIp: data.modem_data_ip || data.modem_ip_address || null,
                    pdpIp: data.modem_pdp_ip_address || null,
                    telephonySupported: data.telephony_supported ?? data.telephonySupported ?? derivedSim?.telephonySupported ?? null,
                    telephonyEnabled: data.telephony_enabled ?? data.telephonyEnabled ?? derivedSim?.telephonyEnabled ?? null,
                    dataModeEnabled: data.data_mode_enabled ?? data.dataModeEnabled ?? derivedSim?.dataModeEnabled ?? null
                };
            }

            if (derivedSim) {
                data = {
                    ...data,
                    sim: derivedSim
                };
            }

            if (!data.wifi) {
                const wifi = reportedFields(data, {
                    connected: ['wifi_connected'], ssid: ['wifi_ssid'],
                    ipAddress: ['wifi_ip_address'], security: ['wifi_security'],
                    rssi: ['wifi_rssi'], configured: ['wifi_configured'],
                    started: ['wifi_started'], ipAssigned: ['wifi_ip_assigned'],
                    reconnectSuppressed: ['wifi_reconnect_suppressed'],
                    connectAttemptCount: ['wifi_connect_attempt_count'],
                    reconnectCount: ['wifi_reconnect_count'],
                    lastDisconnectReason: ['wifi_last_disconnect_reason'],
                    lastDisconnectReasonText: ['wifi_last_disconnect_reason_text'],
                    lastScanTargetVisible: ['wifi_last_scan_target_visible'],
                    lastScanVisibleCount: ['wifi_last_scan_visible_count'],
                    lastScanElapsedMs: ['wifi_last_scan_elapsed_ms'],
                    lastScanSummary: ['wifi_last_scan_summary']
                });
                if (wifi.started !== undefined || wifi.configured !== undefined) {
                    const started = wifi.started ?? device.wifi?.started;
                    const configured = wifi.configured ?? device.wifi?.configured;
                    wifi.mode = started ? 'sta' : (configured ? 'configured' : 'off');
                }
                if (Object.keys(wifi).length > 0) data = { ...data, wifi };
            }

            const reportedSystem = reportedFields(data, SYSTEM_ALIASES, data.system || {});
            if (reportedSystem.voltage_mV === undefined && reportedSystem.voltageMv !== undefined) {
                reportedSystem.voltage_mV = reportedSystem.voltageMv;
            }
            if (reportedSystem.uptime === undefined && data.uptime_ms !== undefined) {
                reportedSystem.uptime = data.uptime_ms !== null && Number.isFinite(Number(data.uptime_ms))
                    ? Math.floor(Number(data.uptime_ms) / 1000) : null;
            }
            if (Object.keys(reportedSystem).length > 0) {
                data = { ...data, system: reportedSystem };
            }

            if (!data.hardware && (
                data.hardware_uid !== undefined ||
                data.board_name !== undefined ||
                data.board_chip !== undefined ||
                data.static_ram_bytes !== undefined ||
                data.rom_bytes !== undefined ||
                data.flash_size_bytes !== undefined ||
                data.psram_size_bytes !== undefined ||
                data.psram_available !== undefined
            )) {
                data = {
                    ...data,
                    hardware: {
                        uid: data.hardware_uid || null,
                        boardName: data.board_name || null,
                        chip: data.board_chip || null,
                        cpu: data.board_cpu || null,
                        staticRamBytes: data.static_ram_bytes ?? null,
                        romBytes: data.rom_bytes ?? null,
                        flashSizeBytes: data.flash_size_bytes ?? null,
                        psramSizeBytes: data.psram_size_bytes ?? null,
                        psramAvailable: typeof data.psram_available === 'boolean' ? data.psram_available : null,
                        smsStorage: normalizeSmsStorageSummary(data)
                    }
                };
            }

            if (!data.status && (
                data.mqtt_connected !== undefined ||
                data.mqtt_subscribed !== undefined ||
                data.storage_queue_depth !== undefined ||
                data.pending_uploads !== undefined ||
                data.storage_media_available !== undefined ||
                data.in_sync !== undefined ||
                data.dashboard_ack_age_ms !== undefined ||
                data.telephony_supported !== undefined ||
                data.telephony_enabled !== undefined ||
                data.data_mode_enabled !== undefined ||
                data.telephonySupported !== undefined ||
                data.telephonyEnabled !== undefined ||
                data.dataModeEnabled !== undefined ||
                data.active_path !== undefined
            )) {
                data = {
                    ...data,
                    status: {
                        active_path: data.active_path || null,
                        queues: {
                            storagePending: Number(data.storage_queue_depth || 0),
                            pendingUploads: Number(data.pending_uploads || 0),
                            dropped: Number(data.storage_dropped_count || 0)
                        },
                        transport: {
                            mqttCommandAccepting: Boolean(data.mqtt_connected) && Boolean(data.mqtt_subscribed),
                            reason: data.degraded_reason || null
                        },
                        sync: {
                            inSync: data.in_sync !== false,
                            driftFlags: Number(data.drift_flags || 0),
                            dashboardAckAgeMs: Number(data.dashboard_ack_age_ms || 0),
                            desiredVersion: Number(data.desired_version || 0),
                            appliedVersion: Number(data.applied_version || 0)
                        },
                        storage: {
                            mounted: !!(data.storage_media_mounted ?? data.sd_mounted),
                            mediaAvailable: !!data.storage_media_available,
                            bufferedOnly: !!data.storage_buffered_only,
                            queueDepth: Number(data.storage_queue_depth || 0),
                            pendingUploads: Number(data.pending_uploads || 0),
                            dropped: Number(data.storage_dropped_count || 0),
                            mountFailures: Number(data.storage_mount_failures || 0),
                            writeFailures: Number(data.storage_sd_write_failures || 0),
                            flushCount: Number(data.storage_sd_flush_count || 0),
                            totalBytes: Number(data.storage_total_bytes || 0),
                            usedBytes: Number(data.storage_used_bytes || 0),
                            freeBytes: Number(data.storage_free_bytes || 0),
                            type: data.storage_media_label || data.storage_media_type || 'SSD',
                            bus: data.storage_media_bus || null
                        },
                        hardware: data.hardware || null,
                        mqtt: reportedFields(data, MQTT_ALIASES, data.mqtt || {}),
                        modem: {
                            registered: !!data.modem_registered,
                            simReady: !!data.modem_sim_ready,
                            operator: data.modem_operator || data.modem_operator_name || null,
                            signal: data.modem_signal != null ? Number(data.modem_signal) : null,
                            telephonySupported: data.telephony_supported ?? data.telephonySupported ?? null,
                            telephonyEnabled: data.telephony_enabled ?? data.telephonyEnabled ?? null,
                            dataModeEnabled: data.data_mode_enabled ?? data.dataModeEnabled ?? (data.modem_data_session_open !== undefined ? !!data.modem_data_session_open : null),
                            dataSession: !!data.modem_data_session_open,
                            ipBearer: !!data.modem_ip_bearer_ready,
                            dataIp: data.modem_data_ip || data.modem_ip_address || null,
                            subscriberNumber: data.modem_subscriber_number || null,
                            smsStorage: normalizeSmsStorageSummary(data)
                        }
                    }
                };
            }

            if (data.sd && typeof data.sd === 'object') {
                data = {
                    ...data,
                    status: {
                        ...(data.status || {}),
                        storage: {
                            ...(data.status?.storage || {}),
                            mounted: !!data.sd.mounted,
                            mediaAvailable: !!(data.sd.mediaAvailable ?? data.sd.mounted),
                            bufferedOnly: !!data.sd.bufferedOnly,
                            queueDepth: Number(data.sd.queueDepth || 0),
                            pendingUploads: Number(data.sd.pendingUploads || 0),
                            totalBytes: Number(firstDefined(data.sd.totalBytes, data.sd.total) || 0),
                            usedBytes: Number(firstDefined(data.sd.usedBytes, data.sd.used) || 0),
                            freeBytes: Number(firstDefined(data.sd.freeBytes, data.sd.free) || 0),
                            type: data.sd.type || data.status?.storage?.type || data.storage_media_label || data.storage_media_type || 'SSD',
                            filesystem: data.sd.filesystem || data.status?.storage?.filesystem || null,
                            bus: data.sd.bus || data.status?.storage?.bus || data.storage_media_bus || null
                        }
                    }
                };
            }

            const payloadDevice = data.device && typeof data.device === 'object' ? data.device : {};
            const payloadSystem = data.system && typeof data.system === 'object' ? data.system : {};

            const explicitPlatform = firstDefined(data.platform, payloadDevice.platform);
            if (explicitPlatform) {
                device.platform = String(explicitPlatform).trim().toLowerCase();
            } else if (data.android_id || data.androidId || payloadDevice.androidId || payloadDevice.android_id) {
                device.platform = 'android';
            } else if (/esp32|a7670/i.test([
                data.board_name, data.board_chip, data.hardware?.boardName, data.hardware?.chip,
                data.type, payloadDevice.type, payloadDevice.chip
            ].filter(Boolean).join(' '))) {
                device.platform = 'firmware';
            }

            if (data.imei) {
                device.imei = String(data.imei).trim();
            }
            device.manufacturer = firstDefined(data.manufacturer, payloadDevice.manufacturer, payloadSystem.manufacturer, device.manufacturer) || null;
            device.brand = firstDefined(data.brand, payloadDevice.brand, payloadSystem.brand, device.brand) || null;
            device.model = firstDefined(data.model, payloadDevice.model, payloadSystem.model, device.model) || null;
            device.deviceName = firstDefined(data.device_name, data.deviceName, payloadDevice.deviceName, payloadDevice.device_name, payloadSystem.deviceName, device.deviceName) || null;
            device.androidId = firstDefined(data.android_id, data.androidId, payloadDevice.androidId, payloadDevice.android_id, payloadSystem.androidId, payloadSystem.android_id, device.androidId) || null;
            device.installId = firstDefined(data.install_id, data.installId, payloadDevice.installId, payloadDevice.install_id, payloadSystem.installId, payloadSystem.install_id, device.installId) || null;

            if (data.mobile) {
                const incomingMobileSimNumber = String(firstDefined(
                    data.mobile.simNumber,
                    data.mobile.subscriberNumber,
                    data.modem_subscriber_number,
                    data.sim?.number,
                    data.sim?.subscriberNumber
                ) || '').trim();
                const existingMobileSimNumber = String(firstDefined(
                    device.mobile?.simNumber,
                    device.mobile?.subscriberNumber,
                    device.sim?.number,
                    device.sim?.subscriberNumber
                ) || '').trim();
                if (data.mobile.ipAddress) {
                    data.mobile.ipAddress = data.mobile.ipAddress.replace(/^\+IPADDR:\s*/i, '').trim();
                }
                device.mobile = {
                    ...device.mobile,
                    ...data.mobile
                };
                if (!incomingMobileSimNumber && existingMobileSimNumber) {
                    device.mobile.simNumber = device.mobile.simNumber || existingMobileSimNumber;
                    device.mobile.subscriberNumber = device.mobile.subscriberNumber || existingMobileSimNumber;
                }
                if (!device.mobile.operatorName && data.modem_operator_name) {
                    device.mobile.operatorName = data.modem_operator_name;
                }
                if (!device.mobile.operator && (data.modem_operator || data.modem_operator_name)) {
                    device.mobile.operator = data.modem_operator || data.modem_operator_name;
                }
                if (!device.mobile.subscriberNumber && (data.modem_subscriber_number || data.sim?.number)) {
                    device.mobile.subscriberNumber = data.modem_subscriber_number || data.sim?.number;
                }
                if (!device.mobile.simNumber && (data.modem_subscriber_number || data.sim?.number)) {
                    device.mobile.simNumber = data.modem_subscriber_number || data.sim?.number;
                }
                device.mobile.operator = resolveOperatorLabel(device.mobile.operator, device.mobile.operatorName);
                if (data.mobile.signalStrength !== undefined) {
                    const sig = parseRssi(data.mobile.signalStrength);
                    device.mobile.signalPercent = sig.percent;
                    device.mobile.signalDbm = sig.dbm;
                    device.mobile.signalBars = sig.bars;
                    device.mobile.signalLabel = sig.label;
                    device.mobile.signalRssi = data.mobile.signalStrength;
                    device.mobile.signalStrength = sig.percent;
                }
            }

            if (data.sim) {
                const incomingSimNumber = String(firstDefined(
                    data.modem_subscriber_number,
                    data.sim?.number,
                    data.sim?.subscriberNumber,
                    data.mobile?.simNumber,
                    data.mobile?.subscriberNumber
                ) || '').trim();
                const existingSimNumber = String(firstDefined(
                    device.sim?.number,
                    device.sim?.subscriberNumber,
                    device.mobile?.simNumber,
                    device.mobile?.subscriberNumber
                ) || '').trim();
                device.sim = {
                    ...device.sim,
                    ...data.sim
                };
                device.sim.number = incomingSimNumber || device.sim.number || existingSimNumber || null;
                device.sim.subscriberNumber = incomingSimNumber || device.sim.subscriberNumber || device.sim.number || existingSimNumber || null;
                device.sim.operatorName = resolveOperatorLabel(
                    data.modem_operator_name || device.sim.operatorName || device.mobile?.operatorName,
                    data.modem_operator || device.sim.operator || device.mobile?.operator
                );
                device.sim.operator = resolveOperatorLabel(
                    data.modem_operator || device.sim.operator || device.mobile?.operator,
                    data.modem_operator_name || device.sim.operatorName || device.mobile?.operatorName
                );
            }

            if (data.wifi) {
                const lastDisconnectReason = Number(data.wifi.lastDisconnectReason ?? device.wifi?.lastDisconnectReason ?? 0);
                device.wifi = {
                    ...device.wifi,
                    ...data.wifi,
                    security: data.wifi.security ?? device.wifi?.security ?? '',
                    lastDisconnectReason,
                    lastDisconnectReasonText: getWifiDisconnectReasonText(
                        lastDisconnectReason,
                        data.wifi.lastDisconnectReasonText ?? (data.wifi.lastDisconnectReason !== undefined
                            ? undefined : device.wifi?.lastDisconnectReasonText)
                    )
                };
            }

            // Profile-only telemetry must not manufacture a Wi-Fi disconnect or
            // clear the current SSID. Missing metadata means not reported.
            for (const [wire, field] of [
                ['wifi_profiles_revision', 'profilesRevision'],
                ['wifi_profiles_count', 'profilesCount']
            ]) {
                if (data[wire] !== undefined) {
                    device.wifi = { ...device.wifi, [field]: data[wire] };
                }
            }

            if (data.system) {
                device.system = {
                    ...device.system,
                    ...data.system
                };
            }

            if (data.sensors) {
                device.system = {
                    ...device.system,
                    battery: firstDefined(data.system?.battery, data.sensors.batterySoc, data.sensors.battery_soc, device.system?.battery),
                    voltage_mV: firstDefined(data.system?.voltage_mV, data.sensors.batteryVoltage_mV, data.sensors.battery_voltage_mV, device.system?.voltage_mV),
                    charging: firstDefined(data.system?.charging, data.sensors.charging, device.system?.charging),
                    temperature: firstDefined(data.system?.temperature, data.sensors.temperature_C, data.sensors.temperature_c, device.system?.temperature)
                };
            }

            if (data.status) {
                device.status = mergeStatusSnapshot(device.status, data.status);
            }
            const reportedMqtt = reportedFields(data, MQTT_ALIASES, data.mqtt || data.status?.mqtt || {});
            if (Object.keys(reportedMqtt).length) {
                device.status.mqtt = { ...device.status.mqtt, ...reportedMqtt };
            }
            if (data.hardware) {
                device.status = {
                    ...device.status,
                    hardware: {
                        ...(device.status?.hardware || {}),
                        ...data.hardware
                    }
                };
            }

            if (data.sd) {
                device.sd = {
                    ...(device.sd || {}),
                    ...data.sd
                };
            }

            this.devices.set(deviceId, device);

            logger.debug(`Device ${deviceId} status updated`, {
                signal: device.mobile?.signalStrength,
                network: device.mobile?.networkType,
                online: device.online
            });

            return device;
        } catch (error) {
            logger.error('Error updating device status:', error);
            return null;
        }
    }

    handleHeartbeat(deviceId) {
        const device = this.devices.get(deviceId);

        if (!device) {
            logger.info(`New device detected: ${deviceId}`);
            this.devices.set(deviceId, {
                id: deviceId,
                firstSeen: new Date().toISOString(),
                lastSeen: new Date().toISOString(),
                online: true,
                manufacturer: null,
                brand: null,
                model: null,
                deviceName: null,
                androidId: null,
                installId: null,
                mobile: {
                    signalStrength: null,
                    signalDbm: null,
                    networkType: 'Unknown',
                    operator: 'Unknown',
                    ipAddress: '',
                    connected: false
                },
                system: {
                    battery: null,
                    charging: null,
                    uptime: null,
                    temperature: null
                },
                sim: null,
                wifi: {
                    mode: 'off',
                    connected: false,
                    ssid: '',
                    ipAddress: '',
                    apEnabled: false,
                    apSsid: '',
                    apIp: '',
                    clients: 0,
                    rssi: null
                },
                status: {}
            });
        } else {
            device.lastSeen = new Date().toISOString();
            device.online = true;
            this.devices.set(deviceId, device);
        }

        logger.debug(`Heartbeat from device ${deviceId}`);
    }

    checkOnlineDevices() {
        const now = new Date();
        const onlineDevices = [];

        for (const [deviceId, device] of this.devices) {
            const lastSeen = new Date(device.lastSeen);
            const lastSeenMs = lastSeen.getTime();
            const wasOnline = device.online;
            device.online = Number.isFinite(lastSeenMs)
                && (now.getTime() - lastSeenMs) <= DEVICE_ONLINE_GRACE_MS;

            if (wasOnline && !device.online) {
                logger.warn(`Device ${deviceId} went offline (last seen: ${device.lastSeen})`);
                const room = global.io?.to?.('device:' + deviceId);
                if (room?.emit) room.emit('device:offline', { deviceId });
                else global.io?.emit?.('device:offline', { deviceId });
            } else if (!wasOnline && device.online) {
                logger.info(`Device ${deviceId} came online`);
                const room = global.io?.to?.('device:' + deviceId);
                if (room?.emit) room.emit('device:online', { deviceId });
                else global.io?.emit?.('device:online', { deviceId });
            }

            if (device.online) {
                onlineDevices.push(deviceId);
            }
        }

        return onlineDevices;
    }

    getAllDevices() {
        this.checkOnlineDevices();
        return Array.from(this.devices.keys()).map((deviceId) => {
            const live = this.getStatus(deviceId);
            return {
                id: deviceId,
                online: live?.online || false,
                lastSeen: live?.lastSeen || null,
                signal: live?.signal ?? null,
                network: live?.network || 'Unknown',
                operator: live?.operator || 'Unknown'
            };
        });
    }

    updateWifiNetworks(deviceId, networks) {
        try {
            this.wifiNetworks = networks;
            const device = this.devices.get(deviceId);
            if (device) {
                device.wifiNetworks = networks;
                this.devices.set(deviceId, device);
            }
            global.io?.emit('modem:wifi-scan', { deviceId, networks });
        } catch (error) {
            logger.error('Error updating WiFi networks:', error);
        }
    }

    updateHotspotClients(deviceId, clients) {
        try {
            this.hotspotClients = clients;
            const device = this.devices.get(deviceId);
            if (device) {
                device.hotspotClients = clients;
                device.wifiHotspot = device.wifiHotspot || {};
                device.wifiHotspot.connectedClients = clients.length;
                this.devices.set(deviceId, device);
            }
            global.io?.emit('modem:hotspot-clients', { deviceId, clients });
        } catch (error) {
            logger.error('Error updating hotspot clients:', error);
        }
    }

    cleanupOfflineDevices() {
        const now = new Date();
        const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

        for (const [deviceId, device] of this.devices) {
            const lastSeen = new Date(device.lastSeen);
            if (lastSeen < fiveMinutesAgo && !device.online) {
                logger.info(`Removing stale device: ${deviceId} (last seen: ${device.lastSeen})`);
                this.devices.delete(deviceId);
            }
        }
    }

    hasDevices() {
        return this.devices.size > 0;
    }

    getDeviceCount() {
        return this.devices.size;
    }

    resetDevices() {
        this.devices.clear();
        logger.info('All devices cleared');
    }
}

module.exports = new ModemService();
