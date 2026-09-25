'use strict';

const {
    inferCapabilitiesFromStatus,
    isCapabilityAvailable,
    mergeCapabilities,
    parseCapabilities,
    sanitizeStoredCapabilities
} = require('../utils/deviceCapabilities');

describe('deviceCapabilities', () => {
    test.each([null, 'false', 'true', 0, 1, [], [true], {}, { supported: false }, { supported: true }])(
        'fails closed on a non-boolean module flag: %j', (value) => {
            const manifest = { camera: value, sd: value, wifi: value, gpio: value };
            expect(sanitizeStoredCapabilities(manifest)).toEqual({
                camera: false, sd: false, wifi: false, gpio: false
            });
            const caps = parseCapabilities({
                capabilities: JSON.stringify(manifest), has_camera: 1, has_sd: 1,
                board: 'esp32-s3'
            });
            expect(caps).toMatchObject({
                camera: false, sd: false, wifi: false, gpio: false,
                intercom: false, storage: false, internet: false
            });
            expect(mergeCapabilities({ camera: true, sd: true, wifi: true }, manifest))
                .toMatchObject({ camera: false, sd: false, wifi: false,
                    intercom: false, storage: false, internet: false });
        }
    );

    test('ignores array capability sources without dropping valid metadata', () => {
        const caps = mergeCapabilities([{ camera: true }], {
            camera: false, specs: { chip: 'esp32-s3' }, board: 'waveshare'
        });
        expect(caps).not.toHaveProperty('0');
        expect(caps).toMatchObject({ camera: false,
            specs: { chip: 'esp32-s3' }, board: 'waveshare' });
    });

    test('a present manifest does not inherit omitted capabilities from stale columns', () => {
        const caps = parseCapabilities({
            capabilities: JSON.stringify({ board: 'esp32-s3', wifi: true }),
            has_camera: 1, has_audio: 1, has_sd: 1
        });
        expect(caps.camera).toBeUndefined();
        expect(caps.audio).toBeUndefined();
        expect(caps.sd).toBeUndefined();
        expect(caps.intercom).toBeUndefined();
        expect(caps.storage).toBeUndefined();
        expect(caps.wifi).toBe(true);
        expect(parseCapabilities({ capabilities: null, has_camera: 1 }).camera).toBe(true);
        expect(parseCapabilities({ capabilities: '{bad', has_camera: 1 }).camera).toBeUndefined();
    });

    test('board and bridge labels do not infer GPIO support', () => {
        const caps = parseCapabilities({
            board: 'esp32-s3-a7670e',
            capabilities: JSON.stringify({ bridge: 'firmware', chip: 'esp32-s3' })
        });
        expect(caps.gpio).toBeUndefined();
    });

    test('infers only capabilities proven by live modem, wifi, and storage status', () => {
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
        expect(caps).not.toHaveProperty('sms');
        expect(caps).not.toHaveProperty('calls');
        expect(caps).not.toHaveProperty('ussd');
    });

    test('does not infer capabilities from stale or offline telemetry snapshots', () => {
        const stale = inferCapabilitiesFromStatus({
            online: false,
            statusFresh: false,
            activePath: 'wifi',
            imei: '867530900000001',
            wifi: { connected: true, ssid: 'RiazM' },
            storage: { mounted: true },
            battery: 90
        });
        expect(stale).toEqual({});
    });

    test('allows a current source to revoke stale stored capability flags', () => {
        expect(mergeCapabilities(
            { camera: true, audio: true, wifi: true },
            { camera: false, audio: false, wifi: false }
        )).toEqual(expect.objectContaining({
            camera: false,
            audio: false,
            intercom: false,
            wifi: false,
            internet: false
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

    test('removes stale runtime status fields from stored capability profiles', () => {
        const caps = parseCapabilities({
            capabilities: JSON.stringify({
                active_path: 'modem',
                wifi_ssid: 'RiazM',
                wifi_connected: false,
                mqtt_reconnect_count: 12,
                storage_media_available: true,
                activePath: 'modem',
                mqtt: { connected: false },
                wifi: true,
                modem: true,
                internet: true,
                sms: true,
                board: 'esp32-s3',
                specs: { chip: 'esp32-s3' }
            })
        });

        expect(caps).toEqual(expect.objectContaining({
            wifi: true,
            modem: true,
            sms: true,
            internet: true,
            board: 'esp32-s3',
            specs: { chip: 'esp32-s3' }
        }));
        expect(caps).not.toHaveProperty('active_path');
        expect(caps).not.toHaveProperty('wifi_ssid');
        expect(caps).not.toHaveProperty('wifi_connected');
        expect(caps).not.toHaveProperty('mqtt_reconnect_count');
        expect(caps).not.toHaveProperty('storage_media_available');
        expect(caps).not.toHaveProperty('activePath');
        expect(caps).not.toHaveProperty('mqtt');
    });

    test('keeps explicit manifest false ahead of legacy profile flags', () => {
        const caps = parseCapabilities({
            capabilities: JSON.stringify({
                camera: false,
                sd: false,
                storage: false,
                intercom: false,
                internet: false
            }),
            has_camera: 1,
            has_sd: 1,
            has_audio: 1,
            board: 'esp32-s3'
        });

        expect(caps).toEqual(expect.objectContaining({
            camera: false,
            sd: false,
            storage: false,
            intercom: false,
            internet: false
        }));
    });

    test('does not let derived capability checks bypass an explicit false', () => {
        expect(isCapabilityAvailable({ storage: false, sd: true }, 'storage')).toBe(false);
        expect(isCapabilityAvailable({ intercom: false, camera: true, audio: true }, 'intercom')).toBe(false);
        expect(isCapabilityAvailable({ internet: false, modem: true }, 'internet')).toBe(false);
        expect(isCapabilityAvailable({ sd: true }, 'storage')).toBe(true);
        expect(isCapabilityAvailable({ camera: true }, 'intercom')).toBe(true);
    });

    test('preserves explicit stored false when merged after live inference', () => {
        const inferred = inferCapabilitiesFromStatus({
            activePath: 'wifi',
            wifi: { connected: true, ssid: 'BenchNet' },
            storage: { mounted: true },
            imei: '867530900000001'
        });
        const stored = parseCapabilities({
            capabilities: JSON.stringify({ wifi: false, storage: false, internet: false })
        });

        expect(mergeCapabilities(inferred, stored)).toEqual(expect.objectContaining({
            wifi: false,
            storage: false,
            internet: false
        }));
    });
});
