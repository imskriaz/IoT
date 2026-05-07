'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = { deviceId: 'device-1', user: { id: 1 } };
        next();
    });
    app.use('/api/esp32-console', require('../routes/esp32Console'));
    return app;
}

describe('ESP32 MQTT console route', () => {
    afterEach(() => {
        delete global.mqttService;
        jest.resetModules();
    });

    test('returns command presets and vendor notes', async () => {
        const app = buildApp();

        const res = await request(app).get('/api/esp32-console/commands');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.presets).toEqual(expect.arrayContaining([
            expect.objectContaining({ command: 'get-status' }),
            expect.objectContaining({ command: 'storage-info' }),
            expect.objectContaining({ command: 'gpio-status', payload: {} }),
            expect.objectContaining({ command: 'gpio-write', payload: { pin: 2, value: 1 } }),
            expect.objectContaining({ command: 'restart-modem', timeoutMs: 45000 }),
            expect.objectContaining({ command: 'modem-at', category: 'manual' })
        ]));
        expect(res.body.data.vendorCommands.length).toBeGreaterThan(400);
        expect(res.body.data.vendorCommands).toEqual(expect.arrayContaining([
            expect.objectContaining({
                command: 'AT+CMQTTSTART',
                transports: expect.arrayContaining(['serial', 'mqtt'])
            }),
            expect.objectContaining({
                command: 'AT+HTTPINIT',
                transports: expect.arrayContaining(['serial', 'mqtt'])
            }),
            expect.objectContaining({
                command: 'AT+CFTPSSTART',
                transports: expect.arrayContaining(['serial', 'mqtt'])
            })
        ]));
        expect(res.body.data.vendorCatalog.generatedFrom).toEqual(expect.arrayContaining([
            expect.objectContaining({ pdf: 'A76XX_Series_AT_Command_Manual_V1.09.pdf' }),
            expect.objectContaining({ pdf: 'A76XX_Series_MQTT(S)_Application_Note_V1.00.pdf' })
        ]));
        expect(res.body.data.documents).toEqual(expect.arrayContaining([
            expect.objectContaining({ title: 'Runtime Rulebook' })
        ]));
    });

    test('reuses the document catalog between nearby command requests', async () => {
        const readdirSpy = jest.spyOn(fs, 'readdirSync');
        const app = buildApp();

        const first = await request(app).get('/api/esp32-console/commands');
        const afterFirst = readdirSpy.mock.calls.length;
        const second = await request(app).get('/api/esp32-console/commands');

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(afterFirst).toBeGreaterThan(0);
        expect(readdirSpy.mock.calls.length).toBe(afterFirst);

        readdirSpy.mockRestore();
    });

    test('keeps every vendor command compatible with the ESP32 modem-at passthrough', async () => {
        const app = buildApp();

        const res = await request(app).get('/api/esp32-console/commands');
        const vendorCommands = res.body.data.vendorCommands;

        expect(res.status).toBe(200);
        expect(vendorCommands.length).toBeGreaterThan(400);
        for (const entry of vendorCommands) {
            expect(entry.command).toMatch(/^A/);
            expect(entry.command.length).toBeLessThanOrEqual(96);
            expect(entry.command).toMatch(/^[\x20-\x7e]+$/);
            expect(entry.transports).toEqual(expect.arrayContaining(['serial', 'mqtt']));
        }
        expect(new Set(vendorCommands.map((entry) => entry.command)).size).toBe(vendorCommands.length);
    });

    test('keeps every ESP32 console preset backed by a firmware handler', async () => {
        const app = buildApp();
        const repoRoot = path.join(__dirname, '..', '..');
        const firmwareRoot = path.join(repoRoot, 'firmware', 'espidf', 'esp32-s3-a7670e', 'components');
        const actionModels = fs.readFileSync(
            path.join(firmwareRoot, 'shared_models', 'src', 'action_models.c'),
            'utf8'
        );
        const automationBridge = fs.readFileSync(
            path.join(firmwareRoot, 'automation_bridge', 'src', 'automation_bridge.c'),
            'utf8'
        );
        const apiBridge = fs.readFileSync(
            path.join(firmwareRoot, 'api_bridge', 'src', 'api_bridge.c'),
            'utf8'
        );
        const enumByCommand = new Map(
            Array.from(actionModels.matchAll(/case\s+(UNIFIED_ACTION_CMD_[A-Z0-9_]+):\s+return\s+"([^"]+)"/g))
                .map((match) => [match[2], match[1]])
        );
        const parsedCommandEnums = new Map(
            Array.from(automationBridge.matchAll(/\{"([^"]+)",\s*(UNIFIED_ACTION_CMD_[A-Z0-9_]+)\}/g))
                .map((match) => [match[1], match[2]])
        );
        const dispatchedEnums = new Set(
            Array.from(apiBridge.matchAll(/case\s+(UNIFIED_ACTION_CMD_[A-Z0-9_]+):/g))
                .map((match) => match[1])
        );
        const commandAliases = {
            'send-ussd': 'send_ussd',
            'cancel-ussd': 'cancel_ussd',
            'make-call': 'dial_number',
            'end-call': 'hangup_call',
            'modem-at': 'modem_at'
        };
        const toFirmwareCommand = (command) => commandAliases[command] || String(command).replace(/-/g, '_');

        const res = await request(app).get('/api/esp32-console/commands');
        const esp32Presets = res.body.data.presets.filter((preset) => preset.deviceTypes.includes('esp32'));

        expect(esp32Presets.length).toBeGreaterThan(0);
        for (const preset of esp32Presets) {
            const firmwareCommand = toFirmwareCommand(preset.command);
            const actionEnum = enumByCommand.get(firmwareCommand);
            expect(actionEnum).toBeTruthy();
            expect(parsedCommandEnums.get(firmwareCommand)).toBe(actionEnum);
            expect(dispatchedEnums).toContain(actionEnum);
        }
    });

    test('keeps non-dispatched firmware aliases limited to the known pending lanes', () => {
        const repoRoot = path.join(__dirname, '..', '..');
        const firmwareRoot = path.join(repoRoot, 'firmware', 'espidf', 'esp32-s3-a7670e', 'components');
        const automationBridge = fs.readFileSync(
            path.join(firmwareRoot, 'automation_bridge', 'src', 'automation_bridge.c'),
            'utf8'
        );
        const apiBridge = fs.readFileSync(
            path.join(firmwareRoot, 'api_bridge', 'src', 'api_bridge.c'),
            'utf8'
        );
        const aliasMap = new Map(
            Array.from(automationBridge.matchAll(/\{"([^"]+)",\s*(UNIFIED_ACTION_CMD_[A-Z0-9_]+)\}/g))
                .map((match) => [match[1], match[2]])
        );
        const dispatchedEnums = new Set(
            Array.from(apiBridge.matchAll(/case\s+(UNIFIED_ACTION_CMD_[A-Z0-9_]+):/g))
                .map((match) => match[1])
        );
        const pendingAliases = new Set([
            'gpio_pulse',
            'sensor_read',
            'file_list',
            'file_read_meta',
            'file_delete',
            'file_export',
            'start_camera',
            'stop_camera',
            'take_snapshot',
            'start_stream',
            'stop_stream',
            'card_scan_start',
            'card_scan_stop',
            'card_read',
            'card_write'
        ]);
        const missingAliases = Array.from(aliasMap.entries())
            .filter(([, actionEnum]) => !dispatchedEnums.has(actionEnum))
            .map(([alias]) => alias)
            .sort();

        expect(missingAliases).toEqual(Array.from(pendingAliases).sort());
    });

    test('persists and reads compact console events from the merged log', async () => {
        const app = buildApp();

        await request(app).delete('/api/esp32-console/events');
        const write = await request(app)
            .post('/api/esp32-console/events')
            .send({
                source: 'test',
                level: 'info',
                message: 'merged console event',
                data: { runId: 'run-1' }
            });
        const read = await request(app).get('/api/esp32-console/events?deviceId=device-1&limit=5');

        expect(write.status).toBe(200);
        expect(write.body.success).toBe(true);
        expect(read.status).toBe(200);
        expect(read.body.data).toEqual(expect.arrayContaining([
            expect.objectContaining({
                deviceId: 'device-1',
                source: 'test',
                message: 'merged console event'
            })
        ]));
        await request(app).delete('/api/esp32-console/events');
    });

    test('publishes live MQTT command without persistent queue or compatibility fallback', async () => {
        const publishCommand = jest.fn().mockResolvedValue({
            success: true,
            detail: 'status_snapshot'
        });
        global.mqttService = { publishCommand };
        const app = buildApp();

        const res = await request(app)
            .post('/api/esp32-console/command')
            .send({
                command: 'get-status',
                payload: {},
                waitForResponse: true,
                timeoutMs: 15000
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(publishCommand).toHaveBeenCalledWith(
            'device-1',
            'get-status',
            {},
            true,
            15000,
            expect.objectContaining({
                source: 'dashboard-esp32-console',
                skipPersistentQueue: true,
                bypassCompatibility: true,
                domain: 'status'
            })
        );
    });

    test('treats typed raw modem lines as modem-at payloads', async () => {
        const publishCommand = jest.fn().mockResolvedValue({
            success: true,
            detail: 'modem_at_completed'
        });
        global.mqttService = { publishCommand };
        const app = buildApp();

        const res = await request(app)
            .post('/api/esp32-console/command')
            .send({
                command: 'AT+CPIN?',
                payload: {},
                waitForResponse: true,
                timeoutMs: 10000
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.command).toBe('modem-at');
        expect(res.body.rawLine).toBe('AT+CPIN?');
        expect(publishCommand).toHaveBeenCalledWith(
            'device-1',
            'modem-at',
            { line: 'AT+CPIN?', raw_line: 'AT+CPIN?' },
            true,
            10000,
            expect.objectContaining({
                source: 'dashboard-esp32-console',
                skipPersistentQueue: true,
                bypassCompatibility: true
            })
        );
    });

    test('keeps short A-style raw probes literal instead of lowercasing them as command topics', async () => {
        const publishCommand = jest.fn().mockResolvedValue({ success: true });
        global.mqttService = { publishCommand };
        const app = buildApp();

        const res = await request(app)
            .post('/api/esp32-console/command')
            .send({ command: 'A+P', payload: {} });

        expect(res.status).toBe(200);
        expect(res.body.command).toBe('modem-at');
        expect(res.body.rawLine).toBe('A+P');
        expect(publishCommand).toHaveBeenCalledWith(
            'device-1',
            'modem-at',
            expect.objectContaining({ line: 'A+P', raw_line: 'A+P' }),
            true,
            30000,
            expect.any(Object)
        );
    });

    test('rejects invalid command names', async () => {
        global.mqttService = { publishCommand: jest.fn() };
        const app = buildApp();

        const res = await request(app)
            .post('/api/esp32-console/command')
            .send({ command: 'device/1/command/get-status', payload: {} });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(global.mqttService.publishCommand).not.toHaveBeenCalled();
    });
});
