'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

describe('main.js unread badge device scope', () => {
    function createBadgeHarness() {
        const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
        const badge = { textContent: '7', hidden: false };
        const classes = new Set();
        const inbox = {
            textContent: '7',
            classList: { add: value => classes.add(value), remove: value => classes.delete(value) }
        };
        const scope = { deviceId: '', simSlot: null };
        const context = vm.createContext({
            URL, URLSearchParams, console,
            window: {
                location: { origin: 'http://localhost:3001' },
                getActiveDeviceId: () => scope.deviceId,
                getActiveDeviceSimSlot: () => scope.simSlot
            },
            document: {
                title: '(7) Device Bridge',
                getElementById: id => id === 'unreadSmsBadge' ? badge : inbox
            },
            showElement: element => { if (element) element.hidden = false; },
            hideElement: element => { if (element) element.hidden = true; },
            fetch: jest.fn()
        });
        vm.runInContext('let dashboardSmsUnreadToken = 0;\n'
            + source.slice(source.indexOf('function getDashboardSmsDeviceId()'), source.indexOf('function scheduleDashboardSmsRefresh('))
            + source.slice(source.indexOf('function renderUnreadBadgeState('), source.indexOf('function getVisibleNotificationCount(')), context);
        return { context, scope, badge, inbox, classes };
    }

    test('clears both badges and title without requesting unread SMS when no device is selected', async () => {
        const { context, badge, inbox, classes } = createBadgeHarness();
        await expect(context.updateUnreadBadge()).resolves.toBe(0);
        expect(context.fetch).not.toHaveBeenCalled();
        expect(badge.textContent).toBe('0');
        expect(badge.hidden).toBe(true);
        expect(inbox.textContent).toBe('0');
        expect(classes.has('d-none')).toBe(true);
        expect(context.document.title).toBe('Device Bridge');
    });

    test('requests the selected device and SIM and renders their unread count', async () => {
        const { context, scope, badge } = createBadgeHarness();
        scope.deviceId = 'device one';
        scope.simSlot = 1;
        context.fetch.mockResolvedValue({ json: async () => ({ count: 3 }) });
        await expect(context.updateUnreadBadge()).resolves.toBe(3);
        const url = new URL(context.fetch.mock.calls[0][0], 'http://localhost:3001');
        expect(url.searchParams.get('deviceId')).toBe('device one');
        expect(url.searchParams.get('simSlot')).toBe('1');
        expect(badge.textContent).toBe(3);
        expect(badge.hidden).toBe(false);
    });

    test('ignores an old response after clearing and reselecting the same device', async () => {
        const { context, scope, badge } = createBadgeHarness();
        scope.deviceId = 'device-one';
        let finishRequest;
        context.fetch.mockImplementation(() => new Promise(resolve => { finishRequest = resolve; }));
        const pending = context.updateUnreadBadge();
        scope.deviceId = '';
        await context.updateUnreadBadge();
        scope.deviceId = 'device-one';
        finishRequest({ json: async () => ({ count: 9 }) });
        await pending;
        expect(badge.textContent).toBe('0');
        expect(badge.hidden).toBe(true);
        expect(context.fetch).toHaveBeenCalledTimes(1);
    });

    test('an explicit count supersedes a pending response', async () => {
        const { context, scope, badge } = createBadgeHarness();
        scope.deviceId = 'device-one';
        let finishRequest;
        context.fetch.mockImplementation(() => new Promise(resolve => { finishRequest = resolve; }));
        const pending = context.updateUnreadBadge();
        await context.updateUnreadBadge(2);
        finishRequest({ json: async () => ({ count: 9 }) });
        await pending;
        expect(badge.textContent).toBe(2);
    });
});

describe('main.js device HTTP helper export', () => {
    test('exports window.deviceHttpOnline without recursive self-calls', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');

        expect(source).toContain('function inferDeviceHttpOnline(status = latestDeviceStatus)');
        expect(source).toContain('window.deviceHttpOnline = function () {');
        expect(source).toContain('return inferDeviceHttpOnline(latestDeviceStatus);');
        expect(source).not.toContain('return deviceHttpOnline(latestDeviceStatus);');
    });

    test('keeps sidebar navigation scoped to the active device and SIM', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');

        expect(source).toContain("url.searchParams.set('deviceId', deviceId);");
        expect(source).toContain("url.searchParams.set('device', deviceId);");
        expect(source).toContain("url.searchParams.set('simSlot', String(simContext.simSlot));");
        expect(source).toContain("function syncSidebarDeviceAwareLinks(root = document) {");
        expect(source).toContain("scope.querySelectorAll('[data-device-nav=\"true\"] a[href^=\"/\"]:not([target=\"_blank\"])')");
        expect(source).toContain("window.history.replaceState({}, '', scopedHref);");
        expect(source).toContain('window.syncSidebarDeviceAwareLinks = syncSidebarDeviceAwareLinks;');
    });

    test('uses a non-blocking incoming call panel instead of a blocking modal', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');

        expect(source).toContain("document.getElementById('incomingCallPanel')");
        expect(source).toContain('function showIncomingCallPanel(displayNumber, timeLabel)');
        expect(source).toContain("panel.classList.remove('d-none');");
        expect(source).toContain('function hideIncomingCallPanel()');
        expect(source).toContain('window.dismissIncomingCallPanel = function () {');
        expect(source).not.toContain("document.getElementById('incomingCallModal')");
    });

    test('keeps dashboard usable during MQTT outage instead of showing a blocking overlay', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');

        expect(source).toContain("nextTitle = 'Dashboard Socket Down';");
        expect(source).toContain("reason = 'Unavailable while dashboard MQTT reconnects.';");
        expect(source).not.toContain('MQTT_DOWN_SETTINGS_REDIRECT_DELAY_MS');
        expect(source).not.toContain('function scheduleMQTTDownSettingsRedirect()');
        expect(source).not.toContain("return '/settings?mqttDown=1#mqtt-broker';");
        expect(source).not.toContain("nextTitle = 'MQTT';");
        expect(source).not.toContain("nextMessage = mqttState.reconnecting || mqttState.connecting ? 'Connecting' : 'Offline';");
        expect(source).not.toContain('Opening System Settings in ${getMQTTDownRedirectSecondsRemaining()} seconds');
    });

    test('boots connection badges from the server-rendered snapshot instead of forcing a disconnected state', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');

        expect(source).toContain('window._serverConnected = window.INITIAL_SERVER_CONNECTED !== false;');
        expect(source).toContain('window._mqttStatus = normalizeMQTTStatus(window.INITIAL_MQTT_STATUS || {');
        expect(source).toContain('if (window._serverConnected !== true) {');
        expect(source).toContain("updateConnectionStatus('connecting');");
        expect(source).toContain('updateTopBarStatus();');
    });

    test('shows dual-SIM numbers in the status modal and dashboard card', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');

        expect(source).toContain('function getSimNumbersDisplayValue(status, fallback = \'Not reported by SIM\')');
        expect(source).toContain("labels.push(`SIM ${index + 1}: ${number || fallback}`);");
        expect(source).toContain('? getSimNumbersDisplayValue(status)');
        expect(source).toContain('const simNumbersText = isOnline ? getSimNumbersDisplayValue(status) : \'-\';');
        expect(source).not.toContain('selectedSim?.number || getSimNumberDisplayValue(status)');
    });
});
