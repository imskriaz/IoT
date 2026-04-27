'use strict';

const fs = require('fs');
const path = require('path');

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

    test('redirects to MQTT settings after a sustained dashboard MQTT outage', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');

        expect(source).toContain('const MQTT_DOWN_SETTINGS_REDIRECT_DELAY_MS = 15000;');
        expect(source).toContain('function scheduleMQTTDownSettingsRedirect()');
        expect(source).toContain("return '/settings?mqttDown=1#mqtt-broker';");
        expect(source).toContain('scheduleMQTTDownSettingsRedirect();');
        expect(source).toContain('cancelMQTTDownSettingsRedirect();');
        expect(source).toContain('Opening System Settings in ${getMQTTDownRedirectSecondsRemaining()} seconds');
    });
});
