const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sdStatus = require('../public/js/sd-status');
const { buildDashboardDeviceStatus } = require('../utils/dashboardStatus');
const { hydrateDeviceStatusFromCache } = require('../utils/deviceStatusCache');
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const modem = require('../services/modemService');

const snapshot = {
    mqtt_connected: true, mqtt_subscribed: true,
    storage_media_available: true, storage_media_mounted: true,
    storage_media_label: 'Onboard flash', storage_total_bytes: 10158080,
    storage_used_bytes: 163840, storage_free_bytes: 9994240,
    sd_detected: true, sd_mounted: false, sd_capacity_bytes: 64000000000,
    sd_total_bytes: 0, sd_used_bytes: 0, sd_free_bytes: 0, sd_error: 'unsupported_exfat'
};
beforeEach(() => modem.resetDevices());

test('64GB physical card is the only user-visible storage while onboard storage stays private', () => {
    modem.updateDeviceStatus('sd-test', snapshot);
    const status = modem.getDeviceStatus('sd-test');
    expect(status.storage).toMatchObject({ mounted: true, totalBytes: 10158080 });
    expect(status.sdCard).toEqual({ detected: true, mounted: false, capacityBytes: 64000000000, totalBytes: 0, usedBytes: 0, freeBytes: 0, error: 'unsupported_exfat' });
    expect(buildDashboardDeviceStatus(status, true).sdCard).toEqual(status.sdCard);
    expect(sdStatus.describe(status.sdCard)).toBe('59.6 GiB card — exFAT is not supported; card data unchanged');
    expect(sdStatus.describe(status.sdCard)).not.toContain('free');
});

test('partial heartbeat preserves physical card and explicit removal replaces stale mount state', () => {
    modem.updateDeviceStatus('sd-test', snapshot);
    modem.updateDeviceStatus('sd-test', { uptime: 100 });
    expect(modem.getDeviceStatus('sd-test').sdCard.capacityBytes).toBe(64000000000);
    modem.updateDeviceStatus('sd-test', { sd_detected: false, sd_mounted: false, sd_capacity_bytes: 0, sd_total_bytes: 0, sd_used_bytes: 0, sd_free_bytes: 0, sd_error: 'removed' });
    expect(modem.getDeviceStatus('sd-test').sdCard).toMatchObject({ detected: false, mounted: false, capacityBytes: 0, error: 'removed' });
    expect(modem.getDeviceStatus('sd-test').storage.totalBytes).toBe(10158080);
});

test('cache hydration preserves card capacity and observation age', async () => {
    const updatedAt = new Date(Date.now() - 30000).toISOString();
    const db = { get: jest.fn().mockResolvedValue({ payload_json: JSON.stringify(snapshot), updated_at: updatedAt }) };
    const restored = await hydrateDeviceStatusFromCache(db, modem, 'sd-test');
    expect(restored.sdCard.capacityBytes).toBe(64000000000);
    expect(restored.lastSeen).toBe(updatedAt);
    const offline = buildDashboardDeviceStatus({ ...restored, lastSeen: new Date(Date.now() - 300000).toISOString() }, false);
    expect(offline.sdCard.capacityBytes).toBe(64000000000);
    expect(sdStatus.describe(offline.sdCard, false)).toMatch(/^Offline — last reported:/);
});

test('legacy hardcoded mounted flag is not presented as physical card detection', () => {
    expect(sdStatus.normalize(null)).toBeNull();
    expect(sdStatus.normalize({ sd_mounted: false, storage_media_mounted: true })).toBeNull();
    expect(sdStatus.describe(null)).toBe('Not checked by firmware');
});

test('an explicit detected false status is presented as a missing card without requiring an error code', () => {
    expect(sdStatus.describe({ detected: false, mounted: false })).toBe('No SD card detected');
    expect(sdStatus.meter({ detected: false, mounted: false })).toMatchObject({ status: 'Not detected', value: 'N/A' });
    expect(sdStatus.details({ detected: false, mounted: false })).toMatchObject({ state: 'missing', stateLabel: 'Card missing' });
});

test.each([
    ['not_probed', 'Not checked'], ['not_detected', 'Not detected'],
    ['init_failed', 'Card check failed'], ['mount_failed', 'could not be mounted'],
    ['usage_failed', 'free space could not be read'], ['removed', 'Card removed']
])('actionable %s state does not falsely report usable space', (error, message) => {
    const text = sdStatus.describe({ detected: true, mounted: false, capacityBytes: 64000000000, error });
    expect(text).toContain(message);
    expect(text).not.toContain('0 B free');
});

