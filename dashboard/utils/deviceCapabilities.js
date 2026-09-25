const MODULE_CAPABILITY_KEYS = new Set([
    'audio',
    'battery',
    'calls',
    'camera',
    'display',
    'gpio',
    'gps',
    'intercom',
    'internet',
    'keyboard',
    'modem',
    'nfc',
    'rfid',
    'sd',
    'sms',
    'storage',
    'touch',
    'ussd',
    'wifi'
]);

const RUNTIME_STATUS_KEYS = new Set([
    'active_path',
    'activePath',
    'applied_version',
    'appliedVersion',
    'call',
    'charging',
    'dashboard_ack_age_ms',
    'dashboardAckAgeMs',
    'desired_version',
    'desiredVersion',
    'imei',
    'in_sync',
    'inSync',
    'ip',
    'message',
    'messageId',
    'message_id',
    'moduleHealth',
    'mqtt',
    'network',
    'online',
    'operator',
    'queueState',
    'reboot_reason',
    'rebootReason',
    'sim',
    'simNumber',
    'sim_number',
    'sync',
    'systemRuntime',
    'hardware',
    'temperature',
    'timestamp',
    'transport',
    'type',
    'uptime',
    'uptimeMs',
    'uptime_ms',
    'voltageMv',
    'voltage_mV'
]);

const RUNTIME_STATUS_PREFIXES = [
    'board_',
    'dashboard_',
    'flash_',
    'free_',
    'hardware_',
    'health_',
    'heap_',
    'internal_',
    'largest_',
    'low_',
    'missing_',
    'modem_',
    'mqtt_',
    'other_heap_',
    'psram_',
    'queue_',
    'rom_',
    'runtime_ram_',
    'sd_',
    'sms_',
    'stack_',
    'static_',
    'status_',
    'storage_',
    'task_',
    'wifi_'
];

function isRuntimeStatusCapabilityKey(key) {
    if (MODULE_CAPABILITY_KEYS.has(key)) return false;
    if (RUNTIME_STATUS_KEYS.has(key)) return true;
    return RUNTIME_STATUS_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function sanitizeStoredCapabilities(caps = {}) {
    const clean = {};
    if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
        return clean;
    }

    for (const [key, value] of Object.entries(caps)) {
        if (!key || isRuntimeStatusCapabilityKey(key)) continue;

        if (MODULE_CAPABILITY_KEYS.has(key)) {
            // A module declaration is a boolean, not a status snapshot or a
            // truthy string. Preserve invalid declarations as false so stale
            // profile columns/earlier sources cannot re-enable the module.
            clean[key] = value === true;
            continue;
        }

        if (value == null) continue;
        clean[key] = value;
    }

    return clean;
}

function parseCapabilities(row = {}) {
    let caps = {};
    // A present but malformed manifest is an invalid declaration, not
    // permission to resurrect stale legacy profile columns.
    const hasManifest = row.capabilities != null && String(row.capabilities).trim() !== '';
    try {
        const manifest = JSON.parse(row.capabilities || '{}');
        caps = sanitizeStoredCapabilities(manifest);
    } catch (_) {
        caps = {};
    }

    // The JSON manifest is the canonical capability source. Legacy profile
    // columns are only a fallback for devices with no manifest. A
    // present manifest that omits a module means unknown, not old column true.
    const rowFlags = {
        gps: row.has_gps,
        battery: row.has_battery,
        sd: row.has_sd,
        camera: row.has_camera,
        audio: row.has_audio,
        display: row.has_display,
        nfc: row.has_nfc,
        rfid: row.has_rfid,
        touch: row.has_touch,
        keyboard: row.has_keyboard
    };
    for (const [key, value] of Object.entries(rowFlags)) {
        if (!hasManifest && value != null && !Object.prototype.hasOwnProperty.call(caps, key)) {
            caps[key] = normalizeBooleanFlag(value);
        }
    }

    // Derived capabilities are defaults only. An explicit false in the
    // manifest remains false even when a related legacy/inferred flag exists.
    if (!Object.prototype.hasOwnProperty.call(caps, 'storage') &&
        Object.prototype.hasOwnProperty.call(caps, 'sd')) {
        caps.storage = caps.sd === true;
    }
    if (!Object.prototype.hasOwnProperty.call(caps, 'intercom') &&
        (Object.prototype.hasOwnProperty.call(caps, 'camera') ||
         Object.prototype.hasOwnProperty.call(caps, 'audio'))) {
        caps.intercom = caps.camera === true || caps.audio === true;
    }
    if (!Object.prototype.hasOwnProperty.call(caps, 'internet') &&
        (Object.prototype.hasOwnProperty.call(caps, 'modem') ||
         Object.prototype.hasOwnProperty.call(caps, 'wifi'))) {
        caps.internet = caps.modem === true || caps.wifi === true;
    }
    if (row.board && !caps.board) caps.board = row.board;

    return caps;
}

function normalizeBooleanFlag(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['', '0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
        if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    }
    return Boolean(value);
}

function hasMeaningfulObject(value) {
    return Boolean(value) && typeof value === 'object' && Object.keys(value).length > 0;
}

function firstBoolean(...values) {
    for (const value of values) {
        if (typeof value === 'boolean') {
            return value;
        }
    }

    return null;
}

