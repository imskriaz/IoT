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
        expect(res.body.data.vendorCommands).toEqual(expect.arrayContaining([
            expect.objectContaining({
                command: 'AT+CFTPSGET',
                requiresInput: true,
                syntaxExamples: expect.arrayContaining(['AT+CFTPSGET="test.txt"']),
                workflowSummary: expect.stringContaining('active FTP(S) session'),
                workflowChain: expect.arrayContaining(['AT+CFTPSSTART', 'AT+CFTPSLOGIN="server",21,"username","password",0'])
            }),
            expect.objectContaining({
                command: 'AT+CFTPSCWD',
                requiresInput: false,
                allowsBare: true,
                syntaxExamples: expect.arrayContaining(['AT+CFTPSCWD="TEST1129"']),
                workflowChain: expect.arrayContaining(['AT+CFTPSPWD', 'AT+CFTPSCWD="TEST1129"'])
            }),
            expect.objectContaining({
                command: 'AT+CMQTTCONNECT',
                workflowSummary: expect.stringContaining('broker'),
                workflowChain: expect.arrayContaining(['AT+CMQTTSTART', 'AT+CMQTTACCQ=0,"client-test",0', 'AT+CMQTTCONNECT=0,"tcp://test.mosquitto.org:1883",60,1'])
            }),
            expect.objectContaining({
                command: 'AT+HTTPACTION',
                workflowSummary: expect.stringContaining('HTTP service'),
                workflowChain: expect.arrayContaining(['AT+HTTPINIT', 'AT+HTTPPARA="URL","http://httpbin.org/get"', 'AT+HTTPACTION=0'])
            }),
            expect.objectContaining({
                command: 'AT+CIPOPEN',
                workflowSummary: expect.stringContaining('AT+NETOPEN'),
                workflowChain: expect.arrayContaining(['AT+NETOPEN', 'AT+CIPOPEN=0,"TCP","117.131.85.139",5253'])
            }),
            expect.objectContaining({
                command: 'AT+BTPAIRED',
                requiresInput: false,
                requiresVariant: true,
                allowsBare: false,
                syntaxExamples: expect.arrayContaining(['AT+BTPAIRED?'])
            })
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

    test('provides workflow chains for stateful FTP, MQTT, HTTP, and TCPIP vendor families', async () => {
        const app = buildApp();

        const res = await request(app).get('/api/esp32-console/commands');
        const interesting = res.body.data.vendorCommands.filter((entry) =>
            /^(AT\+CMQTT|AT\+HTTP|AT\+CFTPS|AT\+NETOPEN|AT\+CIPOPEN|AT\+CSSLCFG)/.test(entry.command)
        );
        const missing = interesting
            .filter((entry) => !Array.isArray(entry.workflowChain) || !entry.workflowChain.length)
            .map((entry) => entry.command);

        expect(interesting.length).toBeGreaterThan(0);
        expect(missing).toEqual([]);
    });

    test('workflow chains stay compatible with the console chain parser format', async () => {
        const app = buildApp();

        const res = await request(app).get('/api/esp32-console/commands');
        const entries = res.body.data.vendorCommands.filter((entry) => Array.isArray(entry.workflowChain) && entry.workflowChain.length);
        const invalidLines = [];

        entries.forEach((entry) => {
            entry.workflowChain.forEach((line, index) => {
                const text = String(line || '').trim();
                if (!text) {
                    invalidLines.push(`${entry.command}:${index + 1}:blank`);
                    return;
                }
                if (text.startsWith('#')) return;
                if (/^wait\s+\d{1,6}(?:\s*ms)?$/i.test(text)) return;
                if (/^(?:AT|A)\S*/i.test(text)) return;
                invalidLines.push(`${entry.command}:${index + 1}:${text}`);
            });
        });

        expect(entries.length).toBeGreaterThan(0);
        expect(invalidLines).toEqual([]);
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

    test('keeps every parsed firmware alias dispatched through the API bridge', () => {
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
        const missingAliases = Array.from(aliasMap.entries())
            .filter(([, actionEnum]) => !dispatchedEnums.has(actionEnum))
            .map(([alias]) => alias)
            .sort();

        expect(missingAliases).toEqual([]);
    });

    test('new firmware aliases are split between real file-gpio handlers and explicit placeholder lanes', () => {
        const repoRoot = path.join(__dirname, '..', '..');
        const firmwareRoot = path.join(repoRoot, 'firmware', 'espidf', 'esp32-s3-a7670e', 'components');
        const apiBridge = fs.readFileSync(
            path.join(firmwareRoot, 'api_bridge', 'src', 'api_bridge.c'),
            'utf8'
        );

        expect(apiBridge).toContain('static unified_action_response_t api_bridge_execute_gpio_pulse(');
        expect(apiBridge).toContain('static unified_action_response_t api_bridge_execute_file_list(');
        expect(apiBridge).toContain('static unified_action_response_t api_bridge_execute_file_read_meta(');
        expect(apiBridge).toContain('static unified_action_response_t api_bridge_execute_file_delete(');
        expect(apiBridge).toContain('request->max_entries > CONFIG_UNIFIED_API_BRIDGE_MAX_LIST_ENTRIES');
        expect(apiBridge).toContain(': CONFIG_UNIFIED_API_BRIDGE_MAX_LIST_ENTRIES;');
        expect(apiBridge).toContain('return api_bridge_execute_placeholder_lane(action, payload, payload_len, "sensor", "sensor_lane_not_implemented")');
        expect(apiBridge).toContain('return api_bridge_execute_placeholder_lane(action, payload, payload_len, "camera", "camera_lane_not_installed")');
        expect(apiBridge).toContain('return api_bridge_execute_placeholder_lane(action, payload, payload_len, "card", "card_lane_not_installed")');
    });

    test('storage manager exposes file list, meta, and delete helpers for the new firmware handlers', () => {
        const repoRoot = path.join(__dirname, '..', '..');
        const firmwareRoot = path.join(repoRoot, 'firmware', 'espidf', 'esp32-s3-a7670e', 'components');
        const storageHeader = fs.readFileSync(
            path.join(firmwareRoot, 'storage_mgr', 'include', 'storage_mgr.h'),
            'utf8'
        );
        const storageSource = fs.readFileSync(
            path.join(firmwareRoot, 'storage_mgr', 'src', 'storage_mgr.c'),
            'utf8'
        );

        expect(storageHeader).toContain('esp_err_t storage_mgr_list_files_json(');
        expect(storageHeader).toContain('esp_err_t storage_mgr_build_file_meta_json(');
        expect(storageHeader).toContain('esp_err_t storage_mgr_delete_file(');
        expect(storageSource).toContain('static esp_err_t storage_mgr_resolve_existing_path(');
        expect(storageSource).toContain('static esp_err_t storage_mgr_build_path_for_mount(');
        expect(storageSource).toContain('esp_err_t storage_mgr_list_files_json(');
        expect(storageSource).toContain('esp_err_t storage_mgr_build_file_meta_json(');
        expect(storageSource).toContain('esp_err_t storage_mgr_delete_file(');
        expect(storageSource).toContain('\\"count\\":%u');
        expect(storageSource).toContain('\\"truncated\\":%s');
        expect(storageSource).toContain('\\"entries\\":[');
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

    test.each([
        'A',
        'AT',
        'A+P'
    ])('keeps short raw modem probe %s literal instead of lowercasing it as a command topic', async (rawLine) => {
        const publishCommand = jest.fn().mockResolvedValue({ success: true });
        global.mqttService = { publishCommand };
        const app = buildApp();

        const res = await request(app)
            .post('/api/esp32-console/command')
            .send({ command: rawLine, payload: {} });

        expect(res.status).toBe(200);
        expect(res.body.command).toBe('modem-at');
        expect(res.body.rawLine).toBe(rawLine);
        expect(publishCommand).toHaveBeenCalledWith(
            'device-1',
            'modem-at',
            expect.objectContaining({ line: rawLine, raw_line: rawLine }),
            true,
            30000,
            expect.any(Object)
        );
    });

    test('reports device-level command rejection as a failed console command', async () => {
        const publishCommand = jest.fn().mockResolvedValue({
            success: false,
            result: 'rejected',
            detail: 'modem_at_requires_serial',
            result_code: 262
        });
        global.mqttService = { publishCommand };
        const app = buildApp();

        const res = await request(app)
            .post('/api/esp32-console/command')
            .send({ command: 'AT+CPMS?', payload: {} });

        expect(res.status).toBe(502);
        expect(res.body).toEqual(expect.objectContaining({
            success: false,
            message: 'modem_at_requires_serial',
            command: 'modem-at',
            rawLine: 'AT+CPMS?'
        }));
        expect(res.body.result).toEqual(expect.objectContaining({
            success: false,
            result: 'rejected',
            result_code: 262
        }));
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