test('mounted SD displays filesystem free space using 64-bit-safe numbers', () => {
    const card = sdStatus.normalize({ sd_detected: true, sd_mounted: true, sd_capacity_bytes: 64000000000, sd_total_bytes: 62519640064, sd_used_bytes: 458752, sd_free_bytes: 62519181312, sd_error: '' });
    expect(card.totalBytes).toBeGreaterThan(2 ** 32);
    expect(sdStatus.describe(card)).toContain('GiB free /');
    expect(sdStatus.normalize({ sd_capacity_bytes: -1 }).capacityBytes).toBeNull();
    expect(sdStatus.describe({ ...card, error: 'mount_failed' })).not.toContain('GiB free /');
    expect(sdStatus.meter(card)).toMatchObject({ text: '58.23 GiB free' });
    expect(sdStatus.meter(card).percent).toBeGreaterThan(0);
    expect(sdStatus.meter(card).percent).toBeLessThan(1);
    expect(sdStatus.meter(card, false)).toMatchObject({ text: 'Offline' });
});

test('missing SD usage and free space stay unknown instead of becoming zero', () => {
    const card = { detected: true, mounted: true, totalBytes: 62519640064, usedBytes: null, freeBytes: null };
    expect(sdStatus.normalize({ sd_detected: true, sd_mounted: true, sd_total_bytes: 62519640064, sd_used_bytes: null, sd_free_bytes: null }))
        .toMatchObject({ usedBytes: null, freeBytes: null });
    expect(sdStatus.meter(card)).toMatchObject({ value: 'Ready', text: 'Free space not reported', known: false });
    expect(sdStatus.details(card)).toMatchObject({ usedText: '—', freeText: '—', capacityText: '58.23 GiB' });
});

test('impossible SD byte counts cannot become a full bar or a plausible free-space label', () => {
    const card = { detected: true, mounted: true, totalBytes: 1024, usedBytes: 2048, freeBytes: 2048 };
    expect(sdStatus.meter(card)).toMatchObject({ known: false, value: 'Ready', text: 'Free space not reported' });
    expect(sdStatus.details(card)).toMatchObject({ usedText: '—', freeText: '—' });
    expect(sdStatus.describe(card)).toBe('Not reported free / 1 KiB');
});

test('contradictory removed-card telemetry cannot report usage or enable file access', () => {
    const card = { detected: false, mounted: true, totalBytes: 1024, usedBytes: 256, freeBytes: 768 };
    expect(sdStatus.describe(card)).toBe('No SD card detected');
    expect(sdStatus.meter(card)).toMatchObject({ known: false, status: 'Not detected', value: 'N/A' });
    expect(sdStatus.details(card)).toMatchObject({ state: 'missing', usedText: '—', canOpenFiles: false });
});

test('mounted card with a usage probe failure stays mounted without inventing zero usage', () => {
    const card = { detected: true, mounted: true, totalBytes: 0, usedBytes: 0, freeBytes: 0, error: 'usage_failed' };
    expect(sdStatus.meter(card)).toMatchObject({ known: false, status: 'Mounted', value: 'Ready' });
    expect(sdStatus.details(card)).toMatchObject({ state: 'mounted', usedText: '—', freeText: '—', canOpenFiles: true });
    expect(sdStatus.details(card).description).toContain('free space could not be read');
});

test('storage details distinguish mounted, missing, unavailable, and offline cards', () => {
    const mounted = sdStatus.details({
        detected: true,
        mounted: true,
        totalBytes: 62519640064,
        usedBytes: 655360,
        freeBytes: 62518984704
    });
    expect(mounted).toMatchObject({
        state: 'mounted',
        stateLabel: 'Mounted',
        capacityText: '58.23 GiB',
        usedText: '640 KiB',
        canOpenFiles: true
    });

    const missing = sdStatus.details({ detected: false, mounted: false, error: 'not_detected' });
    expect(missing).toMatchObject({ state: 'missing', stateLabel: 'Card missing', canOpenFiles: false });
    expect(missing.description).toContain('No SD card detected');
    expect(missing.capacityText).toBe('—');

    const unavailable = sdStatus.details({ detected: true, mounted: false, capacityBytes: 64000000000, error: 'unsupported_exfat' });
    expect(unavailable).toMatchObject({ state: 'unavailable', stateLabel: 'Not mounted', capacityText: '59.6 GiB' });
    expect(unavailable.description).toContain('exFAT is not supported');

    const offline = sdStatus.details({ detected: true, mounted: true, totalBytes: 1024, usedBytes: 0, freeBytes: 1024 }, false);
    expect(offline).toMatchObject({ state: 'offline', stateLabel: 'Offline', canOpenFiles: false });
    expect(offline.description).toContain('Last reported');
});

