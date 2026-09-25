'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/modem.js'), 'utf8');
const start = source.indexOf('    function failClosedOnStatusRefresh(');
const end = source.indexOf('    function updateUI(status) {', start);

function harness(fetchImpl) {
    const elementNames = [
        'internetStatusCard', 'internetIcon', 'internetStatus', 'internetDetails', 'activeSource',
        'policyWifiState', 'policyCellularState',
        'mobileStatus', 'mobileOperator', 'mobileNetwork', 'mobileSignal', 'mobileSignalBar',
        'mobileIP', 'simStatus', 'simNumber', 'wifiClientBadge', 'wifiClientStatus',
        'wifiClientSignal', 'wifiClientSignalBar', 'wifiClientIP', 'usbStatus', 'usbDetails',
        'dataUsageNotice', 'connectionPolicySelect', 'applyConnectionPolicyBtn',
        'mobileToggle', 'detectSimNumberBtn', 'wifiToggle', 'retrySavedWiFiBtn',
        'disconnectWiFiBtn', 'scanWiFiBtn', 'hotspotToggle', 'refreshHotspotClientsBtn',
        'usbToggle', 'dataUsageResetBtn', 'apnSaveBtn', 'hotspotSaveBtn'
    ];
    const elements = Object.fromEntries(elementNames.map(name => [name, { style: {}, disabled: false }]));
    const context = vm.createContext({
        fetch: fetchImpl,
        elements,
        console: { error: jest.fn() },
        window: {},
        syncActiveDeviceId: () => 'device-a',
        resetModemCharts: jest.fn(),
        updateWifiRuntimeCapability: jest.fn(),
        displayHotspotClients: jest.fn()
    });
    vm.runInContext(`
        let currentStatus = { internet: { available: true }, mobile: { connected: true } };
        let deviceId = 'device-a';
        let isDeviceOnline = true;
        let lastUsageSnapshot = {};
        let lastWifiScanResults = null;
        let lastWifiScanDeviceId = '';
        let lastStatusRefreshAt = 0;
        let statusRefreshPromise = null;
        let statusRequestGeneration = 0;
        const STATUS_REFRESH_COOLDOWN_MS = 3000;
        let runtimeCapabilities = {};
        let renderedStatus = null;
        function updateUI(status) { renderedStatus = status; }
        ${source.slice(start, end)}
        this.loadStatus = loadStatus;
        this.getState = () => ({ currentStatus, isDeviceOnline, renderedStatus });
    `, context);
    return { context, elements };
}

describe('Internet Manager status freshness', () => {
    test('a failed fetch never revives cached connectivity or remote controls', async () => {
        const { context, elements } = harness(() => Promise.reject(new Error('network unavailable')));

        expect(await context.loadStatus()).toBeNull();
        expect(context.getState().isDeviceOnline).toBe(false);
        expect(context.getState().currentStatus).toBeNull();
        expect(elements.internetStatus.textContent).toBe('Status Unavailable');
        expect(elements.mobileIP.textContent).toBe('Not reported');
        expect(elements.policyWifiState.textContent).toBe('Not reported');
        expect(elements.applyConnectionPolicyBtn.disabled).toBe(true);
        expect(elements.scanWiFiBtn.disabled).toBe(true);
    });

    test('a successful API response without explicit command readiness stays read-only', async () => {
        const status = { deviceOnline: true, networkTelemetryFresh: true,
            internet: { available: true }, capabilities: {} };
        const { context, elements } = harness(() => Promise.resolve({ json: () => Promise.resolve({ success: true, data: status }) }));

        expect(await context.loadStatus()).toBe(status);
        expect(context.getState().isDeviceOnline).toBe(false);
        expect(elements.internetDetails.textContent).toContain('Device commands unavailable');
    });

    test('fresh authenticated command readiness enables the control state', async () => {
        const status = { deviceOnline: true, networkTelemetryFresh: true,
            commandReady: true, internet: { available: true }, capabilities: {} };
        const { context } = harness(() => Promise.resolve({ json: () => Promise.resolve({ success: true, data: status }) }));

        expect(await context.loadStatus()).toBe(status);
        expect(context.getState().isDeviceOnline).toBe(true);
    });

    test('an API-reported stale status clears live labels even if cached links look connected', async () => {
        const status = { deviceOnline: true, networkTelemetryFresh: false,
            commandReady: false, internet: { available: false }, capabilities: {},
            wifiHotspot: { clients: [{ id: 'stale-client' }] } };
        const { context, elements } = harness(() => Promise.resolve({ json: () => Promise.resolve({ success: true, data: status }) }));

        expect(await context.loadStatus()).toBe(status);
        expect(context.getState().isDeviceOnline).toBe(false);
        expect(elements.internetStatus.textContent).toBe('Status Stale');
        expect(elements.mobileIP.textContent).toBe('Not reported');
        expect(elements.applyConnectionPolicyBtn.disabled).toBe(true);
        expect(context.displayHotspotClients).not.toHaveBeenCalled();
    });

    test('an unsuccessful status response disables actions and is not a refresh success', async () => {
        const { context, elements } = harness(() => Promise.resolve({ json: () => Promise.resolve({ success: false }) }));

        expect(await context.loadStatus()).toBeNull();
        expect(context.getState().isDeviceOnline).toBe(false);
        expect(elements.internetStatus.textContent).toBe('Status Unavailable');
        expect(elements.mobileToggle.disabled).toBe(true);
    });

    test('an older request cannot replace a newer status response', async () => {
        let finishOld;
        const oldResponse = new Promise(resolve => { finishOld = resolve; });
        const fresh = { deviceOnline: true, networkTelemetryFresh: true, commandReady: true,
            internet: { available: true }, capabilities: {} };
        const stale = { deviceOnline: false, networkTelemetryFresh: false, commandReady: false,
            internet: { available: false }, capabilities: {} };
        const fetchImpl = jest.fn()
            .mockImplementationOnce(() => oldResponse)
            .mockImplementationOnce(() => Promise.resolve({ json: () => Promise.resolve({ success: true, data: fresh }) }));
        const { context } = harness(fetchImpl);

        const first = context.loadStatus(true);
        expect(await context.loadStatus(true)).toBe(fresh);
        finishOld({ json: () => Promise.resolve({ success: true, data: stale }) });
        expect(await first).toBeNull();
        expect(context.getState().currentStatus).toBe(fresh);
        expect(context.getState().isDeviceOnline).toBe(true);
    });
});
