'use strict';

const { applyModuleRulesToCapabilities } = require('../utils/moduleRules');

describe('moduleRules', () => {
    test('hides calls when live talk is not complete even if dial/control/status exist', () => {
        const status = {
            online: true,
            mqtt_connected: true,
            mqtt_subscribed: true,
            telephony_supported: true,
            telephony_enabled: true,
            modem_registered: true,
            call_phone_permission: true,
            answer_phone_calls_permission: true,
            read_call_log_permission: true,
            call_live_talk_supported: false
        };

        const caps = applyModuleRulesToCapabilities({ calls: true, modem: true }, status, {
            mqttConnected: true,
            rawStatus: status
        });

        expect(caps.calls).toBe(false);
        expect(caps.modules.calls.available).toBe(false);
        expect(caps.modules.calls.reason).toMatch(/live talk/i);
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