test('dashboard keeps one compact SD presentation and uses the lower card for runtime modules', () => {
    const home = fs.readFileSync(path.join(__dirname, '../views/pages/index.html'), 'utf8');
    const storage = fs.readFileSync(path.join(__dirname, '../views/pages/storage.html'), 'utf8');
    expect(home).toContain('/js/sd-status.js');
    expect(home).toContain('min-height: 9.2rem');
    expect(home).toContain('id="dashSdBar"');
    expect(home).toContain('id="dashSdDetail"');
    expect(home).toContain('const physicalMeter');
    expect(home).not.toContain('dashboard-card-section small');
    expect(home).toContain('<strong>SD</strong> <span id="dashSdDetail">');
    expect(home).toContain('<strong>Flash</strong> <span id="dashFlashUsage">');
    expect(home).toContain('id="dashSdUsed"');
    expect(home).toContain('id="dashSdCapacity"');
    expect(home).not.toContain('id="dashboardStorageOverview"');
    expect(home).toContain('id="dashboardRuntimeOverview"');
    expect(home).toContain('id="dashboardModuleHealth"');
    expect(home).toContain('Runtime modules');
    expect(home).not.toContain('id="dashSdSpace"');
    expect(home).not.toContain('id="dashSdQueue"');
    expect(storage).toContain('/js/sd-status.js');
    expect(storage).toContain('id="physicalSdStatus"');
    expect(storage).not.toContain('onboard storage');
    expect(storage).not.toContain('Dashboard Cache');
    expect(storage).not.toContain('data-storage="internal"');
    expect(storage).not.toContain('data-storage="physicalSd"');
});

test('storage info builds the file lane only from physical SD status', () => {
    modem.updateDeviceStatus('sd-test', snapshot);
    const source = fs.readFileSync(path.join(__dirname, '../routes/storage.js'), 'utf8');
    const code = source.slice(source.indexOf('function buildStorageInfoFromCachedStatus('), source.indexOf('function waitForMqttEvent('));
    const context = vm.createContext({ global: { modemService: modem } });
    vm.runInContext(code, context);
    const response = context.buildStorageInfoFromCachedStatus('sd-test');
    expect(response.data.sd.total).toBe(0);
    expect(response.data.sd.available).toBe(false);
    expect(response.data.sdCard.capacityBytes).toBe(64000000000);
    expect(response.data.sdCard.mounted).toBe(false);
    expect(response.data.online).toBe(true);
});

test('dashboard offline warning follows live status without page reload', () => {
    const source = fs.readFileSync(path.join(__dirname, '../views/pages/index.html'), 'utf8');
    const start = source.indexOf("const offlineAlert = document.getElementById('dashboardOfflineAlert');");
    const end = source.indexOf('\n', source.indexOf("offlineAlert.classList.toggle", start));
    expect(start).toBeGreaterThan(0);
    const toggle = jest.fn();
    const context = vm.createContext({ document: { getElementById: () => ({ classList: { toggle } }) }, status: {} });
    for (const online of [true, false, undefined, true]) {
        context.status = { online };
        vm.runInContext(`{ ${source.slice(start, end)} }`, context);
        expect(toggle).toHaveBeenLastCalledWith('d-none', online === true);
    }
});

test('file listing with missing capacity preserves known SD usage and otherwise says not reported', () => {
    const source = fs.readFileSync(path.join(__dirname, '../public/js/storage.js'), 'utf8');
    const start = source.indexOf('function updateStorageStats(');
    const end = source.indexOf('// ==================== UTILITY FUNCTIONS', start);
    const elements = { freeSpace: {}, totalSpace: {} };
    const state = { storageInfo: { sd: { total: 62519640064, free: 62519181312 } } };
    const context = vm.createContext({ state, document: { getElementById: id => elements[id] }, formatSize: sdStatus.formatBytes });
    vm.runInContext(source.slice(start, end), context);
    context.updateStorageStats({ total: 0, free: 0 });
    expect(elements.totalSpace.textContent).toBe('Total: 58.23 GiB');
    expect(elements.freeSpace.textContent).toContain('GiB');
    state.storageInfo = null;
    context.updateStorageStats({ total: 0, free: 0 });
    expect(elements.freeSpace.textContent).toBe('Free: Not reported');
    context.updateStorageStats({ total: 100, free: 0 });
    expect(elements.freeSpace.textContent).toBe('Free: 0 B');
});
