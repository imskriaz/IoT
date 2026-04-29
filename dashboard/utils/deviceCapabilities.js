function parseCapabilities(row = {}) {
    let caps = {};
    try {
        caps = JSON.parse(row.capabilities || '{}');
    } catch (_) {
        caps = {};
    }

    if (row.has_gps != null) caps.gps = !!row.has_gps;
    if (row.has_battery != null) caps.battery = !!row.has_battery;
    if (row.has_sd != null) caps.sd = !!row.has_sd;
    if (row.has_camera != null) caps.camera = !!row.has_camera;
    if (row.has_audio != null) caps.audio = !!row.has_audio;
    if (row.has_display != null) caps.display = !!row.has_display;
    if (row.has_nfc != null) caps.nfc = !!row.has_nfc;
    if (row.has_rfid != null) caps.rfid = !!row.has_rfid;
    if (row.has_touch != null) caps.touch = !!row.has_touch;
    if (row.has_keyboard != null) caps.keyboard = !!row.has_keyboard;

    caps.storage = Boolean(caps.storage || caps.sd);
    caps.intercom = Boolean(caps.intercom && caps.camera && caps.audio);
    if (row.board && !caps.board) caps.board = row.board;

    const inferred = inferCapabilitiesFromStatus(caps);
    for (const [key, value] of Object.entries(inferred)) {
        if (value === true && typeof caps[key] !== 'boolean') {
            caps[key] = true;
        }
    }

    if (typeof caps.gpio !== 'boolean') {
        const boardToken = String(row.board || row.type || caps.board || '').trim().toLowerCase();
        const bridgeToken = String(caps.bridge || '').trim().toLowerCase();
        const chipToken = String(caps.chip || '').trim().toLowerCase();

        if (
            bridgeToken === 'android'
            || (bridgeToken.includes('http') && bridgeToken.includes('sms'))
            || boardToken.includes('android')
            || (boardToken.includes('http') && boardToken.includes('sms'))
        ) {
            caps.gpio = false;
        } else if (
            bridgeToken === 'firmware'
            || chipToken.includes('esp32')
            || boardToken.includes('esp32')
            || boardToken.includes('a7670')
        ) {
            caps.gpio = true;
        }
    }

    return caps;
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
        if (telephonySupported === null) {
            caps.sms = true;
            caps.calls = true;
            caps.ussd = true;
        } else {
            caps.sms = telephonySupported;
            caps.calls = telephonySupported && firstBoolean(status?.call_supported, status?.callSupported) !== false;
            caps.ussd = telephonySupported;
        }
    }

    if (firstBoolean(
        status?.send_sms_permission,
        status?.receive_sms_permission,
        status?.sms_ready,
        status?.smsReady,
        status?.sms_supported,
        status?.smsSupported,
        status?.sms_send_supported,
        status?.sms_receive_supported,
        status?.sms?.ready,
        status?.sms?.supported,
        status?.sms?.sendReady,
        status?.sms?.receiveReady
    ) === true || status?.sms_poll_count != null || status?.sms_last_detail) {
        caps.sms = true;
    }
    if (firstBoolean(
        status?.call_supported,
        status?.callSupported,
        status?.call_dial_supported,
        status?.callDialSupported,
        status?.call?.supported,
        status?.call?.dialSupported
    ) === true) {
        caps.calls = true;
    }
    if (firstBoolean(status?.contacts_supported, status?.contact_sync_supported, status?.read_contacts_permission, status?.contacts?.supported) === true) {
        caps.contacts = true;
    }
    if (firstBoolean(status?.ussd_supported, status?.ussdSupported, status?.ussd_ready, status?.ussdReady, status?.ussd?.supported, status?.ussd?.ready) === true) {
        caps.ussd = true;
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
        if (!source || typeof source !== 'object') continue;

        for (const [key, value] of Object.entries(source)) {
            if (value == null) continue;

            if (typeof value === 'boolean') {
                if (!(key in merged)) {
                    merged[key] = value;
                } else {
                    merged[key] = Boolean(merged[key] || value);
                }
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

    merged.storage = Boolean(merged.storage || merged.sd);
    merged.intercom = Boolean(merged.intercom && merged.camera && merged.audio);
    merged.internet = Boolean(merged.internet || merged.modem || merged.wifi);

    return merged;
}

function isCapabilityAvailable(caps = {}, key = '') {
    switch (key) {
        case 'storage':
            return Boolean(caps.storage || caps.sd);
        case 'intercom':
            return Boolean(caps.modules?.intercom?.available || (caps.intercom && caps.camera && caps.audio));
        case 'sd':
            return Boolean(caps.modules?.storage?.available || caps.storage || caps.sd);
        case 'camera':
            return Boolean(caps.modules?.webcam?.available || caps.camera);
        default:
            if (caps.modules && caps.modules[key]) {
                return Boolean(caps.modules[key].available);
            }
            return Boolean(caps[key]);
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
    parseCapabilities
};
