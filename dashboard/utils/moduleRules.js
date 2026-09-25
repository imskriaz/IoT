'use strict';

const { isCapabilityAvailable, sanitizeStoredCapabilities } = require('./deviceCapabilities');

const MODULE_RULE_LABELS = Object.freeze({
    mqtt: 'MQTT',
    modem: 'Modem',
    internet: 'Internet',
    sms: 'SMS',
    calls: 'Calls',
    contacts: 'Contacts',
    ussd: 'USSD',
    wifi: 'Wi-Fi',
    gps: 'GPS',
    storage: 'Storage',
    sd: 'Storage',
    camera: 'Camera',
    webcam: 'Camera',
    audio: 'Audio',
    intercom: 'Intercom',
    gpio: 'GPIO',
    display: 'Display',
    nfc: 'NFC',
    rfid: 'RFID',
    touch: 'Touch',
    keyboard: 'Keyboard',
    battery: 'Battery'
});

const MODULE_RULES = Object.freeze({
    mqtt: { transport: 'mqtt', core: true },
    modem: { transport: 'mqtt', core: true },
    internet: { transport: 'network' },
    sms: { transport: 'mqtt' },
    calls: { transport: 'mqtt' },
    contacts: { transport: 'mqtt' },
    ussd: { transport: 'mqtt' },
    wifi: { transport: 'mqtt' },
    gps: { transport: 'mqtt' },
    storage: { transport: 'mqtt' },
    sd: { alias: 'storage', transport: 'mqtt' },
    camera: { alias: 'webcam', transport: 'stream' },
    webcam: { transport: 'stream' },
    audio: { transport: 'stream' },
    intercom: { transport: 'stream' },
    gpio: { transport: 'mqtt' },
    display: { transport: 'mqtt' },
    nfc: { transport: 'mqtt' },
    rfid: { transport: 'mqtt' },
    touch: { transport: 'mqtt' },
    keyboard: { transport: 'mqtt' },
    battery: { core: true }
});

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
        if (value === 1) return true;
        if (value === 0) return false;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', 'yes', 'y', '1', 'on', 'ready', 'supported', 'ok', 'enabled'].includes(normalized)) return true;
        if (['false', 'no', 'n', '0', 'off', 'unsupported', 'disabled', 'missing'].includes(normalized)) return false;
    }
    return null;
}

function firstBoolean(...values) {
    for (const value of values) {
        const coerced = coerceBoolean(value);
        if (coerced !== null) return coerced;
    }
    return null;
}

function hasText(value) {
    return String(value || '').trim().length > 0;
}

function readPath(source, path) {
    if (!source || !path) return undefined;
    return String(path).split('.').reduce((current, key) => {
        if (!current || typeof current !== 'object') return undefined;
        return current[key];
    }, source);
}

function readBoolean(status, context, paths) {
    const raw = context?.rawStatus || context?.raw || null;
    const values = [];
    for (const path of paths) {
        values.push(readPath(status, path));
        values.push(readPath(raw, path));
    }
    return firstBoolean(...values);
}

function readValue(status, context, paths) {
    const raw = context?.rawStatus || context?.raw || null;
    for (const path of paths) {
        const value = readPath(status, path);
        if (value !== undefined && value !== null && value !== '') return value;
        const rawValue = readPath(raw, path);
        if (rawValue !== undefined && rawValue !== null && rawValue !== '') return rawValue;
    }
    return undefined;
}

function normalizeModuleKey(key) {
    const normalized = String(key || '').trim().toLowerCase();
    const rule = MODULE_RULES[normalized];
    return rule?.alias || normalized;
}

