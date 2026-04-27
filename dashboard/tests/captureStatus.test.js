'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

jest.mock('mqtt', () => ({
    connect: jest.fn()
}));

jest.mock('child_process', () => ({
    spawnSync: jest.fn()
}));

const mqtt = require('mqtt');
const { spawnSync } = require('child_process');
const { captureStatus, parseArgs } = require('../utils/capture_status');

class MockMqttClient extends EventEmitter {
    constructor() {
        super();
        this.subscribe = jest.fn((topic, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
            }

            if (callback) {
                callback(null);
            }
        });
        this.end = jest.fn();
    }
}

describe('capture_status helper', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('parseArgs builds the device status topic and flag values', () => {
        const args = parseArgs([
            '--device', 'ws-a7670e-476178',
            '--timeout-ms', '45000',
            '--quiet'
        ]);

        expect(args.deviceId).toBe('ws-a7670e-476178');
        expect(args.topic).toBe('device/ws-a7670e-476178/status');
        expect(args.timeoutMs).toBe(45000);
        expect(args.quiet).toBe(true);
        expect(args.validate).toBe(true);
    });

    test('parseArgs accepts explicit topic overrides and disable-validation flag', () => {
        const args = parseArgs([
            '--topic', 'device/custom/status',
            '--no-validate',
            '--protocol', 'mqtts'
        ]);

        expect(args.topic).toBe('device/custom/status');
        expect(args.validate).toBe(false);
        expect(args.protocol).toBe('mqtts');
    });

    test('captureStatus rejects when no device or topic is supplied', async () => {
        await expect(captureStatus({ topic: '', deviceId: '' })).rejects.toThrow(
            'missing MQTT topic; pass --device or --topic'
        );
    });

    test('captureStatus saves the payload and runs the verifier by default', async () => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-status-'));
        const client = new MockMqttClient();

        mqtt.connect.mockReturnValue(client);
        spawnSync.mockReturnValue({
            status: 0,
            stdout: 'VALID PAYLOAD\n',
            stderr: ''
        });

        const capturePromise = captureStatus({
            host: '127.0.0.1',
            port: 1883,
            deviceId: 'ws-a7670e-476178',
            topic: 'device/ws-a7670e-476178/status',
            outDir,
            timeoutMs: 5000
        });

        process.nextTick(() => {
            client.emit('connect');
            client.emit(
                'message',
                'device/ws-a7670e-476178/status',
                Buffer.from(JSON.stringify({
                    type: 'device_status',
                    device_id: 'ws-a7670e-476178',
                    active_path: 'modem',
                    uptime_ms: 12345,
                    modem_signal: -1,
                    imei: '123456789012345'
                }))
            );
        });

        const result = await capturePromise;

        expect(mqtt.connect).toHaveBeenCalledWith('mqtt://127.0.0.1:1883', expect.objectContaining({
            reconnectPeriod: 0
        }));
        expect(client.subscribe).toHaveBeenCalledWith(
            'device/ws-a7670e-476178/status',
            { qos: 0 },
            expect.any(Function)
        );
        expect(result.outputPath).toContain(outDir);
        expect(fs.existsSync(result.outputPath)).toBe(true);
        expect(JSON.parse(fs.readFileSync(result.outputPath, 'utf8'))).toEqual(expect.objectContaining({
            type: 'device_status',
            device_id: 'ws-a7670e-476178',
            imei: '123456789012345'
        }));
        expect(result.validation).toEqual(expect.objectContaining({
            skipped: false,
            status: 0,
            stdout: 'VALID PAYLOAD\n'
        }));
        expect(spawnSync).toHaveBeenCalledWith(
            process.execPath,
            [expect.stringContaining('verify-status-payload.js'), result.outputPath],
            expect.objectContaining({ encoding: 'utf8' })
        );
        expect(client.end).toHaveBeenCalledWith(true);
    });
});