function inferCapabilitiesFromStatus(status = {}) {
    // Cached/offline snapshots are telemetry history, not current capability
    // evidence. Keep persisted explicit declarations available to callers,
    // but never derive a new module capability from stale runtime fields.
    if (status?.statusFresh === false || status?.online === false) {
        return {};
    }

    const caps = {};
    const activePath = String(status?.activePath || status?.active_path || status?.status?.active_path || '').trim().toLowerCase();
    const wifi = status?.wifi;
    const storage = status?.storage || status?.sd;
    const sim = status?.sim;
    const transport = status?.transport;
    const call = status?.call;
    const telephonySupported = firstBoolean(
        status?.telephonySupported,
        status?.telephony_supported,
        status?.sim?.telephonySupported,
        status?.sim?.telephony_supported,
        status?.modem?.telephonySupported,
        status?.status?.modem?.telephonySupported
    );
    const telephonyEnabled = firstBoolean(
        status?.telephonyEnabled,
        status?.telephony_enabled,
        status?.sim?.telephonyEnabled,
        status?.sim?.telephony_enabled,
        status?.modem?.telephonyEnabled,
        status?.status?.modem?.telephonyEnabled
    );
    const dataModeEnabled = firstBoolean(
        status?.dataModeEnabled,
        status?.data_mode_enabled,
        status?.sim?.dataModeEnabled,
        status?.sim?.data_mode_enabled,
        status?.modem?.dataModeEnabled,
        status?.status?.modem?.dataModeEnabled,
        status?.status?.modem?.dataSession
    );

    const modemPresent = Boolean(
        String(status?.imei || '').trim()
        || activePath === 'modem'
        || hasMeaningfulObject(sim)
        || hasMeaningfulObject(transport)
        || hasMeaningfulObject(call)
        || telephonySupported !== null
        || telephonyEnabled !== null
        || dataModeEnabled !== null
        || status?.operator
        || status?.cellularSignal != null
        || status?.cellularSignalDbm != null
        || status?.cellularStatus
    );

    if (modemPresent) {
        caps.modem = true;
        // A data modem/session proves modem and internet capability only.
        // Telephony actions require an explicit capability declaration from
        // the device manifest or status; registration alone is not proof.
        if (telephonySupported !== null) {
            caps.sms = telephonySupported;
            caps.calls = telephonySupported;
            caps.ussd = telephonySupported;
        }
    }

    const wifiPresent = Boolean(
        activePath === 'wifi'
        || status?.wifiSsid
        || hasMeaningfulObject(wifi)
    );
    if (wifiPresent) {
        caps.wifi = true;
    }

    if (caps.modem || caps.wifi) {
        caps.internet = true;
    }

    const storagePresent = Boolean(
        hasMeaningfulObject(storage)
        || status?.storage?.mounted != null
        || status?.storage?.mediaAvailable != null
        || status?.sd?.mounted != null
    );
    if (storagePresent) {
        caps.storage = true;
        caps.sd = true;
    }

    if (
        status?.battery != null
        || status?.voltageMv != null
        || status?.voltage_mV != null
        || status?.charging != null
    ) {
        caps.battery = true;
    }

    return caps;
}

function mergeCapabilities(...sources) {
    const merged = {};

    for (const source of sources) {
        for (const [key, value] of Object.entries(sanitizeStoredCapabilities(source))) {
            if (value == null) continue;

            if (typeof value === 'boolean') {
                // Later sources are authoritative. A live manifest/status
                // must be able to revoke stale stored capability flags.
                merged[key] = value;
                continue;
            }

            if (typeof value === 'object' && !Array.isArray(value)) {
                merged[key] = {
                    ...(typeof merged[key] === 'object' && merged[key] !== null && !Array.isArray(merged[key]) ? merged[key] : {}),
                    ...value
                };
                continue;
            }

            if (!(key in merged) || merged[key] == null || merged[key] === '') {
                merged[key] = value;
            }
        }
    }

    if (!Object.prototype.hasOwnProperty.call(merged, 'storage')) {
        merged.storage = merged.sd === true;
    }
    if (!Object.prototype.hasOwnProperty.call(merged, 'intercom')) {
        merged.intercom = merged.camera === true || merged.audio === true;
    }
    if (!Object.prototype.hasOwnProperty.call(merged, 'internet')) {
        merged.internet = merged.modem === true || merged.wifi === true;
    }

    return merged;
}

function isCapabilityAvailable(caps = {}, key = '') {
    switch (key) {
        case 'storage':
            return Object.prototype.hasOwnProperty.call(caps, 'storage')
                ? caps.storage === true
                : caps.sd === true;
        case 'intercom':
            return Object.prototype.hasOwnProperty.call(caps, 'intercom')
                ? caps.intercom === true
                : caps.camera === true || caps.audio === true;
        default:
            return caps[key] === true;
    }
}

async function getDeviceCapabilities(db, deviceId) {
    if (!db || !deviceId) {
        return { row: null, caps: {} };
    }

    const row = await db.get(
        `SELECT dp.capabilities,
                COALESCE(dp.board, d.type) AS board,
                d.type,
                dp.has_gps, dp.has_battery, dp.has_sd, dp.has_camera, dp.has_audio,
                dp.has_display, dp.has_nfc, dp.has_rfid, dp.has_touch, dp.has_keyboard
         FROM devices d
         LEFT JOIN device_profiles dp ON dp.device_id = d.id
         WHERE d.id = ?`,
        [deviceId]
    );

    return {
        row: row || null,
        caps: parseCapabilities(row || {})
    };
}

module.exports = {
    getDeviceCapabilities,
    inferCapabilitiesFromStatus,
    isCapabilityAvailable,
    mergeCapabilities,
    parseCapabilities,
    sanitizeStoredCapabilities
};