function explicitModule(status, context, key) {
    const normalized = normalizeModuleKey(key);
    const raw = context?.rawStatus || context?.raw || null;
    const sources = [
        status?.modules,
        status?.moduleRules,
        status?.module_rules,
        status?.features,
        status?.caps?.modules,
        status?.caps,
        raw?.modules,
        raw?.moduleRules,
        raw?.module_rules,
        raw?.features,
        raw?.caps?.modules,
        raw?.caps
    ];
    for (const source of sources) {
        if (!isObject(source)) continue;
        const value = Object.prototype.hasOwnProperty.call(source, normalized)
            ? source[normalized]
            : source[key];
        if (isObject(value)) return value;
        const booleanValue = coerceBoolean(value);
        if (booleanValue !== null) return { available: booleanValue, supported: booleanValue };
    }
    return null;
}

function hasAnyTrue(status, context, paths) {
    return readBoolean(status, context, paths) === true;
}

function hasAnyFalse(status, context, paths) {
    return readBoolean(status, context, paths) === false;
}

function hasSmsRuntimeEvidence(status = {}, context = {}) {
    return hasAnyTrue(status, context, [
        'sms.ready',
        'sms.supported',
        'sms.enabled',
        'smsReady',
        'smsSupported',
        'sms_ready',
        'sms_supported',
        'sms_send_supported',
        'sms_receive_supported',
        'send_sms_permission',
        'receive_sms_permission',
        'android.permissions.sms',
        'permissions.sms'
    ]) || [
        'sms_poll_count',
        'sms_sent_count',
        'sms_received_count',
        'sms_failure_count',
        'sms.lastDetail',
        'sms_last_detail'
    ].some(path => readValue(status, context, [path]) !== undefined);
}

function hasCallRuntimeEvidence(status = {}, context = {}) {
    return hasAnyTrue(status, context, [
        'calls.ready',
        'calls.supported',
        'call.ready',
        'call.supported',
        'call.dialSupported',
        'callReady',
        'callSupported',
        'call_supported',
        'call_dial_supported',
        'call_phone_permission',
        'phone_call_permission',
        'android.permissions.phone',
        'permissions.phone'
    ]) || readValue(status, context, ['call.status', 'call_status', 'call.active', 'call_active']) !== undefined;
}

function hasUssdRuntimeEvidence(status = {}, context = {}) {
    return hasAnyTrue(status, context, [
        'ussd.ready',
        'ussd.supported',
        'ussdReady',
        'ussdSupported',
        'ussd_ready',
        'ussd_supported'
    ]) || readValue(status, context, ['ussd.lastDetail', 'ussd_last_detail', 'ussd_session_state']) !== undefined;
}

function resolveTransportState(status = {}, context = {}) {
    const mqttConnected = readBoolean(status, context, ['mqtt.connected', 'mqtt_connected']);
    const mqttSubscribed = readBoolean(status, context, ['mqtt.subscribed', 'mqtt_subscribed']);
    const dashboardMqttConnected = context.mqttConnected === true;
    // A connected socket without a confirmed command subscription cannot
    // execute device actions. Missing subscription telemetry is unknown.
    const mqttReady = dashboardMqttConnected === true
        && mqttConnected === true
        && mqttSubscribed === true;

    const httpReady = readBoolean(status, context, [
        'http.ready',
        'http.connected',
        'transport.httpReady',
        'transport.http_ready',
        'http_ready',
        'http_connected'
    ]) === true;
    const websocketReady = readBoolean(status, context, [
        'websocket.ready',
        'websocket.connected',
        'transport.websocketReady',
        'transport.websocket_ready',
        'websocket_ready',
        'websocket_connected',
        'stream.ready',
        'stream.connected'
    ]) === true;

    return {
        mqttReady,
        httpReady,
        websocketReady,
        streamReady: websocketReady || readBoolean(status, context, [
            'stream_ready',
            'camera_stream_supported',
            'webcam_stream_supported',
            'intercom_stream_supported'
        ]) === true
    };
}

