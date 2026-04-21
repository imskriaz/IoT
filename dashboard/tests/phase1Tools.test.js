'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    parseArgs: parseCaptureArgs,
    normalizeBaseUrl,
    sanitizeFileSegment
} = require('../utils/phase1_capture');
const {
    parseArgs: parseCompareArgs,
    comparePhase1
} = require('../utils/phase1_compare');
const {
    parseArgs: parseSoakArgs,
    resolveCaptureCount,
    buildCaptureLabel
} = require('../utils/phase1_soak');

function makeCapture({
    capturedAt,
    deviceId = 'ws-a7670e-476178',
    label = '',
    status = {},
    devices = null,
    smsRows = []
}) {
    return {
        capturedAt,
        deviceId,
        label,
        note: '',
        devices: devices || {
            devices: [
                { id: deviceId, online: Boolean(status.online) }
            ]
        },
        captures: {
            status: {
                ok: true,
                status: 200,
                data: {
                    data: status
                }
            },
            recentSms: {
                ok: true,
                status: 200,
                data: smsRows
            }
        }
    };
}

describe('phase1 helpers', () => {
    test('capture helpers normalize base URL and filename labels', () => {
        expect(normalizeBaseUrl('http://127.0.0.1:3001///')).toBe('http://127.0.0.1:3001');
        expect(sanitizeFileSegment(' Bench Run 01 ')).toBe('bench-run-01');
        expect(parseCaptureArgs(['--device', 'dev-1', '--quiet'])).toEqual(expect.objectContaining({
            deviceId: 'dev-1',
            quiet: true
        }));
    });

    test('compare helper reports Wi-Fi and MQTT regressions', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-compare-'));
        const fromPath = path.join(tempDir, 'from.json');
        const toPath = path.join(tempDir, 'to.json');

        const fromCapture = makeCapture({
            capturedAt: '2026-04-03T10:00:00.000Z',
            label: 'start',
            status: {
                online: true,
                activePath: 'wifi',
                wifi: {
                    connected: true,
                    ssid: 'Riaz',
                    ipAddress: '192.168.1.50',
                    rssi: -60
                },
                mqtt: {
                    connected: true,
                    subscribed: true,
                    reconnectCount: 0,
                    publishedCount: 10,
                    publishFailures: 0
                },
                storage: {
                    mounted: true,
                    queueDepth: 0,
                    dropped: 0
                },
                sync: {
                    inSync: true,
                    dashboardAckAgeMs: 1000,
                    desiredVersion: 1,
                    appliedVersion: 1
                },
                systemRuntime: {
                    freeHeap: 200000,
                    freePsram: 4000000,
                    largestFreeBlock: 100000,
                    rebootReason: 'power_on',
                    degradedReason: ''
                }
            },
            smsRows: [{ type: 'incoming' }]
        });
        const toCapture = makeCapture({
            capturedAt: '2026-04-03T10:30:00.000Z',
            label: 'end',
            status: {
                online: false,
                activePath: 'wifi',
                wifi: {
                    connected: false,
                    ssid: 'Riaz',
                    ipAddress: '',
                    rssi: null
                },
                mqtt: {
                    connected: true,
                    subscribed: false,
                    reconnectCount: 2,
                    publishedCount: 12,
                    publishFailures: 3
                },
                storage: {
                    mounted: true,
                    queueDepth: 2,
                    dropped: 1
                },
                sync: {
                    inSync: false,
                    dashboardAckAgeMs: 4000,
                    desiredVersion: 2,
                    appliedVersion: 1
                },
                systemRuntime: {
                    freeHeap: 180000,
                    freePsram: 3900000,
                    largestFreeBlock: 90000,
                    rebootReason: 'software',
                    degradedReason: 'wifi_disconnected'
                }
            },
            smsRows: [{ type: 'incoming' }, { type: 'outgoing' }]
        });

        fs.writeFileSync(fromPath, JSON.stringify(fromCapture, null, 2), 'utf8');
        fs.writeFileSync(toPath, JSON.stringify(toCapture, null, 2), 'utf8');

        const result = comparePhase1({ from: fromPath, to: toPath });

        expect(result.status).toBe('attention');
        expect(result.warningCount).toBeGreaterThan(0);
        expect(result.warnings).toEqual(expect.arrayContaining([
            'device is offline in the newer capture',
            'active path is Wi-Fi but Wi-Fi is not connected',
            'MQTT is connected but not subscribed'
        ]));
        expect(result.report).toContain('Phase 1 Capture Compare');
    });

    test('soak helpers parse options and compute capture labels/counts', () => {
        expect(parseCompareArgs(['--device', 'dev-1', '--save-json'])).toEqual(expect.objectContaining({
            deviceId: 'dev-1',
            saveJson: true
        }));
        expect(parseSoakArgs(['--device', 'dev-1', '--duration-min', '15', '--interval-sec', '60'])).toEqual(expect.objectContaining({
            deviceId: 'dev-1',
            durationMin: 15,
            intervalSec: 60
        }));
        expect(resolveCaptureCount({ count: 3 })).toBe(3);
        expect(resolveCaptureCount({ count: 0, durationMin: 10, intervalSec: 300 })).toBe(3);
        expect(buildCaptureLabel({ label: 'bench' }, 1, 4)).toBe('bench-02-of-04');
    });
});
