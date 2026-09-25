'use strict';

jest.mock('child_process', () => ({
    execFile: jest.fn()
}));

const { execFile } = require('child_process');
const hostHotspotService = require('../services/hostHotspotService');
const windowsHostedNetwork = require('../services/hostHotspot/windowsHostedNetwork');
const darwinInternetSharing = require('../services/hostHotspot/darwinInternetSharing');

describe('hostHotspotService platform dispatch', () => {
    afterEach(() => {
        execFile.mockReset();
    });

    test('reports Windows as the implemented host-hotspot backend', () => {
        expect(hostHotspotService.getPlatformSupport('win32')).toMatchObject({
            platform: 'win32',
            supported: true,
            label: 'Windows hosted network'
        });
    });

    test('reports macOS as an explicit adapter slot that is not implemented yet', () => {
        expect(hostHotspotService.getPlatformSupport('darwin')).toMatchObject({
            platform: 'darwin',
            supported: false,
            label: 'macOS Internet Sharing',
            reason: 'not_implemented'
        });
    });

    test('Windows adapter parses hosted-network SSID, status, and security key', async () => {
        execFile.mockImplementation((_file, args, _opts, callback) => {
            if (args.includes('setting=security')) {
                callback(null, `
Hosted network security settings
--------------------------------
    User security key      : 12345678
`, '');
                return;
            }

            callback(null, `
Hosted network settings
-----------------------
    Mode                   : Allowed
    SSID name              : "RIAZ-GAP"

Hosted network status
---------------------
    Status                 : Started
`, '');
        });

        const state = await windowsHostedNetwork.readState();

        expect(state.hosted).toEqual({
            ssid: 'RIAZ-GAP',
            status: 'Started'
        });
        expect(state.security.userSecurityKey).toBe('12345678');
        expect(state.support.supported).toBe(true);
    });

    test('Windows adapter parses interface state and visible Wi-Fi networks', async () => {
        execFile.mockImplementation((_file, args, _opts, callback) => {
            if (args.includes('interfaces')) {
                callback(null, `
There is 1 interface on the system:

    Name                   : Wi-Fi
    Description            : Realtek Adapter
    State                  : disconnected
    Radio status           : Hardware On
                             Software On
`, '');
                return;
            }

            callback(null, `
Interface name : Wi-Fi
There are 2 networks currently visible.

SSID 1 : RIAZ-GAP
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : AA:BB:CC:DD:EE:01
         Signal             : 84%
         Band               : 2.4 GHz
         Channel            : 6

SSID 2 : Guest
    Network type            : Infrastructure
    Authentication          : Open
    Encryption              : None
    BSSID 1                 : AA:BB:CC:DD:EE:02
         Signal             : 40%
         Band               : 2.4 GHz
         Channel            : 11
`, '');
        });

        const scan = await windowsHostedNetwork.scanVisibleNetworks();

        expect(scan.interfaceState).toEqual({
            name: 'Wi-Fi',
            description: 'Realtek Adapter',
            state: 'disconnected',
            radioHardwareOn: true,
            radioSoftwareOn: true
        });
        expect(scan.networks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                ssid: 'RIAZ-GAP',
                authentication: 'WPA2-Personal',
                encryption: 'CCMP',
                signal: 84,
                band: '2.4 GHz',
                channel: 6,
                bssids: ['AA:BB:CC:DD:EE:01']
            })
        ]));
    });

    test('macOS adapter fails explicitly instead of pretending it can configure sharing', async () => {
        await expect(darwinInternetSharing.readState()).rejects.toMatchObject({
            code: 'host_hotspot_platform_not_supported',
            platform: 'darwin'
        });
        await expect(darwinInternetSharing.configure()).rejects.toMatchObject({
            code: 'host_hotspot_platform_not_supported',
            platform: 'darwin'
        });
        await expect(darwinInternetSharing.scanVisibleNetworks()).rejects.toMatchObject({
            code: 'host_hotspot_platform_not_supported',
            platform: 'darwin'
        });
    });
});
