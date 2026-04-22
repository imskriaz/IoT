// Modem/Internet Management JavaScript
(function () {
    'use strict';

    console.log('Internet Manager loaded - ' + new Date().toISOString());

    let updateInterval = null;
    let initialized = false;
    let currentStatus = null;
    let deviceId = resolveActiveDeviceId();
    let isDeviceOnline = false;
    let scanInProgress = false;
    let statusRefreshPromise = null;
    let lastStatusRefreshAt = 0;
    let lastUsageSnapshot = null;
    let lastWifiScanResults = null;
    let lastWifiScanDeviceId = '';
    const DEFAULT_STATUS_REFRESH_INTERVAL_MS = 60000;
    const STATUS_REFRESH_COOLDOWN_MS = 3000;
    let statusRefreshIntervalMs = DEFAULT_STATUS_REFRESH_INTERVAL_MS;
    let runtimeCapabilities = {
        mobile: {
            remoteToggle: true,
            remoteApn: true
        },
        wifiClient: {
            scan: true,
            remoteToggle: false,
            remoteConnect: false,
            remoteDisconnect: false,
            retrySaved: false,
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
        dataUsage: {
            remoteReset: false
        }
    };
    const SIGNAL_HISTORY_LIMIT = 24;
    const USAGE_HISTORY_LIMIT = 36;
    const signalCharts = {
        mobile: null,
        wifi: null
    };
    const usageCharts = {
        history: null
    };

    // DOM Elements
    const elements = {
        // Internet status
        internetStatusCard: document.getElementById('internetStatusCard'),
        internetIcon: document.getElementById('internetIcon'),
        internetStatus: document.getElementById('internetStatus'),
        internetDetails: document.getElementById('internetDetails'),
        activeSource: document.getElementById('activeSource'),

        // Mobile
        mobileToggle: document.getElementById('mobileToggle'),
        mobileToggleLabel: document.getElementById('mobileToggleLabel'),
        mobileIcon: document.getElementById('mobileIcon'),
        mobileStatus: document.getElementById('mobileStatus'),
        mobileOperator: document.getElementById('mobileOperator'),
        mobileNetwork: document.getElementById('mobileNetwork'),
        mobileSignalBar: document.getElementById('mobileSignalBar'),
        mobileSignal: document.getElementById('mobileSignal'),
        mobileIP: document.getElementById('mobileIP'),
        simStatus: document.getElementById('simStatus'),
        simNumber: document.getElementById('simNumber'),
        detectSimNumberBtn: document.getElementById('detectSimNumberBtn'),
        mobileDataUsed: document.getElementById('mobileDataUsed'),

        // WiFi Client
        wifiClientBadge: document.getElementById('wifiClientBadge'),
        wifiToggle: document.getElementById('wifiToggle'),
        wifiToggleLabel: document.getElementById('wifiToggleLabel'),
        wifiClientIcon: document.getElementById('wifiClientIcon'),
        wifiClientSSID: document.getElementById('wifiClientSSID'),
        wifiClientStatus: document.getElementById('wifiClientStatus'),
        wifiClientSignalBar: document.getElementById('wifiClientSignalBar'),
        wifiClientSignal: document.getElementById('wifiClientSignal'),
        wifiClientIP: document.getElementById('wifiClientIP'),
        wifiClientSecurity: document.getElementById('wifiClientSecurity'),
        wifiClientChannel: document.getElementById('wifiClientChannel'),
        wifiClientBSSID: document.getElementById('wifiClientBSSID'),
        wifiClientHint: document.getElementById('wifiClientHint'),
        wifiSavedProfileMeta: document.getElementById('wifiSavedProfileMeta'),
        wifiNetworksSummary: document.getElementById('wifiNetworksSummary'),
        wifiClientDiagnostics: document.getElementById('wifiClientDiagnostics'),
        retrySavedWiFiBtn: document.getElementById('retrySavedWiFiBtn'),
        disconnectWiFiBtn: document.getElementById('disconnectWiFiBtn'),
        scanWiFiBtn: document.getElementById('scanWiFiBtn'),

        // WiFi Hotspot
        hotspotToggle: document.getElementById('hotspotToggle'),
        hotspotToggleLabel: document.getElementById('hotspotToggleLabel'),
        hotspotIcon: document.getElementById('hotspotIcon'),
        hotspotSSID: document.getElementById('hotspotSSID'),
        hotspotClientsCount: document.getElementById('hotspotClientsCount'),
        clientCount: document.getElementById('clientCount'),
        refreshHotspotClientsBtn: document.getElementById('refreshHotspotClientsBtn'),
        clientsList: document.getElementById('clientsList'),

        // USB
        usbToggle: document.getElementById('usbToggle'),
        usbToggleLabel: document.getElementById('usbToggleLabel'),
        usbIcon: document.getElementById('usbIcon'),
        usbStatus: document.getElementById('usbStatus'),
        usbDetails: document.getElementById('usbDetails'),

        // Data Usage
        totalSent: document.getElementById('totalSent'),
        totalReceived: document.getElementById('totalReceived'),
        totalUsage: document.getElementById('totalUsage'),
        mobileSent: document.getElementById('mobileSent'),
        mobileReceived: document.getElementById('mobileReceived'),
        wifiSent: document.getElementById('wifiSent'),
        wifiReceived: document.getElementById('wifiReceived'),
        dataUsageNotice: document.getElementById('dataUsageNotice'),
        dataUsageResetBtn: document.getElementById('dataUsageResetBtn'),

        // APN Form
        apnName: document.getElementById('apnName'),
        apnUsername: document.getElementById('apnUsername'),
        apnPassword: document.getElementById('apnPassword'),
        apnAuth: document.getElementById('apnAuth'),
        apnSaveBtn: document.getElementById('apnSaveBtn'),

        // Hotspot Form
        hotspotSsid: document.getElementById('hotspotSsid'),
        hotspotPassword: document.getElementById('hotspotPassword'),
        hotspotSecurity: document.getElementById('hotspotSecurity'),
        hotspotBand: document.getElementById('hotspotBand'),
        hotspotChannel: document.getElementById('hotspotChannel'),
        hotspotMaxClients: document.getElementById('hotspotMaxClients'),
        hotspotHidden: document.getElementById('hotspotHidden'),
        hotspotForm: document.getElementById('hotspotForm'),
        hotspotSaveBtn: document.getElementById('hotspotSaveBtn'),
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        if (initialized) return;
        initialized = true;

        console.log('Initializing Internet Manager...');
        if (typeof window.syncBootstrapTabsWithUrl === 'function') {
            window.syncBootstrapTabsWithUrl(document);
        }

        initSignalCharts();
        initUsageCharts();
        loadStatus();
        attachEventListeners();
        loadRuntimeSettings().finally(() => startUpdates());
        attachSocketListeners();
    }

    function normalizeStatusRefreshInterval(value) {
        const parsed = Number.parseInt(String(value ?? ''), 10);
        if (!Number.isFinite(parsed)) return DEFAULT_STATUS_REFRESH_INTERVAL_MS;
        return Math.max(5000, Math.min(3600000, parsed));
    }

    async function loadRuntimeSettings() {
        try {
            const settings = window.loadDashboardRuntimeSettings
                ? await window.loadDashboardRuntimeSettings()
                : null;
            statusRefreshIntervalMs = normalizeStatusRefreshInterval(settings?.deviceStatusRefreshMs);
        } catch (_) {
            statusRefreshIntervalMs = DEFAULT_STATUS_REFRESH_INTERVAL_MS;
        }
    }

    function resolveActiveDeviceId() {
        const byQuery = new URLSearchParams(window.location.search).get('device') || '';
        const byGetter = typeof window.getActiveDeviceId === 'function'
            ? window.getActiveDeviceId()
            : '';
        const byGlobal = window.DEVICE_ID || localStorage.getItem('activeDeviceId') || '';
        const byResolver = typeof window.resolveActiveDeviceId === 'function'
            ? window.resolveActiveDeviceId(false)
            : '';
        const resolvedByResolver = typeof byResolver === 'string' ? byResolver : '';

        return String(byQuery || byGetter || byGlobal || resolvedByResolver || '').trim();
    }

    function syncActiveDeviceId() {
        const nextDeviceId = resolveActiveDeviceId() || deviceId;
        if (nextDeviceId !== deviceId) {
            deviceId = nextDeviceId;
            lastWifiScanResults = null;
            lastWifiScanDeviceId = '';
        } else {
            deviceId = nextDeviceId;
        }
        return deviceId;
    }

    function hasLiveConnectivity(status = currentStatus) {
        if (!status || typeof status !== 'object') {
            return false;
        }

        return Boolean(
            status.internet?.available
            || status.mobile?.connected
            || status.wifiClient?.connected
            || status.usb?.connected
            || String(status.internet?.activeSource || '').trim().toLowerCase() !== 'none'
        );
    }

    function preserveLiveUiOnRefreshFailure() {
        if (!currentStatus || !hasLiveConnectivity(currentStatus)) {
            return false;
        }

        isDeviceOnline = true;
        updateUI(currentStatus);
        return true;
    }

    // Load complete status
    function loadStatus(force = true) {
        const activeDeviceId = syncActiveDeviceId();
        if (!activeDeviceId) {
            if (typeof window.resolveActiveDeviceId === 'function') {
                return Promise.resolve(window.resolveActiveDeviceId(false))
                    .then((resolvedDeviceId) => {
                        const normalizedDeviceId = String(resolvedDeviceId || '').trim();
                        if (!normalizedDeviceId) {
                            if (preserveLiveUiOnRefreshFailure()) {
                                return currentStatus;
                            }
                            isDeviceOnline = false;
                            lastUsageSnapshot = null;
                            showOfflineUI();
                            return null;
                        }
                        deviceId = normalizedDeviceId;
                        return loadStatus(force);
                    })
                    .catch(() => {
                        if (preserveLiveUiOnRefreshFailure()) {
                            return currentStatus;
                        }
                        isDeviceOnline = false;
                        lastUsageSnapshot = null;
                        showOfflineUI();
                        return null;
                    });
            }

            if (preserveLiveUiOnRefreshFailure()) {
                return Promise.resolve(currentStatus);
            }
            isDeviceOnline = false;
            lastUsageSnapshot = null;
            showOfflineUI();
            return Promise.resolve(null);
        }

        const now = Date.now();
        if (!force) {
            if (statusRefreshPromise) {
                return statusRefreshPromise;
            }
            if ((now - lastStatusRefreshAt) < STATUS_REFRESH_COOLDOWN_MS) {
                return Promise.resolve(currentStatus);
            }
        }

        lastStatusRefreshAt = now;
        statusRefreshPromise = fetch(`/api/modem/status?deviceId=${encodeURIComponent(activeDeviceId)}&_ts=${Date.now()}`, {
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    currentStatus = data.data;
                    runtimeCapabilities = {
                        ...runtimeCapabilities,
                        ...(data.data?.capabilities || {})
                    };
                    isDeviceOnline = true;
                    updateUI(data.data);
                    if (typeof window.refreshDeviceEnvelope === 'function') {
                        window.refreshDeviceEnvelope();
                    }
                    updateWifiRuntimeCapability();
                    if (Array.isArray(data.data?.wifiHotspot?.clients)) {
                        displayHotspotClients(data.data.wifiHotspot.clients);
                    } else if (!data.data?.wifiHotspot?.enabled || Number(data.data?.wifiHotspot?.connectedClients || 0) === 0) {
                        displayHotspotClients([]);
                    }
                    return data.data;
                } else {
                    if (preserveLiveUiOnRefreshFailure()) {
                        return currentStatus;
                    }
                    showError('Failed to load status');
                    return null;
                }
            })
            .catch(error => {
                console.error('Error loading status:', error);
                if (preserveLiveUiOnRefreshFailure()) {
                    return currentStatus;
                }
                isDeviceOnline = false;
                showOfflineUI();
                return null;
            })
            .finally(() => {
                statusRefreshPromise = null;
            });

        return statusRefreshPromise;
    }

    function showOfflineUI() {
        lastWifiScanResults = null;
        lastWifiScanDeviceId = '';
        resetModemCharts();
        // Update internet status
        if (elements.internetStatusCard) {
            elements.internetStatusCard.className = 'card bg-secondary bg-opacity-10 border-0';
        }
        if (elements.internetIcon) elements.internetIcon.className = 'bi bi-globe2 fs-1 text-secondary';
        if (elements.internetStatus) elements.internetStatus.textContent = 'Device Offline';
        if (elements.internetDetails) elements.internetDetails.textContent = 'Connect to device to see status';
        if (elements.activeSource) elements.activeSource.textContent = 'Offline';
        if (elements.mobileOperator) elements.mobileOperator.textContent = '-';
        if (elements.simStatus) elements.simStatus.textContent = '-';
        if (elements.simNumber) elements.simNumber.textContent = '-';
        if (elements.detectSimNumberBtn) elements.detectSimNumberBtn.disabled = true;
        updateWifiRuntimeCapability();

        // Disable toggles
        if (elements.mobileToggle) {
            elements.mobileToggle.disabled = true;
            elements.mobileToggle.checked = false;
        }
        if (elements.hotspotToggle) {
            elements.hotspotToggle.disabled = true;
            elements.hotspotToggle.checked = false;
        }
        if (elements.usbToggle) {
            elements.usbToggle.disabled = true;
            elements.usbToggle.checked = false;
        }
    }

    // Update all UI elements
    function updateUI(status) {
        updateInternetStatus(status);
        updateMobileUI(status.mobile);
        updateWiFiClientUI(status.wifiClient);
        updateHotspotUI(status.wifiHotspot);
        updateUSBUI(status.usb);
        updateDataUsageUI(status);
        updateSignalHistory(status);
    }

    function getWifiRuntimeMessage() {
        return 'Runtime Wi-Fi credential switching is not supported by this firmware.';
    }

    function isOpenWifiSecurityValue(value) {
        const normalized = String(value || '').trim().toLowerCase();
        return normalized === 'open'
            || normalized === 'none'
            || normalized === 'unsecured';
    }

    function getSelectedWifiSsid() {
        return String(
            currentStatus?.wifiClient?.selectedSsid
            || currentStatus?.wifiClient?.desiredSsid
            || ''
        ).trim();
    }

    function isSelectedWifiPasswordSaved() {
        if (currentStatus?.wifiClient?.selectedPasswordSet !== undefined) {
            return Boolean(currentStatus.wifiClient.selectedPasswordSet);
        }
        return Boolean(currentStatus?.wifiClient?.desiredPasswordSet);
    }

    function getSavedWifiProfile() {
        const ssid = getSelectedWifiSsid();
        const passwordSet = isSelectedWifiPasswordSaved();
        const knownNetwork = ssid ? getKnownWifiNetwork(ssid) : null;
        const openNetwork = Boolean(knownNetwork && isOpenWifiSecurityValue(knownNetwork.security));
        return {
            ssid,
            passwordSet,
            openNetwork,
            retryable: passwordSet || openNetwork
        };
    }

    function updateWifiRuntimeCapability() {
        const wifiCaps = runtimeCapabilities?.wifiClient || {};
        const canRemoteConnect = Boolean(wifiCaps.remoteConnect);
        const canRemoteDisconnect = Boolean(wifiCaps.remoteDisconnect);
        const canRetrySaved = Boolean(wifiCaps.retrySaved);
        const savedProfile = getSavedWifiProfile();
        const savedProfileText = savedProfile.ssid
            ? `${savedProfile.ssid}${savedProfile.passwordSet ? ' (password saved)' : (savedProfile.openNetwork ? ' (open network)' : ' (password missing)')}`
            : 'Not set';

        if (elements.wifiClientHint) {
            const shouldShowHint = !canRemoteConnect;
            elements.wifiClientHint.classList.toggle('d-none', !shouldShowHint);
            elements.wifiClientHint.className = `alert ${canRemoteConnect ? 'alert-info' : 'alert-warning'} rounded-0 border-start-0 border-end-0 mb-0 small${shouldShowHint ? '' : ' d-none'}`;
            elements.wifiClientHint.textContent = getWifiRuntimeMessage();
        }

        if (elements.wifiSavedProfileMeta) {
            elements.wifiSavedProfileMeta.textContent = savedProfileText;
        }

        if (elements.retrySavedWiFiBtn) {
            elements.retrySavedWiFiBtn.style.display = canRetrySaved && savedProfile.ssid ? 'block' : 'none';
            elements.retrySavedWiFiBtn.disabled = !isDeviceOnline || !savedProfile.ssid || !savedProfile.retryable;
            elements.retrySavedWiFiBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Retry Selected Network';
        }

        if (elements.disconnectWiFiBtn) {
            const wifiConnected = Boolean(currentStatus?.wifiClient?.connected);
            elements.disconnectWiFiBtn.style.display = wifiConnected && canRemoteDisconnect ? 'block' : 'none';
        }

        if (elements.scanWiFiBtn) {
            elements.scanWiFiBtn.disabled = wifiCaps.scan === false;
        }

        renderAvailableWifiNetworks(lastWifiScanResults);
    }

    function setCapabilityHint(element, enabled, message, tone = 'secondary') {
        if (!element) return;
        element.textContent = message;
        element.className = `alert alert-${tone} small${enabled ? '' : ' d-none'}`;
    }

    function setFormControlsDisabled(controls, disabled) {
        controls.forEach((control) => {
            if (control) {
                control.disabled = disabled;
            }
        });
    }

    function setSwitchLabel(labelElement, isSupported) {
        if (!labelElement) return;
        labelElement.textContent = isSupported ? 'Enable' : 'Read-only';
        labelElement.classList.toggle('text-muted', !isSupported);
    }

    // Update internet status overview
    function updateInternetStatus(status) {
        const internetAvailable = status.internet.available;
        const activeSourceLabel = formatRoutingSourceLabel(status.internet.activeSource);
        const sources = [];

        if (status.mobile.connected) sources.push('Mobile Data');
        if (status.wifiClient.connected) sources.push('Wi-Fi Client');
        if (status.usb.connected) sources.push('USB');
        
        if (elements.internetStatusCard) {
            elements.internetStatusCard.className = internetAvailable ? 
                'card bg-success bg-opacity-10 border-0' : 
                'card bg-danger bg-opacity-10 border-0';
        }
        
        if (elements.internetIcon) {
            elements.internetIcon.className = internetAvailable ? 
                'bi bi-globe2 fs-1 text-success' : 
                'bi bi-globe2 fs-1 text-danger';
        }
        
        if (elements.internetStatus) {
            elements.internetStatus.textContent = internetAvailable ? 
                'Internet Available' : 
                'No Active Internet Path';
        }
        
        if (elements.activeSource) {
            elements.activeSource.textContent = internetAvailable ? activeSourceLabel : 'None';
        }

        if (elements.internetDetails) {
            if (internetAvailable && activeSourceLabel !== 'None') {
                elements.internetDetails.textContent = `Active path: ${activeSourceLabel}`;
            } else if (sources.length > 0) {
                elements.internetDetails.textContent = `Detected links: ${sources.join(' + ')}`;
            } else {
                elements.internetDetails.textContent = 'Waiting for Mobile Data, Wi-Fi Client, or USB';
            }
        }
    }

    function resolveSimNumberValue(mobile) {
        return mobile?.simNumber
            || mobile?.subscriberNumber
            || mobile?.number
            || null;
    }

    function formatWifiSecurityLabel(value) {
        const text = String(value || '').trim();
        if (!text) return '';

        const normalized = text.toLowerCase().replace(/[\s-]+/g, '_');
        if (normalized === 'open') return 'Open';
        if (normalized.includes('wpa2') && normalized.includes('wpa3')) return 'WPA2/WPA3';
        if (normalized.includes('wpa') && normalized.includes('wpa2')) return 'WPA/WPA2';
        if (normalized.includes('wpa3')) return 'WPA3';
        if (normalized.includes('wpa2')) return 'WPA2';
        if (normalized.includes('wep')) return 'WEP';
        if (normalized.includes('wpa')) return 'WPA';
        return text.toUpperCase();
    }

    function formatCellularNetworkTypeLabel(value) {
        const text = String(value || '').trim();
        if (!text) return '';

        const normalized = text.toLowerCase();
        if (normalized === 'cellular' || normalized === 'unknown' || normalized === 'offline' || normalized === 'no service') {
            return '';
        }
        if (normalized.includes('5g') || normalized.includes('nr')) return '5G';
        if (normalized.includes('lte') || normalized.includes('4g') || normalized.includes('cat-1') || normalized.includes('cat1')) return '4G/LTE';
        if (normalized.includes('wcdma') || normalized.includes('umts') || normalized.includes('hspa') || normalized.includes('hsdpa') || normalized.includes('hsupa') || normalized.includes('3g')) return '3G';
        if (normalized.includes('edge') || normalized.includes('gprs') || normalized.includes('gsm') || normalized.includes('2g')) return '2G';
        return text.toUpperCase();
    }

    function formatStatusReasonText(value) {
        const text = String(value || '').trim();
        return text ? text.replace(/_/g, ' ') : '';
    }

    function getKnownWifiNetworks() {
        return Array.isArray(currentStatus?.wifiClient?.savedNetworks)
            ? currentStatus.wifiClient.savedNetworks
            : [];
    }

    function getKnownWifiNetwork(ssid) {
        const target = String(ssid || '').trim();
        if (!target) return null;
        return getKnownWifiNetworks().find((network) => String(network?.ssid || '').trim() === target) || null;
    }

    function formatSignalHistoryTime(ts) {
        return new Date(ts).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    function normalizeActiveSource(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'mobile') return 'modem';
        return normalized;
    }

    function formatRoutingSourceLabel(value) {
        switch (normalizeActiveSource(value)) {
        case 'wifi':
            return 'Wi-Fi Client';
        case 'modem':
            return 'Mobile Data';
        case 'hotspot':
            return 'Wi-Fi Hotspot';
        case 'usb':
            return 'USB';
        default:
            return 'None';
        }
    }

    function hasUsableLegendText(legendItem) {
        const text = String(legendItem?.text || '').trim().toLowerCase();
        return Boolean(text && text !== 'undefined' && text !== 'null');
    }

    function getDatasetLabel(context, fallback) {
        const label = String(context?.dataset?.label || '').trim();
        return label && label.toLowerCase() !== 'undefined' ? label : fallback;
    }

    function initSignalChart(canvasId, label, color) {
        if (typeof Chart === 'undefined') return null;
        const ctx = document.getElementById(canvasId)?.getContext('2d');
        if (!ctx) return null;

        return new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label,
                    data: [],
                    borderColor: color,
                    backgroundColor: `${color}22`,
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true,
                    spanGaps: true,
                    pointRadius: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        max: 100,
                        ticks: {
                            callback: (value) => `${value}%`
                        }
                    }
                }
            }
        });
    }

    function initSignalCharts() {
        signalCharts.mobile = initSignalChart('signalChart', 'Cellular signal', '#0d6efd');
        signalCharts.wifi = initSignalChart('wifiSignalChart', 'Wi-Fi signal', '#198754');
    }

    function initUsageCharts() {
        if (typeof Chart === 'undefined') return;

        const historyCtx = document.getElementById('dataUsageHistoryChart')?.getContext('2d');
        if (historyCtx) {
            usageCharts.history = new Chart(historyCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        {
                            label: 'Total',
                            data: [],
                            borderColor: '#0d6efd',
                            backgroundColor: '#0d6efd22',
                            borderWidth: 2,
                            tension: 0.3,
                            fill: true,
                            pointRadius: 2
                        },
                        {
                            label: 'Mobile',
                            data: [],
                            borderColor: '#198754',
                            backgroundColor: '#19875422',
                            borderWidth: 2,
                            tension: 0.3,
                            fill: false,
                            pointRadius: 2
                        },
                        {
                            label: 'Wi-Fi',
                            data: [],
                            borderColor: '#fd7e14',
                            backgroundColor: '#fd7e1422',
                            borderWidth: 2,
                            tension: 0.3,
                            fill: false,
                            pointRadius: 2
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                filter: hasUsableLegendText
                            }
                        },
                        tooltip: {
                            callbacks: {
                                label: (context) => `${getDatasetLabel(context, 'Usage')}: ${formatBytes(context.parsed.y || 0)}`
                            }
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                callback: (value) => formatBytes(value)
                            }
                        }
                    }
                }
            });
        }
    }

    function recordSignalHistory(chartKey, signal) {
        const chart = signalCharts[chartKey];
        if (!chart) return;

        const labels = chart.data.labels;
        const values = chart.data.datasets[0].data;
        labels.push(formatSignalHistoryTime(Date.now()));
        values.push(signal == null ? null : Number(signal));

        while (labels.length > SIGNAL_HISTORY_LIMIT) {
            labels.shift();
            values.shift();
        }

        chart.update('none');
    }

    function clearChartHistory(chart) {
        if (!chart) return;
        chart.data.labels = [];
        chart.data.datasets.forEach((dataset) => {
            dataset.data = [];
        });
        chart.update('none');
    }

    function resetUsageHistory() {
        lastUsageSnapshot = null;
        clearChartHistory(usageCharts.history);
    }

    function resetModemCharts() {
        clearChartHistory(signalCharts.mobile);
        clearChartHistory(signalCharts.wifi);
        resetUsageHistory();
    }

    function updateSignalHistory(status) {
        const mobileSignal = status?.mobile?.enabled
            ? (Number.isFinite(Number(status.mobile.signalStrength)) ? Number(status.mobile.signalStrength) : 0)
            : null;
        const wifiSignal = status?.wifiClient?.connected
            ? (Number.isFinite(Number(status.wifiClient.signalStrength)) ? Number(status.wifiClient.signalStrength) : 0)
            : null;

        recordSignalHistory('mobile', mobileSignal);
        recordSignalHistory('wifi', wifiSignal);
    }

    function updateUsageCharts(status) {
        const mobileTotal = Number(status?.mobile?.dataUsage?.sent || 0) + Number(status?.mobile?.dataUsage?.received || 0);
        const wifiTotal = Number(status?.wifiClient?.dataUsage?.sent || 0) + Number(status?.wifiClient?.dataUsage?.received || 0);
        const overallTotal = mobileTotal + wifiTotal;
        const sample = {
            overall: overallTotal,
            mobile: mobileTotal,
            wifi: wifiTotal
        };
        const previous = lastUsageSnapshot;
        const usageDelta = {
            overall: previous ? Math.max(0, sample.overall - previous.overall) : 0,
            mobile: previous ? Math.max(0, sample.mobile - previous.mobile) : 0,
            wifi: previous ? Math.max(0, sample.wifi - previous.wifi) : 0
        };

        if (previous) {
            if (sample.overall < previous.overall) usageDelta.overall = sample.overall;
            if (sample.mobile < previous.mobile) usageDelta.mobile = sample.mobile;
            if (sample.wifi < previous.wifi) usageDelta.wifi = sample.wifi;
        }

        lastUsageSnapshot = sample;

        if (usageCharts.history) {
            const labels = usageCharts.history.data.labels;
            const datasets = usageCharts.history.data.datasets;

            labels.push(formatSignalHistoryTime(Date.now()));
            datasets[0].data.push(usageDelta.overall);
            datasets[1].data.push(usageDelta.mobile);
            datasets[2].data.push(usageDelta.wifi);

            while (labels.length > USAGE_HISTORY_LIMIT) {
                labels.shift();
                datasets.forEach((dataset) => dataset.data.shift());
            }

            usageCharts.history.update('none');
        }
    }

    function getWifiClientPresentation(wifi) {
        const activeSource = String(currentStatus?.internet?.activeSource || '').trim().toLowerCase();
        const savedProfile = getSavedWifiProfile();
        const hasSavedProfile = Boolean(String(savedProfile.ssid || '').trim());
        const reasonText = String(wifi.lastDisconnectReasonText || '').trim().toLowerCase();
        const authFailure = reasonText === 'auth_expire'
            || reasonText === 'auth_fail'
            || reasonText === 'handshake_timeout'
            || reasonText === '4way_handshake_timeout'
            || reasonText === 'group_key_update_timeout'
            || reasonText === 'assoc_fail'
            || reasonText === 'connection_fail';
        const visibleButJoinFailed = reasonText === 'no_ap_found' && wifi.lastScanTargetVisible === true;
        const securityFailure = reasonText === 'no_ap_with_compatible_security';
        const hasWifiProfile = Boolean(
            wifi.configured
            || wifi.started
            || String(wifi.ssid || '').trim()
            || hasSavedProfile
        );
        const hasRecentFailure = Boolean(
            String(wifi.lastDisconnectReasonText || '').trim()
            || Number(wifi.lastDisconnectReason || 0) > 0
            || String(wifi.lastScanSummary || '').trim()
            || Number(wifi.connectAttemptCount || 0) > 0
            || Number(wifi.reconnectCount || 0) > 0
        );

        if (wifi.connected) {
            return {
                label: 'Connected',
                badgeClass: 'badge bg-success',
                iconClass: 'bi bi-wifi text-success'
            };
        }

        if (!wifi.started) {
            return {
                label: 'Disabled',
                badgeClass: 'badge bg-secondary',
                iconClass: 'bi bi-wifi text-secondary'
            };
        }

        if (visibleButJoinFailed) {
            return {
                label: 'Join failed',
                badgeClass: 'badge bg-warning text-dark',
                iconClass: 'bi bi-wifi-off text-warning'
            };
        }

        if (securityFailure && wifi.lastScanTargetVisible === true) {
            return {
                label: 'Security mismatch',
                badgeClass: 'badge bg-danger',
                iconClass: 'bi bi-shield-exclamation text-danger'
            };
        }

        if (authFailure && wifi.lastScanTargetVisible === true) {
            return {
                label: 'Auth failed',
                badgeClass: 'badge bg-danger',
                iconClass: 'bi bi-wifi-off text-danger'
            };
        }

        if (hasRecentFailure) {
            return {
                label: 'Searching',
                badgeClass: 'badge bg-warning text-dark',
                iconClass: 'bi bi-wifi text-warning'
            };
        }

        if (activeSource === 'modem' && hasWifiProfile) {
            return {
                label: 'Available',
                badgeClass: 'badge bg-info text-dark',
                iconClass: 'bi bi-wifi text-info'
            };
        }

        if (hasWifiProfile) {
            return {
                label: 'Available',
                badgeClass: 'badge bg-info text-dark',
                iconClass: 'bi bi-wifi text-info'
            };
        }

        if (wifi.enabled) {
            return {
                label: 'Connecting...',
                badgeClass: 'badge bg-warning text-dark',
                iconClass: 'bi bi-wifi text-warning'
            };
        }

        return {
            label: 'Disconnected',
            badgeClass: 'badge bg-danger',
            iconClass: 'bi bi-wifi text-secondary'
        };
    }

    function updateWifiClientDiagnostics(wifi, presentation) {
        if (!elements.wifiClientDiagnostics) return;

        if (wifi.connected) {
            elements.wifiClientDiagnostics.className = 'alert alert-warning small mt-3 mb-0 d-none';
            elements.wifiClientDiagnostics.textContent = '';
            return;
        }

        const detailBits = [];
        const reasonText = formatStatusReasonText(wifi.lastDisconnectReasonText);
        const scanSummary = String(wifi.lastScanSummary || '').trim();
        const attempts = Number(wifi.connectAttemptCount || 0);
        const reconnects = Number(wifi.reconnectCount || 0);
        const visibleCount = Number(wifi.lastScanVisibleCount || 0);
        const selectedSsid = getSelectedWifiSsid();
        const normalizedReason = String(wifi.lastDisconnectReasonText || '').trim().toLowerCase();
        const authFailure = normalizedReason === 'auth_expire'
            || normalizedReason === 'auth_fail'
            || normalizedReason === 'handshake_timeout'
            || normalizedReason === '4way_handshake_timeout'
            || normalizedReason === 'group_key_update_timeout'
            || normalizedReason === 'assoc_fail'
            || normalizedReason === 'connection_fail';
        const visibleButJoinFailed = normalizedReason === 'no_ap_found' && wifi.lastScanTargetVisible === true;
        const securityFailure = normalizedReason === 'no_ap_with_compatible_security';
        const selectedOrConfiguredSsid = selectedSsid || String(wifi.ssid || '').trim();

        if (selectedSsid) {
            detailBits.push(`Selected network: ${selectedSsid}`);
        }
        if (reasonText) {
            detailBits.push(`Last reason: ${reasonText}`);
        } else if (Number(wifi.lastDisconnectReason || 0) > 0) {
            detailBits.push(`Last reason code: ${wifi.lastDisconnectReason}`);
        }
        if (scanSummary) {
            detailBits.push(`Scan: ${scanSummary}`);
        }
        if (visibleCount > 0) {
            detailBits.push(`Visible APs: ${visibleCount}`);
        }
        if (attempts > 0 || reconnects > 0) {
            detailBits.push(`Attempts: ${attempts} | Reconnects: ${reconnects}`);
        }
        if (visibleButJoinFailed) {
            detailBits.push(`Guidance: ${selectedOrConfiguredSsid || 'Target hotspot'} is visible in scan, but the device still could not join it. Stay close to the hotspot and re-check its security settings.`);
        }
        if (securityFailure && wifi.lastScanTargetVisible === true) {
            detailBits.push(`Guidance: ${selectedOrConfiguredSsid || 'Target hotspot'} is visible, but its security is not compatible. Use 2.4 GHz and WPA2.`);
        } else if (authFailure && wifi.lastScanTargetVisible === true) {
            detailBits.push(`Guidance: ${selectedOrConfiguredSsid || 'Target hotspot'} is visible, but authentication is failing. Check the saved password and hotspot security.`);
        }

        if (!detailBits.length) {
            elements.wifiClientDiagnostics.className = 'alert alert-warning small mt-3 mb-0 d-none';
            elements.wifiClientDiagnostics.textContent = '';
            return;
        }

        const tone = (authFailure && wifi.lastScanTargetVisible === true) || (securityFailure && wifi.lastScanTargetVisible === true)
            ? 'danger'
            : presentation.label === 'Available'
            ? 'info'
            : 'warning';
        elements.wifiClientDiagnostics.className = `alert alert-${tone} small mt-3 mb-0`;
        elements.wifiClientDiagnostics.textContent = detailBits.join(' | ');
    }

    function getWifiDisplayEntries(scannedNetworks = null) {
        const connectedSsid = String(currentStatus?.wifiClient?.ssid || '').trim();
        const connected = Boolean(currentStatus?.wifiClient?.connected);
        const visibleNetworks = Array.isArray(scannedNetworks) ? scannedNetworks : [];
        const knownBySsid = new Map(
            getKnownWifiNetworks()
                .filter((network) => String(network?.ssid || '').trim())
                .map((network) => [String(network.ssid).trim(), network])
        );
        const entries = [];

        visibleNetworks.forEach((network) => {
            const ssid = String(network?.ssid || '').trim() || 'Hidden Network';
            const knownNetwork = ssid !== 'Hidden Network'
                ? (knownBySsid.get(ssid) || null)
                : null;
            if (knownNetwork) {
                knownBySsid.delete(ssid);
            }
            entries.push({
                ssid,
                bssid: String(network?.bssid || '').trim(),
                signal: Number.isFinite(Number(network?.signal)) ? Number(network.signal) : null,
                security: String(network?.security || '').trim(),
                channel: Number(network?.channel || 0),
                band: String(network?.band || '').trim(),
                encrypted: Boolean(network?.encrypted),
                visible: true,
                saved: Boolean(knownNetwork),
                knownNetwork,
                connected: connected && connectedSsid === ssid
            });
        });

        knownBySsid.forEach((knownNetwork, ssid) => {
            entries.push({
                ssid,
                bssid: String(knownNetwork?.lastBssid || '').trim(),
                signal: knownNetwork?.lastSignal == null ? null : Number(knownNetwork.lastSignal),
                security: String(knownNetwork?.security || '').trim(),
                channel: Number(knownNetwork?.lastChannel || 0),
                band: '',
                encrypted: !isOpenWifiSecurityValue(knownNetwork?.security),
                visible: false,
                saved: true,
                knownNetwork,
                connected: connected && connectedSsid === ssid
            });
        });

        entries.sort((left, right) => {
            if (left.connected !== right.connected) return left.connected ? -1 : 1;
            if (left.visible !== right.visible) return left.visible ? -1 : 1;
            if (left.saved !== right.saved) return left.saved ? -1 : 1;
            const leftSignal = left.signal == null ? -1 : left.signal;
            const rightSignal = right.signal == null ? -1 : right.signal;
            if (leftSignal !== rightSignal) return rightSignal - leftSignal;
            return left.ssid.localeCompare(right.ssid);
        });

        return entries;
    }

    function updateWifiNetworksSummary(scannedNetworks) {
        if (!elements.wifiNetworksSummary) return;
        const visibleCount = Array.isArray(scannedNetworks) ? scannedNetworks.length : 0;
        const savedCount = getKnownWifiNetworks().length;
        const hostFallback = Array.isArray(scannedNetworks)
            && scannedNetworks.some((network) => String(network?.scanSource || '').trim() === 'dashboard_host');

        if (Array.isArray(scannedNetworks)) {
            if (hostFallback) {
                elements.wifiNetworksSummary.textContent = `Dashboard host scan found ${visibleCount} network${visibleCount === 1 ? '' : 's'} after the device scan timed out. Connect actions still run on the device over MQTT.`;
                return;
            }
            elements.wifiNetworksSummary.textContent = `Device scan found ${visibleCount} network${visibleCount === 1 ? '' : 's'}. Saved networks are merged into the same list and marked with a Saved badge.`;
            return;
        }

        elements.wifiNetworksSummary.textContent = savedCount > 0
            ? `Saved networks are shown here even before a live scan. Run Scan to merge visible results from the device.`
            : 'Saved and scanned networks are shown together here. Saved entries keep the same actions as scanned results and carry a Saved badge.';
    }

    function renderAvailableWifiNetworks(scannedNetworks = null) {
        const list = document.getElementById('wifiNetworksList');
        if (!list) return;
        const activeDeviceId = syncActiveDeviceId();

        if (lastWifiScanDeviceId && activeDeviceId && lastWifiScanDeviceId !== activeDeviceId) {
            lastWifiScanResults = null;
            lastWifiScanDeviceId = '';
        }

        if (Array.isArray(scannedNetworks)) {
            lastWifiScanResults = scannedNetworks;
            lastWifiScanDeviceId = activeDeviceId;
        }

        const entries = getWifiDisplayEntries(lastWifiScanResults);
        const canRemoteConnect = Boolean(runtimeCapabilities?.wifiClient?.remoteConnect);
        const canRetrySaved = Boolean(runtimeCapabilities?.wifiClient?.retrySaved);
        const savedProfile = getSavedWifiProfile();

        updateWifiNetworksSummary(lastWifiScanResults);

        if (!entries.length) {
            list.innerHTML = `
                <div class="text-center py-5">
                    <i class="bi bi-wifi fs-1 text-muted d-block mb-3"></i>
                    <p class="text-muted">Click Scan to see available networks</p>
                    <button class="btn btn-primary" onclick="scanWiFiNetworks()">
                        <i class="bi bi-search"></i> Scan Now
                    </button>
                </div>
            `;
            return;
        }

        list.innerHTML = entries.map((entry) => {
            const signalClass = entry.signal > 70 ? 'success' : (entry.signal > 40 ? 'warning' : 'secondary');
            const securityIcon = !entry.encrypted ? 'unlock' : 'lock';
            const matchesSavedProfile = savedProfile.ssid && entry.ssid === savedProfile.ssid;
            const savedPasswordAvailable = Boolean(entry.knownNetwork?.passwordSet);
            const openNetwork = isOpenWifiSecurityValue(entry.security);
            const canDirectConnect = canRemoteConnect && (!entry.encrypted || savedPasswordAvailable || openNetwork);
            const needsPassword = canRemoteConnect && entry.visible && entry.encrypted && !savedPasswordAvailable && !openNetwork;
            const statusBadges = [];
            const metaBits = [];
            const footerBits = [];

            if (entry.connected) statusBadges.push('<span class="badge bg-success ms-2">Connected</span>');
            if (entry.saved) statusBadges.push('<span class="badge bg-light text-dark border ms-2">Saved</span>');
            if (matchesSavedProfile) statusBadges.push('<span class="badge bg-info text-dark ms-2">Selected</span>');
            if (!entry.visible) statusBadges.push('<span class="badge bg-secondary ms-2">Saved only</span>');

            if (entry.visible && entry.bssid) {
                metaBits.push(entry.bssid);
            } else if (entry.knownNetwork?.lastConnectedAt) {
                metaBits.push(`Last connected ${new Date(entry.knownNetwork.lastConnectedAt).toLocaleDateString()}`);
            } else if (entry.knownNetwork?.source === 'legacy_profile') {
                metaBits.push('Saved from earlier device setup');
            }

            if (entry.security) footerBits.push(entry.security);
            if (entry.band) footerBits.push(entry.band);
            if (entry.channel) footerBits.push(`CH ${entry.channel}`);
            if (!entry.visible) footerBits.push('Not visible in current device scan');

            let primaryAction = '';
            if (entry.connected) {
                primaryAction = '<button type="button" class="btn btn-sm btn-success" disabled>Connected</button>';
            } else if (canDirectConnect) {
                primaryAction = `<button type="button" class="btn btn-sm btn-primary" data-ssid="${escapeHtml(entry.ssid)}" data-security="${escapeHtml(entry.security || '')}" onclick="connectKnownWiFi(this.dataset.ssid, this.dataset.security)">Connect</button>`;
            } else if (needsPassword) {
                primaryAction = `<button type="button" class="btn btn-sm btn-outline-primary" data-ssid="${escapeHtml(entry.ssid)}" onclick="showConnectModal(this.dataset.ssid, true)">Enter Password</button>`;
            } else if (canRemoteConnect) {
                primaryAction = '<button type="button" class="btn btn-sm btn-outline-secondary" disabled>Password missing</button>';
            }

            const retryAction = matchesSavedProfile && canRetrySaved
                ? `<button type="button" class="btn btn-sm btn-outline-success" data-ssid="${escapeHtml(entry.ssid)}" onclick="retrySavedWiFi(this.dataset.ssid)">Retry Selected</button>`
                : '';

            if (entry.saved) {
                footerBits.push(entry.knownNetwork?.passwordSet ? 'Password saved' : (openNetwork ? 'Open network' : 'Password required'));
            }

            return `
                <div class="list-group-item py-3">
                    <div class="d-flex justify-content-between align-items-start gap-3">
                        <div class="flex-grow-1 min-w-0">
                            <div class="fw-semibold text-break">
                                <i class="bi bi-${securityIcon} me-2"></i>${escapeHtml(entry.ssid)}
                                ${statusBadges.join('')}
                            </div>
                            ${metaBits.length ? `<div class="small text-muted mt-1">${escapeHtml(metaBits.join(' | '))}</div>` : ''}
                            ${footerBits.length ? `<div class="small text-muted mt-2">${escapeHtml(footerBits.join(' | '))}</div>` : ''}
                        </div>
                        <div class="text-end flex-shrink-0" style="min-width: 140px;">
                            ${entry.signal == null ? '<div class="small text-muted">Saved network</div>' : `
                                <div class="progress mb-1" style="width: 120px;">
                                    <div class="progress-bar bg-${signalClass}" style="width: ${entry.signal}%"></div>
                                </div>
                                <small>${entry.signal}%</small>
                            `}
                            ${(primaryAction || retryAction) ? `<div class="d-flex justify-content-end gap-2 mt-2 flex-wrap">${primaryAction}${retryAction}</div>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    // Update mobile UI
    function updateMobileUI(mobile) {
        const canRemoteToggle = Boolean(runtimeCapabilities?.mobile?.remoteToggle);
        const canRemoteApn = Boolean(runtimeCapabilities?.mobile?.remoteApn);
        const operatorLabel = mobile.operatorName || mobile.operator || 'Unknown';
        const networkTypeLabel = formatCellularNetworkTypeLabel(mobile.networkType) || mobile.networkType || 'Unknown';
        const simStatusLabel = formatSimStatus(mobile.simStatus);
        const simNumberLabel = resolveSimNumberValue(mobile) || (mobile.simStatus === 'ready' ? 'Checking...' : '-');
        const activeSource = String(currentStatus?.internet?.activeSource || '').trim().toLowerCase();
        const mobileReady = Boolean(
            mobile.enabled && (
                Number(mobile.signalStrength || 0) > 0
                || operatorLabel !== 'Unknown'
                || networkTypeLabel !== 'Unknown'
                || mobile.simStatus === 'ready'
            )
        );

        if (elements.mobileToggle) {
            elements.mobileToggle.checked = mobile.enabled;
            elements.mobileToggle.disabled = !isDeviceOnline || !canRemoteToggle;
        }
        setSwitchLabel(elements.mobileToggleLabel, canRemoteToggle);

        if (elements.simStatus) elements.simStatus.textContent = simStatusLabel;
        if (elements.simNumber) elements.simNumber.textContent = simNumberLabel;
        if (elements.detectSimNumberBtn) {
            elements.detectSimNumberBtn.disabled = !isDeviceOnline || !mobile.enabled;
            elements.detectSimNumberBtn.innerHTML = resolveSimNumberValue(mobile)
                ? '<i class="bi bi-arrow-clockwise me-1"></i>Refresh SIM Number'
                : '<i class="bi bi-sim me-1"></i>Detect SIM Number';
        }

        if (mobile.connected) {
            if (elements.mobileIcon) elements.mobileIcon.className = 'bi bi-broadcast text-success';
            if (elements.mobileStatus) elements.mobileStatus.textContent = 'Connected';
            if (elements.mobileOperator) elements.mobileOperator.textContent = operatorLabel;
            if (elements.mobileNetwork) elements.mobileNetwork.textContent = networkTypeLabel;
            
            if (elements.mobileSignalBar) {
                elements.mobileSignalBar.style.width = mobile.signalStrength + '%';
                elements.mobileSignalBar.className = mobile.signalStrength > 70 ? 'progress-bar bg-success' :
                    mobile.signalStrength > 40 ? 'progress-bar bg-warning' : 'progress-bar bg-danger';
            }
            
            if (elements.mobileSignal) elements.mobileSignal.textContent = mobile.signalStrength + '%';
            if (elements.mobileIP) elements.mobileIP.textContent = mobile.ipAddress || '0.0.0.0';
            
            const totalMB = Math.round((mobile.dataUsage.sent + mobile.dataUsage.received) / (1024 * 1024));
            if (elements.mobileDataUsed) elements.mobileDataUsed.textContent = totalMB + ' MB';
        } else if (mobileReady) {
            if (elements.mobileIcon) elements.mobileIcon.className = `bi bi-broadcast ${activeSource === 'wifi' ? 'text-info' : 'text-warning'}`;
            if (elements.mobileStatus) elements.mobileStatus.textContent = 'Available';
            if (elements.mobileOperator) elements.mobileOperator.textContent = operatorLabel;
            if (elements.mobileNetwork) elements.mobileNetwork.textContent = networkTypeLabel;
            if (elements.mobileSignalBar) {
                elements.mobileSignalBar.style.width = `${mobile.signalStrength || 0}%`;
                elements.mobileSignalBar.className = Number(mobile.signalStrength || 0) > 70 ? 'progress-bar bg-success' :
                    Number(mobile.signalStrength || 0) > 40 ? 'progress-bar bg-warning' : 'progress-bar bg-info';
            }
            if (elements.mobileSignal) elements.mobileSignal.textContent = `${mobile.signalStrength || 0}%`;
            if (elements.mobileIP) elements.mobileIP.textContent = '-';
        } else if (mobile.enabled) {
            if (elements.mobileIcon) elements.mobileIcon.className = 'bi bi-broadcast text-warning';
            if (elements.mobileStatus) elements.mobileStatus.textContent = 'Connecting...';
            if (elements.mobileOperator) elements.mobileOperator.textContent = operatorLabel === 'Unknown' ? '-' : operatorLabel;
            if (elements.mobileNetwork) elements.mobileNetwork.textContent = networkTypeLabel === 'Unknown' ? '-' : networkTypeLabel;
            if (elements.mobileSignalBar) elements.mobileSignalBar.style.width = '0%';
            if (elements.mobileSignal) elements.mobileSignal.textContent = '0%';
            if (elements.mobileIP) elements.mobileIP.textContent = '-';
        } else {
            if (elements.mobileIcon) elements.mobileIcon.className = 'bi bi-broadcast text-secondary';
            if (elements.mobileStatus) elements.mobileStatus.textContent = 'Disabled';
            if (elements.mobileOperator) elements.mobileOperator.textContent = '-';
            if (elements.mobileNetwork) elements.mobileNetwork.textContent = '-';
            if (elements.mobileSignalBar) elements.mobileSignalBar.style.width = '0%';
            if (elements.mobileSignal) elements.mobileSignal.textContent = '0%';
            if (elements.mobileIP) elements.mobileIP.textContent = '-';
        }

        if (elements.mobileOperator) elements.mobileOperator.textContent = operatorLabel;

        // Update APN form
        if (elements.apnName) elements.apnName.value = mobile.apn.name || 'internet';
        if (elements.apnUsername) elements.apnUsername.value = mobile.apn.username || '';
        if (elements.apnPassword) elements.apnPassword.value = mobile.apn.password || '';
        if (elements.apnAuth) elements.apnAuth.value = mobile.apn.auth || 'none';
        setFormControlsDisabled(
            [
                elements.apnName,
                elements.apnUsername,
                elements.apnPassword,
                elements.apnAuth,
                elements.apnSaveBtn
            ],
            !canRemoteApn
        );
        document.querySelectorAll('[data-apn-preset]').forEach((button) => {
            button.disabled = !canRemoteApn;
        });
    }

    function canDisableMobileTransport() {
        return Boolean(
            currentStatus?.wifiClient?.connected
            || String(currentStatus?.internet?.activeSource || '').trim().toLowerCase() === 'wifi'
        );
    }

    function canDisableWiFiTransport() {
        return Boolean(
            currentStatus?.mobile?.connected
            || String(currentStatus?.internet?.activeSource || '').trim().toLowerCase() === 'modem'
        );
    }

    // Update WiFi client UI
    function updateWiFiClientUI(wifi) {
        const canRemoteToggle = Boolean(runtimeCapabilities?.wifiClient?.remoteToggle);
        const wifiSecurityLabel = formatWifiSecurityLabel(wifi.security);
        const presentation = getWifiClientPresentation(wifi);
        const displaySsid = String(wifi.ssid || getSelectedWifiSsid() || '').trim() || 'Not Connected';

        if (elements.wifiToggle) {
            elements.wifiToggle.checked = Boolean(wifi.started);
            elements.wifiToggle.disabled = !isDeviceOnline || !canRemoteToggle;
        }
        setSwitchLabel(elements.wifiToggleLabel, canRemoteToggle);

        if (elements.wifiClientBadge) {
            elements.wifiClientBadge.textContent = presentation.label;
            elements.wifiClientBadge.className = presentation.badgeClass;
        }

        if (elements.wifiClientIcon) {
            elements.wifiClientIcon.className = presentation.iconClass;
        }

        if (elements.wifiClientSSID) elements.wifiClientSSID.textContent = displaySsid;
        
        if (elements.wifiClientStatus) {
            elements.wifiClientStatus.textContent = presentation.label;
            elements.wifiClientStatus.className = presentation.badgeClass;
        }

        if (wifi.connected) {
            if (elements.wifiClientSignalBar) {
                elements.wifiClientSignalBar.style.width = wifi.signalStrength + '%';
                elements.wifiClientSignalBar.className = wifi.signalStrength > 70 ? 'progress-bar bg-success' :
                    wifi.signalStrength > 40 ? 'progress-bar bg-warning' : 'progress-bar bg-danger';
            }
            if (elements.wifiClientSignal) elements.wifiClientSignal.textContent = wifi.signalStrength + '%';
            if (elements.wifiClientIP) elements.wifiClientIP.textContent = wifi.ipAddress || '0.0.0.0';
            if (elements.wifiClientSecurity) elements.wifiClientSecurity.textContent = wifiSecurityLabel || '-';
            if (elements.wifiClientChannel) elements.wifiClientChannel.textContent = wifi.channel || '-';
            if (elements.wifiClientBSSID) elements.wifiClientBSSID.textContent = wifi.bssid || '-';
        } else {
            if (elements.wifiClientSignalBar) elements.wifiClientSignalBar.style.width = '0%';
            if (elements.wifiClientSignal) elements.wifiClientSignal.textContent = '0%';
            if (elements.wifiClientIP) elements.wifiClientIP.textContent = '-';
            if (elements.wifiClientSecurity) elements.wifiClientSecurity.textContent = '-';
            if (elements.wifiClientChannel) elements.wifiClientChannel.textContent = '-';
            if (elements.wifiClientBSSID) elements.wifiClientBSSID.textContent = '-';
        }

        if (elements.disconnectWiFiBtn) {
            const canRemoteDisconnect = Boolean(runtimeCapabilities?.wifiClient?.remoteDisconnect);
            elements.disconnectWiFiBtn.style.display = wifi.connected && canRemoteDisconnect ? 'block' : 'none';
        }

        updateWifiClientDiagnostics(wifi, presentation);
        updateWifiRuntimeCapability();
    }

    // Update hotspot UI
    function updateHotspotUI(hotspot) {
        const canRemoteToggle = Boolean(runtimeCapabilities?.hotspot?.remoteToggle);
        const canRemoteConfigure = Boolean(runtimeCapabilities?.hotspot?.remoteConfigure);
        const canReadClients = canRemoteToggle || canRemoteConfigure || Boolean(runtimeCapabilities?.hotspot?.remoteClientBlock) || Boolean(runtimeCapabilities?.hotspot?.remoteClientLimit);
        if (elements.hotspotToggle) {
            elements.hotspotToggle.checked = hotspot.enabled;
            elements.hotspotToggle.disabled = !isDeviceOnline || !canRemoteToggle;
        }
        setSwitchLabel(elements.hotspotToggleLabel, canRemoteToggle);

        if (elements.hotspotIcon) {
            elements.hotspotIcon.className = hotspot.enabled ? 
                'bi bi-wifi text-success' : 
                'bi bi-wifi text-secondary';
        }

        if (elements.hotspotSSID) elements.hotspotSSID.textContent = hotspot.ssid || 'Disabled';
        if (elements.clientCount) elements.clientCount.textContent = Number(hotspot.connectedClients || 0);
        if (elements.refreshHotspotClientsBtn) {
            elements.refreshHotspotClientsBtn.disabled = !isDeviceOnline || !canReadClients;
        }
        if (elements.hotspotClientsCount) {
            if (hotspot.enabled) {
                elements.hotspotClientsCount.textContent = `${Number(hotspot.connectedClients || 0)} client${Number(hotspot.connectedClients || 0) === 1 ? '' : 's'} connected`;
            } else if (!canReadClients) {
                elements.hotspotClientsCount.textContent = 'No client telemetry';
            } else {
                elements.hotspotClientsCount.textContent = '0 clients connected';
            }
        }

        // Update form
        if (elements.hotspotSsid) elements.hotspotSsid.value = hotspot.ssid || 'Hotspot';
        if (elements.hotspotPassword) elements.hotspotPassword.value = hotspot.password || '12345678';
        if (elements.hotspotSecurity) elements.hotspotSecurity.value = hotspot.security || 'WPA2-PSK';
        if (elements.hotspotBand) elements.hotspotBand.value = hotspot.band || '2.4GHz';
        if (elements.hotspotChannel) elements.hotspotChannel.value = hotspot.channel || 6;
        if (elements.hotspotMaxClients) elements.hotspotMaxClients.value = hotspot.maxClients || 10;
        if (elements.hotspotHidden) elements.hotspotHidden.checked = hotspot.hidden || false;
        setFormControlsDisabled(
            [
                elements.hotspotSsid,
                elements.hotspotPassword,
                elements.hotspotSecurity,
                elements.hotspotBand,
                elements.hotspotChannel,
                elements.hotspotMaxClients,
                elements.hotspotHidden,
                elements.hotspotSaveBtn
            ],
            !canRemoteConfigure
        );
        if (elements.hotspotForm) {
            elements.hotspotForm.classList.toggle('d-none', !canRemoteConfigure);
        }
    }

    // Update USB UI
    function updateUSBUI(usb) {
        const canRemoteToggle = Boolean(runtimeCapabilities?.usb?.remoteToggle);
        if (elements.usbToggle) {
            elements.usbToggle.checked = usb.enabled;
            elements.usbToggle.disabled = !isDeviceOnline || !canRemoteToggle;
        }
        setSwitchLabel(elements.usbToggleLabel, canRemoteToggle);

        if (usb.connected) {
            if (elements.usbIcon) elements.usbIcon.className = 'bi bi-usb-symbol text-success';
            if (elements.usbStatus) elements.usbStatus.textContent = 'Connected';
            if (elements.usbDetails) elements.usbDetails.textContent = `IP: ${usb.clientIp || '0.0.0.0'}`;
        } else if (usb.enabled) {
            if (elements.usbIcon) elements.usbIcon.className = 'bi bi-usb-symbol text-warning';
            if (elements.usbStatus) elements.usbStatus.textContent = 'Waiting for USB...';
            if (elements.usbDetails) elements.usbDetails.textContent = 'Connect USB cable to computer';
        } else {
            if (elements.usbIcon) elements.usbIcon.className = 'bi bi-usb-symbol text-secondary';
            if (elements.usbStatus) elements.usbStatus.textContent = 'Disabled';
            if (elements.usbDetails) elements.usbDetails.textContent = 'Connect USB cable to share internet';
        }
    }

    // Update data usage UI
    function updateDataUsageUI(status) {
        const canRemoteReset = Boolean(runtimeCapabilities?.dataUsage?.remoteReset);
        const totalSent = (status.mobile.dataUsage.sent + status.wifiClient.dataUsage.sent);
        const totalReceived = (status.mobile.dataUsage.received + status.wifiClient.dataUsage.received);
        const activePathLabel = formatRoutingSourceLabel(status?.internet?.activeSource);
        const hasTrafficCounters = (totalSent + totalReceived) > 0;
        const hasActivePath = activePathLabel !== 'None';

        if (elements.totalSent) elements.totalSent.textContent = formatBytes(totalSent);
        if (elements.totalReceived) elements.totalReceived.textContent = formatBytes(totalReceived);
        if (elements.totalUsage) elements.totalUsage.textContent = formatBytes(totalSent + totalReceived);
        if (elements.dataUsageResetBtn) {
            elements.dataUsageResetBtn.disabled = !isDeviceOnline || !canRemoteReset;
            elements.dataUsageResetBtn.classList.toggle('d-none', !canRemoteReset);
        }

        if (elements.mobileSent) elements.mobileSent.textContent = formatBytes(status.mobile.dataUsage.sent);
        if (elements.mobileReceived) elements.mobileReceived.textContent = formatBytes(status.mobile.dataUsage.received);
        if (elements.wifiSent) elements.wifiSent.textContent = formatBytes(status.wifiClient.dataUsage.sent);
        if (elements.wifiReceived) elements.wifiReceived.textContent = formatBytes(status.wifiClient.dataUsage.received);
        if (elements.dataUsageNotice) {
            if (hasTrafficCounters && hasActivePath) {
                elements.dataUsageNotice.textContent = `Active path: ${activePathLabel}. Trend shows traffic added since the last refresh using the live device counters.`;
            } else if (hasTrafficCounters) {
                elements.dataUsageNotice.textContent = 'Trend shows traffic added since the last refresh using the live device counters.';
            } else if (hasActivePath) {
                elements.dataUsageNotice.textContent = canRemoteReset
                    ? `Active path: ${activePathLabel}. Waiting for usage counters from the device.`
                    : `Active path: ${activePathLabel}. Counters are read-only until the firmware reports reset support.`;
            } else {
                elements.dataUsageNotice.textContent = canRemoteReset
                    ? 'Waiting for live traffic counters from the device.'
                    : 'Waiting for live traffic counters from the device. Reset is not supported by the current firmware.';
            }
        }
        updateUsageCharts(status);
    }

    // ==================== MOBILE FUNCTIONS ====================

    function toggleMobile(enabled) {
        if (!isDeviceOnline) {
            showToast('Device is offline', 'warning');
            if (elements.mobileToggle) elements.mobileToggle.checked = !enabled;
            return;
        }

        if (!enabled && !canDisableMobileTransport()) {
            showToast('Connect Wi-Fi first before turning mobile data off', 'warning');
            if (elements.mobileToggle) elements.mobileToggle.checked = true;
            return;
        }

        const toggle = elements.mobileToggle;
        const originalChecked = toggle.checked;
        toggle.disabled = true;

        fetch('/api/modem/mobile/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, deviceId })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast(data.message, 'success');
                setTimeout(loadStatus, 1000);
            } else {
                showToast(data.message, 'danger');
                toggle.checked = originalChecked;
            }
        })
        .catch(error => {
            console.error('Error:', error);
            showToast('Failed to toggle mobile data', 'danger');
            toggle.checked = originalChecked;
        })
        .finally(() => {
            toggle.disabled = false;
        });
    }

    function toggleWiFi(enabled) {
        if (!runtimeCapabilities?.wifiClient?.remoteToggle) {
            showToast('Wi-Fi runtime toggle is not supported by the current firmware.', 'info');
            if (elements.wifiToggle) elements.wifiToggle.checked = !enabled;
            return;
        }

        if (!isDeviceOnline) {
            showToast('Device is offline', 'warning');
            if (elements.wifiToggle) elements.wifiToggle.checked = !enabled;
            return;
        }

        if (!enabled && !canDisableWiFiTransport()) {
            showToast('Turn on mobile data and wait for it to connect before turning Wi-Fi off', 'warning');
            if (elements.wifiToggle) elements.wifiToggle.checked = true;
            return;
        }

        const toggle = elements.wifiToggle;
        const originalChecked = toggle.checked;
        toggle.disabled = true;

        fetch('/api/modem/wifi/client/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, deviceId })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast(data.message, 'success');
                setTimeout(() => loadStatus(true), 1000);
            } else {
                showToast(data.message, 'danger');
                toggle.checked = originalChecked;
            }
        })
        .catch(error => {
            console.error('Error:', error);
            showToast('Failed to toggle Wi-Fi', 'danger');
            toggle.checked = originalChecked;
        })
        .finally(() => {
            toggle.disabled = false;
        });
    }

    function saveAPN() {
        if (!isDeviceOnline) {
            showToast('Device is offline', 'warning');
            return;
        }

        const apn = {
            apn: elements.apnName?.value,
            username: elements.apnUsername?.value,
            password: elements.apnPassword?.value,
            auth: elements.apnAuth?.value
        };

        if (!apn.apn) {
            showToast('APN is required', 'warning');
            return;
        }

        fetch('/api/modem/mobile/apn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...apn, deviceId })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('APN saved', 'success');
            } else {
                showToast(data.message, 'danger');
            }
        })
        .catch(error => {
            console.error('Error:', error);
            showToast('Failed to save APN', 'danger');
        });
    }

    function setAPN(apn, username, password, auth) {
        if (elements.apnName) elements.apnName.value = apn;
        if (elements.apnUsername) elements.apnUsername.value = username || '';
        if (elements.apnPassword) elements.apnPassword.value = password || '';
        if (elements.apnAuth) elements.apnAuth.value = auth || 'none';
        saveAPN();
    }

    function detectSimNumber() {
        if (!isDeviceOnline) {
            showToast('Device is offline', 'warning');
            return;
        }

        const button = elements.detectSimNumberBtn;
        if (button) button.disabled = true;

        fetch(`/api/quick/sim-number?deviceId=${encodeURIComponent(syncActiveDeviceId())}`, {
            method: 'POST'
        })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    showToast(data.message || 'SIM number detection started', 'info');
                    setTimeout(() => {
                        loadStatus(true);
                        if (window.refreshDeviceEnvelope) {
                            window.refreshDeviceEnvelope();
                        }
                    }, 800);
                } else {
                    showToast(data.message || 'Failed to detect SIM number', 'danger');
                }
            })
            .catch(error => {
                console.error('Error detecting SIM number:', error);
                showToast('Failed to detect SIM number', 'danger');
            })
            .finally(() => {
                if (button) button.disabled = !isDeviceOnline;
            });
    }

    // ==================== WIFI FUNCTIONS ====================

    function renderWiFiScanFailure(list, message, diagnostic) {
        const safeMsg = escapeHtml(message || 'Failed to scan Wi-Fi networks');
        const selectedSsid = String(diagnostic?.selectedSsid || diagnostic?.desiredSsid || '').trim();
        const deviceWifi = diagnostic?.deviceWifi || {};
        const hostScan = diagnostic?.hostScan || {};
        const detailRows = [];

        if (selectedSsid) {
            detailRows.push(`<div><strong>Selected network:</strong> <code>${escapeHtml(selectedSsid)}</code></div>`);
        }
        if (deviceWifi.lastDisconnectReasonText) {
            detailRows.push(`<div><strong>Device reason:</strong> <code>${escapeHtml(deviceWifi.lastDisconnectReasonText)}</code></div>`);
        }
        if (hostScan.available && selectedSsid && hostScan.desiredVisible === false) {
            detailRows.push(`<div><strong>Host scan:</strong> <code>${escapeHtml(selectedSsid)}</code> was not visible from this dashboard host.</div>`);
        } else if (hostScan.available && hostScan.desiredNetwork) {
            const signal = hostScan.desiredNetwork.signal == null ? 'unknown signal' : `${hostScan.desiredNetwork.signal}%`;
            const band = hostScan.desiredNetwork.band ? ` on ${escapeHtml(hostScan.desiredNetwork.band)}` : '';
            detailRows.push(`<div><strong>Host scan:</strong> <code>${escapeHtml(selectedSsid)}</code> is visible (${signal}${band}).</div>`);
        }
        if (hostScan.interfaceState?.state) {
            detailRows.push(`<div><strong>Host adapter:</strong> ${escapeHtml(hostScan.interfaceState.state)}</div>`);
        }
        if (diagnostic?.likelyCause === 'target_ssid_not_visible_from_dashboard_host') {
            detailRows.push('<div class="small text-muted mt-2">Turn on Windows Mobile Hotspot manually and make sure the hotspot is broadcasting on 2.4 GHz.</div>');
        }
        const showSavedButton = getKnownWifiNetworks().length > 0
            ? `
                <button class="btn btn-sm btn-outline-secondary mt-3 ms-2" onclick="renderAvailableWifiNetworks()">
                    Show Saved Networks
                </button>
            `
            : '';

        list.innerHTML = `
            <div class="text-center py-4 text-danger">
                <i class="bi bi-exclamation-triangle fs-1 d-block mb-3"></i>
                <p>${safeMsg}</p>
                ${detailRows.length ? `<div class="small text-start mx-auto" style="max-width: 520px;">${detailRows.join('')}</div>` : ''}
                <div>
                    <button class="btn btn-sm btn-outline-danger mt-3" onclick="scanWiFiNetworks()">
                        Retry
                    </button>
                    ${showSavedButton}
                </div>
            </div>
        `;
    }

    function formatSimStatus(status) {
        const normalized = String(status || '').trim().toLowerCase();

        switch (normalized) {
            case 'ready':
                return 'Ready';
            case 'sim_ready':
                return 'SIM ready';
            case 'registered':
                return 'Registered';
            case 'absent':
                return 'Absent';
            case 'unknown':
                return 'Unknown';
            default:
                return normalized ? normalized.replace(/_/g, ' ') : 'Unknown';
        }
    }

    function scanWiFiNetworks() {
        const activeDeviceId = syncActiveDeviceId();
        if (!activeDeviceId) {
            showToast('No device selected', 'warning');
            return;
        }

        if (runtimeCapabilities?.wifiClient?.scan === false) {
            showToast('Wi-Fi scan is not supported by this firmware.', 'info');
            return;
        }

        if (scanInProgress) return;
        scanInProgress = true;

        const list = document.getElementById('wifiNetworksList');
        list.innerHTML = `
            <div class="text-center py-4">
                <div class="spinner-border text-primary" role="status"></div>
                <p class="mt-2">Scanning for networks...</p>
            </div>
        `;

        fetch(`/api/modem/wifi/client/scan?deviceId=${encodeURIComponent(activeDeviceId)}`)
            .then(async response => ({
                ok: response.ok,
                data: await response.json().catch(() => ({}))
            }))
            .then(({ ok, data }) => {
                if (ok && data.success) {
                    renderAvailableWifiNetworks(Array.isArray(data.data) ? data.data : []);
                    if (String(data.scanSource || '').trim() === 'dashboard_host') {
                        showToast(data.message || 'Device scan timed out. Showing dashboard host scan results.', 'warning');
                    }
                } else {
                    const fallbackNetworks = Array.isArray(data.data) ? data.data : [];
                    if (fallbackNetworks.length > 0) {
                        renderAvailableWifiNetworks(fallbackNetworks);
                        showToast(data.message || 'Device scan timed out. Showing dashboard host scan results.', 'warning');
                        return;
                    }
                    renderWiFiScanFailure(
                        list,
                        data.message || 'Failed to scan Wi-Fi networks',
                        data.diagnostic || null
                    );
                }
            })
            .catch(error => {
                console.error('Error:', error);
                renderWiFiScanFailure(list, error.message || 'Unknown error', null);
            })
            .finally(() => {
                scanInProgress = false;
            });
    }

    function switchScannedWiFi(ssid, encrypted, security) {
        const knownNetwork = getKnownWifiNetwork(ssid);
        if (knownNetwork?.passwordSet || !encrypted) {
            connectKnownWiFi(ssid, security);
            return;
        }
        showConnectModal(ssid, encrypted);
    }

    function connectKnownWiFi(ssid, security) {
        if (!runtimeCapabilities?.wifiClient?.remoteConnect) {
            showToast(getWifiRuntimeMessage(), 'info');
            return;
        }

        if (!isDeviceOnline) {
            showToast('Device is offline', 'warning');
            return;
        }

        fetch('/api/modem/wifi/client/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deviceId,
                ssid,
                security: security || getKnownWifiNetwork(ssid)?.security || ''
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast(data.message, 'success');
                loadStatus(true);
                setTimeout(() => loadStatus(true), 4000);
                setTimeout(() => loadStatus(true), 12000);
            } else {
                showToast(data.message, 'danger');
            }
        })
        .catch(error => {
            console.error('Error:', error);
            showToast('Failed to switch Wi-Fi network', 'danger');
        });
    }

    function retrySavedWiFi(preferredSsid = null) {
        if (!runtimeCapabilities?.wifiClient?.retrySaved) {
            showToast(getWifiRuntimeMessage(), 'info');
            return;
        }

        if (!isDeviceOnline) {
            showToast('Device is offline', 'warning');
            return;
        }

        const savedProfile = getSavedWifiProfile();
        const preferredNetwork = preferredSsid ? getKnownWifiNetwork(preferredSsid) : null;
        if (!savedProfile.ssid && !preferredNetwork) {
            showToast('No saved Wi-Fi network is available for this device yet', 'warning');
            return;
        }
        if (preferredSsid && !preferredNetwork) {
            showToast(`No saved Wi-Fi network found for ${preferredSsid}`, 'warning');
            return;
        }
        if (preferredNetwork && !preferredNetwork.passwordSet && !isOpenWifiSecurityValue(preferredNetwork.security)) {
            showToast(`Saved Wi-Fi network ${preferredSsid} is missing a password`, 'warning');
            return;
        }
        if (!preferredNetwork && !savedProfile.passwordSet) {
            showToast('The selected saved Wi-Fi network is missing a password', 'warning');
            return;
        }

        fetch('/api/modem/wifi/client/retry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deviceId,
                ssid: preferredSsid || savedProfile.ssid
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast(data.message, 'success');
                loadStatus(true);
                setTimeout(() => loadStatus(true), 4000);
                setTimeout(() => loadStatus(true), 12000);
            } else {
                showToast(data.message, 'danger');
            }
        })
        .catch(error => {
            console.error('Error:', error);
            showToast('Failed to retry saved Wi-Fi network', 'danger');
        });
    }

    function updateConnectPasswordFieldVisibility() {
        const security = document.getElementById('connectSecurity')?.value || 'WPA2-PSK';
        const passwordField = document.getElementById('passwordField');
        const passwordInput = document.getElementById('connectPassword');
        if (!passwordField || !passwordInput) return;

        const openNetwork = isOpenWifiSecurityValue(security);
        passwordField.style.display = openNetwork ? 'none' : 'block';
        if (openNetwork) {
            passwordInput.value = '';
        }
    }

    function openWiFiConnectModal({ ssid = '', encrypted = true, security = '', manual = false } = {}) {
        if (!runtimeCapabilities?.wifiClient?.remoteConnect) {
            showToast(getWifiRuntimeMessage(), 'info');
            return;
        }

        const knownNetwork = getKnownWifiNetwork(ssid);
        const ssidInput = document.getElementById('connectSsidDisplay');
        const passwordInput = document.getElementById('connectPassword');
        const securityField = document.getElementById('securityField');
        const securityInput = document.getElementById('connectSecurity');
        const modalTitle = document.querySelector('#wifiConnectModal .modal-title');
        const resolvedSecurity = security || knownNetwork?.security || (encrypted ? 'WPA2-PSK' : 'open');

        if (ssidInput) {
            ssidInput.value = ssid;
            ssidInput.readOnly = !manual;
            ssidInput.placeholder = manual ? 'Enter Wi-Fi name' : '';
        }
        if (passwordInput) {
            passwordInput.value = '';
            passwordInput.placeholder = knownNetwork?.passwordSet
                ? 'Leave blank to use the saved dashboard password'
                : '';
        }
        if (securityField) {
            securityField.style.display = 'block';
        }
        if (securityInput) {
            securityInput.value = resolvedSecurity;
        }
        if (modalTitle) {
            modalTitle.innerHTML = manual
                ? '<i class="bi bi-plus-lg me-2"></i>Add Wi-Fi Network'
                : '<i class="bi bi-wifi me-2"></i>Connect to Wi-Fi';
        }

        updateConnectPasswordFieldVisibility();
        const modal = new bootstrap.Modal(document.getElementById('wifiConnectModal'));
        modal.show();
    }

    function openManualWiFiEntry() {
        openWiFiConnectModal({ manual: true, encrypted: true, security: 'WPA2-PSK' });
    }

    function showConnectModal(ssid, encrypted) {
        openWiFiConnectModal({
            ssid,
            encrypted,
            security: getKnownWifiNetwork(ssid)?.security || (encrypted ? 'WPA2-PSK' : 'open'),
            manual: false
        });
    }

    function connectToWiFi() {
        if (!runtimeCapabilities?.wifiClient?.remoteConnect) {
            showToast(getWifiRuntimeMessage(), 'info');
            return;
        }

        if (!isDeviceOnline) {
            showToast('Device is offline', 'warning');
            return;
        }

        const ssid = document.getElementById('connectSsidDisplay').value.trim();
        const password = document.getElementById('connectPassword').value;
        const security = document.getElementById('connectSecurity')?.value || getKnownWifiNetwork(ssid)?.security || 'WPA2-PSK';

        if (!ssid) {
            showToast('SSID is required', 'warning');
            return;
        }

        const data = { ssid, security, deviceId };
        if (password !== '') {
            data.password = password;
        }

        fetch('/api/modem/wifi/client/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast(data.message, 'success');
                const modal = bootstrap.Modal.getInstance(document.getElementById('wifiConnectModal'));
                modal.hide();
                loadStatus();
            } else {
                showToast(data.message, 'danger');
            }
        })
        .catch(error => {
            console.error('Error:', error);
            showToast('Failed to connect', 'danger');
        });
    }

    function disconnectWiFi() {
        if (!runtimeCapabilities?.wifiClient?.remoteDisconnect) {
            showToast(getWifiRuntimeMessage(), 'info');
            return;
        }

        if (!isDeviceOnline) {
            showToast('Device is offline', 'warning');
            return;
        }

        if (!confirm('Disconnect from Wi-Fi?')) return;

        fetch('/api/modem/wifi/client/disconnect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast(data.message, 'success');
                loadStatus();
            } else {
                showToast(data.message, 'danger');
            }
        })
        .catch(error => {
            console.error('Error:', error);
            showToast('Failed to disconnect', 'danger');
        });
    }

    // ==================== HOTSPOT FUNCTIONS ====================

    function toggleHotspot(enabled) {
        if (!runtimeCapabilities?.hotspot?.remoteToggle) {
            showToast('Remote hotspot toggle is not supported by the current firmware.', 'info');
            if (elements.hotspotToggle) elements.hotspotToggle.checked = !enabled;
            return;
        }

        if (!isDeviceOnline) {
            showToast('Device is offline', 'warning');
            if (elements.hotspotToggle) elements.hotspotToggle.checked = !enabled;
            return;
        }

        fetch('/api/modem/wifi/hotspot/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, deviceId })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast(data.message, 'success');
                loadStatus();
            } else {
                if (elements.hotspotToggle) elements.hotspotToggle.checked = !enabled;
                showToast(data.message, 'danger');
            }
        })
        .catch(error => {
            console.error('Error:', error);
            if (elements.hotspotToggle) elements.hotspotToggle.checked = !enabled;
            showToast('Failed to toggle hotspot', 'danger');
        });
    }

    function loadHotspotClients() {
        const activeDeviceId = syncActiveDeviceId();
        const canReadClients = Boolean(runtimeCapabilities?.hotspot?.remoteToggle)
            || Boolean(runtimeCapabilities?.hotspot?.remoteConfigure)
            || Boolean(runtimeCapabilities?.hotspot?.remoteClientBlock)
            || Boolean(runtimeCapabilities?.hotspot?.remoteClientLimit);
        if (!isDeviceOnline) return;
        if (!canReadClients) return;

        fetch(`/api/modem/wifi/hotspot/clients?deviceId=${encodeURIComponent(activeDeviceId)}&_ts=${Date.now()}`, {
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    displayHotspotClients(data.data);
                }
            })
            .catch(console.error);
    }

    function displayHotspotClients(clients) {
        const list = elements.clientsList;
        if (!list) return;
        const canBlockClients = Boolean(runtimeCapabilities?.hotspot?.remoteClientBlock);
        const canLimitClients = Boolean(runtimeCapabilities?.hotspot?.remoteClientLimit);

        if (!clients || clients.length === 0) {
            list.innerHTML = runtimeCapabilities?.hotspot?.remoteToggle
                ? '<div class="text-center py-4 text-muted">No clients connected</div>'
                : '<div class="text-center py-4 text-muted">No hotspot client telemetry reported.</div>';
            return;
        }

        let html = '';
        clients.forEach(client => {
            const signalClass = client.rssi ? 
                (client.rssi > -50 ? 'success' : client.rssi > -70 ? 'warning' : 'danger') : 
                'secondary';
            const connectedTime = client.connected ? formatConnectedTime(client.connected) : 'Just now';

            html += `
                <div class="list-group-item">
                    <div class="d-flex justify-content-between align-items-center">
                        <div>
                            <i class="bi bi-${client.hostname?.includes('iPhone') ? 'phone' : 'laptop'} me-2"></i>
                            <strong>${escapeHtml(client.hostname || 'Unknown Device')}</strong>
                            <br>
                            <small class="text-muted">${escapeHtml(client.mac || 'Unknown MAC')}</small>
                        </div>
                        <div class="text-end">
                            <small>${escapeHtml(client.ip || '0.0.0.0')}</small>
                            <br>
                            <small class="text-muted">${escapeHtml(connectedTime)}</small>
                        </div>
                    </div>
                    ${client.rssi ? `
                        <div class="mt-2">
                            <div class="progress" style="height: 4px;">
                                <div class="progress-bar bg-${signalClass}" style="width: ${Math.min(100, (client.rssi + 100) * 2)}%"></div>
                            </div>
                        </div>
                    ` : ''}
                    ${(canBlockClients || canLimitClients) ? `
                        <div class="mt-2 d-flex justify-content-end gap-2">
                            ${canLimitClients ? `
                                <button class="btn btn-sm btn-outline-warning" data-mac="${escapeHtml(client.mac || '')}" onclick="limitClient(this.dataset.mac)">
                                    <i class="bi bi-speedometer2"></i> Limit
                                </button>
                            ` : ''}
                            ${canBlockClients ? `
                                <button class="btn btn-sm btn-outline-danger" data-mac="${escapeHtml(client.mac || '')}" onclick="blockClient(this.dataset.mac)">
                                    <i class="bi bi-slash-circle"></i> Block
                                </button>
                            ` : ''}
                        </div>
                    ` : '<div class="mt-2 small text-muted">Client control is not exposed by the current firmware.</div>'}
                </div>
            `;
        });

        list.innerHTML = html;
    }

    function saveHotspotConfig() {
        if (!runtimeCapabilities?.hotspot?.remoteConfigure) {
            showToast('Remote hotspot configuration is not supported by the current firmware.', 'info');
            return;
        }

        if (!isDeviceOnline) {
            showToast('Device is offline', 'warning');
            return;
        }

        const config = {
            ssid: elements.hotspotSsid?.value,
            password: elements.hotspotPassword?.value,
            security: elements.hotspotSecurity?.value,
            band: elements.hotspotBand?.value,
            channel: parseInt(elements.hotspotChannel?.value),
            maxClients: parseInt(elements.hotspotMaxClients?.value),
            hidden: elements.hotspotHidden?.checked,
            deviceId
        };

        if (!config.ssid || !config.password) {
            showToast('SSID and password are required', 'warning');
            return;
        }

        if (config.password.length < 8) {
            showToast('Password must be at least 8 characters', 'warning');
            return;
        }

        fetch('/api/modem/wifi/hotspot/configure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('Hotspot configured', 'success');
                loadStatus();
            } else {
                showToast(data.message, 'danger');
            }
        })
        .catch(error => {
            console.error('Error:', error);
            showToast('Failed to save config', 'danger');
        });
    }

    function limitClient(mac) {
        if (!runtimeCapabilities?.hotspot?.remoteClientLimit) {
            showToast('Client bandwidth limiting is not supported by the current firmware.', 'info');
            return;
        }

        const speed = prompt('Enter speed limit in Kbps (e.g., 512):', '512');
        if (speed) {
            fetch('/api/modem/wifi/hotspot/clients/limit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mac, speed: parseInt(speed), deviceId })
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    showToast(`Client limited to ${speed} Kbps`, 'success');
                } else {
                    showToast(data.message, 'danger');
                }
            })
            .catch(console.error);
        }
    }

    function blockClient(mac) {
        if (!runtimeCapabilities?.hotspot?.remoteClientBlock) {
            showToast('Client blocking is not supported by the current firmware.', 'info');
            return;
        }

        if (!confirm(`Block client ${mac}?`)) return;

        fetch('/api/modem/wifi/hotspot/clients/block', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mac, deviceId })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('Client blocked', 'success');
                loadHotspotClients();
            } else {
                showToast(data.message, 'danger');
            }
        })
        .catch(console.error);
    }

    // ==================== USB FUNCTIONS ====================

    function toggleUSB(enabled) {
        if (!runtimeCapabilities?.usb?.remoteToggle) {
            showToast('USB tethering control is not supported by the current firmware.', 'info');
            if (elements.usbToggle) elements.usbToggle.checked = !enabled;
            return;
        }

        if (!isDeviceOnline) {
            showToast('Device is offline', 'warning');
            if (elements.usbToggle) elements.usbToggle.checked = !enabled;
            return;
        }

        fetch('/api/modem/usb/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, deviceId })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast(data.message, 'success');
                loadStatus();
            } else {
                if (elements.usbToggle) elements.usbToggle.checked = !enabled;
                showToast(data.message, 'danger');
            }
        })
        .catch(error => {
            console.error('Error:', error);
            if (elements.usbToggle) elements.usbToggle.checked = !enabled;
            showToast('Failed to toggle USB', 'danger');
        });
    }

    // ==================== DATA USAGE FUNCTIONS ====================

    function resetDataUsage() {
        if (!runtimeCapabilities?.dataUsage?.remoteReset) {
            showToast('Data usage reset is not supported by the current firmware.', 'info');
            return;
        }

        if (!isDeviceOnline) {
            showToast('Device is offline', 'warning');
            return;
        }

        if (!confirm('Reset all data usage counters?')) return;

        fetch('/api/modem/data-usage/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                resetUsageHistory();
                showToast('Data usage reset', 'success');
                loadStatus();
            } else {
                showToast(data.message, 'danger');
            }
        })
        .catch(console.error);
    }

    // ==================== UTILITY FUNCTIONS ====================

    function attachEventListeners() {
        // Mobile toggle
        if (elements.mobileToggle) {
            const newToggle = elements.mobileToggle.cloneNode(true);
            elements.mobileToggle.parentNode.replaceChild(newToggle, elements.mobileToggle);
            newToggle.addEventListener('change', (e) => toggleMobile(e.target.checked));
            elements.mobileToggle = newToggle;
        }

        if (elements.wifiToggle) {
            const newToggle = elements.wifiToggle.cloneNode(true);
            elements.wifiToggle.parentNode.replaceChild(newToggle, elements.wifiToggle);
            newToggle.addEventListener('change', (e) => toggleWiFi(e.target.checked));
            elements.wifiToggle = newToggle;
        }

        // Hotspot toggle
        if (elements.hotspotToggle) {
            const newToggle = elements.hotspotToggle.cloneNode(true);
            elements.hotspotToggle.parentNode.replaceChild(newToggle, elements.hotspotToggle);
            newToggle.addEventListener('change', (e) => toggleHotspot(e.target.checked));
            elements.hotspotToggle = newToggle;
        }

        // USB toggle
        if (elements.usbToggle) {
            const newToggle = elements.usbToggle.cloneNode(true);
            elements.usbToggle.parentNode.replaceChild(newToggle, elements.usbToggle);
            newToggle.addEventListener('change', (e) => toggleUSB(e.target.checked));
            elements.usbToggle = newToggle;
        }

        const connectSecurity = document.getElementById('connectSecurity');
        if (connectSecurity) {
            connectSecurity.addEventListener('change', updateConnectPasswordFieldVisibility);
        }
    }

    function attachSocketListeners() {
        if (typeof socket === 'undefined') return;

        socket.off('internet:mobile');
        socket.off('internet:wifi-client');
        socket.off('internet:hotspot');
        socket.off('internet:usb');

        socket.on('internet:mobile', () => loadStatus(false));
        socket.on('internet:wifi-client', () => loadStatus(false));
        socket.on('internet:hotspot', () => {
            loadStatus(false);
            loadHotspotClients();
        });
        socket.on('internet:usb', () => loadStatus(false));
    }

    function startUpdates() {
        if (updateInterval) clearInterval(updateInterval);
        updateInterval = setInterval(() => loadStatus(false), statusRefreshIntervalMs);
    }

    function refreshStatus() {
        loadStatus(true)
            .then((data) => {
                if (data) {
                    showToast('Status refreshed', 'success');
                } else {
                    showToast('Status refresh failed', 'danger');
                }
            });
    }

    function togglePassword() {
        const input = document.getElementById('connectPassword');
        input.type = input.type === 'password' ? 'text' : 'password';
    }

    function toggleHotspotPassword() {
        const input = document.getElementById('hotspotPassword');
        input.type = input.type === 'password' ? 'text' : 'password';
    }

    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function formatConnectedTime(seconds) {
        if (!seconds) return 'Just now';
        if (seconds < 60) return `${seconds}s ago`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return `${Math.floor(seconds / 86400)}d ago`;
    }

    // Cleanup
    window.addEventListener('beforeunload', () => {
        if (updateInterval) clearInterval(updateInterval);
    });

    window.addEventListener('device:changed', (event) => {
        const nextDeviceId = String(
            event?.detail?.deviceId
            || (window.getActiveDeviceId ? window.getActiveDeviceId() : '')
            || resolveActiveDeviceId()
            || deviceId
            || ''
        ).trim();

        deviceId = nextDeviceId;
        currentStatus = null;
        lastWifiScanResults = null;
        lastWifiScanDeviceId = '';
        resetModemCharts();
        loadStatus(true);
    });

    // Export functions
        window.toggleMobile = toggleMobile;
        window.toggleWiFi = toggleWiFi;
        window.saveAPN = saveAPN;
    window.setAPN = setAPN;
    window.detectSimNumber = detectSimNumber;
    window.scanWiFiNetworks = scanWiFiNetworks;
    window.renderAvailableWifiNetworks = renderAvailableWifiNetworks;
    window.switchScannedWiFi = switchScannedWiFi;
    window.connectKnownWiFi = connectKnownWiFi;
    window.retrySavedWiFi = retrySavedWiFi;
    window.openManualWiFiEntry = openManualWiFiEntry;
    window.showConnectModal = showConnectModal;
    window.connectToWiFi = connectToWiFi;
    window.disconnectWiFi = disconnectWiFi;
    window.toggleHotspot = toggleHotspot;
    window.saveHotspotConfig = saveHotspotConfig;
    window.toggleUSB = toggleUSB;
    window.blockClient = blockClient;
    window.resetDataUsage = resetDataUsage;
    window.refreshStatus = refreshStatus;
    window.togglePassword = togglePassword;
    window.toggleHotspotPassword = toggleHotspotPassword;

    console.log('Internet Manager initialized');
})();
