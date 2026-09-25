'use strict';

const { applyModuleRulesToCapabilities } = require('../utils/moduleRules');

describe('moduleRules', () => {
    test('fails closed when online state is missing or telemetry is stale', () => {
        const caps = { wifi: true, modem: true, sms: true, battery: true };
        const missingHeartbeat = applyModuleRulesToCapabilities(caps, {}, {
            mqttConnected: true,
            rawStatus: {}
        });
        const staleHeartbeat = applyModuleRulesToCapabilities(caps, {
            online: true,
            statusFresh: false,
            mqtt_connected: true,
            mqtt_subscribed: true,
            wifi_started: true
        }, { mqttConnected: true });

        expect(missingHeartbeat.modules.wifi.available).toBe(false);
        expect(missingHeartbeat.modules.modem.available).toBe(false);
        expect(missingHeartbeat.modules.sms.available).toBe(false);
        expect(staleHeartbeat.modules.wifi.available).toBe(false);
        expect(staleHeartbeat.modules.modem.available).toBe(false);
        expect(staleHeartbeat.modules.sms.available).toBe(false);
    });

    test('does not let explicit MQTT capability metadata bypass disconnected state', () => {
        const status = {
            online: true,
            mqtt_connected: false,
            mqtt_subscribed: false
        };
        const result = applyModuleRulesToCapabilities({
            mqtt: true,
            modules: { mqtt: { available: true, supported: true } }
        }, status, { mqttConnected: false, rawStatus: status });

        expect(result.modules.mqtt.available).toBe(false);
        expect(result.modules.mqtt.reason).toMatch(/not ready|disconnected|control path/i);
    });

    test('does not treat missing MQTT subscription telemetry as command readiness', () => {
        const status = {
            online: true,
            mqtt_connected: true,
            wifi_started: true,
            telephony_supported: true,
            telephony_enabled: true,
            modem_registered: true
        };
        const result = applyModuleRulesToCapabilities({ wifi: true, modem: true, sms: true }, status, {
            mqttConnected: true,
            rawStatus: status
        });

        expect(result.modules.mqtt.available).toBe(false);
        expect(result.modules.wifi.available).toBe(false);
        expect(result.modules.modem.available).toBe(false);
        expect(result.modules.sms.available).toBe(false);
    });

    test('does not infer dashboard broker readiness when caller omits it', () => {
        const status = {
            online: true,
            mqtt_connected: true,
            mqtt_subscribed: true,
            wifi_started: true
        };
        const result = applyModuleRulesToCapabilities({ wifi: true }, status, { rawStatus: status });

        expect(result.modules.mqtt.available).toBe(false);
        expect(result.modules.wifi.available).toBe(false);
    });

    test('does not turn a cellular bearer IP or route label into an Internet command path', () => {
        const status = {
            online: true,
            active_path: 'modem',
            modem_ip_bearer_ready: true,
            modem_data_ip: '10.171.43.197',
            mqtt_connected: true,
            mqtt_subscribed: false,
            modules: { internet: { available: true, supported: true } }
        };
        const result = applyModuleRulesToCapabilities({ internet: true }, status, {
            mqttConnected: true,
            rawStatus: status
        });

        expect(result.modules.internet.available).toBe(false);
        expect(result.internet).toBe(false);
        expect(result.modules.internet.reason).toMatch(/not ready/i);
    });

    test('exposes Internet only for a fresh selected bearer with subscribed MQTT', () => {
        const status = {
            online: true,
            active_path: 'modem',
            modem_ip_bearer_ready: true,
            mqtt_connected: true,
            mqtt_subscribed: true
        };
        const result = applyModuleRulesToCapabilities({ internet: true }, status, {
            mqttConnected: true,
            rawStatus: status
        });

        expect(result.modules.internet.available).toBe(true);
        expect(result.internet).toBe(true);
        expect(applyModuleRulesToCapabilities({ internet: true }, {
            ...status,
            statusFresh: false
        }, { mqttConnected: true }).internet).toBe(false);
    });

    test('fails closed for malformed direct capability flags', () => {
        const status = {
            online: true,
            mqtt_connected: true,
            mqtt_subscribed: true,
            wifi_started: true,
            storage_media_available: true,
            camera_capture_supported: true,
            audio_stream_supported: true,
            intercom_supported: true
        };
        const caps = applyModuleRulesToCapabilities({
            wifi: 'false', storage: { supported: false }, sd: true,
            camera: { supported: false }, audio: 'true', intercom: true
        }, status, { mqttConnected: true, rawStatus: status });

        expect(caps.wifi).toBe(false);
        expect(caps.storage).toBe(false);
        expect(caps.webcam).toBe(false);
        expect(caps.audio).toBe(false);
        expect(caps.intercom).toBe(false);
        expect(caps.modules.wifi.available).toBe(false);
        expect(caps.modules.storage.available).toBe(false);
    });

    test('explicit unsupported flags cannot be reopened by stale positive status', () => {
        const status = {
            online: true,
            mqtt_connected: true,
            mqtt_subscribed: true,
            telephony_supported: true,
            telephony_enabled: true,
            modem_registered: true,
            sms_supported: true,
            wifi_started: true,
            storage_media_available: true,
            camera_capture_supported: true,
            modules: { wifi: { available: true }, storage: { available: true },
                webcam: { available: true }, sms: { available: true } }
        };
        const result = applyModuleRulesToCapabilities({
            sms: false, wifi: false, storage: false, sd: true, camera: false
        }, status, { mqttConnected: true, rawStatus: status });

        for (const key of ['sms', 'wifi', 'storage', 'webcam']) {
            expect(result.modules[key].available).toBe(false);
        }
        expect(result.camera).toBe(false);
        expect(result.sd).toBe(false);
    });

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

    test('does not infer telephony readiness from modem presence or stored flags', () => {
        const status = {
            online: true,
            mqtt_connected: true,
            mqtt_subscribed: true,
            modem_registered: true,
            modem_operator: 'robi axiata',
            imei: '862596081929782'
        };

        const caps = applyModuleRulesToCapabilities({
            modem: true,
            sms: true,
            calls: true,
            ussd: true
        }, status, { mqttConnected: true, rawStatus: status });

        expect(caps.modules.sms.available).toBe(false);
        expect(caps.modules.calls.available).toBe(false);
        expect(caps.modules.ussd.available).toBe(false);
        expect(caps.sms).toBe(false);
        expect(caps.calls).toBe(false);
        expect(caps.ussd).toBe(false);
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
