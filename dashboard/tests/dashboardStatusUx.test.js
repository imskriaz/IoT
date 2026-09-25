const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ejs = require('ejs');
const template = fs.readFileSync(path.join(__dirname, '../views/pages/index.html'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '../public/js/main.js'), 'utf8');

test('home status requires explicit online truth even with cached Wi-Fi or MQTT hints', () => {
    const normalizeStart = template.indexOf('function normalizeDashboardStatus(status)');
    const updateStart = template.indexOf('function updateDashboardSummary(status)');
    const ctx = vm.createContext({});
    vm.runInContext(template.slice(normalizeStart, updateStart), ctx);
    for (const online of [undefined, null, false, 'true', 1]) {
        const normalized = ctx.normalizeDashboardStatus({ online, activePath: 'wifi', wifi: { connected: true }, mqtt: { connected: true } });
        expect(normalized.online).toBe(false);
        expect(normalized.wifi.connected).toBe(false);
        expect(normalized.mqtt.connected).toBe(false);
    }
    expect(template).toContain('const isOnline = status.online === true;');
    expect(template).toContain('if (!data || data.online !== true) return;');
});

test('SD progress is numeric only for reported usage, including a measured zero', () => {
    const markup = template.match(/<div class="progress thin-progress <%= physicalMeter\.known[^\n]+/)[0];
    const unknown = ejs.render(markup, { physicalMeter: { known: false, percent: 0 } });
    const measuredZero = ejs.render(markup, { physicalMeter: { known: true, percent: 0 } });
    expect(unknown).toContain('thin-progress d-none');
    expect(unknown).not.toContain('aria-valuenow');
    expect(measuredZero).not.toContain('thin-progress d-none');
    expect(measuredZero).toContain('aria-valuenow="0"');
    expect(template).toContain("progress?.classList.toggle('d-none', !meter.known)");
    expect(template).toContain("progress?.removeAttribute('aria-valuenow')");
    expect(template).toContain('id="dashSdDetail"><%= physicalMeter.text %>');
    expect(template).toContain('if (sdDetailEl) sdDetailEl.textContent = meter.text;');
    expect(template).toContain('id="dashSdUsed"><%= physicalMeter.known ?');
});

test('live SD progress clears a previous numeric reading when usage becomes unknown', () => {
    const start = template.indexOf('if (sdBarEl) {', template.indexOf('function updateDashboardSummary(status)'));
    const end = template.indexOf('\n            }\n\n            const runtime', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const values = new Map();
    const hidden = new Set();
    const progress = {
        classList: { toggle: (name, shouldHide) => shouldHide ? hidden.add(name) : hidden.delete(name) },
        setAttribute: (name, value) => values.set(name, value),
        removeAttribute: name => values.delete(name)
    };
    const sdBarEl = { style: {}, parentElement: progress };
    const ctx = vm.createContext({ sdBarEl, meter: { percent: 17, known: true } });
    const code = template.slice(start, end);
    vm.runInContext(code, ctx);
    expect(values.get('aria-valuenow')).toBe('17');
    expect(hidden.has('d-none')).toBe(false);
    ctx.meter = { percent: 0, known: false };
    vm.runInContext(code, ctx);
    expect(values.has('aria-valuenow')).toBe(false);
    expect(hidden.has('d-none')).toBe(true);
    ctx.meter = { percent: 0, known: true };
    vm.runInContext(code, ctx);
    expect(values.get('aria-valuenow')).toBe('0');
    expect(hidden.has('d-none')).toBe(false);
});

test('live storage details clear on offline and reject contradictory measurements', () => {
    const start = template.indexOf('if (sdValueEl && sdMetaEl && window.SdStatus) {', template.indexOf('function updateDashboardSummary(status)'));
    const end = template.indexOf('\n            const runtime =', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const card = { mounted: true, detected: true, totalBytes: 1000, usedBytes: 250, freeBytes: 750 };
    const sdUsedEl = { textContent: '', parentElement: { title: '' } };
    const sdCapacityEl = { textContent: '' };
    const progress = { classList: { toggle: jest.fn() }, setAttribute: jest.fn(), removeAttribute: jest.fn() };
    const ctx = vm.createContext({
        window: { SdStatus: require('../public/js/sd-status') }, status: { sdCard: card }, isOnline: true,
        sdValueEl: { textContent: '' }, sdMetaEl: { title: '' }, sdDetailEl: { textContent: '' },
        sdStatusEl: { textContent: '' }, sdUsedEl, sdCapacityEl,
        sdBarEl: { style: {}, parentElement: progress },
        formatCompactBytes: value => `${value}B`
    });
    const code = template.slice(start, end);
    vm.runInContext(code, ctx);
    expect(sdUsedEl.textContent).toBe('250B');
    expect(sdCapacityEl.textContent).toBe('1000B');
    ctx.isOnline = false;
    vm.runInContext(code, ctx);
    expect(sdUsedEl.textContent).toBe('—');
    expect(sdCapacityEl.textContent).toBe('—');
    expect(sdUsedEl.parentElement.title).toBe('SD usage unavailable while device is offline');
    ctx.isOnline = true;
    ctx.status = { sdCard: { ...card, usedBytes: 1100 } };
    vm.runInContext(code, ctx);
    expect(sdUsedEl.textContent).toBe('—');
    ctx.status = { sdCard: { ...card, detected: false } };
    vm.runInContext(code, ctx);
    expect(sdUsedEl.textContent).toBe('—');
    expect(sdCapacityEl.textContent).toBe('—');
});

test('both initial and live storage formatters reject impossible memory pairs', () => {
    const serverCtx = vm.createContext({});
    vm.runInContext(template.slice(template.indexOf('const formatStorageBytes'), template.indexOf('const formatSimSlotNumber')) + '\nthis.pair = formatCompactPair;', serverCtx);
    const liveStart = template.indexOf('const formatCompactBytes = (bytes) =>', template.indexOf('function updateDashboardSummary(status)'));
    const liveEnd = template.indexOf('const updateHttpSmsTone =', liveStart);
    const liveCtx = vm.createContext({ offlinePlaceholder: '—' });
    vm.runInContext(template.slice(liveStart, liveEnd) + '\nthis.pair = formatMemoryPair;', liveCtx);
    for (const pair of [serverCtx.pair, liveCtx.pair]) {
        expect(pair(0, 1024)).toBe('0B/1K');
        expect(pair(1025, 1024)).toBe('—');
        expect(pair(-1, 1024)).toBe('—');
        expect(pair(1, 0)).toBe('—');
        expect(pair(null, 1024)).toBe('—');
    }
});

test('small physical flash uses readable units rather than rounding to zero GB', () => {
    const ctx = vm.createContext({});
    vm.runInContext(template.slice(template.indexOf('const formatStorageBytes'), template.indexOf('const formatSimSlotNumber')) + '\nthis.format = formatStorageBytes;', ctx);
    expect(ctx.format(10158080)).toBe('9.69 MiB');
    expect(ctx.format(163840)).toBe('160 KiB');
    expect(ctx.format(0)).toBe('0 B');
    expect(ctx.format(-1)).toBe('Not reported');
    expect(template).not.toContain("+'GB free");
    expect(template).toContain('window.formatBytes(free)');
});

test('missing SIM number is not permanent loading and reported numbers remain intact', () => {
    const ctx = vm.createContext({});
    vm.runInContext(main.slice(main.indexOf('function getSimNumberDisplayValue('), main.indexOf('function getSimSlotNumber(')), ctx);
    expect(ctx.getSimNumberDisplayValue({ online:true })).toBe('Not reported by SIM');
    expect(ctx.getSimNumberDisplayValue({simNumber:'+8801700000000'})).toBe('+8801700000000');
    expect(ctx.getSimNumberDisplayValue({}, null)).toBeNull();
});

test('stored SIM number provenance survives a partial live status update', () => {
    const values = new Map();
    const ctx = vm.createContext({
        getActiveDeviceId: () => 'esp-test',
        sessionStorage: {
            setItem: (key, value) => values.set(key, value),
            getItem: (key) => values.get(key) || null
        }
    });
    vm.runInContext(main.slice(main.indexOf('function getSimNumberDisplayValue('), main.indexOf('function getSimSlotNumber(')), ctx);

    expect(ctx.getSimNumberDisplayValue({ deviceId: 'esp-test', simNumber: 'test-number', simNumberSource: 'stored' })).toBe('test-number');
    expect(ctx.getSimNumberDisplayValue({ deviceId: 'esp-test' })).toBe('test-number');
    expect(ctx.getSimNumberSourceLabel({ deviceId: 'esp-test' })).toBe('SIM (stored)');
});

test('unknown battery charging and power source are never inferred from a full gauge', () => {
    expect(template).not.toContain('batteryLooksFull');
    expect(template).not.toContain('Full/idle');
    expect(template).not.toContain('USB/idle');
    expect(main).not.toContain('batteryLooksFull');
    expect(main).not.toContain('Full/idle');
    expect(main).not.toContain('USB/idle');
    expect(template).toContain("const chargingLabel = batteryHasCharging ? (deviceStatus.charging ? 'Yes' : 'No') : 'Unknown'");
    expect(main).toContain("const batteryPowerSourceLabel = status?.powerSource || status?.power_source || 'Unknown'");
});

test('SIM provenance is shown in the existing row label', () => {
    expect(template).toContain('id="dashSimNumberLabel"');
    expect(template).toContain("? 'SIM (stored)'");
    expect(main).toContain('function getSimNumberSourceLabel(status)');
    expect(main).toContain("return 'SIM (stored)'");
});

test('live dashboard updater shares SIM provenance helpers with normalization', () => {
    const helperStart = template.indexOf('const getSimNumberStorageKey = function');
    const labelStart = template.indexOf('const getSimNumberLabel = function');
    const displayStart = template.indexOf('const getSimNumberDisplayValue = function');
    const normalizeStart = template.indexOf('function normalizeDashboardStatus(status)');
    const updateStart = template.indexOf('function updateDashboardSummary(status)');
    expect(helperStart).toBeGreaterThan(0);
    expect(labelStart).toBeGreaterThan(helperStart);
    expect(displayStart).toBeGreaterThan(labelStart);
    expect(displayStart).toBeLessThan(normalizeStart);
    expect(normalizeStart).toBeLessThan(updateStart);
    expect(template.slice(normalizeStart, updateStart)).not.toContain('const getSimNumberLabel = function');
    expect(template.slice(updateStart)).toContain('getSimNumberLabel(status)');
    expect(template.slice(updateStart)).toContain('getSimNumberDisplayValue(status,');
});

test.each([true, false])('refresh waits for command result and restores control (success=%s)', async success => {
    const ctx = vm.createContext({
        window: { getActiveDeviceId: () => 'esp-test', showToast:jest.fn(), refreshDeviceEnvelope:jest.fn().mockResolvedValue() },
        document: {querySelector: () => ({content:'csrf-test'})},
        fetch:jest.fn().mockResolvedValue({ok:success,json:async()=>({success,message:'Device did not respond'})})
    });
    vm.runInContext(template.slice(template.indexOf('async function refreshDashboard('), template.indexOf('async function switchDeviceAndReload(')),ctx);
    const button = {disabled:false,setAttribute:jest.fn(),removeAttribute:jest.fn()};
    await ctx.refreshDashboard(button);
    expect(ctx.fetch).toHaveBeenCalledWith('/api/mqtt/request-status/esp-test',expect.objectContaining({method:'POST'}));
    expect(ctx.window.refreshDeviceEnvelope).toHaveBeenCalledTimes(success ? 1 : 0);
    expect(ctx.window.showToast).toHaveBeenCalledWith(success ? 'Device status refreshed' : 'Device did not respond',success ? 'success' : 'danger');
    expect(button.disabled).toBe(false);
    expect(button.removeAttribute).toHaveBeenCalledWith('aria-busy');
});
