const MODULE_DEFINITIONS = {
    mqtt: { label: 'MQTT' },
    modem: { label: 'Modem' },
    wifi: { label: 'Wi-Fi', capability: 'wifi' },
    gps: { label: 'GPS', capability: 'gps' },
    storage: { label: 'Storage', capability: 'storage' },
    display: { label: 'Display', capability: 'display' },
    camera: { label: 'Camera', capability: 'camera' },
    audio: { label: 'Audio', capability: 'audio' },
    nfc: { label: 'NFC', capability: 'nfc' },
    rfid: { label: 'RFID', capability: 'rfid' },
    touch: { label: 'Touch', capability: 'touch' },
    keyboard: { label: 'Keyboard', capability: 'keyboard' }
};

function isSupported(moduleKey, caps = {}) {
    if (moduleKey === 'mqtt' || moduleKey === 'modem') return true;
    if (moduleKey === 'storage') return Boolean(caps.storage || caps.sd);
    return Boolean(caps[MODULE_DEFINITIONS[moduleKey]?.capability || moduleKey]);
}

function safeJson(details) {
    if (details == null) return null;
    try {
        return JSON.stringify(details);
    } catch (_) {
        return JSON.stringify({ note: 'unserializable details' });
    }
}

async function upsertModuleHealth(db, {
    deviceId,
    moduleKey,
    state = 'unknown',
    supported = true,
    message = null,
    details = null,
    markSuccess = false,
    markFailure = false,
    occurredAt = new Date().toISOString()
}) {
    if (!db || !deviceId || !moduleKey) return;

    await db.run(
        `INSERT INTO device_module_health
            (device_id, module_key, supported, state, last_success_at, last_failure_at, last_message, details, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(device_id, module_key) DO UPDATE SET
            supported = excluded.supported,
            state = excluded.state,
            last_success_at = COALESCE(excluded.last_success_at, device_module_health.last_success_at),
            last_failure_at = COALESCE(excluded.last_failure_at, device_module_health.last_failure_at),
            last_message = COALESCE(excluded.last_message, device_module_health.last_message),
            details = COALESCE(excluded.details, device_module_health.details),
            updated_at = CURRENT_TIMESTAMP`,
        [
            deviceId,
            moduleKey,
            supported ? 1 : 0,
            state,
            markSuccess ? occurredAt : null,
            markFailure ? occurredAt : null,
            message,
            safeJson(details)
        ]
    );
}

async function markModuleSuccess(db, deviceId, moduleKey, message, details = null) {
    return upsertModuleHealth(db, {
        deviceId,
        moduleKey,
        supported: true,
        state: 'ok',
        message,
        details,
        markSuccess: true
    });
}

async function markModuleFailure(db, deviceId, moduleKey, message, details = null, state = 'error') {
    return upsertModuleHealth(db, {
        deviceId,
        moduleKey,
        supported: true,
        state,
        message,
        details,
        markFailure: true
    });
}

function parseRow(row) {
    let details = null;
    try {
        details = row.details ? JSON.parse(row.details) : null;
    } catch (_) {
        details = null;
    }

    return {
        moduleKey: row.module_key,
        label: MODULE_DEFINITIONS[row.module_key]?.label || row.module_key,
        supported: row.supported !== 0,
        state: row.state || 'unknown',
        message: row.last_message || null,
        lastSuccessAt: row.last_success_at || null,
        lastFailureAt: row.last_failure_at || null,
        updatedAt: row.updated_at || null,
        details
    };
}

