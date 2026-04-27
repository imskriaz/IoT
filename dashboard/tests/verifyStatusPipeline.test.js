'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('axios', () => ({
    post: jest.fn(),
    create: jest.fn()
}));

const axios = require('axios');
const {
    compareStatusPipeline,
    parseArgs,
    parseModemSignalPercent,
    parseWifiSignalPercent,
    resolveLatestPayload,
    verifyStatusPipeline
} = require('../utils/verify_status_pipeline');

describe('verify_status_pipeline helper', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('parse helpers normalize args and signal semantics', () => {
        expect(parseArgs(['--device', 'dev-1', '--quiet'])).toEqual(expect.objectContaining({
            deviceId: 'dev-1',
            quiet: true
        }));
        expect(parseModemSignalPercent(-1)).toBeNull();
        expect(parseModemSignalPercent(99)).toBeNull();
        expect(parseModemSignalPercent(20)).toBe(65);
        expect(parseWifiSignalPercent(-58)).toBe(84);
    });

    test('resolveLatestPayload returns the newest json file', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-pipeline-'));
        const older = path.join(tempDir, 'older.json');
        const newer = path.join(tempDir, 'newer.json');

        fs.writeFileSync(older, '{}', 'utf8');
        fs.writeFileSync(newer, '{}', 'utf8');
        const olderTime = new Date('2026-04-08T10:00:00.000Z');
        const newerTime = new Date('2026-04-08T10:05:00.000Z');
        fs.utimesSync(older, olderTime, olderTime);
        fs.utimesSync(newer, newerTime, newerTime);

        expect(resolveLatestPayload(tempDir)).toBe(newer);
    });

    test('compareStatusPipeline matches normalized dashboard fields from firmware payload', () => {
        const comparison = compareStatusPipeline(
            {
                device_id: 'ws-a7670e-476178',
                active_path: 'modem',
                modem_operator_name: 'Grameenphone',
                modem_ip_address: '10.172.126.118',
                modem_signal: -1,
                battery: 82,
                voltage_mV: 3794,
                temperature: 31.26,
                imei: '123456789012345',
                storage_queue_depth: 0,
                storage_media_available: true,
                task_count: 5,
                missing_task_count: 1,
                health_degraded: true,
                degraded_module_count: 1,
                failed_module_count: 0,
                health_last_reason: 'storage_backlog'
            },
            {
                activePath: 'modem',
                operator: 'Grameenphone',
                ip: '10.172.126.118',
                cellularSignal: null,
                battery: 82,
                voltageMv: 3794,
                temperature: 31.3,
                imei: '123456789012345',
                taskCount: 5,
                missingTaskCount: 1,
                healthDegraded: true,
                degradedModuleCount: 1,
                failedModuleCount: 0,
                healthLastReason: 'storage_backlog',
                storage: {
                    queueDepth: 0,
                    mediaAvailable: true
                }
            }
        );

        expect(comparison.ok).toBe(true);
        expect(comparison.mismatches).toEqual([]);
    });

    test('compareStatusPipeline reports mismatches for diverging dashboard values', () => {
        const comparison = compareStatusPipeline(
            {
                active_path: 'wifi',
                wifi_ssid: 'BenchNet',
                wifi_ip_address: '192.168.1.50',
                wifi_rssi: -58,
                voltage_mV: 3794
            },
            {
                activePath: 'modem',
                wifi: {
                    ssid: 'WrongNet',
                    ipAddress: '192.168.1.99',
                    rssi: -70
                },
                wifiSignal: 60,
                voltageMv: 3600
            }
        );

        expect(comparison.ok).toBe(false);
        expect(comparison.mismatches).toEqual(expect.arrayContaining([
            expect.stringContaining('activePath'),
            expect.stringContaining('wifi.ssid'),
            expect.stringContaining('wifi.ipAddress'),
            expect.stringContaining('wifi.rssi'),
            expect.stringContaining('wifiSignal'),
            expect.stringContaining('voltageMv')
        ]));
    });

    test('verifyStatusPipeline logs in, fetches /api/status, and compares against payload', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-pipeline-live-'));
        const payloadPath = path.join(tempDir, 'payload.json');

        fs.writeFileSync(payloadPath, JSON.stringify({
            device_id: 'ws-a7670e-476178',
            active_path: 'modem',
            modem_operator_name: 'Grameenphone',
            modem_ip_address: '10.172.126.118',
            modem_signal: -1,
            battery: 82,
            voltage_mV: 3794,
            temperature: 31.26,
            imei: '123456789012345'
        }), 'utf8');

        axios.post.mockResolvedValue({
            status: 302,
            headers: {
                'set-cookie': ['connect.sid=test-session; Path=/; HttpOnly']
            }
        });

        const client = {
            get: jest.fn().mockResolvedValue({
                status: 200,
                data: {
                    success: true,
                    deviceId: 'ws-a7670e-476178',
                    data: {
                        activePath: 'modem',
                        operator: 'Grameenphone',
                        ip: '10.172.126.118',
                        cellularSignal: null,
                        battery: 82,
                        voltageMv: 3794,
                        temperature: 31.3,
                        imei: '123456789012345'
                    }
                }
            })
        };

        axios.create.mockReturnValue(client);

        const result = await verifyStatusPipeline({
            baseUrl: 'http://127.0.0.1:3001',
            username: 'admin',
            password: 'admin123',
            payload: payloadPath
        });

        expect(axios.post).toHaveBeenCalledWith(
            'http://127.0.0.1:3001/auth/login',
            expect.any(String),
            expect.objectContaining({
                headers: expect.objectContaining({
                    'Content-Type': 'application/x-www-form-urlencoded'
                })
            })
        );
        expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({
            baseURL: 'http://127.0.0.1:3001',
            headers: expect.objectContaining({
                Cookie: 'connect.sid=test-session'
            })
        }));
        expect(client.get).toHaveBeenCalledWith(
            '/api/status?deviceId=ws-a7670e-476178',
            expect.any(Object)
        );
        expect(result.comparison.ok).toBe(true);
        expect(result.deviceId).toBe('ws-a7670e-476178');
        expect(result.payloadPath).toBe(payloadPath);
    });
});