function resolveTelephonyState(status = {}, context = {}) {
    const supported = readBoolean(status, context, [
        'telephonySupported',
        'telephony_supported',
        'sim.telephonySupported',
        'sim.telephony_supported',
        'modem.telephonySupported'
    ]);
    const enabled = readBoolean(status, context, [
        'telephonyEnabled',
        'telephony_enabled',
        'sim.telephonyEnabled',
        'sim.telephony_enabled',
        'modem.telephonyEnabled'
    ]);
    const registered = readBoolean(status, context, [
        'sim.registered',
        'modem_registered',
        'modem.registered'
    ]);

    return {
        // Missing telephony declarations are unknown, not proof of a usable
        // SMS/call/USSD path. Native ESP32 status reports all three fields;
        // other transports must publish their own explicit capability path.
        supported: supported === true,
        enabled: enabled === true,
        registered: registered === true,
        ready: supported === true && enabled === true && registered === true
    };
}

function resolveStorageReady(status = {}, context = {}) {
    return readBoolean(status, context, [
        'storage.mediaAvailable',
        'storage.media_available',
        'storage.mounted',
        'sd.mounted',
        'storage_media_available',
        'storage_media_mounted',
        'sd_mounted'
    ]) === true;
}

function resolveRule(key, caps = {}, status = {}, context = {}) {
    const normalized = normalizeModuleKey(key);
    const declaredKey = normalized === 'webcam' ? 'camera' : normalized;
    const explicitlyUnsupported = Object.prototype.hasOwnProperty.call(caps, declaredKey)
        && caps[declaredKey] === false;
    // Capability controls require a current, explicit device heartbeat. A
    // missing online flag or stale snapshot is not evidence that a command
    // path is usable; persisted capability metadata may describe hardware but
    // cannot establish current execution readiness.
    const online = status?.online === true && status?.statusFresh !== false;
    const transports = resolveTransportState(status, context);
    const telephony = resolveTelephonyState(status, context);
    const explicit = explicitModule(status, context, normalized) || (isObject(caps.modules) ? caps.modules[normalized] : null);
    const explicitAvailable = firstBoolean(explicit?.available, explicit?.complete, explicit?.ready, explicit?.supported);
    const cap = isCapabilityAvailable(caps, normalized)
        || (normalized === 'webcam' && caps.webcam === true);
    const mqttRequired = !['mqtt', 'internet', 'battery'].includes(normalized);
    const mqttReady = transports.mqttReady;
    const storageReady = resolveStorageReady(status, context);
    let available = false;
    let reason = 'Feature path incomplete';

    if (!online && normalized !== 'battery') {
        return { available: false, complete: false, visible: false, linkEnabled: false, reason: 'Device is offline', transport: MODULE_RULES[normalized]?.transport || null };
    }

    switch (normalized) {
        case 'mqtt':
            available = mqttReady;
            reason = available ? 'MQTT command path ready' : 'MQTT command path is not ready';
            break;
        case 'modem':
            available = Boolean(
                cap
                || telephony.ready
                || readBoolean(status, context, ['modem.present', 'modem_present']) === true
                || hasText(readValue(status, context, ['imei', 'modem.imei', 'modem_data_ip', 'modem_ip_address', 'sim.dataIp']))
                || String(status?.activePath || status?.active_path || '').trim().toLowerCase() === 'modem'
            ) && (!mqttRequired || mqttReady);
            reason = available ? 'Modem module present' : 'Modem module or MQTT control is not ready';
            break;
        case 'internet': {
            const activePath = String(status?.activePath || status?.active_path || '').toLowerCase();
            const wifiBearer = readBoolean(status, context, ['wifi.connected', 'wifi_connected']) === true;
            const modemBearer = readBoolean(status, context, ['modem_ip_bearer_ready', 'sim.ipBearer']) === true;
            // A LAN IP, cellular PDP address, or selected route is bearer
            // evidence only. The Internet module is actionable through the
            // authenticated, subscribed device command lane.
            available = mqttReady && (
                (activePath === 'wifi' && wifiBearer)
                || (activePath === 'modem' && modemBearer)
            );
            reason = available ? 'Internet command path ready' : 'Internet command path is not ready';
            break;
        }
        case 'sms': {
            const smsExplicitlyUnsupported = hasAnyFalse(status, context, [
                'sms.supported',
                'smsSupported',
                'sms_supported',
                'sms.enabled',
                'smsEnabled',
                'sms_enabled'
            ]);
            const smsCapable = cap || explicitAvailable === true || hasSmsRuntimeEvidence(status, context) || telephony.ready;
            available = telephony.ready && mqttReady && smsCapable && !smsExplicitlyUnsupported;
            reason = available ? 'SMS path ready' : 'SMS requires telephony and MQTT control';
            break;
        }
        case 'calls': {
            const callsExplicitlyUnsupported = hasAnyFalse(status, context, [
                'calls.supported',
                'call.supported',
                'callSupported',
                'call_supported',
                'call.dialSupported',
                'call_dial_supported'
            ]);
            const callsCapable = cap || explicitAvailable === true || hasCallRuntimeEvidence(status, context) || telephony.ready;
            available = telephony.ready && mqttReady && callsCapable && !callsExplicitlyUnsupported;
            reason = available ? 'Call dial path ready' : 'Calls require telephony and MQTT control';
            break;
        }
        case 'contacts': {
            const contactsReady = readBoolean(status, context, ['contacts_supported', 'contact_sync_supported', 'read_contacts_permission', 'contacts.supported']) === true;
            available = mqttReady && contactsReady;
            reason = available ? 'Contact sync path ready' : 'Contacts require a complete contact read/sync path';
            break;
        }
        case 'ussd': {
            const ussdExplicitlyUnsupported = hasAnyFalse(status, context, [
                'ussd.supported',
                'ussdSupported',
                'ussd_supported',
                'ussd.enabled',
                'ussdEnabled',
                'ussd_enabled'
            ]);
            const ussdCapable = cap || explicitAvailable === true || hasUssdRuntimeEvidence(status, context) || telephony.ready;
            available = telephony.ready && mqttReady && ussdCapable && !ussdExplicitlyUnsupported;
            reason = available ? 'USSD path ready' : 'USSD requires telephony and MQTT control';
            break;
        }
        case 'wifi': {
            const wifiReady = readBoolean(status, context, ['wifi.started', 'wifi.configured', 'wifi_started', 'wifi_configured']) === true;
            available = isCapabilityAvailable(caps, 'wifi') && mqttReady && wifiReady;
            reason = available ? 'Wi-Fi control path ready' : 'Wi-Fi requires firmware support and MQTT control';
            break;
        }
        case 'storage':
            available = isCapabilityAvailable(caps, 'storage') && mqttReady && storageReady;
            reason = available ? 'Storage mounted and command path ready' : 'Storage requires mounted media and MQTT control';
            break;
        case 'webcam': {
            const cameraReady = readBoolean(status, context, ['camera_capture_supported', 'webcam_supported', 'camera.supported', 'webcam.supported']) === true;
            available = (caps.camera === true || caps.webcam === true) && cameraReady && (mqttReady || transports.httpReady || transports.streamReady);
            reason = available ? 'Camera capture/feed path ready' : 'Camera requires capture/feed support and an active transport';
            break;
        }
        case 'audio': {
            const audioReady = readBoolean(status, context, ['audio_supported', 'audio_stream_supported', 'audio.supported']) === true;
            available = caps.audio === true && audioReady && (mqttReady || transports.streamReady);
            reason = available ? 'Audio path ready' : 'Audio requires capture/playback support and an active transport';
            break;
        }
        case 'intercom': {
            const intercomReady = readBoolean(status, context, ['intercom_supported', 'intercom_live_supported', 'intercom.supported']) === true;
            available = caps.camera === true && caps.audio === true && intercomReady && (transports.streamReady || mqttReady);
            reason = available ? 'Intercom video/audio path ready' : 'Intercom requires camera, audio, and live talk support';
            break;
        }
        case 'battery':
            available = isCapabilityAvailable(caps, 'battery') || status?.battery != null;
            reason = available ? 'Battery telemetry available' : 'Battery telemetry unavailable';
            break;
        default:
            available = Boolean(cap) && (!mqttRequired || mqttReady);
            reason = available ? `${MODULE_RULE_LABELS[normalized] || normalized} path ready` : `${MODULE_RULE_LABELS[normalized] || normalized} requires firmware support and MQTT control`;
            break;
    }

    if (explicitlyUnsupported) {
        available = false;
        reason = 'Firmware reports this capability unsupported';
    } else if (explicitAvailable === false) {
        available = false;
        reason = explicit?.reason || explicit?.message || reason;
    } else if (explicitAvailable === true && normalized !== 'calls') {
        // A declaration can confirm that a module is implemented, but it
        // cannot override a live transport gate. In particular, MQTT support
        // metadata must not turn a disconnected/unsubscribed client green.
        if (normalized === 'mqtt') {
            available = online && mqttReady;
        } else if (normalized === 'internet') {
            available = online && available;
        } else {
            available = online && (normalized === 'battery' || !mqttRequired || mqttReady);
        }
        reason = explicit?.reason || explicit?.message || reason;
    }

    return {
        available,
        complete: available,
        visible: available,
        linkEnabled: available,
        reason,
        transport: MODULE_RULES[normalized]?.transport || null
    };
}