function getBaseEntry(moduleKey, caps = {}, mqttConnected = false, live = {}) {
    const definition = MODULE_DEFINITIONS[moduleKey] || { label: moduleKey };
    let supported = isSupported(moduleKey, caps);

    if (moduleKey === 'wifi' && live.wifi && Object.keys(live.wifi).length > 0) {
        supported = true;
    }

    if (moduleKey === 'storage' && live.storage) {
        supported = true;
    }

    if (moduleKey === 'mqtt') {
        const hasLiveMqttState = live?.mqtt && Object.prototype.hasOwnProperty.call(live.mqtt, 'connected');
        const hasRecentDeviceTelemetry = live && (live.online === true || live.online === false || live.lastSeen);
        const deviceMqttConnected = hasLiveMqttState ? Boolean(live.mqtt.connected) : false;
        const deviceMqttSubscribed = hasLiveMqttState ? Boolean(live.mqtt.subscribed) : null;
        const mqttState = !hasLiveMqttState
            ? (live.online === false ? 'error' : (hasRecentDeviceTelemetry ? 'unknown' : (mqttConnected ? 'warning' : 'unknown')))
            : (!deviceMqttConnected
                ? 'error'
                : (deviceMqttSubscribed === false ? 'warning' : 'ok'));
        const mqttMessage = !hasLiveMqttState
            ? (live.online === false
                ? 'No recent device MQTT telemetry'
                : (hasRecentDeviceTelemetry
                    ? 'Waiting for device MQTT telemetry'
                    : (mqttConnected ? 'Dashboard broker connected; device MQTT unknown' : 'Waiting for device MQTT telemetry')))
            : (!deviceMqttConnected
                ? 'Device MQTT disconnected'
                : (deviceMqttSubscribed === false ? 'Device MQTT connected, subscription pending' : 'Device MQTT connected'));

        return {
            moduleKey,
            label: definition.label,
            supported: true,
            state: mqttState,
            message: mqttMessage,
            lastSuccessAt: hasLiveMqttState && deviceMqttConnected ? (live.lastSeen || null) : null,
            lastFailureAt: hasLiveMqttState && !deviceMqttConnected ? (live.lastSeen || null) : null,
            updatedAt: live.lastSeen || null,
            details: hasLiveMqttState ? {
                connected: deviceMqttConnected,
                subscribed: deviceMqttSubscribed,
                reconnectCount: live.mqtt.reconnectCount ?? null,
                publishedCount: live.mqtt.publishedCount ?? null,
                publishFailures: live.mqtt.publishFailures ?? null
            } : null
        };
    }

    if (moduleKey === 'modem') {
        const sim = live.sim || {};
        const operator = live.operator || sim.operatorName || sim.operator || null;
        const signal = live.cellularSignal ?? live.modem?.signal ?? live.status?.modem?.signal ?? null;
        const registered = !!sim.registered;

        return {
            moduleKey,
            label: definition.label,
            supported: true,
            state: !live.online ? 'error' : (registered ? 'ok' : 'warning'),
            message: !live.online
                ? 'No recent heartbeat'
                : (registered
                    ? `Registered${operator ? ` on ${operator}` : ''}${signal !== null && signal !== undefined ? ` (${signal}%)` : ''}`
                    : 'Modem not registered'),
            lastSuccessAt: live.lastSeen || null,
            lastFailureAt: live.online ? null : live.lastSeen || null,
            updatedAt: live.lastSeen || null,
            details: live.online ? {
                operator: operator || null,
                signal,
                network: live.cellularStatus || (live.activePath === 'modem' ? (live.network || null) : null),
                simReady: sim.ready ?? null,
                registered
            } : null
        };
    }

    if (moduleKey === 'wifi') {
        const wifi = live.wifi || {};

        if (!supported) {
            return {
                moduleKey,
                label: definition.label,
                supported: false,
                state: 'unsupported',
                message: 'Firmware support pending on active device',
                lastSuccessAt: null,
                lastFailureAt: null,
                updatedAt: null,
                details: null
            };
        }

        if (wifi.connected) {
            return {
                moduleKey,
                label: definition.label,
                supported: true,
                state: 'ok',
                message: `Connected to ${wifi.ssid || 'Wi-Fi'}${wifi.ipAddress ? ` (${wifi.ipAddress})` : ''}`,
                lastSuccessAt: live.lastSeen || null,
                lastFailureAt: null,
                updatedAt: live.lastSeen || null,
                details: wifi
            };
        }

        if (wifi.apEnabled) {
            return {
                moduleKey,
                label: definition.label,
                supported: true,
                state: 'warning',
                message: `Hotspot active${wifi.apSsid ? ` (${wifi.apSsid})` : ''}`,
                lastSuccessAt: live.lastSeen || null,
                lastFailureAt: null,
                updatedAt: live.lastSeen || null,
                details: wifi
            };
        }

        if (live.online && wifi && Object.keys(wifi).length > 0) {
            const reasonText = wifi.lastDisconnectReasonText || null;
            const reasonCode = wifi.lastDisconnectReason || 0;
            const configuredSsid = String(wifi.ssid || '').trim();
            return {
                moduleKey,
                label: definition.label,
                supported: true,
                state: 'warning',
                message: reasonText === 'no_ap_found'
                    ? (configuredSsid
                        ? `Configured for ${configuredSsid}, access point not visible`
                        : 'Configured Wi-Fi access point not visible')
                    : (reasonText
                        ? `Disconnected (${reasonText})`
                        : (reasonCode ? `Disconnected (reason ${reasonCode})` : 'Wi-Fi disconnected')),
                lastSuccessAt: null,
                lastFailureAt: live.lastSeen || null,
                updatedAt: live.lastSeen || null,
                details: wifi
            };
        }
    }

    if (moduleKey === 'storage' && supported && live.online && live.storage) {
        const storage = live.storage;
        const mounted = storage.mounted === true || storage.mediaAvailable === true;
        return {
            moduleKey,
            label: definition.label,
            supported: true,
            state: mounted ? 'ok' : 'warning',
            message: mounted
                ? (storage.bufferedOnly ? 'Buffered storage active' : 'Storage mounted')
                : 'Storage unavailable',
            lastSuccessAt: mounted ? (live.lastSeen || null) : null,
            lastFailureAt: mounted ? null : (live.lastSeen || null),
            updatedAt: live.lastSeen || null,
            details: storage
        };
    }

    if (!supported) {
        return {
            moduleKey,
            label: definition.label,
            supported: false,
            state: 'unsupported',
            message: 'Firmware support pending on active device',
            lastSuccessAt: null,
            lastFailureAt: null,
            updatedAt: null,
            details: null
        };
    }

    return {
        moduleKey,
        label: definition.label,
        supported: true,
        state: 'unknown',
        message: 'Waiting for first successful operation',
        lastSuccessAt: null,
        lastFailureAt: null,
        updatedAt: null,
        details: null
    };
}

