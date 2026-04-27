// Main JavaScript file for ESP32-S3 Manager Dashboard

// Socket.IO connection
let socket;
let connectionCheckInterval = null;
let deviceStatusInterval = null;
let deviceEnvelopeTimer = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 10;
const DEFAULT_STATUS_REFRESH_INTERVAL_MS = 60000;
const STATUS_REFRESH_COOLDOWN_MS = 3000;
const MQTT_DOWN_SETTINGS_REDIRECT_DELAY_MS = 15000;
let statusRefreshIntervalMs = DEFAULT_STATUS_REFRESH_INTERVAL_MS;
let latestDeviceStatus = null;
let latestQueueState = { dashboard: null, device: null };
let inflightStatusRefresh = null;
let lastStatusRefreshAt = 0;
let lastLiveDeviceStatusAt = 0;
let lastVisibilityRefreshAt = 0;
let dashboardSmsRefreshTimer = null;
let dashboardSmsPreviewToken = 0;
let dashboardSmsUnreadToken = 0;
let activeIncomingCallContext = null;
let mqttDownSettingsRedirectTimer = null;
let mqttDownSettingsRedirectStartedAt = 0;
let mqttDownSettingsRedirectCountdownTimer = null;
const TOAST_DEDUPE_WINDOW_MS = 2500;
const recentToastKeys = new Map();

function deviceWifiConnected() {
    if (latestDeviceStatus?.wifi?.connected === true) {
        return true;
    }

    if (String(latestDeviceStatus?.activePath || '').trim().toLowerCase() === 'wifi') {
        return true;
    }

    if (latestDeviceStatus?.wifi?.ipAssigned === true) {
        return true;
    }

    return Boolean(
        latestDeviceStatus?.wifi?.ipAddress
        || (String(latestDeviceStatus?.activePath || '').trim().toLowerCase() === 'wifi' ? latestDeviceStatus?.ip : null)
    );
}

function deviceOnline() {
    return inferStatusOnline(latestDeviceStatus);
}

function inferDeviceHttpOnline(status = latestDeviceStatus) {
    if (!status || !matchesActiveDeviceStatus(status)) {
        return false;
    }

    const activePath = String(status?.activePath || status?.active_path || '').trim().toLowerCase();
    const transportMode = String(
        status?.transport?.mode
        || status?.transport_mode
        || status?.bridge_transport
        || ''
    ).trim().toLowerCase();

    if (activePath !== 'http' && transportMode !== 'http') {
        return false;
    }

    return inferStatusOnline(status);
}

function hasActiveDeviceContext() {
    return Boolean(window.getActiveDeviceId ? window.getActiveDeviceId() : '');
}

function getStatusDeviceId(status) {
    return String(status?.deviceId || status?.device_id || '').trim();
}

function matchesActiveDeviceStatus(status) {
    const activeDeviceId = getStatusActiveDeviceId();
    if (!activeDeviceId) return false;
    const statusDeviceId = getStatusDeviceId(status);
    return !statusDeviceId || statusDeviceId === activeDeviceId;
}

function hasRecentStatusTimestamp(status) {
    const lastSeenMs = parseStatusTimestampMs(status?.lastSeen || status?.last_seen);
    const timestampMs = parseStatusTimestampMs(status?.timestamp);
    const freshestMs = Math.max(Number(lastSeenMs || 0), Number(timestampMs || 0));

    if (!freshestMs) {
        return false;
    }

    return (Date.now() - freshestMs) < Math.max(120000, statusRefreshIntervalMs * 2);
}

function inferLinkOnline(status) {
    const activePath = String(status?.activePath || status?.active_path || '').trim().toLowerCase();
    const wifi = status?.wifi || null;
    const wifiIpAddress = String(
        wifi?.ipAddress
        || status?.wifi_ip_address
        || ''
    ).trim();

    if (wifi?.connected === true || status?.wifi_connected === true) {
        return true;
    }

    if (activePath === 'wifi') {
        return true;
    }

    if (wifi?.ipAssigned === true || status?.wifi_ip_assigned === true) {
        return true;
    }

    if (wifiIpAddress) {
        return true;
    }

    return false;
}

function inferStatusOnline(status) {
    if (!status || !matchesActiveDeviceStatus(status)) {
        return false;
    }

    if (status.statusFresh === false || status.staleReason === 'no_recent_heartbeat') {
        return false;
    }

    if (status.online === true) {
        return true;
    }

    return Boolean(
        status?.mqtt?.connected === true
        || status?.mqtt_connected === true
        || status?.transport?.mqttCommandAccepting === true
        || status?.transport?.voiceSessionActive === true
        || (hasRecentStatusTimestamp(status) && inferLinkOnline(status))
        || String(status?.runtime_state || status?.service_state || '').trim().toLowerCase() === 'online'
    );
}

function normalizeStatusRefreshInterval(value) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return DEFAULT_STATUS_REFRESH_INTERVAL_MS;
    return Math.max(5000, Math.min(3600000, parsed));
}

function parseStatusTimestampMs(value) {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
}

function isDashboardVisible() {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function isDashboardHomePage() {
    const pathname = String(window.location?.pathname || '').trim().toLowerCase();
    return pathname === '/' || pathname === '/dashboard';
}

function isSystemSettingsPage() {
    const pathname = String(window.location?.pathname || '').trim().toLowerCase();
    return pathname === '/settings';
}

function shouldRedirectMQTTDownToSettings() {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return false;
    }
    if (isSystemSettingsPage()) {
        return false;
    }
    if (window._serverConnected === false) {
        return false;
    }
    return Boolean(document.getElementById('globalConnectionOverlay'));
}

function getMQTTSettingsRedirectUrl() {
    return '/settings?mqttDown=1#mqtt-broker';
}

function getMQTTDownRedirectSecondsRemaining() {
    if (!mqttDownSettingsRedirectStartedAt) {
        return Math.ceil(MQTT_DOWN_SETTINGS_REDIRECT_DELAY_MS / 1000);
    }
    const elapsed = Date.now() - mqttDownSettingsRedirectStartedAt;
    return Math.max(0, Math.ceil((MQTT_DOWN_SETTINGS_REDIRECT_DELAY_MS - elapsed) / 1000));
}

function cancelMQTTDownSettingsRedirect() {
    if (mqttDownSettingsRedirectTimer) {
        clearTimeout(mqttDownSettingsRedirectTimer);
        mqttDownSettingsRedirectTimer = null;
    }
    if (mqttDownSettingsRedirectCountdownTimer) {
        clearInterval(mqttDownSettingsRedirectCountdownTimer);
        mqttDownSettingsRedirectCountdownTimer = null;
    }
    mqttDownSettingsRedirectStartedAt = 0;
}

function scheduleMQTTDownSettingsRedirect() {
    if (mqttDownSettingsRedirectTimer || !shouldRedirectMQTTDownToSettings()) {
        return;
    }

    mqttDownSettingsRedirectStartedAt = Date.now();
    mqttDownSettingsRedirectTimer = setTimeout(() => {
        mqttDownSettingsRedirectTimer = null;
        if (mqttDownSettingsRedirectCountdownTimer) {
            clearInterval(mqttDownSettingsRedirectCountdownTimer);
            mqttDownSettingsRedirectCountdownTimer = null;
        }
        window.location.assign(getMQTTSettingsRedirectUrl());
    }, MQTT_DOWN_SETTINGS_REDIRECT_DELAY_MS);

    mqttDownSettingsRedirectCountdownTimer = setInterval(updateGlobalConnectionOverlay, 1000);
}

function isStatusPanelOpen() {
    const panel = document.getElementById('statusPanel');
    return Boolean(panel && panel.classList.contains('is-open'));
}

function isStatusDemandActive() {
    if (!hasActiveDeviceContext()) {
        return false;
    }

    return isDashboardHomePage() || isStatusPanelOpen();
}

function getLatestDeviceActivityAt() {
    return Math.max(
        Number(lastLiveDeviceStatusAt || 0),
        parseStatusTimestampMs(latestDeviceStatus?.lastSeen),
        parseStatusTimestampMs(latestDeviceStatus?.timestamp)
    );
}

function shouldRequestLiveDeviceRefresh(force = false) {
    if (force) {
        return true;
    }

    if (!isDashboardVisible() || !isStatusDemandActive()) {
        return false;
    }

    if (!socket || !socket.connected) {
        return true;
    }

    if (!latestDeviceStatus || !matchesActiveDeviceStatus(latestDeviceStatus)) {
        return true;
    }

    if (latestDeviceStatus.online === false) {
        return false;
    }
    if (latestDeviceStatus.statusFresh === false) {
        return true;
    }

    const latestActivityAt = getLatestDeviceActivityAt();
    if (!latestActivityAt) {
        return true;
    }

    return (Date.now() - latestActivityAt) >= Math.max(120000, statusRefreshIntervalMs * 2);
}

function emitStatusWatchState() {
    if (!socket || !socket.connected) {
        return false;
    }

    socket.emit('status-watch:visibility', {
        visible: isDashboardVisible(),
        active: isStatusDemandActive()
    });
    return true;
}

function syncDashboardStatusDemand(options = {}) {
    const { allowReconnect = false } = options;
    if (!emitStatusWatchState() || !isDashboardVisible()) {
        return;
    }

    const now = Date.now();
    const demandActive = isStatusDemandActive();
    const needsLiveRefresh = demandActive && shouldRequestLiveDeviceRefresh(false);
    const hasCurrentDeviceSnapshot = Boolean(
        latestDeviceStatus
        && matchesActiveDeviceStatus(latestDeviceStatus)
    );

    if (!demandActive && hasCurrentDeviceSnapshot) {
        return;
    }

    if (!needsLiveRefresh && (now - lastVisibilityRefreshAt) < Math.max(15000, Math.floor(statusRefreshIntervalMs / 2))) {
        return;
    }

    lastVisibilityRefreshAt = now;
    requestDashboardStatus({
        allowReconnect,
        force: needsLiveRefresh
    });
}

function applyDashboardRuntimeSettings(settings = {}) {
    const nextInterval = normalizeStatusRefreshInterval(settings.deviceStatusRefreshMs);
    const changed = nextInterval !== statusRefreshIntervalMs;
    statusRefreshIntervalMs = nextInterval;
    window.DASHBOARD_RUNTIME_SETTINGS = {
        ...(window.DASHBOARD_RUNTIME_SETTINGS || {}),
        ...settings,
        deviceStatusRefreshMs: nextInterval
    };
    if (settings.timezone && window.DashboardTime) {
        window.DashboardTime.setTimeZone(settings.timezone);
    }

    if (changed && connectionCheckInterval) {
        startConnectionMonitoring();
    }
}

function loadDashboardRuntimeSettings(force = false) {
    if (!force && window.DASHBOARD_RUNTIME_SETTINGS?.deviceStatusRefreshMs) {
        applyDashboardRuntimeSettings(window.DASHBOARD_RUNTIME_SETTINGS);
        return Promise.resolve(window.DASHBOARD_RUNTIME_SETTINGS);
    }

    return fetch('/api/settings/runtime', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        }
    })
        .then(response => response.json())
        .then(payload => {
            if (!payload?.success) throw new Error(payload?.message || 'Failed to load runtime settings');
            applyDashboardRuntimeSettings(payload.data || {});
            return payload.data || {};
        })
        .catch(() => {
            applyDashboardRuntimeSettings({ deviceStatusRefreshMs: DEFAULT_STATUS_REFRESH_INTERVAL_MS });
            return window.DASHBOARD_RUNTIME_SETTINGS;
        });
}

window.loadDashboardRuntimeSettings = loadDashboardRuntimeSettings;

function formatHeaderTimestamp(value) {
    if (!value) return null;
    try {
        return window.formatDashboardDateTime
            ? window.formatDashboardDateTime(value)
            : new Date(value).toLocaleString();
    } catch (_) {
        return null;
    }
}

function getStatusNetworkLabel(status) {
    return status?.activePathLabel || status?.network || '---';
}

function getStatusSignalIcon(status) {
    return (status?.signalSource === 'wifi' || status?.activePath === 'wifi') ? 'bi-wifi' : 'bi-broadcast';
}

function getSimNumberDisplayValue(status, fallback = 'Checking...') {
    const value = status?.simNumber
        || status?.sim_number
        || status?.subscriberNumber
        || status?.subscriber_number
        || status?.modem_subscriber_number
        || status?.sim?.number
        || status?.sim?.subscriberNumber
        || status?.sim?.msisdn
        || status?.mobile?.simNumber
        || status?.mobile?.subscriberNumber
        || status?.mobile?.number
        || status?.modem?.subscriberNumber
        || status?.status?.modem_subscriber_number
        || null;
    return value || fallback;
}

function getDeviceHardwareIdentity(status, fallback = 'Not reported by device') {
    const androidId = status?.androidId
        || status?.android_id
        || status?.device?.androidId
        || status?.device?.android_id
        || null;
    if (androidId) {
        return {
            label: 'Android ID',
            value: String(androidId).trim()
        };
    }

    const imei = status?.imei || status?.modem?.imei || status?.device?.imei || null;
    if (imei) {
        return {
            label: 'IMEI',
            value: String(imei).trim()
        };
    }

    const installId = status?.installId || status?.device?.installId || null;
    if (installId) {
        return {
            label: 'Install ID',
            value: String(installId).trim()
        };
    }

    return {
        label: 'Android ID / IMEI',
        value: fallback
    };
}

function formatDeviceHardwareIdLabel(status, fallback = 'Not reported by device') {
    const imei = status?.imei || status?.modem?.imei || status?.device?.imei || null;
    if (imei) {
        return `IMEI • ${imei}`;
    }

    const androidId = status?.androidId
        || status?.android_id
        || status?.device?.androidId
        || status?.device?.android_id
        || null;
    if (androidId) {
        return `Android ID • ${androidId}`;
    }

    const installId = status?.installId || status?.device?.installId || null;
    if (installId) {
        return `Install ID • ${installId}`;
    }

    return fallback;
}

function getActiveDeviceTypeLabel() {
    try {
        if (typeof window.getActiveDeviceType === 'function') {
            return window.getActiveDeviceType();
        }
        return window.ACTIVE_DEVICE_TYPE || localStorage.getItem('activeDeviceType') || '';
    } catch (_) {
        return window.ACTIVE_DEVICE_TYPE || '';
    }
}

function isEsp32LikeStatus(status = {}) {
    const tokens = [
        getActiveDeviceTypeLabel(),
        status?.type,
        status?.deviceType,
        status?.device_type,
        status?.board,
        status?.deviceBoard,
        status?.device_board,
        status?.chip,
        status?.platform,
        status?.model,
        status?.deviceModel,
        status?.device?.type,
        status?.device?.deviceType,
        status?.device?.device_type,
        status?.device?.board,
        status?.device?.chip,
        status?.device?.platform,
        status?.device?.model,
        getStatusActiveDeviceId()
    ].map(value => String(value ?? '').trim().toLowerCase()).filter(Boolean);

    if (tokens.some(token => token.includes('android'))) {
        return false;
    }

    return tokens.some(token => token.includes('esp32') || token.includes('a7670') || token === 'firmware');
}

function getDeviceModelDisplayLabel(status = {}, fallback = 'Not reported by device') {
    const manufacturer = String(status?.manufacturer || status?.deviceManufacturer || status?.device?.manufacturer || '').trim();
    const model = String(status?.model || status?.deviceModel || status?.device?.model || '').trim();
    if (model) {
        return [manufacturer, model].filter(Boolean).join(' ');
    }
    if (isEsp32LikeStatus(status)) {
        return 'ESP32';
    }
    const deviceName = String(status?.deviceName || status?.device_name || status?.device?.deviceName || status?.device?.device_name || '').trim();
    return manufacturer || deviceName || fallback;
}

function getStatusActiveDeviceId(fallback = '') {
    const value = (window.getActiveDeviceId ? window.getActiveDeviceId() : '')
        || window.DEVICE_ID
        || localStorage.getItem('activeDeviceId')
        || fallback
        || '';
    return String(value || '').trim();
}

function getSimContextStorageKey(deviceId = '') {
    const normalizedDeviceId = getStatusActiveDeviceId(deviceId);
    return normalizedDeviceId ? `activeDeviceSimSlot:${normalizedDeviceId}` : 'activeDeviceSimSlot';
}

