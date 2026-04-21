'use strict';

const {
    inferCapabilitiesFromStatus,
    mergeCapabilities
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
});