function offlineAdjustedEntry(entry, live = {}) {
    if (!live || live.online !== false) {
        return entry;
    }

    if (!entry || entry.state === 'unsupported') {
        return entry;
    }

    if (entry.moduleKey === 'mqtt') {
        return entry;
    }

    if (entry.moduleKey === 'modem') {
        return {
            ...entry,
            state: 'error',
            message: 'No recent heartbeat'
        };
    }

    return {
        ...entry,
        state: 'warning',
        message: 'Stale while device offline'
    };
}

async function getDeviceModuleHealth(db, deviceId, caps = {}, options = {}) {
    const mqttConnected = Boolean(options.mqttConnected);
    const live = options.live || {};
    const rows = db
        ? await db.all(
            `SELECT device_id, module_key, supported, state, last_success_at, last_failure_at, last_message, details, updated_at
             FROM device_module_health
             WHERE device_id = ?`,
            [deviceId]
        )
        : [];

    const byKey = new Map(rows.map(row => [row.module_key, parseRow(row)]));

    return Object.keys(MODULE_DEFINITIONS).map(moduleKey => {
        const base = getBaseEntry(moduleKey, caps, mqttConnected, live);
        const stored = byKey.get(moduleKey);
        const preferLive = moduleKey === 'mqtt'
            || moduleKey === 'modem'
            || (moduleKey === 'wifi' && live.wifi)
            || (moduleKey === 'storage' && live.storage);

        const merged = !stored ? base : {
            ...base,
            ...stored,
            supported: stored.supported,
            state: preferLive ? base.state : (stored.state || base.state),
            message: preferLive ? base.message : (stored.message || base.message),
            details: preferLive ? (base.details ?? stored.details ?? null) : (stored.details ?? base.details ?? null),
            lastSuccessAt: preferLive ? (base.lastSuccessAt || stored.lastSuccessAt || null) : (stored.lastSuccessAt || base.lastSuccessAt || null),
            lastFailureAt: preferLive ? (base.lastFailureAt || stored.lastFailureAt || null) : (stored.lastFailureAt || base.lastFailureAt || null),
            updatedAt: preferLive ? (base.updatedAt || stored.updatedAt || null) : (stored.updatedAt || base.updatedAt || null)
        };
        return offlineAdjustedEntry(merged, live);
    });
}

module.exports = {
    MODULE_DEFINITIONS,
    getDeviceModuleHealth,
    markModuleFailure,
    markModuleSuccess,
    offlineAdjustedEntry,
    upsertModuleHealth
};