function getRequestedSimSlotFromLocation() {
    try {
        const requested = new URLSearchParams(window.location.search).get('simSlot');
        const parsed = Number.parseInt(String(requested ?? '').trim(), 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    } catch (_) {
        return null;
    }
}

function normalizeDeviceSimSlots(status) {
    const slots = Array.isArray(status?.simSlots)
        ? status.simSlots
        : (Array.isArray(status?.sim_slots)
            ? status.sim_slots
            : (Array.isArray(status?.sim?.slots)
                ? status.sim.slots
                : (Array.isArray(status?.status?.sim?.slots) ? status.status.sim.slots : [])));

    return slots
        .map((slot, index) => {
            if (!slot || typeof slot !== 'object') return null;
            const slotIndex = Number.parseInt(String(
                slot.slotIndex
                ?? slot.slot_index
                ?? slot.simSlot
                ?? slot.sim_slot
                ?? index
            ), 10);
            return {
                ...slot,
                slotIndex: Number.isFinite(slotIndex) ? slotIndex : index,
                displayName: String(
                    slot.displayName
                    || slot.display_name
                    || slot.carrierName
                    || slot.carrier_name
                    || slot.operatorName
                    || slot.operator
                    || `SIM ${index + 1}`
                ).trim(),
                operatorName: String(slot.operatorName || slot.operator || slot.carrierName || slot.carrier_name || '').trim(),
                number: String(
                    slot.number
                    || slot.subscriberNumber
                    || slot.subscriber_number
                    || slot.msisdn
                    || slot.phoneNumber
                    || slot.phone_number
                    || ''
                ).trim(),
                networkType: String(slot.networkType || slot.network_type || '').trim(),
                signalAsu: Number.isFinite(Number(slot.signalAsu ?? slot.signal_asu ?? slot.signalStrength ?? slot.signal_strength))
                    ? Number(slot.signalAsu ?? slot.signal_asu ?? slot.signalStrength ?? slot.signal_strength)
                    : null,
                smsPreferred: slot.smsPreferred === true || slot.sms_preferred === true,
                dataPreferred: slot.dataPreferred === true || slot.data_preferred === true,
                ready: slot.ready === true || slot.simReady === true || slot.sim_ready === true,
                registered: slot.registered === true || slot.modemRegistered === true || slot.modem_registered === true
            };
        })
        .filter(Boolean);
}

function getStoredActiveSimSlot(deviceId = '') {
    const raw = localStorage.getItem(getSimContextStorageKey(deviceId));
    const parsed = Number.parseInt(String(raw || ''), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function setStoredActiveSimSlot(slotIndex, deviceId = '') {
    const key = getSimContextStorageKey(deviceId);
    const numericSlot = Number.parseInt(String(slotIndex ?? ''), 10);
    if (Number.isFinite(numericSlot) && numericSlot >= 0) {
        localStorage.setItem(key, String(numericSlot));
        return numericSlot;
    }
    localStorage.removeItem(key);
    return null;
}

function getSelectedSimSlotSnapshot(status = latestDeviceStatus) {
    const slots = normalizeDeviceSimSlots(status);
    if (!slots.length) return null;

    const requestedSlot = getRequestedSimSlotFromLocation();
    const storedSlot = getStoredActiveSimSlot(status?.deviceId || status?.device_id || '');
    const explicitActiveSlot = Number.parseInt(String(
        status?.activeSimSlotIndex
        ?? status?.sim?.activeSlotIndex
        ?? status?.sim?.selectedSlotIndex
        ?? status?.sim_active_slot
        ?? ''
    ), 10);

    return slots.find((slot) => requestedSlot !== null && slot.slotIndex === requestedSlot)
        || slots.find((slot) => slot.slotIndex === storedSlot)
        || slots.find((slot) => slot.slotIndex === explicitActiveSlot)
        || slots.find((slot) => slot.smsPreferred)
        || slots.find((slot) => slot.dataPreferred)
        || slots[0]
        || null;
}

function resolveActiveDeviceSimContext(status = latestDeviceStatus) {
    const selectedSim = getSelectedSimSlotSnapshot(status);
    const deviceId = getStatusActiveDeviceId();
    const storedSlot = getStoredActiveSimSlot(status?.deviceId || status?.device_id || deviceId || '');
    return {
        deviceId,
        simSlot: selectedSim?.slotIndex ?? getRequestedSimSlotFromLocation() ?? storedSlot
    };
}

function formatSimSelectorLabel(slot) {
    if (!slot) return 'Primary SIM';
    const parts = [];
    const carrier = String(
        slot.operatorName
        || slot.operator
        || slot.carrierName
        || slot.carrier_name
        || slot.displayName
        || slot.display_name
        || ''
    ).trim();
    const number = String(
        slot.number
        || slot.simNumber
        || slot.subscriberNumber
        || slot.subscriber_number
        || slot.msisdn
        || slot.phoneNumber
        || slot.phone_number
        || ''
    ).trim();
    if (carrier) parts.push(carrier);
    if (number) parts.push(number);
    if (!parts.length) parts.push(`SIM ${Number(slot.slotIndex || 0) + 1}`);
    return parts.join(' • ');
}

function updateSidebarSimSelector(status = latestDeviceStatus) {
    const wrap = document.getElementById('sidebarSimSelectorWrap');
    const selector = document.getElementById('sidebarSimSelector');
    if (!wrap || !selector) return;

    const slots = normalizeDeviceSimSlots(status);
    if (slots.length < 2) {
        hideElement(wrap);
        selector.innerHTML = '<option value="">Primary SIM</option>';
        syncSidebarDeviceAwareLinks();
        return;
    }

    const currentSlot = getSelectedSimSlotSnapshot(status) || slots[0];
    selector.innerHTML = slots.map((slot) => `
        <option value="${escapeHtml(String(slot.slotIndex))}">
            ${escapeHtml(formatSimSelectorLabel(slot))}
        </option>
    `).join('');
    selector.value = String(currentSlot?.slotIndex ?? slots[0].slotIndex);
    setStoredActiveSimSlot(selector.value, status?.deviceId || status?.device_id || '');
    showElement(wrap, 'block');
    syncSidebarDeviceAwareLinks();
}

function isActiveDevicePayload(payload) {
    const activeDeviceId = getStatusActiveDeviceId();
    const payloadDeviceId = String(payload?.deviceId || payload?.device_id || '').trim();
    return !activeDeviceId || !payloadDeviceId || payloadDeviceId === activeDeviceId;
}

function getLastDeviceStatusCacheKey(deviceId = '') {
    const normalizedDeviceId = getStatusActiveDeviceId(deviceId);
    return normalizedDeviceId ? `lastDeviceStatus:${normalizedDeviceId}` : 'lastDeviceStatus';
}

function saveLastDeviceStatusCache(status) {
    const deviceId = String(status?.deviceId || status?.device_id || getStatusActiveDeviceId() || '').trim();
    if (!deviceId) return;
    localStorage.setItem(getLastDeviceStatusCacheKey(deviceId), JSON.stringify({
        ...status,
        deviceId,
        _cachedAt: new Date().toISOString()
    }));
    localStorage.removeItem('lastDeviceStatus');
}

function removeLastDeviceStatusCache(deviceId = '') {
    localStorage.removeItem(getLastDeviceStatusCacheKey(deviceId));
    localStorage.removeItem('lastDeviceStatus');
}

window.getLastDeviceStatusCacheKey = getLastDeviceStatusCacheKey;

function maybeAutoDetectSimNumber(status) {
    // SIM/USSD is a foreground runtime operation; do not auto-dispatch it from
    // passive dashboard refreshes because it can block unrelated device actions.
    return;
    if (!status?.online) return;
    if (getSimNumberDisplayValue(status, '') !== '') return;
    const deviceId = String(status?.deviceId || status?.device_id || window.getActiveDeviceId?.() || '').trim();
    const operator = String(status?.operator || status?.sim?.operatorName || status?.sim?.operator || status?.mobile?.operatorName || status?.mobile?.operator || '').trim();
    if (!deviceId || !operator) return;

    const key = `sim-auto-detect:${deviceId}`;
    const lastAttempt = Number(sessionStorage.getItem(key) || 0);
    if (Number.isFinite(lastAttempt) && Date.now() - lastAttempt < 10 * 60 * 1000) return;

    sessionStorage.setItem(key, String(Date.now()));
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
    const headers = csrfToken ? { 'X-CSRF-Token': csrfToken } : {};
    fetch(`/api/quick/sim-number?deviceId=${encodeURIComponent(deviceId)}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers
    }).catch(() => {});
}

function buildOfflineDeviceSnapshot(status = latestDeviceStatus, lastSeen = null) {
    const wifi = status?.wifi || null;
    const mqtt = status?.mqtt || null;
    const call = status?.call || null;
    const transport = status?.transport || null;
    const offlineSeenAt = lastSeen || status?.lastSeen || new Date().toISOString();

    return {
        ...(status || {}),
        online: false,
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
        currentNetworkName: 'Offline',
        currentNetworkDetails: 'No recent heartbeat',
        wifiStatus: 'No recent heartbeat',
        cellularStatus: 'No recent heartbeat',
        ip: 'N/A',
        temperature: null,
        uptime: null,
        activePath: 'offline',
        wifi: wifi
            ? {
                ...wifi,
                connected: false,
                ipAddress: '',
                rssi: null
            }
            : null,
        mqtt: mqtt
            ? {
                ...mqtt,
                connected: false,
                subscribed: false
            }
            : null,
        call: call
            ? {
                ...call,
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
                reason: 'no_recent_heartbeat'
            }
            : {
                voiceSessionActive: false,
                mqttCommandAccepting: false,
                reason: 'no_recent_heartbeat'
            },
        statusFresh: false,
        staleReason: 'no_recent_heartbeat',
        lastSeen: offlineSeenAt
    };
}

function summarizeHeaderQueue(queueState) {
    const dashboardSummary = queueState?.dashboard?.summary || {};
    const dashboardDomains = queueState?.dashboard?.domains || {};
    const dashboardRuntime = queueState?.dashboard?.runtime || {};
    const deviceQueue = queueState?.device || {};
    const openCount = Number(dashboardSummary.pending || 0)
        + Number(dashboardSummary.active || 0)
        + Number(dashboardSummary.failed || 0)
        + Number(dashboardSummary.ambiguous || 0)
        + Number(deviceQueue.total || 0);
    const telephonyOpen = Number(dashboardDomains.telephony?.totalOpen || 0);
    const statusOpen = Number(dashboardDomains.status?.totalOpen || 0);
    const storageOpen = Number(dashboardDomains.storage?.totalOpen || 0);

    if (openCount <= 0) {
        if (dashboardRuntime.busy) {
            return 'Queue busy';
        }
        return 'Queue idle';
    }

    if (telephonyOpen > 0) {
        return `SMS/call ${telephonyOpen} open`;
    }
    if (storageOpen > 0) {
        return `Storage ${storageOpen} open`;
    }
    if (statusOpen > 0 && statusOpen === openCount) {
        return 'Status refresh active';
    }

    return `Queue ${openCount} open`;
}

function updateHeaderDeviceSummary(status = latestDeviceStatus, queueState = latestQueueState) {
    const headerId = document.getElementById('headerDeviceId');
    const headerBadge = document.getElementById('headerDeviceBadge');
    const headerMeta = document.getElementById('headerDeviceMeta');
    const headerHealth = document.getElementById('headerDeviceHealth');
    const headerQueue = document.getElementById('headerDeviceQueue');

    if (!headerId || !headerBadge || !headerMeta || !headerHealth || !headerQueue) return;

    const activeDeviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';
    const hasDevice = Boolean(activeDeviceId);

    headerId.textContent = hasDevice ? activeDeviceId : 'No device selected';
    headerQueue.textContent = summarizeHeaderQueue(queueState);
    headerQueue.title = headerQueue.textContent;

    if (!hasDevice) {
        headerBadge.className = 'badge rounded-pill text-bg-secondary';
        headerBadge.textContent = 'No device';
        headerMeta.textContent = 'Pick a device from the sidebar to see live status.';
        headerHealth.textContent = 'Health --';
        headerHealth.title = '';
        return;
    }

    const online = inferStatusOnline(status);
    const rawMissingTaskCount = Number(status?.missingTaskCount);
    const missingTaskCount = Number.isFinite(rawMissingTaskCount) && rawMissingTaskCount > 0
        ? rawMissingTaskCount
        : 0;
    const healthDegraded = status?.healthDegraded === true;
    const healthReason = String(status?.healthLastReason || '').trim().replace(/_/g, ' ');
    headerBadge.className = `badge rounded-pill ${online ? 'text-bg-success' : 'text-bg-secondary'}`;
    headerBadge.textContent = online ? 'Online' : 'Offline';

    const primaryLabel = status?.currentNetworkName || status?.displayName || status?.operator || status?.network || 'Waiting for telemetry';
    const secondaryLabel = status?.currentNetworkDetails || status?.ip || status?.imei || null;
    const seenAt = formatHeaderTimestamp(status?.lastSeen);

    if (online) {
        headerMeta.textContent = secondaryLabel ? `${primaryLabel} - ${secondaryLabel}` : primaryLabel;
    } else if (seenAt) {
        headerMeta.textContent = `${primaryLabel} - last seen ${seenAt}`;
    } else {
        headerMeta.textContent = `${primaryLabel} - awaiting live data`;
    }

    const healthHints = [];
    if (typeof status?.healthScore === 'number') {
        healthHints.push(`Score ${status.healthScore}%`);
    }
    if (healthDegraded) {
        healthHints.push('Degraded');
    }
    if (missingTaskCount > 0) {
        healthHints.push(`${missingTaskCount} task${missingTaskCount === 1 ? '' : 's'} missing`);
    }
    if (healthReason) {
        healthHints.push(`Reason: ${healthReason}`);
    }
    headerHealth.title = healthHints.join(' - ');

    if (healthDegraded) {
        headerHealth.textContent = typeof status?.healthScore === 'number'
            ? `Degraded ${status.healthScore}%`
            : 'Health degraded';
    } else if (missingTaskCount > 0) {
        headerHealth.textContent = `Tasks ${missingTaskCount}`;
    } else if (typeof status?.healthScore === 'number') {
        headerHealth.textContent = `Health ${status.healthScore}%`;
    } else {
        headerHealth.textContent = online ? 'Health pending' : 'Health offline';
    }
}

function updateGlobalConnectionOverlay() {
    const overlay = document.getElementById('globalConnectionOverlay');
    const title = document.getElementById('globalConnectionOverlayTitle');
    const message = document.getElementById('globalConnectionOverlayMessage');
    if (!overlay || !title || !message) return;

    let show = false;
    let nextTitle = 'Reconnecting...';
    let nextMessage = 'Trying to restore dashboard connectivity.';

    if (window._serverConnected === false) {
        show = true;
        nextTitle = 'Dashboard Socket Down';
        nextMessage = 'Trying to reconnect to the dashboard server/socket. Actions are paused until it is back.';
    } else if (window._serverConnected !== false && window._mqttConnected === false) {
        show = true;
        const mqttDetail = window._mqttStatus?.lastError ? ` Reason: ${window._mqttStatus.lastError}.` : '';
        nextTitle = window._mqttStatus?.reconnecting ? 'Dashboard MQTT Reconnecting' : 'Dashboard MQTT Down';
        nextMessage = `Dashboard MQTT broker connection is down.${mqttDetail} Live device actions may queue until dashboard MQTT is restored.`;
        if (mqttDownSettingsRedirectTimer) {
            nextMessage += ` Opening System Settings in ${getMQTTDownRedirectSecondsRemaining()} seconds so you can change MQTT settings.`;
        }
    }

    title.textContent = nextTitle;
    message.textContent = nextMessage;
    if (show) showElement(overlay, 'flex');
    else hideElement(overlay);
}

function updateWifiRequirementBanners() {
    const wifiOk = deviceWifiConnected();
    document.querySelectorAll('[data-wifi-required-banner="true"]').forEach((el) => {
        if (wifiOk) hideElement(el);
        else showElement(el, 'flex');
    });
}

function updateActionAvailability() {
    const hasActiveDevice = hasActiveDeviceContext();
    const online = deviceOnline();
    const wifiOk = deviceWifiConnected();
    const serverOk = window._serverConnected !== false;
    const mqttOk = window._mqttConnected !== false;

    document.querySelectorAll('[data-action-requires-online], [data-action-requires-wifi], [data-action-requires-mqtt]').forEach((el) => {
        const needsOnline = el.getAttribute('data-action-requires-online') === 'true';
        const needsWifi = el.getAttribute('data-action-requires-wifi') === 'true';
        const needsMqtt = el.getAttribute('data-action-requires-mqtt') === 'true';

        let disabled = false;
        let reason = '';

        if (!hasActiveDevice) {
            disabled = true;
            reason = 'Onboard or select a device first.';
        } else if (!serverOk) {
            disabled = true;
            reason = 'Unavailable while the dashboard socket/server reconnects.';
        } else if (needsMqtt && !mqttOk) {
            disabled = true;
            reason = 'Unavailable while dashboard MQTT reconnects.';
        } else if (needsOnline && !online) {
            disabled = true;
            reason = 'Device must be online for this action.';
        } else if (needsWifi && !wifiOk) {
            disabled = true;
            reason = 'This action requires the device to be connected to local Wi-Fi.';
        }

        if (!el.dataset.actionDefaultTitle) {
            el.dataset.actionDefaultTitle = el.getAttribute('title') || '';
        }

        if ('disabled' in el) {
            el.disabled = disabled;
        }
        el.classList.toggle('disabled', disabled);
        if (el.tagName === 'A') {
            el.style.pointerEvents = disabled ? 'none' : '';
            el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
        }
        el.setAttribute('title', disabled ? reason : (el.dataset.actionDefaultTitle || ''));
    });
}

function showElement(el, displayValue) {
    if (!el) return;
    el.classList.remove('app-hidden');
    if (displayValue) {
        el.style.display = displayValue;
    } else {
        el.style.removeProperty('display');
    }
}

function hideElement(el) {
    if (!el) return;
    el.classList.add('app-hidden');
    el.style.removeProperty('display');
}

function setProgressWidth(el, value) {
    if (!el) return;
    const width = Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;
    el.style.width = `${width}%`;
}

function initializeProgressWidths(root = document) {
    root.querySelectorAll('[data-progress-width]').forEach((el) => {
        setProgressWidth(el, el.getAttribute('data-progress-width'));
    });
}

function requestDashboardStatus(options = {}) {
    const {
        allowReconnect = true,
        force = false,
        includeServerStatus = true,
        includeMqttStatus = true,
        includeDeviceStatus = true
    } = options;

    const now = Date.now();
    if (!force) {
        if (inflightStatusRefresh) {
            return inflightStatusRefresh;
        }
        if ((now - lastStatusRefreshAt) < STATUS_REFRESH_COOLDOWN_MS) {
            return Promise.resolve(false);
        }
    }

    lastStatusRefreshAt = now;

    const refreshPromise = (async () => {
        if (socket && !socket.connected && allowReconnect) {
            socket.connect();
        }

        if (socket && socket.connected) {
            if (includeServerStatus) {
                socket.emit('get:status');
            }
            if (includeMqttStatus) {
                socket.emit('get:mqtt-status');
            }
        }

        if (!hasActiveDeviceContext() || !includeDeviceStatus) {
            updateSidebarDeviceStatus({ deviceId: '', online: false });
            return true;
        }

        await refreshDeviceEnvelope({
            liveRefresh: shouldRequestLiveDeviceRefresh(force)
        });
        return true;
    })().catch(() => false).finally(() => {
        if (inflightStatusRefresh === refreshPromise) {
            inflightStatusRefresh = null;
        }
    });

    inflightStatusRefresh = refreshPromise;
    return refreshPromise;
}

function formatSmsTimestamp(value) {
    if (!value) return '';
    try {
        return window.formatDashboardDateTime
            ? window.formatDashboardDateTime(value)
            : new Date(value).toLocaleString();
    } catch (_) {
        return '';
    }
}

function getDashboardSmsDeviceId() {
    const activeDeviceId = window.getActiveDeviceId
        ? window.getActiveDeviceId()
        : (window.DEVICE_ID || localStorage.getItem('activeDeviceId') || '');
    return String(activeDeviceId || '').trim();
}

function getDashboardSmsActiveSimSlot() {
    return typeof window.getActiveDeviceSimSlot === 'function'
        ? window.getActiveDeviceSimSlot()
        : null;
}

function isDashboardSmsScopeSnapshotCurrent(snapshot = {}) {
    return String(snapshot.deviceId || '') === getDashboardSmsDeviceId()
        && Number(snapshot.simSlot ?? -1) === Number(getDashboardSmsActiveSimSlot() ?? -1);
}

function buildDashboardSmsRequestUrl(url, fresh = false) {
    const requestUrl = new URL(url, window.location.origin);
    const activeDeviceId = getDashboardSmsDeviceId();
    const activeSimSlot = getDashboardSmsActiveSimSlot();
    if (activeDeviceId && requestUrl.pathname.startsWith('/api/sms') && !requestUrl.searchParams.has('deviceId')) {
        requestUrl.searchParams.set('deviceId', activeDeviceId);
    }
    if (activeSimSlot !== null && activeSimSlot !== undefined && requestUrl.pathname.startsWith('/api/sms') && !requestUrl.searchParams.has('simSlot')) {
        requestUrl.searchParams.set('simSlot', String(activeSimSlot));
    }
    if (fresh && !requestUrl.searchParams.has('_ts')) {
        requestUrl.searchParams.set('_ts', String(Date.now()));
    }

    return `${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`;
}

function scheduleDashboardSmsRefresh(delayMs = 400) {
    clearTimeout(dashboardSmsRefreshTimer);
    dashboardSmsRefreshTimer = setTimeout(() => {
        refreshDashboardSmsPreview();
    }, delayMs);
}

function getDashboardConversationNumber(thread = {}) {
    return String(thread.primary_number || thread.thread_number || '').trim();
}

function getDashboardConversationTitle(thread = {}) {
    const number = getDashboardConversationNumber(thread);
    return String(thread.title || thread.display_from || number || 'Conversation').trim();
}

function getDashboardConversationPreview(thread = {}) {
    return String(thread.last_message_preview || thread.message || 'No messages yet');
}

function getDashboardConversationTimestamp(thread = {}) {
    return thread.last_message_at || thread.timestamp || '';
}

function getDashboardConversationDirection(thread = {}) {
    return String(thread.last_message_direction || thread.last_direction || '').trim().toLowerCase();
}

function getDashboardConversationTotal(thread = {}) {
    return Number(thread.message_count ?? thread.total_count ?? 0) || 0;
}

function buildDashboardConversationHref(thread = {}) {
    const params = new URLSearchParams();
    const deviceId = getDashboardSmsDeviceId();
    const number = getDashboardConversationNumber(thread);
    const conversationId = Math.max(0, Number(thread.conversation_id ?? thread.conversationId) || 0);
    const title = getDashboardConversationTitle(thread);

    if (deviceId) params.set('device', deviceId);
    if (number) params.set('thread', number);
    if (conversationId) params.set('conversation', String(conversationId));
    if (title) params.set('title', title);

    const query = params.toString();
    return `/sms${query ? `?${query}` : ''}`;
}

function renderDashboardConversationPreviewRows(conversations) {
    const rows = (Array.isArray(conversations) ? conversations : []).slice(0, 3);
    if (!rows.length) {
        return `
            <div class="text-center py-5">
                <i class="bi bi-inbox fs-1 text-muted"></i>
                <p class="text-muted mt-3 mb-0">No recent conversations</p>
            </div>
        `;
    }

    const rowMarkup = rows.map((thread) => {
        const number = getDashboardConversationNumber(thread);
        const title = getDashboardConversationTitle(thread);
        const href = buildDashboardConversationHref(thread);
        const unreadCount = Number(thread.unread_count || 0);
        const direction = getDashboardConversationDirection(thread);
        const timestamp = getDashboardConversationTimestamp(thread);
        const preview = getDashboardConversationPreview(thread);
        const total = getDashboardConversationTotal(thread);
        const badge = unreadCount > 0
            ? `<span class="badge bg-danger ms-2">${unreadCount} new</span>`
            : (direction === 'outgoing' ? '<span class="badge bg-secondary ms-2">Sent</span>' : '');
        const numberMeta = number ? ` &middot; ${escapeHtml(number)}` : '';

        return `
            <a href="${escapeHtml(href)}" data-device-aware-href="${escapeHtml(href)}" class="list-group-item list-group-item-action p-3 text-decoration-none text-reset">
                <div class="d-flex gap-3">
                    <div class="flex-shrink-0">
                        <div class="bg-light rounded-circle p-2">
                            <i class="bi bi-chat-square-text fs-5"></i>
                        </div>
                    </div>
                    <div class="flex-grow-1">
                        <div class="d-flex flex-column flex-sm-row justify-content-between align-items-start gap-2">
                            <h6 class="mb-0">${escapeHtml(title)}${badge}</h6>
                            <small class="text-muted">${escapeHtml(formatSmsTimestamp(timestamp) || 'No activity')}</small>
                        </div>
                        <p class="mb-0 mt-1 text-truncate">${escapeHtml(preview)}</p>
                        <div class="small text-muted mt-1">${total} messages${numberMeta}</div>
                    </div>
                </div>
            </a>
        `;
    }).join('');

    return `<div class="list-group list-group-flush">${rowMarkup}</div>`;
}

function refreshDashboardSmsPreview() {
    const container = document.getElementById('dashboardRecentSmsBody');
    if (!container) return;
    const requestScope = {
        deviceId: getDashboardSmsDeviceId(),
        simSlot: getDashboardSmsActiveSimSlot()
    };
    const requestToken = ++dashboardSmsPreviewToken;

    fetch(buildDashboardSmsRequestUrl('/api/sms/conversations?limit=3', true), {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        }
    })
        .then(response => response.ok ? response.json() : null)
        .then(payload => {
            if (requestToken !== dashboardSmsPreviewToken || !isDashboardSmsScopeSnapshotCurrent(requestScope)) return;
            if (!payload?.success) return;
            container.innerHTML = renderDashboardConversationPreviewRows(payload.data);
        })
        .catch(() => {});
}

window.toggleStatusPanel = function toggleStatusPanel() {
    const panel = document.getElementById('statusPanel');
    if (!panel) return;
    const isVisible = panel.classList.contains('is-open');
    panel.classList.toggle('is-open', !isVisible);
    syncDashboardStatusDemand({ allowReconnect: false });
    if (!isVisible) {
        requestDashboardStatus({ force: true });
        setTimeout(() => {
            document.addEventListener('click', function closePanel(e) {
                const pill = document.getElementById('statusPill');
                const statusPanel = document.getElementById('statusPanel');
                if (statusPanel && pill && !pill.contains(e.target) && !statusPanel.contains(e.target)) {
                    statusPanel.classList.remove('is-open');
                    syncDashboardStatusDemand({ allowReconnect: false });
                    document.removeEventListener('click', closePanel);
                }
            });
        }, 10);
    }
};

function formatIncomingCallNumber(number) {
    const raw = String(number || '').trim();
    const cleaned = raw.replace(/\D/g, '');
    if (cleaned.length === 13 && cleaned.startsWith('88')) {
        return `+${cleaned.slice(0, 2)} ${cleaned.slice(2, 5)} ${cleaned.slice(5, 8)} ${cleaned.slice(8)}`;
    }
    if (cleaned.length === 11 && cleaned.startsWith('0')) {
        return `+88 ${cleaned.slice(1, 4)} ${cleaned.slice(4, 7)} ${cleaned.slice(7)}`;
    }
    if (cleaned.length === 10) {
        return `+88 ${cleaned.slice(0, 3)} ${cleaned.slice(3, 6)} ${cleaned.slice(6)}`;
    }
    return raw || 'Unknown';
}

function getIncomingCallPanelStateElements() {
    return {
        panel: document.getElementById('incomingCallPanel'),
        number: document.getElementById('incomingCallNumber'),
        time: document.getElementById('incomingCallTime'),
        answerBtn: document.getElementById('incomingCallAnswerBtn'),
        rejectBtn: document.getElementById('incomingCallRejectBtn')
    };
}

function setIncomingCallActionState(isBusy) {
    const { answerBtn, rejectBtn } = getIncomingCallPanelStateElements();
    if (answerBtn) answerBtn.disabled = Boolean(isBusy);
    if (rejectBtn) rejectBtn.disabled = Boolean(isBusy);
}

function showIncomingCallPanel(displayNumber, timeLabel) {
    const { panel, number, time } = getIncomingCallPanelStateElements();
    if (!panel) {
        showToast(`Incoming call from ${displayNumber}`, 'warning');
        return;
    }

    if (number) number.textContent = displayNumber || 'Unknown';
    if (time) time.textContent = timeLabel || new Date().toLocaleTimeString();
    setIncomingCallActionState(false);
    panel.classList.remove('d-none');
}

function hideIncomingCallPanel() {
    const { panel } = getIncomingCallPanelStateElements();
    if (!panel) return;
    panel.classList.add('d-none');
    setIncomingCallActionState(false);
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    initializeProgressWidths();
    updateWifiRequirementBanners();
    updateActionAvailability();
    bindStatusPanelLinks();
    bindDeviceAwareLinks();
    syncStatusPanelColumns();

    // Initialize Socket.IO
    initializeSocket();
    
    // Initialize Bootstrap components
    initializeBootstrap();
    
    // Setup event listeners
    setupEventListeners();
    
    // Start connection monitoring after loading the centralized refresh interval.
    loadDashboardRuntimeSettings().finally(() => startConnectionMonitoring());
    
    // Check unread messages
    updateUnreadBadge();
    refreshDashboardSmsPreview();
    
    // Handle orientation change
    window.addEventListener('orientationchange', function() {
        setTimeout(handleOrientationChange, 100);
    });
    
    // Handle resize
    let resizeTimer;
    window.addEventListener('resize', function() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(handleResize, 250);
    });
});

// Initialize Socket.IO
function initializeSocket() {
    // Show connecting state
    updateConnectionStatus('connecting');

    if (typeof io !== 'function') {
        console.error('Socket.IO client is not available');
        updateConnectionStatus('server_disconnected');
        window.socket = null;
        return;
    }
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    
    socket = io({
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: maxReconnectAttempts,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000,
        autoConnect: true
    });
    window.socket = socket;

    socket.on('connect', async function() {
        console.log('Socket connected');
        reconnectAttempts = 0;
        updateConnectionStatus('server_connected');
        
        // Subscribe to the current device's room
        const activeDeviceId = window.resolveActiveDeviceId
            ? await window.resolveActiveDeviceId(false)
            : (window.getActiveDeviceId ? window.getActiveDeviceId() : '');
        if (activeDeviceId) {
            socket.emit('subscribe:device', { deviceId: activeDeviceId });
        }
        syncDashboardStatusDemand({ allowReconnect: false });
    });
    
    socket.on('connect_error', function(error) {
        console.error('Socket connection error:', error);
        reconnectAttempts++;
        
        if (reconnectAttempts >= maxReconnectAttempts) {
            updateConnectionStatus('server_disconnected');
            showToast('Failed to connect to server', 'danger');
        } else {
            updateConnectionStatus('reconnecting');
        }
    });
    
    socket.on('disconnect', function(reason) {
        console.log('Socket disconnected:', reason);
        updateConnectionStatus('reconnecting');
        
        if (reason === 'io server disconnect') {
            // Server initiated disconnect, don't reconnect
            showToast('Disconnected by server', 'warning');
        } else {
            showToast('Disconnected from server', 'warning');
        }
    });
    
    socket.on('reconnect', function(attemptNumber) {
        console.log('Reconnected after', attemptNumber, 'attempts');
        updateConnectionStatus('server_connected');
        syncDashboardStatusDemand({ allowReconnect: false });
    });
    
    socket.on('reconnect_attempt', function(attemptNumber) {
        console.log('Reconnection attempt', attemptNumber);
        updateConnectionStatus('reconnecting');
    });
    
    socket.on('reconnect_error', function(error) {
        console.log('Reconnection error:', error);
    });
    
    socket.on('reconnect_failed', function() {
        console.log('Reconnection failed');
        updateConnectionStatus('server_disconnected');
        showToast('Failed to reconnect to server', 'danger');
    });
    
    socket.on('connected', function(data) {
        console.log('Server confirmed connection:', data);
    });
    
    socket.on('mqtt:status', function(data) {
        updateMQTTStatus(data);
    });
    
    socket.on('mqtt:error', function(data) {
        console.error('MQTT error:', data.message);
        updateMQTTStatus({
            ...(window._mqttStatus || {}),
            connected: false,
            state: 'error',
            lastError: data.message || 'MQTT connection error'
        });
        showToast('MQTT Error: ' + data.message, 'danger');
    });
    
    socket.on('device:status', function(data) {
        if (!isActiveDevicePayload(data)) return;
        lastLiveDeviceStatusAt = Date.now();
        const normalizedStatus = {
            ...(data || {}),
            online: inferStatusOnline(data)
        };
        latestDeviceStatus = { ...(latestDeviceStatus || {}), ...normalizedStatus };
        if (data?.queueState?.device) {
            latestQueueState.device = data.queueState.device;
        } else if (data?.queues) {
            latestQueueState.device = data.queues;
        }
        updateSidebarDeviceStatus(normalizedStatus);
        // Update hardware identifier in page if element exists
        if (data.imei || data.androidId || data.android_id || data.installId || data.device?.androidId || data.device?.android_id || data.device?.installId) {
            const hardwareIdEl = document.getElementById('deviceHardwareId');
            const hardwareIdLabelEl = document.getElementById('deviceHardwareIdLabel');
            if (hardwareIdEl || hardwareIdLabelEl) {
                const hardwareIdentity = getDeviceHardwareIdentity(data);
                if (hardwareIdEl) {
                    hardwareIdEl.textContent = hardwareIdentity.value;
                    hardwareIdEl.title = hardwareIdentity.value;
                }
                if (hardwareIdLabelEl) {
                    hardwareIdLabelEl.textContent = hardwareIdentity.label;
                }
            }
        }
        // Persist last-known status for offline display
        if (normalizedStatus.online) {
            try {
                saveLastDeviceStatusCache(normalizedStatus);
            } catch (_) {}
        }
    });

    socket.on('device:queue', function(data) {
        if (!data) return;
        const targetDeviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';
        if (data.deviceId && String(data.deviceId) !== String(targetDeviceId)) return;
        latestQueueState.dashboard = {
            summary: data.summary || null,
            recent: Array.isArray(data.recent) ? data.recent : []
        };
        updateQueueStatus(latestQueueState);
    });

    socket.on('device:capabilities', function(data) {
        if (!isActiveDevicePayload(data)) return;
        if (data && data.caps) {
            if (data.caps.modules && typeof data.caps.modules === 'object') {
                try {
                    const deviceId = String(data.deviceId || getStatusActiveDeviceId() || '').trim();
                    localStorage.setItem('deviceCaps_' + deviceId, JSON.stringify(data.caps));
                } catch (_) {}
                applyDeviceCapabilities(data.caps);
            } else {
                scheduleDeviceEnvelopeRefresh(100);
            }
        }
    });
    
    socket.on('device:heartbeat', function(data) {
        // Just update last seen, no UI change needed
    });
    
    socket.on('device:online', function(data) {
        if (!isActiveDevicePayload(data)) return;
        console.log('Device online:', data.deviceId);
        showToast(`Device ${data.deviceId} is online`, 'success');
        // Request full status
        socket.emit('get:device-status', { deviceId: getStatusActiveDeviceId(data?.deviceId) });
    });
    
    socket.on('device:offline', function(data) {
        if (!isActiveDevicePayload(data)) return;
        console.log('Device offline:', data.deviceId);
        showToast(`Device ${data.deviceId} went offline`, 'warning');

        const offlineSnapshot = buildOfflineDeviceSnapshot(
            latestDeviceStatus,
            latestDeviceStatus?.lastSeen || new Date().toISOString()
        );

        try {
            removeLastDeviceStatusCache(data?.deviceId);
        } catch (_) {}

        updateSidebarDeviceStatus(offlineSnapshot);

        if (window.updateDashboardSummary) {
            window.updateDashboardSummary(offlineSnapshot);
        }
    });
    
    socket.on('devices:status', function(devices) {
        // status handled by top-bar status pill
    });

    document.addEventListener('visibilitychange', () => {
        syncDashboardStatusDemand({ allowReconnect: false });
    });

function isActiveDeviceEvent(data) {
    const activeDeviceId = getStatusActiveDeviceId();
    if (!activeDeviceId) return true;
    if (!data?.deviceId) return false;
    return String(data.deviceId) === String(activeDeviceId);
}

function isActiveSimScopedEvent(data) {
    if (!isActiveDeviceEvent(data)) return false;
    const activeSimSlot = typeof window.getActiveDeviceSimSlot === 'function'
        ? window.getActiveDeviceSimSlot()
        : null;
    if (activeSimSlot === null || activeSimSlot === undefined) {
        return true;
    }
    const eventSimSlot = data?.simSlot ?? data?.sim_slot ?? null;
    if (eventSimSlot === null || eventSimSlot === undefined || eventSimSlot === '') {
        return true;
    }
    return Number(eventSimSlot) === Number(activeSimSlot);
}

    socket.on('sms:received', function(data) {
        if (!isActiveSimScopedEvent(data)) return;
        console.log('New SMS received:', data);
        const from = data.from_number || data.from || 'Unknown';
        const message = String(data.message || '');
        showToast(`New SMS from ${from}: ${message.substring(0, 30)}...`, 'info');
        updateUnreadBadge();
        scheduleDashboardSmsRefresh();
        playNotificationSound('sms');
        pushNotify('New SMS', `From: ${from}\n${message.substring(0, 80)}`, '/favicon.ico');
    });

    socket.on('sms:queued', function(data) {
        if (!isActiveSimScopedEvent(data)) return;
        console.log('SMS queued:', data);
        showToast('SMS queued for delivery', 'success');
        scheduleDashboardSmsRefresh();
    });
    
    socket.on('sms:sent', function(data) {
        if (!isActiveSimScopedEvent(data)) return;
        console.log('SMS sent:', data);
        showToast('SMS sent successfully', 'success');
        scheduleDashboardSmsRefresh();
    });
    
    socket.on('sms:delivered', function(data) {
        if (!isActiveSimScopedEvent(data)) return;
        console.log('SMS delivered:', data);
        showToast('SMS delivered to recipient', 'success');
        scheduleDashboardSmsRefresh();
    });

    socket.on('sms:send-failed', function(data) {
        if (!isActiveSimScopedEvent(data)) return;
        console.log('SMS send failed:', data);
        showToast(`SMS send failed: ${data?.error || 'Unknown error'}`, 'danger');
        scheduleDashboardSmsRefresh();
    });

    socket.on('sms:read', function(data) {
        if (!isActiveSimScopedEvent(data)) return;
        updateUnreadBadge();
        scheduleDashboardSmsRefresh();
    });

    socket.on('sms:deleted', function(data) {
        if (!isActiveSimScopedEvent(data)) return;
        if (typeof data?.unreadCount === 'number') {
            const badge = document.getElementById('unreadSmsBadge');
            const inboxBadge = document.getElementById('inboxUnreadBadge');
            if (badge) {
                badge.textContent = data.unreadCount;
                badge.style.display = data.unreadCount > 0 ? 'inline' : 'none';
            }
            if (inboxBadge) {
                inboxBadge.textContent = data.unreadCount;
                inboxBadge.classList.toggle('d-none', data.unreadCount === 0);
            }
        } else {
            updateUnreadBadge();
        }
        scheduleDashboardSmsRefresh();
    });

    socket.on('sms:bulk-read', function(data) {
        if (!isActiveSimScopedEvent(data)) return;
        if (typeof data?.unreadCount === 'number') {
            const badge = document.getElementById('unreadSmsBadge');
            const inboxBadge = document.getElementById('inboxUnreadBadge');
            if (badge) {
                badge.textContent = data.unreadCount;
                badge.style.display = data.unreadCount > 0 ? 'inline' : 'none';
            }
            if (inboxBadge) {
                inboxBadge.textContent = data.unreadCount;
                inboxBadge.classList.toggle('d-none', data.unreadCount === 0);
            }
        } else {
            updateUnreadBadge();
        }
        scheduleDashboardSmsRefresh();
    });

    socket.on('sms:bulk-deleted', function(data) {
        if (!isActiveSimScopedEvent(data)) return;
        if (typeof data?.unreadCount === 'number') {
            const badge = document.getElementById('unreadSmsBadge');
            const inboxBadge = document.getElementById('inboxUnreadBadge');
            if (badge) {
                badge.textContent = data.unreadCount;
                badge.style.display = data.unreadCount > 0 ? 'inline' : 'none';
            }
            if (inboxBadge) {
                inboxBadge.textContent = data.unreadCount;
                inboxBadge.classList.toggle('d-none', data.unreadCount === 0);
            }
        } else {
            updateUnreadBadge();
        }
        scheduleDashboardSmsRefresh();
    });
    
    socket.on('call:incoming', function(data) {
        if (!isActiveSimScopedEvent(data)) return;
        if (data?.sync === true || String(data?.sync || '').toLowerCase() === 'true') return;
        console.log('Incoming call:', data);
        activeIncomingCallContext = {
            deviceId: String(data?.deviceId || data?.device_id || getStatusActiveDeviceId() || '').trim(),
            simSlot: data?.simSlot ?? data?.sim_slot ?? null
        };
        const displayNumber = formatIncomingCallNumber(data.number);
        playNotificationSound('call');
        pushNotify('Incoming Call', `From: ${displayNumber}`, '/favicon.ico');
        showIncomingCallPanel(displayNumber, new Date().toLocaleTimeString());
    });

    socket.on('call:status', function(data) {
        if (!isActiveSimScopedEvent(data)) return;
        if (data?.sync === true || String(data?.sync || '').toLowerCase() === 'true') return;
        const status = String(data.status || '').toLowerCase();
        if (['ended', 'missed', 'rejected', 'answered', 'connected', 'dialing'].includes(status)) {
            activeIncomingCallContext = null;
            hideIncomingCallPanel();
        }
    });
    

    
    socket.on('ussd:response', function(data) {
        console.log('USSD response:', data);
        showToast('USSD response received', 'info');
        scheduleDeviceEnvelopeRefresh(500);
    });
    
    socket.on('webcam:capture', function(data) {
        console.log('Webcam capture:', data);
        showToast('New image captured', 'success');
        
        // Update gallery if on webcam page
        if (window.location.pathname.includes('webcam')) {
            refreshWebcamData();
        }
    });
    
    socket.on('modem:wifi-scan', function(data) {
        console.log('WiFi scan results:', data);
    });
    
    socket.on('modem:hotspot-clients', function(data) {
        console.log('Hotspot clients:', data);
    });
    
    socket.on('command:response', function(data) {
        console.log('Command response:', data);
    });

    // GPS sidebar info
    socket.on('gps:status', function(data) {
        const gpsInfo = document.getElementById('gpsInfo');
        const gpsFix = document.getElementById('gpsFix');
        const gpsLat = document.getElementById('gpsLat');
        const gpsLng = document.getElementById('gpsLng');
        const gpsSat = document.getElementById('gpsSat');
        const gpsBadge = document.getElementById('gpsBadge');

        if (data.fixed) {
            if (gpsInfo) gpsInfo.style.display = 'block';
            if (gpsFix) { gpsFix.textContent = '3D Fix'; gpsFix.className = 'fw-bold text-success'; }
            if (gpsLat) gpsLat.textContent = data.latitude?.toFixed(6) + ' deg';
            if (gpsLng) gpsLng.textContent = data.longitude?.toFixed(6) + ' deg';
            if (gpsSat) gpsSat.textContent = data.satellites + ' sat';
            if (gpsBadge) { showElement(gpsBadge, 'inline-block'); gpsBadge.textContent = '3D'; }
        } else {
            if (gpsInfo) gpsInfo.style.display = 'none';
            hideElement(gpsBadge);
        }
    });

    // GPIO active-pins badge
    socket.on('gpio:status', function(data) {
        const gpioBadge = document.getElementById('gpioBadge');
        if (gpioBadge && data.activePins) {
            showElement(gpioBadge, 'inline-block');
            gpioBadge.textContent = data.activePins;
        }
    });
}

// Track connection states for top-bar status pill
window._serverConnected = false;
window._mqttConnected = false;
window._mqttStatus = { connected: false, state: 'connecting', connecting: true };

function normalizeMQTTStatus(status) {
    const mqttState = (typeof status === 'object' && status !== null) ? status : { connected: !!status };
    const connected = Boolean(mqttState.connected);
    const connecting = Boolean(mqttState.connecting || mqttState.state === 'connecting');
    const reconnecting = Boolean(mqttState.reconnecting || mqttState.state === 'reconnecting');
    const lastError = mqttState.lastError || mqttState.error || mqttState.message || '';
    const authFailed = /auth|authorized|credential/i.test(String(lastError));
    let label = 'Disconnected';

    if (connected) label = 'Connected';
    else if (reconnecting) label = 'Reconnecting...';
    else if (connecting) label = 'Connecting...';
    else if (authFailed) label = 'Auth failed';

    return {
        ...mqttState,
        connected,
        connecting,
        reconnecting,
        lastError,
        label
    };
}

function updateTopBarStatus() {
    const pill = document.getElementById('statusPill');
    const dot = document.getElementById('statusDot');
    const label = document.getElementById('statusLabel');
    if (!pill || !dot || !label) return;

    const hasActiveDevice = hasActiveDeviceContext();
    const activeDeviceOnline = hasActiveDevice ? inferStatusOnline(latestDeviceStatus) : false;
    const allOk = window._serverConnected && window._mqttConnected && activeDeviceOnline;
    if (!hasActiveDevice) {
        dot.style.background = '#6c757d';
        label.textContent = window._serverConnected ? 'No Device Selected' : 'Disconnected';
        pill.style.background = 'rgba(108,117,125,0.18)';
        pill.style.borderColor = 'rgba(108,117,125,0.35)';
    } else {
        dot.style.background = allOk ? '#22c55e' : '#ef4444';
        if (allOk) {
            label.textContent = 'All Operational';
        } else if (!window._serverConnected) {
            label.textContent = 'Dashboard Socket Down';
        } else if (!window._mqttConnected) {
            label.textContent = 'Dashboard MQTT Down';
        } else {
            label.textContent = 'Device Offline';
        }
        pill.style.background = allOk ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)';
        pill.style.borderColor = allOk ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.5)';
    }

    // Also update panel statuses
    const panelServer = document.getElementById('panelServerStatus');
    const panelMqtt = document.getElementById('panelMqttStatus');
    const panelDevice = document.getElementById('panelDeviceStatus');
    if (panelServer) {
        panelServer.textContent = window._serverConnected ? 'Connected' : 'Disconnected';
        panelServer.style.color = window._serverConnected ? '#22c55e' : '#ef4444';
    }
    if (panelMqtt) {
        const mqttState = normalizeMQTTStatus(window._mqttStatus || window._mqttConnected);
        panelMqtt.textContent = mqttState.label;
        panelMqtt.title = mqttState.lastError ? `MQTT: ${mqttState.lastError}` : '';
        panelMqtt.style.color = mqttState.connected ? '#22c55e' : (mqttState.connecting || mqttState.reconnecting ? '#f59e0b' : '#ef4444');
    }
    if (panelDevice) {
        panelDevice.textContent = hasActiveDevice ? (activeDeviceOnline ? 'Online' : 'Offline') : 'No device';
        panelDevice.style.color = hasActiveDevice ? (activeDeviceOnline ? '#22c55e' : '#ef4444') : '#6c757d';
    }
}

// Update connection status UI
function updateConnectionStatus(status) {
    const serverConnecting = document.getElementById('serverConnecting');
    const serverConnected = document.getElementById('serverConnected');
    const serverDisconnected = document.getElementById('serverDisconnected');
    const serverStatusText = document.getElementById('serverStatusText');
    const loadingSkeleton = document.getElementById('loadingSkeleton');
    const metricsPanel = document.getElementById('metricsPanel');
    
    if (!serverConnecting || !serverConnected || !serverDisconnected) return;
    
    switch(status) {
        case 'connecting':
            serverConnecting.style.display = 'inline-block';
            serverConnected.style.display = 'none';
            serverDisconnected.style.display = 'none';
            if (serverStatusText) serverStatusText.textContent = 'Connecting...';
            if (loadingSkeleton) loadingSkeleton.style.display = 'block';
            if (metricsPanel) metricsPanel.style.display = 'none';
            break;

        case 'server_connected':
            serverConnecting.style.display = 'none';
            serverConnected.style.display = 'inline-block';
            serverDisconnected.style.display = 'none';
            if (serverStatusText) serverStatusText.textContent = 'Connected';
            window._serverConnected = true;
            break;

        case 'server_disconnected':
            serverConnecting.style.display = 'none';
            serverConnected.style.display = 'none';
            serverDisconnected.style.display = 'inline-block';
            if (serverStatusText) serverStatusText.textContent = 'Disconnected';
            if (loadingSkeleton) loadingSkeleton.style.display = 'none';
            if (metricsPanel) metricsPanel.style.display = 'none';
            window._serverConnected = false;
            cancelMQTTDownSettingsRedirect();
            break;

        case 'reconnecting':
            serverConnecting.style.display = 'inline-block';
            serverConnected.style.display = 'none';
            serverDisconnected.style.display = 'none';
            if (serverStatusText) serverStatusText.textContent = 'Reconnecting...';
            break;
    }
    updateGlobalConnectionOverlay();
    updateActionAvailability();
    updateTopBarStatus();
}

// Update MQTT status UI
function updateMQTTStatus(status) {
    const mqttConnecting = document.getElementById('mqttConnecting');
    const mqttConnected = document.getElementById('mqttConnected');
    const mqttDisconnected = document.getElementById('mqttDisconnected');
    const mqttStatusText = document.getElementById('mqttStatusText');
    const loadingSkeleton = document.getElementById('loadingSkeleton');
    const metricsPanel = document.getElementById('metricsPanel');
    
    if (!mqttConnecting || !mqttConnected || !mqttDisconnected) return;

    const mqttState = normalizeMQTTStatus(status);

    if (mqttState.connected) {
        cancelMQTTDownSettingsRedirect();
        mqttConnecting.style.display = 'none';
        mqttConnected.style.display = 'inline-block';
        mqttDisconnected.style.display = 'none';
        if (mqttStatusText) {
            mqttStatusText.textContent = mqttState.label;
            mqttStatusText.className = 'fw-medium text-success';
            mqttStatusText.title = '';
        }
        if (loadingSkeleton) loadingSkeleton.style.display = 'none';
    } else if (mqttState.connecting || mqttState.reconnecting) {
        cancelMQTTDownSettingsRedirect();
        mqttConnecting.style.display = 'inline-block';
        mqttConnected.style.display = 'none';
        mqttDisconnected.style.display = 'none';
        if (mqttStatusText) {
            mqttStatusText.textContent = mqttState.label;
            mqttStatusText.className = 'fw-medium text-warning';
            mqttStatusText.title = mqttState.lastError || '';
        }
        if (loadingSkeleton) loadingSkeleton.style.display = 'block';
        if (metricsPanel) metricsPanel.style.display = 'none';
    } else {
        mqttConnecting.style.display = 'none';
        mqttConnected.style.display = 'none';
        mqttDisconnected.style.display = 'inline-block';
        if (mqttStatusText) {
            mqttStatusText.textContent = mqttState.label;
            mqttStatusText.className = 'fw-medium text-danger';
            mqttStatusText.title = mqttState.lastError || '';
        }
        if (loadingSkeleton) loadingSkeleton.style.display = 'none';
        if (metricsPanel) metricsPanel.style.display = 'none';
        // Keep device liveness separate from broker liveness. USB/direct paths
        // can still keep the board reachable while MQTT is down.
        scheduleMQTTDownSettingsRedirect();
    }
    window._mqttStatus = mqttState;
    window._mqttConnected = mqttState.connected;
    updateGlobalConnectionOverlay();
    updateActionAvailability();
    updateTopBarStatus();
}

// Update device connection status
function updateDeviceConnection(online) {
    window._deviceOnline = Boolean(online); // track globally for sidebar polling guards
    updateDeviceDiagnosticsVisibility(Boolean(online) && hasActiveDeviceContext());

    const deviceOffline = document.getElementById('deviceOffline');
    const deviceOnline = document.getElementById('deviceOnline');
    const deviceStatusText = document.getElementById('deviceStatusText');

    if (deviceOffline && deviceOnline && deviceStatusText) {
        if (online) {
            deviceOffline.style.display = 'none';
            deviceOnline.style.display = 'inline-block';
            deviceStatusText.textContent = 'Online';
            deviceStatusText.className = 'fw-medium text-success';
        } else {
            deviceOffline.style.display = 'inline-block';
            deviceOnline.style.display = 'none';
            deviceStatusText.textContent = 'Offline';
            deviceStatusText.className = 'fw-medium text-secondary';
        }
    }
    updateGlobalConnectionOverlay();
    updateActionAvailability();
    updateTopBarStatus();
}

// Update sidebar device status
function updateSidebarDeviceStatus(status) {
    if (!status) return;
    const normalizedStatus = {
        ...status,
        online: inferStatusOnline(status)
    };
    latestDeviceStatus = { ...(latestDeviceStatus || {}), ...normalizedStatus };
    if (normalizedStatus.queueState) {
        latestQueueState = {
            dashboard: normalizedStatus.queueState.dashboard || latestQueueState.dashboard,
            device: normalizedStatus.queueState.device || latestQueueState.device
        };
    } else if (normalizedStatus.queues) {
        latestQueueState.device = normalizedStatus.queues;
    }
    
    // Update online status
    updateDeviceConnection(normalizedStatus.online);
    updateSidebarSimSelector(latestDeviceStatus);
    
    const metricsPanel = document.getElementById('metricsPanel');

    if (normalizedStatus.online) {
        if (metricsPanel) metricsPanel.style.display = 'block';
        // Update metrics
        updateDeviceMetrics(normalizedStatus);
        updateDashboardCards(normalizedStatus);
    } else {
        if (metricsPanel) metricsPanel.style.display = 'none';
        // Show placeholder values
        const signalEl = document.getElementById('sidebarSignal');
        const signalBar = document.getElementById('sidebarSignalBar');
        const batteryEl = document.getElementById('sidebarBattery');
        const batteryBar = document.getElementById('sidebarBatteryBar');
        const networkEl = document.getElementById('sidebarNetwork');
        const operatorEl = document.getElementById('sidebarOperator');
        const uptimeEl = document.getElementById('sidebarUptime');
        const panelOperatorEl = document.getElementById('panelOperator');
        const panelSimNumberEl = document.getElementById('panelSimNumber');
        
        if (signalEl) signalEl.textContent = '-';
        if (signalBar) signalBar.style.width = '0%';
        if (batteryEl) batteryEl.textContent = '-';
        if (batteryBar) batteryBar.style.width = '0%';
        if (networkEl) networkEl.textContent = '---';
        if (operatorEl) operatorEl.textContent = '---';
        if (uptimeEl) uptimeEl.textContent = '---';
        if (panelOperatorEl) panelOperatorEl.textContent = '---';
        if (panelSimNumberEl) panelSimNumberEl.textContent = '---';
        updateDashboardCards(status);
    }

    updateQueueStatus(latestQueueState);
    updateHeaderDeviceSummary(latestDeviceStatus, latestQueueState);
    updateWifiRequirementBanners();
    updateActionAvailability();
}

// Update device metrics
function updateDeviceMetrics(status) {
    const selectedSim = getSelectedSimSlotSnapshot(status);
    const operatorLabel = status.online
        ? (selectedSim?.operatorName || selectedSim?.displayName || status.operator || '---')
        : '---';
    const simNumberLabel = status.online
        ? (selectedSim?.number || getSimNumberDisplayValue(status))
        : '---';

    // Update signal
    const signal = status.signal;
    const signalEl = document.getElementById('sidebarSignal');
    const signalBar = document.getElementById('sidebarSignalBar');

    if (signalEl) signalEl.textContent = signal !== null ? signal + '%' : '-';
    if (signalBar) {
        const pct = signal ?? 0;
        signalBar.style.width = pct + '%';
        signalBar.className = pct > 70 ? 'progress-bar bg-success' :
                             pct > 40 ? 'progress-bar bg-warning' :
                             'progress-bar bg-danger';
    }

    // Update battery
    const battery = status.battery;
    const batteryEl = document.getElementById('sidebarBattery');
    const batteryBar = document.getElementById('sidebarBatteryBar');
    const chargingEl = document.getElementById('sidebarCharging');

    if (batteryEl) batteryEl.textContent = battery !== null ? battery + '%' : '-';
    if (batteryBar) batteryBar.style.width = (battery ?? 0) + '%';
    if (chargingEl) {
        chargingEl.style.display = status.charging ? 'inline-block' : 'none';
    }

    // Update network
    const networkEl = document.getElementById('sidebarNetwork');
    const operatorEl = document.getElementById('sidebarOperator');
    const uptimeEl = document.getElementById('sidebarUptime');

    if (networkEl) networkEl.textContent = getStatusNetworkLabel(status);
    if (operatorEl) operatorEl.textContent = operatorLabel;
    if (uptimeEl) uptimeEl.textContent = status.uptime || '---';

    // Update top-bar panel metrics
    const pm = document.getElementById('panelMetrics');
    showElement(pm, 'block');
    const ps = document.getElementById('panelSignal');
    const psBar = document.getElementById('panelSignalBar');
    const pb = document.getElementById('panelBattery');
    const pbBar = document.getElementById('panelBatteryBar');
    const pn = document.getElementById('panelNetwork');
    const pu = document.getElementById('panelUptime');
    const po = document.getElementById('panelOperator');
    const psn = document.getElementById('panelSimNumber');
    if (ps) ps.textContent = (signal !== null ? signal + '%' : '-');
    if (psBar) { setProgressWidth(psBar, signal || 0); psBar.className = (signal > 70 ? 'progress-bar bg-success' : signal > 40 ? 'progress-bar bg-warning' : 'progress-bar bg-danger'); }
    if (pb) pb.textContent = (battery !== null ? battery + '%' : '-');
    if (pbBar) setProgressWidth(pbBar, battery || 0);
    if (pn) pn.textContent = getStatusNetworkLabel(status);
    if (pu) pu.textContent = status.uptime || '---';
    if (po) po.textContent = operatorLabel;
    if (psn) psn.textContent = simNumberLabel;
    // Update compact strip
    const smSig = document.getElementById('smSignal');
    const smSigBar = document.getElementById('smSignalBar');
    const smBat = document.getElementById('smBattery');
    const smNet = document.getElementById('smNetwork');
    const strip = document.getElementById('sidebarMetricsStrip');
    showElement(strip, 'block');
    if (smSig) smSig.innerHTML = `<i class="bi ${getStatusSignalIcon(status)} me-1"></i>${signal !== null ? signal + '%' : '-'}`;
    if (smSigBar) setProgressWidth(smSigBar, signal || 0);
    if (smBat) smBat.innerHTML = '<i class="bi bi-battery-half me-1"></i>' + (battery !== null ? battery + '%' : '-');
    if (smNet) smNet.textContent = getStatusNetworkLabel(status);
}

function updateDashboardCards(status) {
    const isOnline = Boolean(status?.online);
    const selectedSim = getSelectedSimSlotSnapshot(status);

    const lastSeenEl = document.getElementById('dashboardLastSeen');
    if (lastSeenEl) {
        const seenAt = formatHeaderTimestamp(status?.lastSeen);
        lastSeenEl.innerHTML = `<i class="bi bi-clock-history me-1"></i>Last seen: ${seenAt || '-'}`;
    }

    const dashWifiPrimary = document.getElementById('dashWifiPrimary');
    const dashModemActive = document.getElementById('dashModemActive');
    if (dashWifiPrimary) {
        dashWifiPrimary.textContent = status?.wifiRoleLabel
            || (isOnline
                ? (status?.activePath === 'wifi'
                    ? 'Primary'
                    : ((status?.wifi?.connected || status?.wifiSsid || status?.wifi?.ssid) ? 'Connected' : 'Offline'))
                : 'Offline');
    }
    if (dashModemActive) {
        dashModemActive.textContent = status?.modemRoleLabel
            || (isOnline
                ? (status?.activePath === 'modem'
                    ? 'Fallback'
                    : ((status?.operator || status?.ip || status?.cellularSignal !== null || status?.sim?.registered) ? 'Connected' : 'Offline'))
                : 'Offline');
    }

    const wifiSignal = status?.wifiSignal;
    const wifiValue = document.getElementById('dashWifiSignalValue');
    const wifiBar = document.getElementById('dashWifiSignalBar');
    const wifiMeta = document.getElementById('dashWifiSignalMeta');
    const wifiSsid = document.getElementById('dashWifiSsid');
    const wifiIp = document.getElementById('dashWifiIp');
    if (wifiValue) wifiValue.textContent = isOnline ? (wifiSignal !== null ? `${wifiSignal}%` : 'N/A') : '-';
    if (wifiBar) setProgressWidth(wifiBar, isOnline && wifiSignal !== null ? wifiSignal : 0);
    if (wifiMeta) {
        wifiMeta.textContent = isOnline
            ? (status?.wifiStatusLabel || ((status?.wifi?.connected || status?.activePath === 'wifi') ? 'Connected' : 'Not connected'))
            : 'Disconnected';
    }
    if (wifiSsid) wifiSsid.textContent = isOnline ? (status?.wifiSsid || status?.wifi?.ssid || 'Not reported') : '-';
    if (wifiIp) {
        const resolvedWifiIp = isOnline
            ? (status?.wifi?.ipAddress || (status?.signalSource === 'wifi' ? status?.ip : null) || 'N/A')
            : '-';
        wifiIp.textContent = resolvedWifiIp;
    }

    const cellSignal = status?.cellularSignal;
    const cellValue = document.getElementById('dashCellSignalValue');
    const cellBar = document.getElementById('dashCellSignalBar');
    const cellMeta = document.getElementById('dashCellSignalMeta');
    if (cellValue) cellValue.textContent = isOnline ? (cellSignal !== null ? `${cellSignal}%` : 'N/A') : '-';
    if (cellBar) setProgressWidth(cellBar, isOnline && cellSignal !== null ? cellSignal : 0);
    if (cellMeta) cellMeta.textContent = isOnline ? (status?.cellularStatus || 'Unavailable') : 'Disconnected';

    const battery = status?.battery;
    const voltageMv = Number(status?.voltageMv || 0);
    const batteryHasVoltage = Number.isFinite(voltageMv) && voltageMv > 0;
    const charging = status?.charging;
    const batteryHasTelemetry = battery !== null || batteryHasVoltage || (charging !== null && charging !== undefined);
    const batteryLevel = Number(battery);
    const batteryLooksFull = Number.isFinite(batteryLevel) && batteryLevel >= 95 && batteryHasVoltage && voltageMv >= 4180;
    const batteryVoltageLabel = batteryHasVoltage
        ? `${(voltageMv / 1000).toFixed(2)} V`
        : (batteryHasTelemetry ? 'Sampling' : 'Not reported by device');
    const batteryStateLabel = batteryHasTelemetry
        ? (battery !== null ? 'Gauge live' : 'Waiting for gauge sample')
        : 'Not reported by device';
    const chargingLabel = (charging === null || charging === undefined)
        ? (batteryLooksFull ? 'Full/idle' : (batteryHasTelemetry ? 'Unknown' : 'Not reported'))
        : (charging ? 'Yes' : 'No');
    const batteryPowerSourceLabel = (charging === null || charging === undefined)
        ? (batteryLooksFull ? 'USB/idle' : (batteryHasTelemetry ? 'Unknown' : 'Not reported'))
        : (charging ? 'USB power' : 'Battery');

    const dashBatteryValue = document.getElementById('dashBatteryValue');
    const dashBatteryBar = document.getElementById('dashBatteryBar');
    const dashCharging = document.getElementById('dashCharging');
    const dashBatteryVoltage = document.getElementById('dashBatteryVoltage');
    const dashBatteryState = document.getElementById('dashBatteryState');
    const dashBatteryPowerSource = document.getElementById('dashBatteryPowerSource');
    if (dashBatteryValue) dashBatteryValue.textContent = isOnline ? (battery !== null ? `${battery}%` : 'N/A') : '-';
    if (dashBatteryBar) setProgressWidth(dashBatteryBar, isOnline && battery !== null ? battery : 0);
    if (dashCharging) dashCharging.textContent = isOnline ? chargingLabel : '-';
    if (dashBatteryVoltage) dashBatteryVoltage.textContent = isOnline ? batteryVoltageLabel : '-';
    if (dashBatteryState) dashBatteryState.textContent = isOnline ? batteryStateLabel : '-';
    if (dashBatteryPowerSource) dashBatteryPowerSource.textContent = isOnline ? batteryPowerSourceLabel : '-';

    const dashOperator = document.getElementById('dashOperator');
    const dashSimNumber = document.getElementById('dashSimNumber');
    const dashCurrentIp = document.getElementById('dashCurrentIp');
    if (dashOperator) dashOperator.textContent = isOnline ? (selectedSim?.operatorName || selectedSim?.displayName || status?.operator || 'Not reported') : '-';
    if (dashSimNumber) dashSimNumber.textContent = isOnline ? (selectedSim?.number || getSimNumberDisplayValue(status)) : '-';
    if (dashCurrentIp) dashCurrentIp.textContent = isOnline ? (status?.ip || 'N/A') : '-';
    maybeAutoDetectSimNumber(status);

    const telemetryNotice = document.getElementById('dashboardTelemetryNotice');
    if (telemetryNotice) {
        const shouldShow = Boolean(
            isOnline
            && status?.activePath === 'modem'
            && (
                status?.signal === null
                || status?.battery === null
                || status?.temperature === null
                || (!status?.imei && !status?.androidId && !status?.android_id)
            )
        );
        telemetryNotice.classList.toggle('d-none', !shouldShow);
    }

    const healthEl = document.getElementById('deviceHealth');
    if (healthEl) {
        const score = status?.healthScore;
        if (typeof score === 'number') {
            healthEl.textContent = `${score}%`;
            healthEl.classList.remove('text-success', 'text-warning', 'text-danger');
            healthEl.classList.add(score >= 70 ? 'text-success' : score >= 40 ? 'text-warning' : 'text-danger');
        } else {
            healthEl.textContent = 'N/A';
            healthEl.classList.remove('text-success', 'text-warning', 'text-danger');
        }
    }

    const hardwareIdEl = document.getElementById('deviceHardwareId');
    const hardwareIdLabelEl = document.getElementById('deviceHardwareIdLabel');
    if (hardwareIdEl || hardwareIdLabelEl) {
        const hardwareIdentity = isOnline
            ? getDeviceHardwareIdentity(status)
            : { label: 'Android ID / IMEI', value: 'Not reported by device' };
        if (hardwareIdEl) {
            hardwareIdEl.textContent = hardwareIdentity.value;
            hardwareIdEl.setAttribute('title', hardwareIdentity.value);
        }
        if (hardwareIdLabelEl) {
            hardwareIdLabelEl.textContent = hardwareIdentity.label;
        }
    }
    const modelEl = document.getElementById('deviceModel');
    if (modelEl) {
        const modelLabel = getDeviceModelDisplayLabel(status);
        modelEl.textContent = modelLabel;
        modelEl.setAttribute('title', modelEl.textContent);
    }
}

function updateQueueStatus(queueState) {
    const dashboardSummary = queueState?.dashboard?.summary || {};
    const dashboardRecent = Array.isArray(queueState?.dashboard?.recent) ? queueState.dashboard.recent : [];
    const deviceQueue = queueState?.device || {};

    const dashboardPending = Number(dashboardSummary.pending || 0);
    const dashboardActive = Number(dashboardSummary.active || 0);
    const dashboardFailed = Number(dashboardSummary.failed || 0);
    const dashboardAmbiguous = Number(dashboardSummary.ambiguous || 0);
    const devicePending = Number(deviceQueue.total || 0);
    const deviceCommand = Number(deviceQueue.command || 0);
    const deviceDeferred = Number(deviceQueue.deferred || 0);
    const deviceInbound = Number(deviceQueue.mqttInbound || 0);

    const panelDashboardQueue = document.getElementById('panelDashboardQueue');
    const panelDeviceQueue = document.getElementById('panelDeviceQueue');
    const panelQueueRecent = document.getElementById('panelQueueRecent');
    const smQueue = document.getElementById('smQueue');
    const dashQueueSummary = document.getElementById('dashQueueSummary');
    const dashDeviceQueue = document.getElementById('dashDeviceQueue');
    const dashStorageQueue = document.getElementById('dashStorageQueue');
    const dashRecentQueue = document.getElementById('dashRecentQueue');

    let dashboardSummaryText = `${dashboardPending} pending`;
    if (dashboardActive > 0) dashboardSummaryText += `, ${dashboardActive} active`;
    if (dashboardFailed > 0) dashboardSummaryText += `, ${dashboardFailed} failed`;
    if (dashboardAmbiguous > 0) dashboardSummaryText += `, ${dashboardAmbiguous} review`;
    if (!dashboardPending && !dashboardActive && !dashboardFailed && !dashboardAmbiguous) {
        dashboardSummaryText = 'Idle';
    }
    if (panelDashboardQueue) {
        panelDashboardQueue.textContent = dashboardSummaryText;
    }
    if (dashQueueSummary) dashQueueSummary.textContent = dashboardSummaryText;

    const deviceQueueText = devicePending > 0 ? `${devicePending} pending` : 'Idle';
    if (panelDeviceQueue) {
        panelDeviceQueue.textContent = deviceQueueText;
    }
    if (dashDeviceQueue) dashDeviceQueue.textContent = deviceQueueText;

    let recentQueueText = 'No recent actions';
    if (dashboardRecent.length > 0) {
        const recent = dashboardRecent[0];
        recentQueueText = `${recent.command || 'command'}: ${recent.status || 'unknown'}`;
    }
    if (panelQueueRecent) {
        panelQueueRecent.textContent = recentQueueText;
    }
    if (dashRecentQueue) dashRecentQueue.textContent = recentQueueText;

    const storagePending = Number(deviceQueue.storagePending || 0);
    if (dashStorageQueue) {
        dashStorageQueue.textContent = storagePending > 0 ? `${storagePending} pending` : 'Idle';
    }

    if (smQueue) {
        if (dashboardPending || dashboardActive || dashboardFailed || dashboardAmbiguous || devicePending) {
            smQueue.textContent = `Queue: dash ${dashboardPending}/${dashboardActive} | dev ${devicePending}`;
        } else {
            smQueue.textContent = 'Queue: idle';
        }
    }

    updateHeaderDeviceSummary(latestDeviceStatus, queueState);
}

function moduleStateClass(state) {
    switch (state) {
        case 'ok': return 'success';
        case 'warning': return 'warning';
        case 'error': return 'danger';
        case 'unsupported': return 'secondary';
        default: return 'secondary';
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const STATUS_PANEL_MODULE_LINKS = Object.freeze({
    mqtt: '/modem',
    modem: '/modem',
    wifi: '/modem',
    gps: '/location',
    storage: '/storage',
    display: '/display',
    camera: '/webcam',
    webcam: '/webcam',
    audio: '/intercom',
    intercom: '/intercom',
    internet: '/modem',
    sms: '/sms',
    calls: '/calls',
    contacts: '/contacts',
    ussd: '/ussd',
    nfc: '/nfc',
    rfid: '/rfid',
    touch: '/touch',
    keyboard: '/keyboard'
});

function getStatusPanelModuleHref(moduleKey) {
    return STATUS_PANEL_MODULE_LINKS[String(moduleKey || '').trim().toLowerCase()] || '';
}

function getStatusPanelTarget(target) {
    return target?.closest ? target.closest('[data-status-href], [data-status-module]') : null;
}

function buildDeviceAwareHref(rawHref) {
    const href = String(rawHref || '').trim();
    if (!href) return '';

    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname.startsWith('/api/')) {
        return `${url.pathname}${url.search}${url.hash}`;
    }

    const deviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';
    const simContext = window.getActiveDeviceSimContext ? window.getActiveDeviceSimContext() : {
        simSlot: window.getActiveDeviceSimSlot ? window.getActiveDeviceSimSlot() : null
    };
    if (deviceId && url.pathname.startsWith('/devices/')) {
        url.searchParams.set('device', deviceId);
    } else if (deviceId) {
        url.searchParams.set('deviceId', deviceId);
    }
    if (simContext.simSlot !== null && simContext.simSlot !== undefined) {
        url.searchParams.set('simSlot', String(simContext.simSlot));
    }
    url.searchParams.delete('simSubscriptionId');
    url.searchParams.delete('subscription_id');

    return `${url.pathname}${url.search}${url.hash}`;
}

function syncSidebarDeviceAwareLinks(root = document) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    scope.querySelectorAll('[data-device-nav="true"] a[href^="/"]:not([target="_blank"])').forEach((link) => {
        const baseHref = String(
            link.getAttribute('data-device-base-href')
            || link.getAttribute('data-device-aware-href')
            || link.getAttribute('href')
            || ''
        ).trim();
        if (!baseHref || baseHref.startsWith('/api/')) {
            return;
        }

        if (!link.hasAttribute('data-device-base-href')) {
            link.setAttribute('data-device-base-href', baseHref);
        }
        link.setAttribute('data-device-aware-href', baseHref);

        const scopedHref = buildDeviceAwareHref(baseHref);
        if (scopedHref) {
            link.setAttribute('href', scopedHref);
        }
    });
}

function syncCurrentLocationDeviceScope() {
    if (!window.history?.replaceState) {
        return;
    }

    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const scopedHref = buildDeviceAwareHref(currentHref);
    if (!scopedHref || scopedHref === currentHref) {
        return;
    }

    window.history.replaceState({}, '', scopedHref);
}

function navigateStatusPanelLink(linkTarget) {
    const href = String(linkTarget?.getAttribute?.('data-status-href') || '').trim();
    if (!href) return false;

    window.location.href = buildDeviceAwareHref(href);
    return true;
}

async function runStatusPanelModuleAction(linkTarget) {
    const moduleKey = String(linkTarget?.getAttribute?.('data-status-module') || '').trim().toLowerCase();
    if (!moduleKey) return false;

    const deviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';
    if (!deviceId) {
        if (typeof window.showToast === 'function') {
            window.showToast('Select a device first.', 'warning');
        }
        return true;
    }

    if (linkTarget.dataset.statusBusy === '1') {
        return true;
    }

    linkTarget.dataset.statusBusy = '1';
    linkTarget.classList.add('opacity-75');

    try {
        const response = await fetch('/api/status/module-action', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ deviceId, moduleKey })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.success === false) {
            throw new Error(payload?.message || `Failed to refresh ${moduleKey} status`);
        }

        if (payload?.envelope) {
            applyDeviceEnvelope(payload.envelope);
        }

        if (typeof window.showToast === 'function') {
            window.showToast(payload?.message || `Requested live ${moduleKey} status.`, 'info');
        }

        const href = String(linkTarget.getAttribute('data-status-href') || '').trim();
        if (href) {
            setTimeout(() => {
                window.location.href = buildDeviceAwareHref(href);
            }, 120);
        }
    } catch (error) {
        if (typeof window.showToast === 'function') {
            window.showToast(error.message || `Failed to refresh ${moduleKey} status`, 'danger');
        }
    } finally {
        delete linkTarget.dataset.statusBusy;
        linkTarget.classList.remove('opacity-75');
    }

    return true;
}

function activateStatusPanelLink(target) {
    const linkTarget = getStatusPanelTarget(target);
    if (!linkTarget) return false;

    if (linkTarget.hasAttribute('data-status-module')) {
        void runStatusPanelModuleAction(linkTarget);
        return true;
    }

    return navigateStatusPanelLink(linkTarget);
}

function bindStatusPanelLinks() {
    if (window.__statusPanelLinksBound) return;
    window.__statusPanelLinksBound = true;

    document.addEventListener('click', function(event) {
        if (activateStatusPanelLink(event.target)) {
            event.preventDefault();
        }
    });

    document.addEventListener('keydown', function(event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (activateStatusPanelLink(event.target)) {
            event.preventDefault();
        }
    });
}

function bindDeviceAwareLinks() {
    if (window.__deviceAwareLinksBound) return;
    window.__deviceAwareLinksBound = true;

    document.addEventListener('click', function(event) {
        const link = event.target?.closest ? event.target.closest('a[data-device-aware-href]') : null;
        if (!link) return;
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

        const href = buildDeviceAwareHref(link.getAttribute('data-device-aware-href'));
        if (!href) return;

        event.preventDefault();
        window.location.href = href;
    });
}

function syncStatusPanelColumns() {
    const panel = document.getElementById('statusPanel');
    const grid = document.getElementById('statusPanelGrid');
    const detailColumn = document.getElementById('statusPanelDetailColumn');
    const queueSection = document.getElementById('panelQueueSection');
    const moduleSection = document.getElementById('panelModuleHealthSection');

    if (!panel || !grid || !detailColumn) return;

    const showDetailColumn = Boolean(queueSection && moduleSection)
        && !queueSection.classList.contains('app-hidden')
        && !moduleSection.classList.contains('app-hidden');

    if (showDetailColumn) {
        showElement(detailColumn, 'flex');
    } else {
        hideElement(detailColumn);
    }

    panel.classList.toggle('status-panel-single', !showDetailColumn);
    grid.classList.toggle('status-panel-grid-single', !showDetailColumn);
}

function updateDeviceDiagnosticsVisibility(visible) {
    const queueSection = document.getElementById('panelQueueSection');
    const moduleSection = document.getElementById('panelModuleHealthSection');
    const modulePanel = document.getElementById('panelModuleHealth');

    if (queueSection) {
        if (visible) showElement(queueSection, 'block');
        else hideElement(queueSection);
    }

    if (moduleSection) {
        if (visible) {
            showElement(moduleSection, 'block');
        } else {
            hideElement(moduleSection);
            if (modulePanel) modulePanel.innerHTML = '';
        }
    }

    syncStatusPanelColumns();
}

function renderSidebarModuleHealth(moduleHealth) {
    const target = document.getElementById('sidebarModuleHealth');
    if (!target) return;

    if (!hasActiveDeviceContext() || !deviceOnline()) {
        target.innerHTML = '';
        updateDeviceDiagnosticsVisibility(false);
        return;
    }

    if (!Array.isArray(moduleHealth) || moduleHealth.length === 0) {
        target.innerHTML = '<div class="text-muted small">Waiting for device diagnostics...</div>';
        updateDeviceDiagnosticsVisibility(true);
        const panelMH = document.getElementById('panelModuleHealth');
        if (panelMH) panelMH.innerHTML = target.innerHTML;
        return;
    }

    const preferred = ['mqtt', 'modem', 'internet', 'sms', 'calls', 'contacts', 'ussd', 'wifi', 'gps', 'storage', 'display', 'camera', 'webcam', 'audio', 'intercom', 'nfc', 'rfid', 'touch', 'keyboard'];
    const sorted = preferred
        .map((key) => moduleHealth.find((entry) => entry.moduleKey === key))
        .filter(Boolean)
        .filter((entry) => entry.state !== 'unsupported' && entry.visible !== false && entry.available !== false);

    if (sorted.length === 0) {
        target.innerHTML = '<div class="text-muted small">No active module issues.</div>';
        const panelMH = document.getElementById('panelModuleHealth');
        if (panelMH) panelMH.innerHTML = target.innerHTML;
        return;
    }

    target.innerHTML = sorted.map((entry) => {
        const href = entry.linkEnabled === false ? '' : getStatusPanelModuleHref(entry.moduleKey);
        const interactiveAttrs = href
            ? ` data-status-href="${escapeHtml(href)}" data-status-module="${escapeHtml(entry.moduleKey)}" tabindex="0" role="link" title="Open ${escapeHtml(entry.label || entry.moduleKey || 'module')}"`
            : '';

        return `
        <div class="d-flex align-items-start justify-content-between gap-2 mb-1${href ? ' status-linkable' : ''}"${interactiveAttrs}>
            <div class="text-truncate" title="${escapeHtml(entry.message || '')}">
                <span class="fw-semibold">${escapeHtml(entry.label || entry.moduleKey || 'Module')}</span>
                <div class="text-muted" style="font-size:0.72rem;">${escapeHtml(entry.message || 'Waiting for telemetry')}</div>
            </div>
            <span class="badge bg-${moduleStateClass(entry.state)} text-uppercase" style="font-size:0.65rem;">${escapeHtml(entry.state === 'unsupported' ? 'pending' : (entry.state || 'unknown'))}</span>
        </div>
    `;
    }).join('');
    const panelMH = document.getElementById('panelModuleHealth');
    updateDeviceDiagnosticsVisibility(true);
    if (panelMH) panelMH.innerHTML = target.innerHTML;
}

function applyDeviceEnvelope(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.data && !isActiveDevicePayload(payload.data)) return;
    if (payload.data) updateSidebarDeviceStatus(payload.data);
    if (payload.data?.queueState) {
        latestQueueState = {
            dashboard: payload.data.queueState.dashboard || latestQueueState.dashboard,
            device: payload.data.queueState.device || latestQueueState.device
        };
        updateQueueStatus(latestQueueState);
    }
    if (payload.caps) {
        try {
            const deviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : (window.DEVICE_ID || localStorage.getItem('activeDeviceId') || '');
            localStorage.setItem('deviceCaps_' + deviceId, JSON.stringify(payload.caps));
        } catch (_) {}
        applyDeviceCapabilities(payload.caps);
    }
    if (payload.moduleHealth) renderSidebarModuleHealth(payload.moduleHealth);
}

function refreshDeviceEnvelope(options = {}) {
    const { liveRefresh = false } = options;
    const deviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : (window.DEVICE_ID || localStorage.getItem('activeDeviceId') || '');
    if (!deviceId) return Promise.resolve();
    const statusUrl = '/api/status?deviceId=' + encodeURIComponent(deviceId)
        + (liveRefresh ? '&refresh=1' : '')
        + '&_ts=' + Date.now();

    return fetch(statusUrl, {
        cache: 'no-store',
        headers: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        }
    })
        .then(response => response.ok ? response.json() : null)
        .then(data => {
            const currentDeviceId = getStatusActiveDeviceId();
            if (currentDeviceId && String(currentDeviceId) !== String(deviceId)) return;
            if (data && data.success) applyDeviceEnvelope(data);
        })
        .catch(() => {});
}

function scheduleDeviceEnvelopeRefresh(delayMs = 150) {
    clearTimeout(deviceEnvelopeTimer);
    deviceEnvelopeTimer = setTimeout(() => {
        refreshDeviceEnvelope();
    }, delayMs);
}

window.refreshDeviceEnvelope = refreshDeviceEnvelope;
window.scheduleDeviceEnvelopeRefresh = scheduleDeviceEnvelopeRefresh;

if (window.__pendingDeviceEnvelopeRefresh) {
    window.__pendingDeviceEnvelopeRefresh = false;
    scheduleDeviceEnvelopeRefresh(100);
}

/**
 * PAGE -> REQUIRED HARDWARE MAP
 * Key   = URL path segment (e.g. 'nfc' for /nfc)
 * cap   = capability key in the device caps object
 * label = human-readable hardware name shown in banners
 */
const PAGE_HARDWARE_MAP = {
    // Built-in hardware (shown once device has that capability)
    location:  { cap: 'gps',      label: 'GPS module' },
    storage:   { cap: 'storage',  label: 'storage module' },
    intercom:  { cap: 'intercom', label: 'camera and audio live module' },
    webcam:    { cap: 'webcam',   label: 'camera feed module' },
    // Optional add-on hardware pages
    display:   { cap: 'display',  label: 'OLED display (SSD1306)' },
    nfc:       { cap: 'nfc',      label: 'NFC module (PN532)' },
    rfid:      { cap: 'rfid',     label: 'RFID module (RC522)' },
    touch:     { cap: 'touch',    label: 'capacitive touch (ESP32-S3 built-in)' },
    keyboard:  { cap: 'keyboard', label: 'matrix keyboard module' },
};

/**
 * Apply device capability profile to sidebar nav items and page banners.
 *
 * Sidebar behaviour:
 *  - Modules are shown only when the active device reports the needed capability.
 *  - Core always-visible items can still stay present even if the capability is unknown.
 *
 * Page banner:
 *  - <div id="capBanner" data-cap="nfc"> is shown when the device lacks that cap.
 */
const ALWAYS_VISIBLE_CAPS = new Set(['battery']);
const SIDEBAR_VISIBILITY_CACHE_PREFIX = 'sidebarVisibility_v1_';
const COMPLETE_GATED_CAPS = new Set([
    'sms', 'calls', 'contacts', 'ussd', 'internet', 'modem', 'wifi', 'gps',
    'storage', 'sd', 'camera', 'webcam', 'audio', 'intercom', 'gpio',
    'display', 'nfc', 'rfid', 'touch', 'keyboard'
]);

function getSidebarVisibilityCacheStorageKey(deviceId) {
    const normalizedId = String(deviceId || '').trim();
    return normalizedId ? `${SIDEBAR_VISIBILITY_CACHE_PREFIX}${normalizedId}` : '';
}

function getSidebarVisibilityDescriptor(el) {
    if (!el) return '';
    if (el.id) return `id:${el.id}`;

    const header = String(el.getAttribute('data-nav-section-header') || '').trim();
    if (header) return `header:${header}`;

    const href = String(el.querySelector('a')?.getAttribute('href') || '').trim();
    const section = String(el.getAttribute('data-nav-section') || '').trim();
    const cap = String(el.getAttribute('data-cap') || '').trim();
    const capAny = String(el.getAttribute('data-cap-any') || '').trim();
    const selectorKind = el.getAttribute('data-device-selector') === 'true'
        ? 'device-selector'
        : (el.getAttribute('data-sim-selector') === 'true' ? 'sim-selector' : '');

    return [section, href, cap, capAny, selectorKind].filter(Boolean).join('|');
}

function collectSidebarVisibilitySnapshot() {
    const snapshot = {};
    document.querySelectorAll('[data-device-nav="true"], [data-nav-section-header]').forEach(el => {
        const descriptor = getSidebarVisibilityDescriptor(el);
        if (!descriptor) return;
        snapshot[descriptor] = el.style.display === 'none' ? 'none' : '';
    });
    return snapshot;
}

function saveSidebarVisibilitySnapshot(deviceId) {
    const storageKey = getSidebarVisibilityCacheStorageKey(deviceId);
    if (!storageKey) return;
    try {
        localStorage.setItem(storageKey, JSON.stringify({
            savedAt: Date.now(),
            visibility: collectSidebarVisibilitySnapshot()
        }));
    } catch (_) {}
}

function applySidebarVisibilitySnapshot(snapshot = {}) {
    let applied = false;
    document.querySelectorAll('[data-device-nav="true"], [data-nav-section-header]').forEach(el => {
        const descriptor = getSidebarVisibilityDescriptor(el);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(snapshot, descriptor)) return;
        el.style.display = snapshot[descriptor];
        applied = true;
    });
    return applied;
}

function loadCachedSidebarVisibility(deviceId) {
    const storageKey = getSidebarVisibilityCacheStorageKey(deviceId);
    if (!storageKey) return false;
    try {
        const payload = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (!payload?.visibility || typeof payload.visibility !== 'object') return false;
        return applySidebarVisibilitySnapshot(payload.visibility);
    } catch (_) {
        return false;
    }
}

function getSidebarRegisteredDeviceCount() {
    if (window.HAS_REGISTERED_DEVICES === false || window.HAS_ACTIVE_DEVICE === false) {
        return 0;
    }

    const selector = document.getElementById('sidebarDeviceSelector');
    const renderedCount = selector
        ? Array.from(selector.options || []).filter(option => {
            const value = String(option.value || '').trim();
            return value && value !== '__add_new__';
        }).length
        : 0;
    if (renderedCount > 0) return renderedCount;

    const activeDeviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : (window.DEVICE_ID || localStorage.getItem('activeDeviceId') || '');
    const normalizedDeviceId = String(activeDeviceId || '').trim();
    if (!normalizedDeviceId) return 0;

    try {
        const cachedCatalog = window.__sidebarDeviceCatalog
            || JSON.parse(localStorage.getItem('sidebarDeviceCatalog_v1') || '{}')
            || {};
        if (cachedCatalog[normalizedDeviceId]) {
            return 1;
        }
    } catch (_) {}

    try {
        if (localStorage.getItem('deviceCaps_' + normalizedDeviceId)) {
            return 1;
        }
    } catch (_) {}

    try {
        const payload = JSON.parse(localStorage.getItem('sidebarDeviceListCache_v1') || 'null');
        const cachedDevices = Array.isArray(payload?.devices) ? payload.devices : [];
        if (cachedDevices.some(device => String(device?.id || '').trim() === normalizedDeviceId)) {
            return 1;
        }
    } catch (_) {}

    return 0;
}

function updateSidebarSectionVisibility() {
    document.querySelectorAll('[data-nav-section-header]').forEach(header => {
        const section = header.getAttribute('data-nav-section-header');
        if (!section) return;

        const items = Array.from(document.querySelectorAll(`[data-nav-section="${section}"]`));
        const hasVisibleItems = items.some(item => item.style.display !== 'none');
        header.style.display = hasVisibleItems ? '' : 'none';
    });
}

function getActiveDeviceTypeContext() {
    const value = typeof window.getActiveDeviceType === 'function'
        ? window.getActiveDeviceType()
        : (window.ACTIVE_DEVICE_TYPE || localStorage.getItem('activeDeviceType') || '');
    return String(value || '').trim().toLowerCase();
}

function matchesSidebarDeviceType(el) {
    if (!el) return true;

    const activeType = getActiveDeviceTypeContext();
    const hideTypes = String(el.getAttribute('data-hide-device-type') || '')
        .split(',')
        .map(value => value.trim().toLowerCase())
        .filter(Boolean);
    const showTypes = String(el.getAttribute('data-show-device-type') || '')
        .split(',')
        .map(value => value.trim().toLowerCase())
        .filter(Boolean);

    if (showTypes.length) {
        return Boolean(activeType) && showTypes.includes(activeType);
    }

    if (!activeType) {
        return true;
    }

    return !hideTypes.includes(activeType);
}

function isCapabilityComplete(caps, key) {
    const normalized = String(key || '').trim();
    if (!normalized) return false;
    const moduleKey = normalized === 'sd'
        ? 'storage'
        : (normalized === 'camera' ? 'webcam' : normalized);

    if (caps.modules && typeof caps.modules === 'object') {
        if (caps.modules[moduleKey]) {
            return Boolean(caps.modules[moduleKey].available || caps.modules[moduleKey].complete);
        }
        if (COMPLETE_GATED_CAPS.has(normalized)) {
            return false;
        }
    }

    if (COMPLETE_GATED_CAPS.has(normalized) && !caps.modules) {
        return false;
    }

    if (normalized === 'sd') {
        return Boolean(caps.storage || caps.sd);
    }
    if (normalized === 'camera') {
        return Boolean(caps.webcam || caps.camera);
    }
    return Boolean(caps[normalized]);
}

function refreshSidebarDeviceNavigation() {
    const activeDeviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';
    const hasActiveDevice = hasActiveDeviceContext();
    const hasRegisteredDevices = getSidebarRegisteredDeviceCount() > 0;
    const shouldShowDeviceNav = hasActiveDevice && hasRegisteredDevices;
    document.querySelectorAll('.sidebar-content').forEach(sidebarContent => {
        sidebarContent.classList.toggle('device-nav-empty', !shouldShowDeviceNav);
    });

    document.querySelectorAll('[data-device-nav="true"]').forEach(el => {
        const isCapabilityAware = el.hasAttribute('data-cap') || el.hasAttribute('data-cap-any');
        if (!shouldShowDeviceNav) {
            el.style.display = 'none';
            return;
        }
        if (!matchesSidebarDeviceType(el)) {
            el.style.display = 'none';
            return;
        }
        if (!isCapabilityAware) {
            el.style.display = '';
        }
    });

    updateSidebarSectionVisibility();
    saveSidebarVisibilitySnapshot(activeDeviceId);
    syncSidebarDeviceAwareLinks();

    const simWrap = document.getElementById('sidebarSimSelectorWrap');
    if (simWrap && !shouldShowDeviceNav) {
        hideElement(simWrap);
    }
}

function applyDeviceCapabilities(caps) {
    if (!caps || typeof caps !== 'object') return;
    const activeDeviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';

    document.querySelectorAll('[data-cap], [data-cap-any]').forEach(el => {
        const singleKey = el.getAttribute('data-cap');
        const anyKeys = String(el.getAttribute('data-cap-any') || '')
            .split(',')
            .map(key => key.trim())
            .filter(Boolean);
        const keys = anyKeys.length ? anyKeys : (singleKey ? [singleKey] : []);
        if (!keys.length) return;
        if (!matchesSidebarDeviceType(el)) {
            el.style.display = 'none';
            const warn = el.querySelector('.cap-warn');
            if (warn) hideElement(warn);
            return;
        }

        const has = anyKeys.length
            ? keys.some(key => isCapabilityComplete(caps, key))
            : keys.every(key => isCapabilityComplete(caps, key));
        const isCore = el.getAttribute('data-cap-core') === 'true'
            || keys.some(key => ALWAYS_VISIBLE_CAPS.has(key));

        el.style.display = '';
        const warn = el.querySelector('.cap-warn');
        const link = el.querySelector('a');
        const showWarning = false;
        const shouldHide = (!isCore && !has);
        if (shouldHide) {
            el.style.display = 'none';
        }
        if (warn) {
            if (showWarning) {
                showElement(warn, 'inline-block');
            } else {
                hideElement(warn);
            }
        }
        if (link) {
            link.style.opacity = '';
        }
    });

    refreshSidebarDeviceNavigation();
    saveSidebarVisibilitySnapshot(activeDeviceId);

    // In-page banner
    const banner = document.getElementById('capBanner');
    if (banner) {
        const key = banner.getAttribute('data-cap');
        if (key) {
            if (isCapabilityComplete(caps, key)) {
                hideElement(banner);
            } else {
                showElement(banner, 'flex');
            }
        }
    }
}

function resetCapabilityVisibility(options = {}) {
    const hideWhenNoDevice = options.hideWhenNoDevice === true;
    const hasDevice = hasActiveDeviceContext();
    const activeDeviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';
    document.querySelectorAll('[data-cap], [data-cap-any]').forEach(el => {
        const singleKey = el.getAttribute('data-cap');
        const anyKeys = String(el.getAttribute('data-cap-any') || '')
            .split(',')
            .map(key => key.trim())
            .filter(Boolean);
        const keys = anyKeys.length ? anyKeys : (singleKey ? [singleKey] : []);
        const isCore = el.getAttribute('data-cap-core') === 'true'
            || keys.some(key => ALWAYS_VISIBLE_CAPS.has(key));

        if (!matchesSidebarDeviceType(el)) {
            el.style.display = 'none';
            const warn = el.querySelector('.cap-warn');
            const link = el.querySelector('a');
            if (warn) hideElement(warn);
            if (link) link.style.opacity = '';
            return;
        }

        el.style.display = '';
        const warn = el.querySelector('.cap-warn');
        const link = el.querySelector('a');
        if (warn) hideElement(warn);
        if (link) link.style.opacity = '';

        if (!isCore) {
            el.style.display = 'none';
        }
    });

    if (hideWhenNoDevice && !hasDevice) {
        refreshSidebarDeviceNavigation();
        return;
    }

    refreshSidebarDeviceNavigation();
    saveSidebarVisibilitySnapshot(activeDeviceId);
}

function loadCachedDeviceCapabilities(deviceId, options = {}) {
    const preserveVisibilityOnMiss = options.preserveVisibilityOnMiss === true;
    if (!deviceId) {
        resetCapabilityVisibility({ hideWhenNoDevice: true });
        return false;
    }

    try {
        const cached = localStorage.getItem('deviceCaps_' + deviceId);
        if (!cached) {
            if (!preserveVisibilityOnMiss) {
                resetCapabilityVisibility();
            }
            return false;
        }

        applyDeviceCapabilities(JSON.parse(cached));
        return true;
    } catch (_) {
        if (!preserveVisibilityOnMiss) {
            resetCapabilityVisibility();
        }
        return false;
    }
}

// On page load: apply cached caps instantly; live status comes from the shared refresh flow.
(function initDeviceCapabilities() {
    const deviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : (window.DEVICE_ID || localStorage.getItem('activeDeviceId') || '');
    latestDeviceStatus = {
        ...(latestDeviceStatus || {}),
        deviceId,
        online: false
    };
    updateDeviceConnection(false);
    updateHeaderDeviceSummary({
        deviceId,
        online: false
    }, latestQueueState);
    refreshSidebarDeviceNavigation();
    const restoredSidebarVisibility = loadCachedSidebarVisibility(deviceId);
    loadCachedDeviceCapabilities(deviceId, { preserveVisibilityOnMiss: restoredSidebarVisibility });

    if (!deviceId) return;
    scheduleDeviceEnvelopeRefresh(75);
})();

window.addEventListener('device:changed', function () {
    const deviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';
    activeIncomingCallContext = null;
    hideIncomingCallPanel();
    latestDeviceStatus = {
        deviceId,
        online: false
    };
    latestQueueState = { dashboard: null, device: null };
    const restoredSidebarVisibility = loadCachedSidebarVisibility(deviceId);
    loadCachedDeviceCapabilities(deviceId, { preserveVisibilityOnMiss: restoredSidebarVisibility });
    updateHeaderDeviceSummary(latestDeviceStatus, latestQueueState);
    updateSidebarSimSelector(latestDeviceStatus);
    updateUnreadBadge();
    scheduleDashboardSmsRefresh(150);
    scheduleDeviceEnvelopeRefresh(100);
    syncDashboardStatusDemand({ allowReconnect: false });
    syncCurrentLocationDeviceScope();
    syncSidebarDeviceAwareLinks();
});
window.addEventListener('device:sim-changed', function (event) {
    activeIncomingCallContext = null;
    hideIncomingCallPanel();
    updateUnreadBadge();
    scheduleDashboardSmsRefresh(100);
    const nextUrl = new URL(window.location.href);
    const explicitNextSlot = Number.parseInt(String(event?.detail?.simSlot ?? ''), 10);
    const simContext = resolveActiveDeviceSimContext();
    const nextSimSlot = Number.isFinite(explicitNextSlot) && explicitNextSlot >= 0
        ? explicitNextSlot
        : simContext.simSlot;
    if (nextSimSlot !== null && nextSimSlot !== undefined) {
        nextUrl.searchParams.set('simSlot', String(nextSimSlot));
    } else {
        nextUrl.searchParams.delete('simSlot');
    }
    nextUrl.searchParams.delete('simSubscriptionId');
    nextUrl.searchParams.delete('subscription_id');

    const nextHref = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
    if (window.location.pathname === '/' || window.location.pathname === '/dashboard') {
        window.location.replace(nextHref);
        return;
    }
    if (window.history?.replaceState) {
        window.history.replaceState({}, '', nextHref);
    }
    syncSidebarDeviceAwareLinks();
});

// Push notification helper
function pushNotify(title, body, icon) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
        try { new Notification(title, { body, icon }); } catch (_) {}
    } else if (Notification.permission === 'default') {
        Notification.requestPermission().then(perm => {
            if (perm === 'granted') {
                try { new Notification(title, { body, icon }); } catch (_) {}
            }
        });
    }
}

window.refreshSidebarDeviceNavigation = refreshSidebarDeviceNavigation;
window.syncSidebarDeviceAwareLinks = syncSidebarDeviceAwareLinks;

// Audio notification: synthesise short tones via Web Audio API (no file needed)
const _audioCtx = typeof AudioContext !== 'undefined' ? new AudioContext() : null;

function playNotificationSound(type) {
    if (!_audioCtx) return;
    try {
        if (type === 'sms') {
            // Two short beeps
            _playTone(880, 0.08, 0.0);
            _playTone(1100, 0.08, 0.15);
        } else if (type === 'call') {
            // Repeating ring pattern: three rising tones
            _playTone(440, 0.25, 0.0);
            _playTone(550, 0.25, 0.3);
            _playTone(660, 0.35, 0.6);
        }
    } catch (_) {}
}

function _playTone(freq, duration, startOffset) {
    const osc  = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.connect(gain);
    gain.connect(_audioCtx.destination);
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.18, _audioCtx.currentTime + startOffset);
    gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + startOffset + duration);
    osc.start(_audioCtx.currentTime + startOffset);
    osc.stop(_audioCtx.currentTime + startOffset + duration + 0.05);
}

// Initialize Bootstrap components
function initializeBootstrap() {
    if (!window.bootstrap) {
        console.warn('Bootstrap is not available yet');
        return;
    }

    // Initialize all tooltips
    var tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    tooltipTriggerList.map(function(tooltipTriggerEl) {
        return new bootstrap.Tooltip(tooltipTriggerEl, {
            boundary: document.body
        });
    });

    // Initialize all popovers
    var popoverTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="popover"]'));
    popoverTriggerList.map(function(popoverTriggerEl) {
        return new bootstrap.Popover(popoverTriggerEl, {
            boundary: document.body
        });
    });

    // Request notification permission proactively
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

// Setup event listeners
function setupEventListeners() {
    // Quick SMS send from dashboard
    const quickSendBtn = document.getElementById('quickSendSms');
    if (quickSendBtn) {
        quickSendBtn.addEventListener('click', function() {
            sendSms('quickSmsForm', this);
        });
    }
    
    // Message character counter
    const messageTextarea = document.querySelector('#quickSmsForm textarea[name="message"]');
    if (messageTextarea) {
        messageTextarea.addEventListener('input', function() {
            updateDashboardSmsComposerState(this);
        });
        updateDashboardSmsComposerState(messageTextarea);
    }
    
    // Mobile touch optimization
    document.querySelectorAll('.btn, .nav-link, .list-group-item').forEach(el => {
        el.addEventListener('touchstart', function() {
            this.style.opacity = '0.8';
        });
        el.addEventListener('touchend', function() {
            this.style.opacity = '1';
        });
    });
}

// Start connection monitoring
function startConnectionMonitoring() {
    if (connectionCheckInterval) {
        clearInterval(connectionCheckInterval);
    }

    connectionCheckInterval = setInterval(() => {
        if (!isDashboardVisible() || !isStatusDemandActive()) {
            return;
        }
        requestDashboardStatus({
            includeServerStatus: false,
            includeMqttStatus: false,
            includeDeviceStatus: true
        });
    }, statusRefreshIntervalMs);
}

// Legacy hook kept for compatibility; status refresh is now handled centrally.
function startDeviceStatusUpdates() {
    if (window.deviceStatusInterval) {
        clearInterval(window.deviceStatusInterval);
    }
}

// Update device status via API
function updateDeviceStatus() {
    requestDashboardStatus({ force: true }).catch(error => console.error('Error updating device status:', error));
}

function analyzeDashboardSmsText(text) {
    if (window.smsComposeLimits?.analyze) {
        return window.smsComposeLimits.analyze(text);
    }

    const normalized = String(text || '');
    return {
        text: normalized,
        characters: normalized.length,
        utf8Bytes: normalized.length,
        parts: normalized.length > 160 ? Math.ceil(normalized.length / 153) : 1,
        encoding: 'gsm7',
        valid: normalized.length <= 1023,
        overByteLimit: normalized.length > 1023,
        overPartLimit: false
    };
}

function clampDashboardSmsText(text) {
    if (window.smsComposeLimits?.clamp) {
        return window.smsComposeLimits.clamp(text);
    }
    return String(text || '').slice(0, 1023);
}

function updateDashboardSmsComposerState(textarea) {
    const charCount = document.getElementById('charCount');
    const charBytes = document.getElementById('charBytes');
    const charParts = document.getElementById('charParts');

    if (!textarea || !charCount) {
        return analyzeDashboardSmsText(textarea?.value || '');
    }

    const clamped = clampDashboardSmsText(textarea.value);
    if (clamped !== textarea.value) {
        textarea.value = clamped;
    }

    const analysis = analyzeDashboardSmsText(textarea.value);
    charCount.textContent = String(analysis.characters);
    if (charBytes) {
        charBytes.textContent = String(analysis.utf8Bytes);
    }
    if (charParts) {
        charParts.textContent = `(${analysis.parts} part${analysis.parts === 1 ? '' : 's'}, ${analysis.encoding === 'gsm7' ? 'GSM-7' : 'Unicode'})`;
    }

    charCount.className = '';
    if (analysis.utf8Bytes >= 0.8 * (window.smsComposeLimits?.SMS_MAX_UTF8_BYTES || 1023)) {
        charCount.classList.add('text-warning');
    }
    if (analysis.parts > 1) {
        charCount.classList.remove('text-warning');
        charCount.classList.add('text-info');
    }
    if (!analysis.valid) {
        charCount.classList.remove('text-info');
        charCount.classList.add('text-danger');
    }

    return analysis;
}

// Refresh connection status manually
function refreshConnectionStatus(event) {
    const btn = event?.target?.closest ? event.target.closest('button') : null;
    const originalHtml = btn?.innerHTML || '';
    if (btn) {
        btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
        btn.disabled = true;
    }

    updateConnectionStatus('connecting');

    requestDashboardStatus({ force: true })
        .catch(error => console.error('Error refreshing connection status:', error))
        .finally(() => {
            if (!btn) return;
            setTimeout(() => {
                btn.innerHTML = originalHtml;
                btn.disabled = false;
            }, 500);
        });
}

// Send SMS function
function sendSms(formId, button) {
    const form = document.getElementById(formId);
    if (!form) {
        console.error('Form not found:', formId);
        return;
    }
    
    // Get form data
    const formData = new FormData(form);
    let to = formData.get('to');
    const message = String(formData.get('message') || '').trim();
    const activeDeviceId = getDashboardSmsDeviceId();
    const selectedSim = getSelectedSimSlotSnapshot(latestDeviceStatus);
    const analysis = analyzeDashboardSmsText(message);
    
    // Validate
    if (!to || !message) {
        showToast('Please fill in all fields', 'warning');
        return;
    }
    if (!activeDeviceId) {
        showToast('Select a device first.', 'warning');
        return;
    }
    if (!analysis.valid) {
        showToast(window.smsComposeLimits?.formatError?.(analysis) || 'SMS message exceeds the device limit.', 'warning');
        return;
    }
    
    // Clean phone number
    to = to.replace(/\s/g, '');
    
    // Show loading state
    const spinner = button.querySelector('.spinner-border');
    if (spinner) spinner.classList.remove('d-none');
    button.disabled = true;

    const cancelFeedback = typeof mqttWaitFeedback === 'function' ? mqttWaitFeedback(button) : null;

    console.log('Sending SMS to:', to, 'Message:', message);

    fetch(buildDashboardSmsRequestUrl('/api/sms/send'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            to: to,
            message: message,
            deviceId: activeDeviceId,
            simSlot: selectedSim?.slotIndex ?? null
        })
    })
    .then(async response => {
        const contentType = response.headers.get('content-type') || '';
        let payload = null;

        if (contentType.includes('application/json')) {
            payload = await response.json();
        } else {
            const text = await response.text();
            payload = text ? { message: text } : null;
        }

        if (!response.ok) {
            const error = new Error(
                payload?.message
                || payload?.error
                || `Request failed with HTTP ${response.status}`
            );
            error.status = response.status;
            error.payload = payload;
            throw error;
        }

        return payload || {};
    })
    .then(data => {
        console.log('SMS send response:', data);
        
        if (data.success) {
            // Close modal
            const modalElement = form.closest('.modal');
            if (modalElement) {
                const modal = bootstrap.Modal.getInstance(modalElement);
                if (modal) modal.hide();
            }
            
            showToast(
                data.queued
                    ? 'SMS queued for delivery.'
                    : 'SMS sent successfully.',
                'success'
            );
            
            // Reset form
            form.reset();
            
            // Reset counter
            updateDashboardSmsComposerState(form.querySelector('textarea[name="message"]'));

            updateUnreadBadge();
            refreshDashboardSmsPreview();
            if (typeof scheduleDashboardSmsRefresh === 'function') {
                scheduleDashboardSmsRefresh(200);
            }
        } else {
            showToast('Failed to send SMS: ' + (data.message || 'Unknown error'), 'danger');
        }
    })
    .catch(error => {
        console.error('Error sending SMS:', error);
        showToast(`Error sending SMS: ${error.message || 'Please try again.'}`, 'danger');
    })
    .finally(() => {
        // Hide loading state
        if (cancelFeedback) cancelFeedback();
        if (spinner) spinner.classList.add('d-none');
        button.disabled = false;
    });
}

// Update unread SMS badge
function renderUnreadBadgeState(count) {
    const badge = document.getElementById('unreadSmsBadge');
    const inboxBadge = document.getElementById('inboxUnreadBadge');

    if (count > 0) {
        if (badge) {
            badge.textContent = count;
            showElement(badge, 'inline');
        }
        if (inboxBadge) {
            inboxBadge.textContent = count;
            inboxBadge.classList.remove('d-none');
        }

        document.title = `(${count}) Device Bridge`;
    } else {
        hideElement(badge);
        if (inboxBadge) inboxBadge.classList.add('d-none');
        document.title = 'Device Bridge';
    }
}

function updateUnreadBadge(unreadCountOverride) {
    if (unreadCountOverride !== undefined && unreadCountOverride !== null) {
        renderUnreadBadgeState(Number(unreadCountOverride) || 0);
        return Promise.resolve(Number(unreadCountOverride) || 0);
    }

    const requestScope = {
        deviceId: getDashboardSmsDeviceId(),
        simSlot: getDashboardSmsActiveSimSlot()
    };
    const requestToken = ++dashboardSmsUnreadToken;

    return fetch(buildDashboardSmsRequestUrl('/api/sms/unread', true), {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        }
    })
        .then(response => response.json())
        .then(data => {
            if (requestToken !== dashboardSmsUnreadToken || !isDashboardSmsScopeSnapshotCurrent(requestScope)) {
                return null;
            }
            renderUnreadBadgeState(Number(data?.count) || 0);
            return Number(data?.count) || 0;
        })
        .catch(error => console.error('Error updating unread badge:', error));
}

function normalizeToastDedupeText(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[.!?]+$/g, '');
}

function shouldSuppressDuplicateToast(message, type, title) {
    const now = Date.now();
    const key = [
        normalizeToastDedupeText(title),
        normalizeToastDedupeText(type),
        normalizeToastDedupeText(message)
    ].join('|');

    recentToastKeys.forEach((timestamp, existingKey) => {
        if ((now - timestamp) > TOAST_DEDUPE_WINDOW_MS) {
            recentToastKeys.delete(existingKey);
        }
    });

    const lastSeenAt = recentToastKeys.get(key);
    if (lastSeenAt && (now - lastSeenAt) <= TOAST_DEDUPE_WINDOW_MS) {
        return true;
    }

    recentToastKeys.set(key, now);
    return false;
}

// Show toast notification
function showToast(message, type = 'info', title = 'Notification') {
    const toastTemplate = document.getElementById('liveToast');
    if (!toastTemplate || !window.bootstrap) return;
    if (shouldSuppressDuplicateToast(message, type, title)) return;

    const notificationArea = document.getElementById('dashboardNotificationArea') || toastTemplate.parentElement;
    const toastEl = toastTemplate.cloneNode(true);
    toastEl.removeAttribute('id');
    toastEl.removeAttribute('data-toast-template');
    toastEl.classList.remove('d-none');

    const titleEl = toastEl.querySelector('#toastTitle');
    const messageEl = toastEl.querySelector('#toastMessage');
    const timeEl = toastEl.querySelector('#toastTime');
    titleEl?.removeAttribute('id');
    messageEl?.removeAttribute('id');
    timeEl?.removeAttribute('id');
    
    // Set icon based on type
    const iconMap = {
        success: 'bi-check-circle-fill text-success',
        danger: 'bi-exclamation-circle-fill text-danger',
        warning: 'bi-exclamation-triangle-fill text-warning',
        info: 'bi-info-circle-fill text-info'
    };
    
    const icon = toastEl.querySelector('.toast-header i');
    icon.className = iconMap[type] || 'bi-info-circle-fill text-info';
    
    // Set title and message
    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;
    if (timeEl) timeEl.textContent = 'just now';

    toastEl.addEventListener('hidden.bs.toast', function () {
        toastEl.remove();
    });

    notificationArea.appendChild(toastEl);

    const toast = new bootstrap.Toast(toastEl, {
        autohide: true,
        delay: 5000
    });
    
    toast.show();
}

// Handle orientation change
function handleOrientationChange() {
    const isLandscape = window.orientation === 90 || window.orientation === -90;
    
    if (isLandscape) {
        document.body.classList.add('landscape');
    } else {
        document.body.classList.remove('landscape');
    }
    
    // Close sidebar on orientation change if needed
    if (window.innerWidth < 768) {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');
        if (sidebar && sidebar.classList.contains('show')) {
            sidebar.classList.remove('show');
            overlay.style.display = 'none';
        }
    }
}

// Handle resize events
function handleResize() {
    updatePaginationDisplay();
}

// Update pagination for mobile
function updatePaginationDisplay() {
    const isMobile = window.innerWidth < 768;
    const paginationItems = document.querySelectorAll('.pagination .page-item:not(:first-child):not(:last-child)');
    
    if (isMobile && paginationItems.length > 3) {
        paginationItems.forEach((item, index) => {
            if (index > 2 && index < paginationItems.length - 1) {
                item.style.display = 'none';
            }
        });
    } else {
        paginationItems.forEach(item => {
            item.style.display = '';
        });
    }
}

// Toggle sidebar
window.toggleSidebar = function() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    
    if (!sidebar || !overlay) return;
    
    sidebar.classList.toggle('show');
    
    if (sidebar.classList.contains('show')) {
        overlay.style.display = 'block';
        document.body.style.overflow = 'hidden';
    } else {
        overlay.style.display = 'none';
        document.body.style.overflow = '';
    }
};

// Cleanup on page unload
window.addEventListener('beforeunload', function() {
    if (connectionCheckInterval) {
        clearInterval(connectionCheckInterval);
    }
    if (window.deviceStatusInterval) {
        clearInterval(window.deviceStatusInterval);
    }
});

// Incoming call controls

window.dismissIncomingCallPanel = function () {
    hideIncomingCallPanel();
};

window.answerIncomingCall = async function () {
    hideIncomingCallPanel();
    setIncomingCallActionState(true);
    try {
        const callContext = activeIncomingCallContext || resolveActiveDeviceSimContext();
        const res = await fetch('/api/calls/answer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(callContext)
        });
        const data = await res.json();
        if (data.success) showToast('Call answered', 'success');
        else showToast(data.message || 'Failed to answer call', 'danger');
    } catch (e) {
        showToast('Failed to answer call', 'danger');
    } finally {
        setIncomingCallActionState(false);
    }
};

window.rejectIncomingCall = async function () {
    hideIncomingCallPanel();
    setIncomingCallActionState(true);
    try {
        const callContext = activeIncomingCallContext || resolveActiveDeviceSimContext();
        const res = await fetch('/api/calls/reject', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(callContext)
        });
        const data = await res.json();
        if (data.success) showToast('Call rejected', 'info');
        else showToast(data.message || 'Failed to reject call', 'danger');
    } catch (e) {
        showToast('Failed to reject call', 'danger');
    } finally {
        setIncomingCallActionState(false);
    }
};

// Dark mode

function applyDarkMode(dark) {
    document.documentElement.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
    const icon = document.getElementById('darkModeIcon');
    if (icon) icon.className = dark ? 'bi bi-sun-fill' : 'bi bi-moon-stars-fill';
}

window.toggleDarkMode = function () {
    const isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
    const next = !isDark;
    const themeVal = next ? 'dark' : 'light';
    try { localStorage.setItem('theme', themeVal); } catch (_) {}
    applyDarkMode(next);
    // Persist to server (best-effort)
    fetch('/api/settings/theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: themeVal })
    }).catch(() => {});
};

// Sync icon with server-applied theme on load; fall back to localStorage/system preference
(function () {
    try {
        const serverTheme = document.documentElement.getAttribute('data-bs-theme');
        if (serverTheme) {
            // Server already applied the correct theme via HTML attribute; just update the icon
            const icon = document.getElementById('darkModeIcon');
            if (icon) icon.className = serverTheme === 'dark' ? 'bi bi-sun-fill' : 'bi bi-moon-stars-fill';
            try { localStorage.setItem('theme', serverTheme); } catch (_) {}
        } else {
            // No server theme; fall back to localStorage / system preference
            const saved = localStorage.getItem('theme');
            const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
            applyDarkMode(saved ? saved === 'dark' : prefersDark);
        }
    } catch (_) {}
})();

// Export functions for use in other files
window.showToast = showToast;
window.updateUnreadBadge = updateUnreadBadge;
window.sendSms = sendSms;
window.refreshConnectionStatus = refreshConnectionStatus;
window.toggleSidebar = toggleSidebar;
window.getDeviceHardwareIdentity = getDeviceHardwareIdentity;
window.getActiveDeviceSimSlot = function () {
    return resolveActiveDeviceSimContext().simSlot;
};
window.getActiveDeviceSimContext = function () {
    return resolveActiveDeviceSimContext();
};
window.deviceHttpOnline = function () {
    return inferDeviceHttpOnline(latestDeviceStatus);
};
window.switchActiveSim = function (slotIndex) {
    const activeDeviceId = getStatusActiveDeviceId();
    const nextSlot = setStoredActiveSimSlot(slotIndex, activeDeviceId);
    const nextUrl = new URL(window.location.href);
    if (nextSlot !== null && nextSlot !== undefined) {
        nextUrl.searchParams.set('simSlot', String(nextSlot));
    } else {
        nextUrl.searchParams.delete('simSlot');
    }
    nextUrl.searchParams.delete('simSubscriptionId');
    nextUrl.searchParams.delete('subscription_id');
    if (window.history?.replaceState) {
        window.history.replaceState({}, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    }
    updateSidebarSimSelector(latestDeviceStatus);
    updateDeviceMetrics(latestDeviceStatus || {});
    updateDashboardCards(latestDeviceStatus || {});
    window.dispatchEvent(new CustomEvent('device:sim-changed', {
        detail: {
            deviceId: activeDeviceId,
            simSlot: nextSlot
        }
    }));
};


