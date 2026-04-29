'use strict';

const {
    inferCapabilitiesFromStatus,
    mergeCapabilities,
    parseCapabilities
} = require('../utils/deviceCapabilities');

describe('deviceCapabilities', () => {
    test('infers core runtime capabilities from live modem, wifi, and storage status', () => {
        const caps = inferCapabilitiesFromStatus({
            imei: '867530900000001',
            activePath: 'wifi',
            wifi: {
                connected: true,
                ssid: 'BenchNet'
            },
            storage: {
                mounted: true,
                mediaAvailable: true
            },
            battery: 76
        });

        expect(caps).toEqual(expect.objectContaining({
            modem: true,
            sms: true,
            calls: true,
            ussd: true,
            wifi: true,
            internet: true,
            storage: true,
            sd: true,
            battery: true
        }));
    });

    test('merges stored and inferred capability sources without losing positive booleans', () => {
        const caps = mergeCapabilities(
            { display: false, nfc: false, board: 'waveshare' },
            { wifi: true, internet: true, modem: true },
            { storage: true, sd: true }
        );

        expect(caps).toEqual(expect.objectContaining({
            display: false,
            nfc: false,
            wifi: true,
            internet: true,
            modem: true,
            storage: true,
            sd: true,
            board: 'waveshare'
        }));
    });

    test('uses explicit telephony support flags instead of assuming SMS from modem presence', () => {
        const caps = inferCapabilitiesFromStatus({
            activePath: 'modem',
            imei: '867530900000001',
            telephonySupported: false,
            telephonyEnabled: false,
            dataModeEnabled: true,
            sim: {
                registered: true
            }
        });

        expect(caps).toEqual(expect.objectContaining({
            modem: true,
            internet: true,
            sms: false,
            calls: false,
            ussd: false
        }));
    });

    test('normalizes stored ESP32 status JSON into communication capabilities', () => {
        const caps = parseCapabilities({
            board: 'Waveshare ESP32-S3-A7670E-4G',
            capabilities: JSON.stringify({
                active_path: 'modem',
                mqtt_connected: true,
                mqtt_subscribed: true,
                modem_registered: true,
                telephony_supported: true,
                telephony_enabled: true,
                sms_ready: true,
                sms_poll_count: 283,
                imei: '862596081929782'
            })
        });

        expect(caps).toEqual(expect.objectContaining({
            modem: true,
            sms: true,
            calls: true,
            ussd: true,
            internet: true
        }));
    });
});
