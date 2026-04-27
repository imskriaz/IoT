'use strict';

const STATUS_STALE_AFTER_MS = 2 * 60 * 1000;

function toNumberOrNull(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function wifiRssiToPercent(rssi) {
    const level = toNumberOrNull(rssi);
    if (level === null) {
        return null;
    }

    if (level <= -100) {
        return 0;
    }

    if (level >= -50) {
        return 100;
    }

    return Math.round((level + 100) * 2);
}

function normalizeText(value) {
    if (value == null) {
        return null;
    }

    const text = String(value).trim();
    return text.length > 0 ? text : null;
}

function parseTimestampMs(value) {
    const text = normalizeText(value);
    if (text === null) {
        return null;
    }

    const timestamp = Date.parse(text);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function resolveStatusFreshness(status, explicitOnline) {
    const hintedOnline = typeof explicitOnline === 'boolean'
        ? explicitOnline
        : (typeof status?.online === 'boolean' ? status.online : null);
    const lastSeenMs = parseTimestampMs(status?.lastSeen || status?.last_seen || status?._cachedAt || null);
    const ageMs = lastSeenMs === null ? null : Math.max(0, Date.now() - lastSeenMs);
    const staleByAge = ageMs !== null && ageMs > STATUS_STALE_AFTER_MS;
    const isOnline = hintedOnline === false
        ? false
        : (staleByAge ? false : (hintedOnline === true || (hintedOnline === null && lastSeenMs !== null)));

    return {
        isOnline,
        ageMs,
        lastSeenMs,
        stale: !isOnline,
        summary: lastSeenMs === null ? 'Waiting for live data' : 'No recent heartbeat',
        reason: lastSeenMs === null ? 'awaiting_live_data' : 'no_recent_heartbeat'
    };
}

function firstNumber(...values) {
    for (const value of values) {
        const numeric = toNumberOrNull(value);
        if (numeric !== null) {
            return numeric;
        }
    }

    return null;
}

function firstText(...values) {
    for (const value of values) {
        const text = normalizeText(value);
        if (text !== null) {
            return text;
        }
    }

    return null;
}

function firstBoolean(...values) {
    for (const value of values) {
        if (typeof value === 'boolean') {
            return value;
        }
    }

    return null;
}

// Prefer the device-reported carrier label. If only a numeric code is
// available, keep that raw code visible instead of translating in the dashboard.
const normalizeOperatorName = function normalizeOperatorName(...values) {
    const normalized = values
        .map((value) => normalizeText(value))
        .filter((value) => value !== null);

    if (normalized.length === 0) {
        return null;
    }

    const named = normalized.find((value) => /[A-Za-z]/.test(value));
    return named || normalized[0];
};

function resolveOperatorLabel(...values) {
    const normalized = values
        .map((value) => normalizeText(value))
        .filter((value) => value !== null);

    if (normalized.length === 0) {
        return null;
    }

    const named = normalized.find((value) => /[A-Za-z]/.test(value));
    return named || normalized[0];
}

function normalizeWifiSecurityLabel(value) {
    const text = normalizeText(value);
    if (!text) {
        return null;
    }

    const normalized = text.toLowerCase().replace(/[\s-]+/g, '_');
    if (normalized === 'open') {
        return 'Open';
    }
    if (normalized.includes('wpa2') && normalized.includes('wpa3')) {
        return 'WPA2/WPA3';
    }
    if (normalized.includes('wpa') && normalized.includes('wpa2')) {
        return 'WPA/WPA2';
    }
    if (normalized.includes('wpa3')) {
        return 'WPA3';
    }
    if (normalized.includes('wpa2')) {
        return 'WPA2';
    }
    if (normalized.includes('wep')) {
        return 'WEP';
    }
    if (normalized.includes('wpa')) {
        return 'WPA';
    }

    return text.toUpperCase();
}

function normalizeCellularNetworkTypeLabel(value) {
    const text = normalizeText(value);
    if (!text) {
        return null;
    }

    const normalized = text.toLowerCase();
    if (normalized === 'cellular' || normalized === 'unknown' || normalized === 'offline' || normalized === 'no service') {
        return null;
    }
    if (normalized.includes('5g') || normalized.includes('nr')) {
        return '5G';
    }
    if (normalized.includes('lte') || normalized.includes('4g') || normalized.includes('cat-1') || normalized.includes('cat1')) {
        return '4G/LTE';
    }
    if (normalized.includes('wcdma') || normalized.includes('umts') || normalized.includes('hspa') || normalized.includes('hsdpa') || normalized.includes('hsupa') || normalized.includes('3g')) {
        return '3G';
    }
    if (normalized.includes('edge') || normalized.includes('gprs') || normalized.includes('gsm') || normalized.includes('2g')) {
        return '2G';
    }

    return text.toUpperCase();
}

function resolveWifiStatusLabel(isOnline, wifiConnected, activePath) {
    if (!isOnline) {
        return 'Disconnected';
    }

    return (wifiConnected || activePath === 'wifi') ? 'Connected' : 'Not connected';
}

function resolveWifiRoleLabel(isOnline, activePath, wifiConnected, wifiSsid) {
    if (!isOnline) {
        return 'Offline';
    }

    if (activePath === 'wifi') {
        return 'Primary';
    }

    if (wifiConnected) {
        return 'Connected';
    }

    return normalizeText(wifiSsid) ? 'Not connected' : 'Offline';
}

function inferWifiConnected(wifi, activePath, wifiIpAddress) {
    if (wifi?.connected === true) {
        return true;
    }

    if (activePath === 'wifi') {
        return true;
    }

    if (wifi?.ipAssigned === true) {
        return true;
    }

    return normalizeText(wifiIpAddress) !== null;
}

function resolveModemRoleLabel(isOnline, activePath, modemAvailable) {
    if (!isOnline) {
        return 'Offline';
    }

    if (activePath === 'modem') {
        return 'Fallback';
    }

    return modemAvailable ? 'Connected' : 'Offline';
}

function normalizeStorage(status) {
    const storage = status?.storage || status?.status?.storage || null;
    const sd = status?.sd || null;
    const hasFlatStorage = status && (
        status?.storage_media_mounted !== undefined
        || status?.sd_mounted !== undefined
        || status?.storage_media_available !== undefined
        || status?.storage_buffered_only !== undefined
        || status?.storage_queue_depth !== undefined
        || status?.storage_total_bytes !== undefined
        || status?.storage_used_bytes !== undefined
        || status?.storage_free_bytes !== undefined
    );
    const flatStorage = hasFlatStorage ? {
        mounted: firstBoolean(status?.storage_media_mounted, status?.sd_mounted, status?.storage_media_available),
        mediaAvailable: firstBoolean(status?.storage_media_available, status?.storage_media_mounted, status?.sd_mounted),
        bufferedOnly: firstBoolean(status?.storage_buffered_only),
        queueDepth: firstNumber(status?.storage_queue_depth, 0),
        pendingUploads: firstNumber(status?.pending_uploads, status?.storage_queue_depth, 0),
        totalBytes: firstNumber(status?.storage_total_bytes, 0),
        usedBytes: firstNumber(status?.storage_used_bytes, 0),
        freeBytes: firstNumber(status?.storage_free_bytes, 0)
    } : null;
    const source = storage || sd || flatStorage;
    const type = firstText(
        source?.type,
        source?.label,
        source?.mediaType,
        source?.mediaLabel,
        status?.storage_media_label,
        status?.storage_media_type
    ) || 'SSD';
    const bus = firstText(
        source?.bus,
        source?.mediaBus,
        status?.storage_media_bus
    );

    if (!source) {
        return null;
    }

    return {
        ...source,
        type,
        label: type,
        bus,
        mounted: Boolean(source.mounted || source.mediaAvailable),
        mediaAvailable: Boolean(source.mediaAvailable || source.mounted),
        bufferedOnly: Boolean(source.bufferedOnly),
        queueDepth: firstNumber(source.queueDepth, 0),
        pendingUploads: firstNumber(source.pendingUploads, source.queueDepth, 0),
        totalBytes: firstNumber(source.totalBytes, source.total, 0),
        usedBytes: firstNumber(source.usedBytes, source.used, 0),
        freeBytes: firstNumber(source.freeBytes, source.free, 0)
    };
}

function normalizeWifiSnapshot(status) {
    const wifi = status?.wifi || status?.status?.wifi || null;
    const hasFlatWifi = status && (
        status?.wifi_connected !== undefined
        || status?.wifi_configured !== undefined
        || status?.wifi_started !== undefined
        || status?.wifi_ssid !== undefined
        || status?.wifi_ip_address !== undefined
        || status?.wifi_rssi !== undefined
        || status?.wifi_last_disconnect_reason !== undefined
        || status?.wifi_last_disconnect_reason_text !== undefined
        || status?.wifi_last_scan_target_visible !== undefined
    );

    if (!wifi && !hasFlatWifi) {
        return null;
    }

    return {
        ...(wifi || {}),
        connected: firstBoolean(wifi?.connected, status?.wifi_connected) === true,
        ssid: firstText(wifi?.ssid, status?.wifi_ssid) || '',
        ipAddress: firstText(wifi?.ipAddress, status?.wifi_ip_address) || '',
        security: firstText(
            wifi?.security,
            status?.wifi_security,
            status?.wifiSecurity,
            status?.wifi_auth_mode,
            status?.wifi_authmode
        ),
        rssi: firstNumber(wifi?.rssi, status?.wifi_rssi),
        configured: firstBoolean(wifi?.configured, status?.wifi_configured),
        started: firstBoolean(wifi?.started, status?.wifi_started),
        ipAssigned: firstBoolean(wifi?.ipAssigned, status?.wifi_ip_assigned),
        lastDisconnectReason: firstNumber(wifi?.lastDisconnectReason, status?.wifi_last_disconnect_reason),
        lastDisconnectReasonText: firstText(wifi?.lastDisconnectReasonText, status?.wifi_last_disconnect_reason_text),
        lastScanTargetVisible: firstBoolean(wifi?.lastScanTargetVisible, status?.wifi_last_scan_target_visible),
        lastScanVisibleCount: firstNumber(wifi?.lastScanVisibleCount, status?.wifi_last_scan_visible_count),
        lastScanElapsedMs: firstNumber(wifi?.lastScanElapsedMs, status?.wifi_last_scan_elapsed_ms),
        lastScanSummary: firstText(wifi?.lastScanSummary, status?.wifi_last_scan_summary)
    };
}

function normalizeMqttSnapshot(status) {
    const mqtt = status?.mqtt || status?.status?.mqtt || null;
    const transport = status?.transport || status?.status?.transport || null;
    const hasFlatMqtt = status && (
        status?.mqtt_configured !== undefined
        || status?.mqtt_connected !== undefined
        || status?.mqtt_subscribed !== undefined
        || status?.mqtt_reconnect_count !== undefined
        || status?.mqtt_published_count !== undefined
        || status?.mqtt_publish_failures !== undefined
        || status?.mqtt_command_messages !== undefined
        || status?.mqtt_command_rejects !== undefined
        || status?.mqtt_action_results_published !== undefined
        || status?.mqtt_action_result_failures !== undefined
        || status?.mqtt_last_error_text !== undefined
    );

    if (!mqtt && !hasFlatMqtt) {
        return null;
    }

    const connected = firstBoolean(mqtt?.connected, status?.mqtt_connected) === true;
    const acceptsCommands = firstBoolean(
        transport?.mqttCommandAccepting,
        status?.mqttCommandAccepting,
        status?.mqtt_command_accepting
    ) === true;
    const subscribed = connected && acceptsCommands
        ? true
        : firstBoolean(mqtt?.subscribed, status?.mqtt_subscribed);

    return {
        ...(mqtt || {}),
        configured: firstBoolean(mqtt?.configured, status?.mqtt_configured),
        connected,
        subscribed,
        reconnectCount: firstNumber(mqtt?.reconnectCount, status?.mqtt_reconnect_count),
        publishedCount: firstNumber(mqtt?.publishedCount, status?.mqtt_published_count),
        publishFailures: firstNumber(mqtt?.publishFailures, status?.mqtt_publish_failures),
        commandMessages: firstNumber(mqtt?.commandMessages, status?.mqtt_command_messages),
        commandRejects: firstNumber(mqtt?.commandRejects, status?.mqtt_command_rejects),
        actionResultsPublished: firstNumber(mqtt?.actionResultsPublished, status?.mqtt_action_results_published),
        actionResultFailures: firstNumber(mqtt?.actionResultFailures, status?.mqtt_action_result_failures),
        lastErrorText: firstText(mqtt?.lastErrorText, status?.mqtt_last_error_text)
    };
}

function normalizeSimSnapshot(status) {
    const sim = status?.sim || status?.status?.sim || null;
    const hasFlatSim = status && (
        status?.modem_registered !== undefined
        || status?.modem_sim_ready !== undefined
        || status?.modem_operator !== undefined
        || status?.modem_operator_name !== undefined
        || status?.modem_subscriber_number !== undefined
        || status?.telephony_supported !== undefined
        || status?.telephony_enabled !== undefined
        || status?.data_mode_enabled !== undefined
        || status?.modem_data_session_open !== undefined
        || status?.modem_ip_bearer_ready !== undefined
        || status?.modem_data_ip !== undefined
        || status?.modem_ip_address !== undefined
        || status?.sim_slot_count !== undefined
        || status?.sim_active_slot !== undefined
        || status?.sim_slots !== undefined
    );

    if (!sim && !hasFlatSim) {
        return null;
    }

    const slots = normalizeSimSlots(status);
    const explicitActiveSlotIndex = firstNumber(
        status?.sim_active_slot,
        status?.active_sim_slot,
        status?.selected_sim_slot,
        status?.selectedSimSlot,
        sim?.activeSlotIndex,
        sim?.selectedSlotIndex
    );
    const selectedSlot = slots.find((slot) => slot.slotIndex === explicitActiveSlotIndex)
        || slots.find((slot) => slot.smsPreferred)
        || slots.find((slot) => slot.dataPreferred)
        || slots[0]
        || null;
    const slotCount = Math.max(
        Number(firstNumber(status?.sim_slot_count, status?.simSlotCount, sim?.slotCount, slots.length) || 0),
        slots.length
    );

    return {
        ...(sim || {}),
        ready: firstBoolean(selectedSlot?.ready, sim?.ready, status?.modem_sim_ready),
        registered: firstBoolean(selectedSlot?.registered, sim?.registered, status?.modem_registered),
        operator: resolveOperatorLabel(selectedSlot?.operator, selectedSlot?.carrierName, sim?.operator, status?.modem_operator, status?.modem_operator_name),
        operatorName: resolveOperatorLabel(selectedSlot?.operatorName, selectedSlot?.operator, selectedSlot?.carrierName, sim?.operatorName, status?.modem_operator_name, status?.modem_operator),
        number: firstText(selectedSlot?.number, selectedSlot?.subscriberNumber, sim?.number, sim?.subscriberNumber, status?.modem_subscriber_number),
        subscriberNumber: firstText(selectedSlot?.subscriberNumber, selectedSlot?.number, sim?.subscriberNumber, sim?.number, status?.modem_subscriber_number),
        telephonySupported: firstBoolean(sim?.telephonySupported, status?.telephony_supported, status?.telephonySupported),
        telephonyEnabled: firstBoolean(sim?.telephonyEnabled, status?.telephony_enabled, status?.telephonyEnabled),
        dataModeEnabled: firstBoolean(sim?.dataModeEnabled, status?.data_mode_enabled, status?.dataModeEnabled),
        dataSession: firstBoolean(selectedSlot?.dataSession, sim?.dataSession, status?.modem_data_session_open),
        ipBearer: firstBoolean(selectedSlot?.ipBearer, sim?.ipBearer, status?.modem_ip_bearer_ready),
        dataIp: firstText(selectedSlot?.dataIp, sim?.dataIp, status?.modem_data_ip, status?.modem_ip_address),
        slotCount,
        dualSim: slotCount >= 2,
        activeSlotIndex: selectedSlot?.slotIndex ?? explicitActiveSlotIndex,
        selectedSlotIndex: selectedSlot?.slotIndex ?? explicitActiveSlotIndex,
        slots
    };
}

function normalizeSimSlots(status) {
    const rawSlots = Array.isArray(status?.sim_slots)
        ? status.sim_slots
        : (Array.isArray(status?.simSlots)
            ? status.simSlots
            : (Array.isArray(status?.sim?.slots)
                ? status.sim.slots
                : (Array.isArray(status?.status?.sim?.slots) ? status.status.sim.slots : [])));

    return rawSlots
        .map((slot, index) => {
            if (!slot || typeof slot !== 'object') {
                return null;
            }

            const slotIndex = firstNumber(slot?.slotIndex, slot?.slot_index, slot?.simSlot, slot?.sim_slot, index);
            return {
                ...slot,
                slotIndex: slotIndex === null ? index : slotIndex,
                displayName: firstText(slot?.displayName, slot?.display_name, slot?.carrierName, slot?.carrier_name, slot?.operatorName, slot?.operator),
                carrierName: resolveOperatorLabel(slot?.carrierName, slot?.carrier_name, slot?.operatorName, slot?.operator),
                operator: resolveOperatorLabel(slot?.operator, slot?.operatorName, slot?.carrierName, slot?.carrier_name),
                operatorName: resolveOperatorLabel(slot?.operatorName, slot?.operator, slot?.carrierName, slot?.carrier_name),
                number: firstText(slot?.number, slot?.subscriberNumber, slot?.subscriber_number, slot?.msisdn, slot?.phoneNumber, slot?.phone_number),
                subscriberNumber: firstText(slot?.subscriberNumber, slot?.subscriber_number, slot?.number, slot?.msisdn, slot?.phoneNumber, slot?.phone_number),
                networkType: firstText(slot?.networkType, slot?.network_type),
                signalAsu: firstNumber(slot?.signalAsu, slot?.signal_asu, slot?.signalStrength, slot?.signal_strength),
                dataIp: firstText(slot?.dataIp, slot?.data_ip, slot?.ipAddress, slot?.ip_address),
                ready: firstBoolean(slot?.ready, slot?.simReady, slot?.sim_ready),
                registered: firstBoolean(slot?.registered, slot?.modemRegistered, slot?.modem_registered),
                roaming: firstBoolean(slot?.roaming),
                smsPreferred: firstBoolean(slot?.smsPreferred, slot?.sms_preferred),
                dataPreferred: firstBoolean(slot?.dataPreferred, slot?.data_preferred),
                voicePreferred: firstBoolean(slot?.voicePreferred, slot?.voice_preferred),
                countryIso: firstText(slot?.countryIso, slot?.country_iso)
            };
        })
        .filter(Boolean);
}

function normalizeDeviceInfo(status) {
    const device = status?.device || status?.deviceInfo || status?.device_info || null;
    const manufacturer = firstText(status?.manufacturer, status?.deviceManufacturer, device?.manufacturer);
    const brand = firstText(status?.brand, status?.deviceBrand, device?.brand);
    let model = firstText(status?.model, status?.deviceModel, device?.model);
    const imei = firstText(status?.imei, device?.imei);
    const androidId = firstText(status?.androidId, status?.android_id, device?.androidId, device?.android_id);
    const explicitPlatform = firstText(status?.platform, device?.platform);
    const deviceTypeHints = [
        status?.type,
        status?.deviceType,
        status?.device_type,
        status?.board,
        status?.deviceBoard,
        status?.device_board,
        status?.chip,
        status?.deviceId,
        status?.device_id,
        device?.type,
        device?.deviceType,
        device?.device_type,
        device?.board,
        device?.chip
    ].map(value => String(value ?? '').trim().toLowerCase()).filter(Boolean);
    const firmwareHints = [
        status?.activePath,
        status?.active_path,
        status?.wifi_ssid,
        status?.wifi_ip_address,
        status?.modem_operator,
        status?.modem_network_type,
        status?.mqtt_connected,
        status?.task_count,
        status?.storage_total_bytes,
        status?.board,
        device?.board,
        device?.chip,
        device?.bridge
    ].map(value => String(value ?? '').trim().toLowerCase()).filter(Boolean);
    const androidHints = [
        explicitPlatform,
        device?.bridge,
        device?.app,
        status?.bridge,
        status?.bridge_type
    ].map(value => String(value ?? '').trim().toLowerCase()).filter(Boolean);
    const hasAndroidHint = Boolean(androidId)
        || androidHints.some(value => value.includes('android'))
        || deviceTypeHints.some(value => value.includes('android'));
    const hasEsp32Hint = deviceTypeHints
        .concat(firmwareHints)
        .some(value => value.includes('esp32') || value.includes('a7670') || value === 'firmware');
    let platform = explicitPlatform || null;

    if (!platform) {
        if (hasAndroidHint) {
            platform = 'android';
        } else if (imei || hasEsp32Hint || firmwareHints.length > 0) {
            platform = 'firmware';
        }
    }

    if (!model && !hasAndroidHint && (hasEsp32Hint || platform === 'firmware')) {
        model = 'ESP32';
    }

    const deviceName = firstText(
        status?.deviceName,
        status?.device_name,
        device?.deviceName,
        device?.device_name,
        [manufacturer, model].filter(Boolean).join(' ').trim()
    );

    return {
        manufacturer,
        brand,
        model,
        imei,
        androidId,
        deviceName,
        platform
    };
}

function normalizeBatteryLevel(status) {
    const battery = firstNumber(
        status?.battery,
        status?.batteryLevel,
        status?.battery_level,
        status?.system?.battery,
        status?.system?.batteryLevel,
        status?.system?.battery_level,
        status?.sensors?.batterySoc,
        status?.sensors?.battery_soc,
        status?.systemRuntime?.battery
    );
    if (battery === null) {
        return null;
    }

    const voltageMv = firstNumber(
        status?.voltageMv,
        status?.voltage_mV,
        status?.voltage,
        status?.system?.voltage_mV,
        status?.system?.voltageMv,
        status?.system?.voltage,
        status?.system?.batteryVoltage,
        status?.sensors?.batteryVoltage_mV,
        status?.sensors?.battery_voltage_mV
    );
    if (battery === 0 && voltageMv === null) {
        return null;
    }

    return clamp(Math.round(battery), 0, 100);
}

function normalizeChargingState(status) {
    const charging = firstBoolean(
        status?.charging,
        status?.chargingState,
        status?.chargeState,
        status?.system?.charging,
        status?.system?.chargingState,
        status?.system?.chargeState,
        status?.sensors?.charging,
        status?.systemRuntime?.charging
    );
    if (charging === null) {
        return null;
    }

    const battery = normalizeBatteryLevel(status);
    const voltageMv = firstNumber(
        status?.voltageMv,
        status?.voltage_mV,
        status?.voltage,
        status?.system?.voltage_mV,
        status?.system?.voltageMv,
        status?.system?.voltage,
        status?.system?.batteryVoltage,
        status?.sensors?.batteryVoltage_mV,
        status?.sensors?.battery_voltage_mV
    );
    if (battery === null && voltageMv === null) {
        return null;
    }

    return charging;
}

function normalizeTemperature(status) {
    const temperature = firstNumber(
        status?.temperature,
        status?.system?.temperature
    );
    if (temperature === null || temperature === 0) {
        return null;
    }

    return Math.round(temperature * 10) / 10;
}

function describeLink(name, percent, suffix = null) {
    const cleanName = normalizeText(name);
    const level = toNumberOrNull(percent);

    if (cleanName && level !== null) {
        return `${cleanName} - ${level}%${suffix ? ` - ${suffix}` : ''}`;
    }

    if (cleanName) {
        return suffix ? `${cleanName} - ${suffix}` : cleanName;
    }

    if (level !== null) {
        return suffix ? `${level}% - ${suffix}` : `${level}%`;
    }

    return suffix || 'Unknown';
}

function parseUptimeSeconds(uptime) {
    if (!uptime) {
        return 0;
    }

    const uptimeStr = String(uptime);
    const dMatch = uptimeStr.match(/(\d+)d/);
    const hMatch = uptimeStr.match(/(\d+)h/);
    const mMatch = uptimeStr.match(/(\d+)m/);
    const sMatch = uptimeStr.match(/^(\d+)s?$/);

    return (dMatch ? parseInt(dMatch[1], 10) * 86400 : 0)
        + (hMatch ? parseInt(hMatch[1], 10) * 3600 : 0)
        + (mMatch ? parseInt(mMatch[1], 10) * 60 : 0)
        + (sMatch && !dMatch && !hMatch && !mMatch ? parseInt(sMatch[1], 10) : 0);
}

function getSignalPresentation(status) {
    const activePath = String(status?.activePath || status?.active_path || status?.status?.active_path || '').trim().toLowerCase();
    const wifi = normalizeWifiSnapshot(status);
    const wifiIpAddress = firstText(wifi?.ipAddress, status?.wifi?.ipAddress, status?.wifi_ip_address, activePath === 'wifi' ? status?.ip : null);
    const wifiConnected = inferWifiConnected(wifi, activePath, wifiIpAddress);

    if (wifiConnected || activePath === 'wifi') {
        const wifiRssi = toNumberOrNull(wifi?.rssi);
        const wifiPercent = wifiRssiToPercent(wifiRssi);
        const ssid = wifi?.ssid || 'Wi-Fi';

        return {
            source: 'wifi',
            percent: wifiPercent,
            label: wifiPercent === null ? 'N/A' : `${wifiPercent}%`,
            meta: wifiRssi === null ? ssid : `${ssid} (${Math.round(wifiRssi)} dBm)`,
            raw: wifiRssi
        };
    }

    const rawSignal = firstNumber(
        status?.signal,
        status?.modem_signal,
        status?.cellularSignal,
        status?.mobile?.signalStrength,
        status?.modem?.signal,
        status?.status?.modem?.signal
    );
    const signalPercent = rawSignal === null ? null : clamp(Math.round(rawSignal), 0, 100);

    return {
        source: 'cellular',
        percent: signalPercent,
        label: signalPercent === null ? 'N/A' : `${signalPercent}%`,
        meta: status?.operator || status?.network || 'Cellular',
        raw: rawSignal
    };
}

function isPppPending(status) {
    const mqtt = normalizeMqttSnapshot(status);
    return String(mqtt?.lastErrorText || '').trim() === 'modem_data_ready_ppp_missing';
}

function describeWifiDisconnect(wifiSsid, wifiReason) {
    if (wifiReason === 'no_ap_found') {
        return describeLink(wifiSsid, null, '(no_ap_found)');
    }

    return wifiSsid
        ? describeLink(wifiSsid, null, wifiReason ? `disconnected (${wifiReason})` : 'disconnected')
        : 'Not connected';
}

function buildDashboardDeviceStatus(status, online) {
    const source = status || {};
    const freshness = resolveStatusFreshness(source, online);
    const isOnline = freshness.isOnline;
    const wifi = normalizeWifiSnapshot(source);
    const mqtt = normalizeMqttSnapshot(source);
    const deviceInfo = normalizeDeviceInfo(source);
    const sim = normalizeSimSnapshot(source);
    const simSlots = sim?.slots || normalizeSimSlots(source);
    const signal = getSignalPresentation(source);
    const battery = normalizeBatteryLevel(source);
    const wifiSsid = firstText(source?.wifiSsid, wifi?.ssid, source?.wifi_ssid);
    const operator = resolveOperatorLabel(
        source?.operator,
        source?.operatorName,
        source?.operator_name,
        source?.modem_operator_name,
        source?.modem_operator,
        source?.mobile?.operatorName,
        source?.mobile?.operator,
        sim?.operatorName,
        sim?.operator,
        source?.sim?.operatorName,
        source?.sim?.operator,
        source?.modem?.operator,
        source?.status?.modem?.operator,
        source?.status?.modem_operator_name,
        source?.status?.modem_operator
    );
    const simNumber = firstText(
        source?.simNumber,
        source?.sim_number,
        source?.subscriberNumber,
        source?.subscriber_number,
        source?.modem_subscriber_number,
        sim?.number,
        sim?.subscriberNumber,
        source?.sim?.number,
        source?.sim?.subscriberNumber,
        source?.mobile?.simNumber,
        source?.mobile?.subscriberNumber,
        source?.modem?.subscriberNumber,
        source?.status?.modem?.subscriberNumber,
        source?.status?.modem_subscriber_number,
        source?.status?.subscriber_number
    );
    const activePath = String(source?.activePath || source?.active_path || source?.status?.active_path || '').trim().toLowerCase() || null;
    const wifiIpAddress = firstText(wifi?.ipAddress, source?.wifi?.ipAddress, source?.wifi_ip_address, activePath === 'wifi' ? source?.ip : null);
    const imei = firstText(source?.imei, deviceInfo.imei);
    const wifiConnected = inferWifiConnected(wifi, activePath, wifiIpAddress);
    const wifiSignal = (wifiConnected || activePath === 'wifi')
        ? toNumberOrNull(source?.wifiSignal ?? wifiRssiToPercent(wifi?.rssi))
        : null;
    const cellularSignal = firstNumber(
        source?.cellularSignal,
        source?.signal,
        source?.modem_signal,
        source?.mobile?.signalStrength,
        source?.modem?.signal,
        source?.status?.modem?.signal
    );
    const wifiReason = normalizeText(wifi?.lastDisconnectReasonText);
    const pppPending = isPppPending(source);
    const wifiSecurity = normalizeWifiSecurityLabel(
        firstText(
            wifi?.security,
            source?.wifi_security,
            source?.wifiSecurity,
            source?.wifi_auth_mode,
            source?.wifi_authmode,
            source?.status?.wifi?.security
        )
    );
    const cellularNetworkType = normalizeCellularNetworkTypeLabel(
        firstText(
            source?.mobile?.networkType,
            source?.networkType,
            source?.status?.mobile?.networkType,
            source?.status?.networkType
        )
    );
    const cellularName = operator || source?.network || source?.mobile?.networkType || 'Cellular';
    const wifiSsidDisplay = wifiSsid || (wifiConnected ? 'SSID unavailable' : null);
    const wifiLinkName = wifiSecurity && wifiSsid ? `${wifiSsid} (${wifiSecurity})` : (wifiSsidDisplay || 'Wi-Fi');
    const cellularLinkName = cellularNetworkType ? `${cellularName} (${cellularNetworkType})` : cellularName;
    const storage = normalizeStorage(source);
    const wifiNeedsAttention = Boolean(wifiSsid)
        && !wifiConnected
        && activePath !== 'wifi'
        && (
            wifi?.configured
            || wifi?.started
            || wifi?.lastScanTargetVisible === false
            || wifiReason
        );
    const healthDegraded = firstBoolean(
        source?.healthDegraded,
        source?.health_degraded,
        source?.health?.degraded
    );
    const taskCount = firstNumber(
        source?.taskCount,
        source?.task_count,
        source?.tasks?.totalCount,
        source?.tasks?.taskCount
    );
    const missingTaskCount = firstNumber(
        source?.missingTaskCount,
        source?.missing_task_count,
        source?.tasks?.missingCount,
        source?.tasks?.missingTaskCount
    );
    const healthModuleCount = firstNumber(
        source?.healthModuleCount,
        source?.health_module_count,
        source?.health?.moduleCount
    );
    const degradedModuleCount = firstNumber(
        source?.degradedModuleCount,
        source?.degraded_module_count,
        source?.health?.degradedModuleCount,
        source?.health?.degradedCount
    );
    const failedModuleCount = firstNumber(
        source?.failedModuleCount,
        source?.failed_module_count,
        source?.health?.failedModuleCount,
        source?.health?.failedCount
    );
    const stubModuleCount = firstNumber(
        source?.stubModuleCount,
        source?.stub_module_count,
        source?.health?.stubModuleCount,
        source?.health?.stubCount
    );
    const healthLastReason = firstText(
        source?.healthLastReason,
        source?.health_last_reason,
        source?.health?.lastReason
    );
    const telephonySupported = firstBoolean(
        source?.telephonySupported,
        source?.telephony_supported,
        sim?.telephonySupported,
        source?.sim?.telephonySupported,
        source?.sim?.telephony_supported,
        source?.modem?.telephonySupported,
        source?.status?.modem?.telephonySupported
    );
    const telephonyEnabled = firstBoolean(
        source?.telephonyEnabled,
        source?.telephony_enabled,
        sim?.telephonyEnabled,
        source?.sim?.telephonyEnabled,
        source?.sim?.telephony_enabled,
        source?.modem?.telephonyEnabled,
        source?.status?.modem?.telephonyEnabled
    );
    const dataModeEnabled = firstBoolean(
        source?.dataModeEnabled,
        source?.data_mode_enabled,
        sim?.dataModeEnabled,
        source?.sim?.dataModeEnabled,
        source?.sim?.data_mode_enabled,
        source?.modem?.dataModeEnabled,
        source?.status?.modem?.dataModeEnabled,
        source?.status?.modem?.dataSession
    );
    const systemRuntime = source?.systemRuntime ? { ...source.systemRuntime } : null;
    const transport = source?.transport ? { ...source.transport } : null;
    const sync = source?.sync || source?.status?.sync || null;

    if (mqtt?.connected === true && mqtt?.subscribed !== false) {
        if (systemRuntime?.degradedReason === 'mqtt_not_connected') {
            systemRuntime.degradedReason = null;
        }
        if (transport?.reason === 'mqtt_not_connected') {
            transport.reason = null;
        }
    }

    if (!isOnline) {
        const offlineResult = {
            signal: null,
            signalLabel: 'N/A',
            signalMeta: freshness.summary,
            signalSource: null,
            wifiSignal: null,
            cellularSignal: null,
            battery: null,
            batteryLabel: 'N/A',
            voltageMv: null,
            charging: null,
            network: 'Offline',
            operator: null,
            simNumber: null,
            wifiSsid,
            wifiSsidDisplay,
            displayName: 'Offline',
            currentNetworkName: 'Offline',
            currentNetworkDetails: freshness.summary,
            wifiStatus: freshness.summary,
            wifiStatusLabel: resolveWifiStatusLabel(false, false, null),
            wifiRoleLabel: resolveWifiRoleLabel(false, null, false, wifiSsid),
            cellularStatus: freshness.summary,
            modemRoleLabel: resolveModemRoleLabel(false, null, false),
            networkLabel: 'Network',
            temperature: null,
            uptime: null,
            ip: 'N/A',
            online: false,
            imei,
            manufacturer: deviceInfo.manufacturer,
            brand: deviceInfo.brand,
            model: deviceInfo.model,
            deviceName: deviceInfo.deviceName,
            androidId: deviceInfo.androidId,
            platform: deviceInfo.platform,
            lastSeen: firstText(source?.lastSeen, source?.last_seen),
            firstSeen: firstText(source?.firstSeen, source?.first_seen),
            telephonySupported,
            telephonyEnabled,
            dataModeEnabled,
            wifi: wifi
                ? {
                    ...wifi,
                    connected: false,
                    ipAddress: '',
                    rssi: null
                }
                : null,
            activePath: 'offline',
            mqtt: mqtt
                ? {
                    ...mqtt,
                    connected: false,
                    subscribed: false
                }
                : null,
            sync,
            storage,
            systemRuntime,
            call: source?.call
                ? {
                    ...source.call,
                    active: false,
                    status: null,
                    number: null,
                    transportSuspended: true
                }
                : null,
            transport: transport
                ? {
                    ...transport,
                    voiceSessionActive: false,
                    mqttCommandAccepting: false,
                    reason: freshness.reason
                }
                : {
                    voiceSessionActive: false,
                    mqttCommandAccepting: false,
                    reason: freshness.reason
                },
            sim,
            simSlots,
            dualSim: Boolean(sim?.dualSim || simSlots.length >= 2),
            simSlotCount: Number(sim?.slotCount || simSlots.length || 0),
            activeSimSlotIndex: firstNumber(sim?.activeSlotIndex, sim?.selectedSlotIndex),
            queues: source?.queues || null,
            taskCount,
            missingTaskCount,
            healthDegraded,
            healthModuleCount,
            degradedModuleCount,
            failedModuleCount,
            stubModuleCount,
            healthLastReason,
            health: {
                degraded: healthDegraded,
                moduleCount: healthModuleCount,
                degradedModuleCount,
                failedModuleCount,
                stubModuleCount,
                lastReason: healthLastReason
            },
            tasks: {
                totalCount: taskCount,
                missingCount: missingTaskCount
            },
            statusFresh: false,
            statusAgeMs: freshness.ageMs,
            staleReason: freshness.reason
        };

        offlineResult.healthScore = computeHealthScore(offlineResult);
        return offlineResult;
    }

    const wifiStatus = wifiConnected
        ? describeLink(wifiLinkName, wifiSignal, wifiIpAddress ? `IP ${wifiIpAddress}` : null)
        : describeWifiDisconnect(wifiLinkName, wifiReason);

    let cellularStatus = 'Unavailable';
    if (sim?.registered || source?.modem_registered || operator || source?.ip || cellularSignal !== null) {
        const suffixParts = [];
        if (cellularSignal === null) {
            suffixParts.push('signal unavailable');
        }
        if (pppPending) {
            suffixParts.push('PPP pending');
        } else if (activePath === 'modem') {
            suffixParts.push('active');
        }

        cellularStatus = describeLink(
            cellularLinkName,
            cellularSignal,
            suffixParts.length ? suffixParts.join(' - ') : null
        );
    }

    let network = source?.network || 'No Service';
    let currentNetworkName = '-';
    let currentNetworkDetails = '-';
    let resolvedIp = firstText(
        source?.ip,
        source?.modem?.dataIp,
        source?.modem?.ipAddress,
        sim?.dataIp,
        source?.sim?.dataIp,
        source?.mobile?.ipAddress,
        wifi?.ipAddress,
        source?.wifi?.ipAddress
    ) || 'N/A';

    const modemActiveOrAvailable = activePath !== 'offline' && (
        activePath === 'modem'
        || sim?.registered
        || source?.modem_registered
        || operator
        || source?.ip
        || source?.mobile?.ipAddress
    );

    if (wifiConnected || activePath === 'wifi') {
        network = 'Wi-Fi';
        currentNetworkName = wifiSsidDisplay || 'Wi-Fi';
        currentNetworkDetails = wifiStatus;
        resolvedIp = wifiIpAddress || 'N/A';
    } else if (modemActiveOrAvailable) {
        network = pppPending ? 'Cellular standby' : 'Cellular';
        currentNetworkName = cellularName;
        currentNetworkDetails = cellularStatus;
        resolvedIp = firstText(
            source?.ip,
            source?.modem?.dataIp,
            source?.modem?.ipAddress,
            sim?.dataIp,
            source?.sim?.dataIp,
            source?.mobile?.ipAddress
        ) || 'N/A';
    } else if (wifiNeedsAttention) {
        network = 'Wi-Fi standby';
        currentNetworkName = wifiSsidDisplay || 'Wi-Fi';
        currentNetworkDetails = wifiStatus;
        resolvedIp = wifiIpAddress || 'N/A';
    }

    const result = {
        signal: signal.percent,
        signalLabel: signal.label,
        signalMeta: signal.meta,
        signalSource: signal.source,
        wifiSignal,
        cellularSignal,
        battery,
        batteryLabel: battery === null ? 'N/A' : `${battery}%`,
        voltageMv: firstNumber(
            source?.voltageMv,
            source?.voltage_mV,
            source?.system?.voltage_mV,
            source?.system?.voltageMv
        ),
        charging: normalizeChargingState(source),
        network,
        operator,
        simNumber,
        wifiSsid,
        wifiSsidDisplay,
        wifiSecurity,
        cellularNetworkType,
        activePathLabel: activePath === 'wifi'
            ? (wifiSecurity ? `Wi-Fi (${wifiSecurity})` : 'Wi-Fi')
            : (activePath === 'modem'
                ? (cellularNetworkType ? `Modem (${cellularNetworkType})` : 'Modem')
                : network),
        displayName: (signal.source === 'wifi' || activePath === 'wifi')
            ? (wifiSsidDisplay || operator || 'Wi-Fi')
            : (modemActiveOrAvailable
                ? (operator || cellularName || network || 'Cellular')
                : ((wifiNeedsAttention && wifiSsid) ? wifiSsid : (operator || network || 'Cellular'))),
        currentNetworkName,
        currentNetworkDetails,
        wifiStatus,
        wifiStatusLabel: resolveWifiStatusLabel(isOnline, wifiConnected, activePath),
        wifiRoleLabel: resolveWifiRoleLabel(isOnline, activePath, wifiConnected, wifiSsid),
        cellularStatus,
        modemRoleLabel: resolveModemRoleLabel(isOnline, activePath, modemActiveOrAvailable),
        networkLabel: operator ? 'Operator' : (signal.source === 'wifi' ? 'SSID' : 'Network'),
        temperature: normalizeTemperature(source),
        uptime: firstText(source?.uptime, source?.system?.uptime),
        ip: resolvedIp,
        online: isOnline,
        imei,
        manufacturer: deviceInfo.manufacturer,
        brand: deviceInfo.brand,
        model: deviceInfo.model,
        deviceName: deviceInfo.deviceName,
        androidId: deviceInfo.androidId,
        platform: deviceInfo.platform,
        lastSeen: firstText(source?.lastSeen, source?.last_seen),
        firstSeen: firstText(source?.firstSeen, source?.first_seen),
        telephonySupported,
        telephonyEnabled,
        dataModeEnabled,
        wifi: wifi
            ? {
                ...wifi,
                connected: wifiConnected,
                ipAddress: wifiIpAddress || wifi?.ipAddress || ''
            }
            : null,
        activePath,
        mqtt,
        sync,
        storage,
        systemRuntime,
        call: source?.call || null,
        transport,
        sim,
        simSlots,
        dualSim: Boolean(sim?.dualSim || simSlots.length >= 2),
        simSlotCount: Number(sim?.slotCount || simSlots.length || 0),
        activeSimSlotIndex: firstNumber(sim?.activeSlotIndex, sim?.selectedSlotIndex),
        queues: source?.queues || null,
        taskCount,
        missingTaskCount,
        healthDegraded,
        healthModuleCount,
        degradedModuleCount,
        failedModuleCount,
        stubModuleCount,
        healthLastReason,
        health: {
            degraded: healthDegraded,
            moduleCount: healthModuleCount,
            degradedModuleCount,
            failedModuleCount,
            stubModuleCount,
            lastReason: healthLastReason
        },
        tasks: {
            totalCount: taskCount,
            missingCount: missingTaskCount
        },
        statusFresh: true,
        statusAgeMs: freshness.ageMs,
        staleReason: null
    };

    result.healthScore = computeHealthScore(result);
    return result;
}

function computeHealthScore(deviceStatus) {
    if (!deviceStatus?.online) {
        return null;
    }

    let score = 0;
    let totalWeight = 0;

    // Signal: 20% weight when available (cellular signal can still be -1/unknown)
    if (deviceStatus.signal !== null && deviceStatus.signal !== undefined && deviceStatus.signal > 0) {
        score += deviceStatus.signal * 0.2;
        totalWeight += 0.2;
    }

    // Battery: 15% weight when available (some modem states may not report it)
    if (deviceStatus.battery !== null && deviceStatus.battery !== undefined && deviceStatus.battery > 0) {
        score += deviceStatus.battery * 0.15;
        totalWeight += 0.15;
    }

    // Uptime: 35% weight — device is healthy if it's been running stably
    const uptimeSeconds = parseUptimeSeconds(deviceStatus.uptime);
    if (uptimeSeconds > 0) {
        // Score ramps up over 24 hours, max at 7 days
        const uptimeScore = Math.min(100, Math.round((uptimeSeconds / 604800) * 100));
        if (uptimeScore > 0) {
            score += uptimeScore * 0.35;
            totalWeight += 0.35;
        }
    }

    // MQTT connection: 30% weight — device is healthy if connected to broker
    if (deviceStatus.mqtt?.connected) {
        score += 100 * 0.3;
        totalWeight += 0.3;
    }

    // If no data at all (shouldn't happen for online devices), return null
    if (totalWeight === 0) {
        return null;
    }

    return Math.round(score / totalWeight);
}

module.exports = {
    buildDashboardDeviceStatus,
    computeHealthScore,
    wifiRssiToPercent
};
