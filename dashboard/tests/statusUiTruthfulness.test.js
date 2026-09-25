'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/main.js'), 'utf8');

function section(start, end) {
    return source.slice(source.indexOf(start), source.indexOf(end));
}

function harness() {
    const elements = new Map();
    const events = {};
    const context = vm.createContext({
        window: { getActiveDeviceId: () => 'esp-test', addEventListener: (name, callback) => { events[name] = callback; } },
        document: { getElementById: id => {
            if (!elements.has(id)) elements.set(id, {
                textContent: '', style: {}, className: '', setAttribute: jest.fn(),
                classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn() }
            });
            return elements.get(id);
        } },
        getStatusActiveDeviceId: () => 'esp-test',
        getSelectedSimSlotSnapshot: () => null,
        getSimNumbersDisplayValue: () => 'Not reported by SIM',
        getSimNumberSourceLabel: () => 'SIM Number',
        getStatusNetworkLabel: () => 'LTE', getStatusSignalIcon: () => 'bi-reception-0',
        getDeviceHardwareIdentity: () => ({ label: 'IMEI', value: 'Not reported' }),
        getDeviceModelDisplayLabel: () => 'ESP32', formatHeaderTimestamp: value => value,
        setProgressWidth: (element, value) => { element.style.width = value + '%'; },
        showElement: jest.fn(), updateDeviceConnection: jest.fn(), updateSidebarSimSelector: jest.fn(),
        updateQueueStatus: jest.fn(), updateHeaderDeviceSummary: jest.fn(),
        updateWifiRequirementBanners: jest.fn(), updateActionAvailability: jest.fn(),
        maybeAutoDetectSimNumber: jest.fn()
    });
    vm.runInContext('let latestDeviceStatus = null; let latestQueueState = {}; let statusRefreshIntervalMs = 60000;\n'
        + section('function deviceWifiConnected()', 'function normalizeStatusRefreshInterval(')
        + section('function normalizeStatusPercent(', 'function isDashboardVisible(')
        + section('function buildOfflineDeviceSnapshot(', 'function summarizeHeaderQueue(')
        + section('function updateSidebarDeviceStatus(', 'function updateQueueStatus(')
        + '\nthis.latest = () => latestDeviceStatus;', context);
    return { context, elements, events };
}

test.each([
    { online: false, mqtt: { connected: true }, wifi: { connected: true } },
    { statusFresh: false, mqtt: { connected: true } },
    { online: true, staleReason: 'no_recent_heartbeat' },
    { wifi: { connected: true, ipAddress: '192.168.0.10' }, activePath: 'wifi' },
    { sim: { registered: true }, mobile: { ipAddress: '10.1.1.2' }, activePath: 'modem' }
])('cached links or bearer registration never override offline/freshness evidence: %j', status => {
    const { context } = harness();
    expect(context.inferStatusOnline({ deviceId: 'esp-test', ...status })).toBe(false);
});

test('another device cannot change the active device cards', () => {
    const { context, elements } = harness();
    context.updateSidebarDeviceStatus({ deviceId: 'esp-test', online: true, battery: 45 });
    context.updateSidebarDeviceStatus({ deviceId: 'other', online: true, battery: 99 });
    expect(elements.get('dashBatteryValue').textContent).toBe('45%');
});

test('fresh heartbeat stays online while stale status readings are cleared', () => {
    const { context, elements } = harness();
    context.updateSidebarDeviceStatus({ deviceId: 'esp-test', online: true, statusFresh: true, battery: 75, signal: 80 });
    context.updateSidebarDeviceStatus({ deviceId: 'esp-test', online: true, statusFresh: false, staleReason: 'no_recent_status' });
    expect(context.latest().online).toBe(true);
    expect(context.updateDeviceConnection).toHaveBeenLastCalledWith(true);
    expect(elements.get('panelBattery').textContent).toBe('---');
    expect(elements.get('dashBatteryValue').textContent).toBe('-');
    expect(elements.get('dashCellSignalMeta').textContent).toBe('Status stale');
    expect(elements.get('dashWifiPrimary').textContent).toBe('Unknown');
});

test('partial updates retain existing metrics and nested module members; explicit null clears', () => {
    const { context, elements } = harness();
    context.updateSidebarDeviceStatus({ deviceId: 'esp-test', online: true, signal: 70, battery: 45,
        wifi: { connected: true, ssid: 'Example', ipAddress: '192.168.1.2' } });
    context.updateSidebarDeviceStatus({ deviceId: 'esp-test', wifi: { rssi: -65 } });
    expect(elements.get('dashBatteryValue').textContent).toBe('45%');
    expect(elements.get('sidebarSignal').textContent).toBe('70%');
    expect(context.latest().wifi).toEqual({ connected: true, ssid: 'Example', ipAddress: '192.168.1.2', rssi: -65 });
    context.updateSidebarDeviceStatus({ deviceId: 'esp-test', battery: null, wifi: null });
    expect(elements.get('dashBatteryValue').textContent).toBe('N/A');
    expect(context.latest().wifi).toBeNull();
});