function applyModuleRulesToCapabilities(caps = {}, status = {}, context = {}) {
    const source = isObject(caps) ? sanitizeStoredCapabilities(caps) : {};
    const modules = {};
    const keys = new Set([...Object.keys(MODULE_RULES), ...Object.keys(source), ...Object.keys(source.modules || {})]);

    for (const key of keys) {
        const normalized = normalizeModuleKey(key);
        if (!MODULE_RULES[normalized]) continue;
        const result = resolveRule(normalized, source, status, context);
        modules[normalized] = {
            label: MODULE_RULE_LABELS[normalized] || normalized,
            ...result
        };
        source[normalized] = result.available;
        if (normalized === 'storage') source.sd = result.available;
        if (normalized === 'webcam') source.camera = result.available;
    }

    source.modules = modules;
    source.intercom = Boolean(modules.intercom?.available);
    source.internet = Boolean(modules.internet?.available);
    return source;
}

function applyModuleRulesToHealth(moduleHealth = [], caps = {}, status = {}, context = {}) {
    return (Array.isArray(moduleHealth) ? moduleHealth : []).map(entry => {
        const key = normalizeModuleKey(entry?.moduleKey);
        if (!key || !MODULE_RULES[key]) return entry;
        const result = caps?.modules?.[key] || resolveRule(key, caps, status, context);
        const hasReportedHealth = entry?.supported === true
            && entry?.state
            && entry.state !== 'unsupported'
            && (
                entry.lastSuccessAt
                || entry.lastFailureAt
                || entry.updatedAt
                || entry.details
                || (entry.message && entry.message !== 'Firmware support pending on active device')
            );
        if (result.available) {
            return {
                ...entry,
                moduleKey: key,
                available: true,
                complete: true,
                visible: true,
                linkEnabled: true,
                ruleReason: result.reason,
                transport: result.transport
            };
        }
        if (hasReportedHealth) {
            return {
                ...entry,
                moduleKey: key,
                available: true,
                complete: entry.state === 'ok',
                visible: true,
                linkEnabled: true,
                ruleReason: result.reason,
                transport: result.transport
            };
        }
        return {
            ...entry,
            moduleKey: key,
            supported: false,
            state: 'unsupported',
            message: result.reason || entry?.message || 'Feature path incomplete',
            available: false,
            complete: false,
            visible: false,
            linkEnabled: false,
            ruleReason: result.reason,
            transport: result.transport
        };
    });
}

module.exports = {
    MODULE_RULE_LABELS,
    MODULE_RULES,
    applyModuleRulesToCapabilities,
    applyModuleRulesToHealth,
    normalizeModuleKey,
    resolveRule
};
