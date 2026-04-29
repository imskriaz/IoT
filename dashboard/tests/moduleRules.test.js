'use strict';

const { applyModuleRulesToCapabilities } = require('../utils/moduleRules');

describe('moduleRules', () => {
    test('shows calls when the ESP32 dial path is ready without live talk support', () => {
        const status = {
            online: true,
            mqtt_connected: true,
            mqtt_subscribed: true,
            telephony_supported: true,
            telephony_enabled: true,
            modem_registered: true,
            call_dial_supported: true,
            call_control_supported: false,
            call_live_talk_supported: false
        };

        const caps = applyModuleRulesToCapabilities({ calls: true, modem: true }, status, {
            mqttConnected: true,
            rawStatus: status
        });

        expect(caps.calls).toBe(true);
        expect(caps.modules.calls.available).toBe(true);
        expect(caps.modules.calls.reason).toMatch(/dial path/i);
    });

    test('shows SMS only when MQTT, telephony, send, and receive are ready', () => {
        const status = {
            online: true,
            mqtt_connected: true,
            mqtt_subscribed: true,
            telephony_supported: true,
            telephony_enabled: true,
            modem_registered: true,
            send_sms_permission: true,
            receive_sms_permission: true
        };

        const caps = applyModuleRulesToCapabilities({ sms: true, modem: true }, status, {
            mqttConnected: true,
            rawStatus: status
        });

        expect(caps.sms).toBe(true);
        expect(caps.modules.sms.available).toBe(true);
    });

    test('shows ESP32 SMS from firmware support flags and nested module caps', () => {
        const status = {
            online: true,
            mqtt_connected: true,
            mqtt_subscribed: true,
            telephony_supported: true,
            telephony_enabled: true,
            modem_registered: true,
            sms_supported: true,
            caps: {
                modules: {
                    sms: {
                        available: true,
                        complete: true
                    }
                }
            }
        };

        const caps = applyModuleRulesToCapabilities({ modem: true }, status, {
            mqttConnected: true,
            rawStatus: status
        });

        expect(caps.sms).toBe(true);
        expect(caps.modules.sms.available).toBe(true);
    });

    test('shows ESP32 communication menus from telephony modem even when feature flags are omitted', () => {
        const status = {
            online: true,
            mqtt_connected: true,
            mqtt_subscribed: true,
            telephony_supported: true,
            telephony_enabled: true,
            modem_registered: true,
            modem_operator: 'robi axiata',
            imei: '862596081929782'
        };

        const caps = applyModuleRulesToCapabilities({ modem: true, sms: true, calls: true, ussd: true }, status, {
            mqttConnected: true,
            rawStatus: status
        });

        expect(caps.sms).toBe(true);
        expect(caps.calls).toBe(true);
        expect(caps.ussd).toBe(true);
        expect(caps.modules.sms.available).toBe(true);
        expect(caps.modules.calls.available).toBe(true);
        expect(caps.modules.ussd.available).toBe(true);
    });

    test('keeps SMS visible for stored ESP32 status snapshots with sms_ready evidence', () => {
        const status = {
            online: true,
            mqtt_connected: 'true',
            mqtt_subscribed: 1,
            telephony_supported: 'true',
            telephony_enabled: 'true',
            modem_registered: 'true',
            sms_ready: 'true',
            sms_poll_count: 283
        };

        const caps = applyModuleRulesToCapabilities({ modem: true }, status, {
            mqttConnected: true,
            rawStatus: status
        });

        expect(caps.sms).toBe(true);
        expect(caps.modules.sms.available).toBe(true);
    });

    test('honors explicit unsupported SMS reports', () => {
        const status = {
            online: true,
            mqtt_connected: true,
            mqtt_subscribed: true,
            telephony_supported: true,
            telephony_enabled: true,
            modem_registered: true,
            sms_supported: false
        };

        const caps = applyModuleRulesToCapabilities({ modem: true, sms: true }, status, {
            mqttConnected: true,
            rawStatus: status
        });

        expect(caps.sms).toBe(false);
        expect(caps.modules.sms.available).toBe(false);
    });

    test('hides HTTP or stream features until a complete transport-specific path is reported', () => {
        const status = {
            online: true,
            mqtt_connected: true,
            mqtt_subscribed: true
        };

        const caps = applyModuleRulesToCapabilities({ camera: true, audio: true, intercom: true }, status, {
            mqttConnected: true,
            rawStatus: status
        });

        expect(caps.webcam).toBe(false);
        expect(caps.intercom).toBe(false);
        expect(caps.modules.webcam.available).toBe(false);
        expect(caps.modules.intercom.available).toBe(false);
    });
});