test('missing metrics render unknown, never undefined%, a full bar, or cellular connected', () => {
    const { context, elements } = harness();
    context.updateSidebarDeviceStatus({ deviceId: 'esp-test', online: true, wifi: { ssid: 'Configured only' } });
    expect(elements.get('sidebarBattery').textContent).toBe('-');
    expect(elements.get('sidebarSignal').textContent).toBe('-');
    expect(elements.get('dashCellSignalValue').textContent).toBe('N/A');
    expect(elements.get('dashCellSignalMeta').textContent).toBe('Unavailable');
    expect(elements.get('dashWifiSignalMeta').textContent).toBe('Not connected');
    expect(elements.get('dashBatteryBar').style.width).toBe('0%');
    expect(context.deviceWifiConnected()).toBe(false);
});

test('explicit Wi-Fi disconnect wins over cached path and role labels', () => {
    const { context, elements } = harness();
    context.updateSidebarDeviceStatus({ deviceId: 'esp-test', online: true, activePath: 'wifi',
        wifiRoleLabel: 'Primary', wifiStatusLabel: 'Connected', wifi: { connected: false, ssid: 'Configured only' } });
    expect(context.deviceWifiConnected()).toBe(false);
    expect(elements.get('dashWifiPrimary').textContent).toBe('Offline');
    expect(elements.get('dashWifiSignalMeta').textContent).toBe('Not connected');
});

test.each([undefined, null, '', ' ', false, true, -1, 101, 'bad', Infinity])('invalid percentage %p stays unknown', value => {
    expect(harness().context.normalizeStatusPercent(value)).toBeNull();
});

test('zero signal/battery remains a real measurement', () => {
    const { context, elements } = harness();
    context.updateSidebarDeviceStatus({ deviceId: 'esp-test', online: true, battery: 0, signal: 0, cellularSignal: 0 });
    expect(elements.get('dashBatteryValue').textContent).toBe('0%');
    expect(elements.get('sidebarSignal').textContent).toBe('0%');
    expect(elements.get('dashCellSignalValue').textContent).toBe('0%');
});

test('status panel renders active transport and keeps absent power telemetry unknown', () => {
    const { context, elements } = harness();
    context.updateSidebarDeviceStatus({
        deviceId: 'esp-test', online: true, statusFresh: true, activePath: 'wifi',
        charging: null, powerSource: null,
        wifi: { connected: true, ipAddress: '192.168.0.102' },
        sim: { dataIp: '10.177.244.78' },
        connectionTransports: {
            wifi: { ipAddress: '192.168.0.102', transport: 'Wi-Fi/MQTT' },
            modem: { ipAddress: '10.177.244.78', transport: 'AT bearer' },
            mqtt: { label: 'MQTT' }
        }
    });
    expect(elements.get('panelWifiIp').textContent).toBe('192.168.0.102 (Wi-Fi/MQTT)');
    expect(elements.get('panelModemIp').textContent).toBe('10.177.244.78 (AT bearer)');
    expect(elements.get('panelTransport').textContent).toBe('MQTT · WebSocket offline');
    expect(elements.get('panelCharging').textContent).toBe('Not reported');
    expect(elements.get('panelPowerSource').textContent).toBe('Not reported');
    context.updateSidebarDeviceStatus({ deviceId: 'esp-test', online: false });
    expect(elements.get('panelTransport').textContent).toBe('---');
    expect(elements.get('panelModemIp').textContent).toBe('---');
});

test('offline state clears old status panel numbers and progress bars', () => {
    const { context, elements } = harness();
    context.updateSidebarDeviceStatus({ deviceId: 'esp-test', online: true, battery: 75, signal: 80 });
    context.updateSidebarDeviceStatus({ deviceId: 'esp-test', online: false });
    expect(elements.get('panelBattery').textContent).toBe('---');
    expect(elements.get('panelBatteryBar').style.width).toBe('0%');
    expect(elements.get('dashBatteryValue').textContent).toBe('-');
});

test('offline transition never invents a last-seen timestamp', () => {
    const { context } = harness();
    expect(context.buildOfflineDeviceSnapshot({}).lastSeen).toBeNull();
    expect(context.buildOfflineDeviceSnapshot({ lastSeen: '2026-01-01T00:00:00Z' }).lastSeen).toBe('2026-01-01T00:00:00Z');
});

test('device selection clears cached cards immediately before the asynchronous refresh', () => {
    const { context, events, elements } = harness();
    ['hideIncomingCallPanel', 'loadCachedSidebarVisibility', 'loadCachedDeviceCapabilities',
        'renderUnreadBadgeState', 'updateUnreadBadge', 'refreshNotificationSummary',
        'refreshHeaderNotificationPreview', 'scheduleDashboardSmsRefresh', 'scheduleDeviceEnvelopeRefresh',
        'syncDashboardStatusDemand', 'syncCurrentLocationDeviceScope', 'syncSidebarDeviceAwareLinks'].forEach(name => { context[name] = jest.fn(); });
    vm.runInContext('let activeIncomingCallContext = null; let lastLiveDeviceStatusAt = 0;\n'
        + section("window.addEventListener('device:changed'", "window.addEventListener('device:sim-changed'"), context);
    context.updateSidebarDeviceStatus({ deviceId: 'esp-test', online: true, battery: 45, operator: 'Old operator' });
    context.window.getActiveDeviceId = () => 'next-device';
    context.getStatusActiveDeviceId = () => 'next-device';
    events['device:changed']();
    expect(context.latest()).toEqual({ deviceId: 'next-device', online: false });
    expect(elements.get('dashBatteryValue').textContent).toBe('-');
    expect(elements.get('dashOperator').textContent).toBe('-');
    expect(context.scheduleDeviceEnvelopeRefresh).toHaveBeenCalledWith(100);
});
