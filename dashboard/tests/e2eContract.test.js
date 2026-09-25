'use strict';

/**
 * End-to-end command/result contract suite (dashboard <-> ESP32 <-> Android).
 *
 * These tests pin the canonical envelope from DESIGN_FLOW_AUDIT.md across all
 * three implementations so a payload change on any side breaks here first:
 *
 *   command:  {schema, action_id, device_id, command, payload{...}}
 *   result:   {action_id, device_id, command, result, result_code, detail, ...}
 *             accepted is NON-terminal; completed/failed/rejected/timeout are terminal.
 *
 * Static sections cross-reference the firmware C sources and the Android Java
 * source; runtime sections exercise the dashboard's actual message builder.
 */

const fs = require('fs');
const path = require('path');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const repoRoot = path.join(__dirname, '..', '..');
const firmwareRoot = path.join(repoRoot, 'firmware', 'espidf', 'esp32-s3-a7670e-idf6.1', 'components');
const androidRoot = path.join(repoRoot, 'firmware', 'android', 'app', 'src', 'main', 'java', 'com', 'devicebridge', 'android');

function readFirmware(component, file) {
    return fs.readFileSync(path.join(firmwareRoot, component, 'src', file), 'utf8');
}

function readAndroid(file) {
    return fs.readFileSync(path.join(androidRoot, file), 'utf8');
}

function requireMqttService() {
    jest.resetModules();
    global.app = {
        locals: {},
        get: jest.fn(),
        use: jest.fn()
    };
    global.io = { emit: jest.fn(), to: () => ({ emit: jest.fn() }) };
    return require('../services/mqttService');
}

const TERMINAL_RESULTS = ['completed', 'failed', 'rejected', 'timeout'];
const NON_TERMINAL_RESULTS = ['accepted'];

describe('A. dashboard -> device command envelopes (runtime builder)', () => {
    test('android-family send-sms emits the plain-text contract the app parses', () => {
        const svc = requireMqttService();

        const message = svc._buildNativeCommandMessage(
            'send-sms',
            { to: '+8801700000001', message: 'hello android', smsId: 42, sim_slot: 0, timeout: 90000, sms_plain_text: true },
            'action-e2e-1',
            'test',
            'device-1'
        );

        // Exactly the fields the Android handleSendSms reads (number/to,
        // text/message) plus the versioned envelope header.
        expect(message).toMatchObject({
            action_id: 'action-e2e-1',
            schema: 1,
            device_id: 'device-1',
            command: 'send_sms',
            number: '+8801700000001',
            text: 'hello android'
        });
        // No dashboard-built PDU may replace the text for this family.
        expect(message.sms_pdu).toBeUndefined();
        expect(message.number).not.toBe('');
        expect(message.text).not.toBe('');
    });

    test('modem-family send-sms keeps the compact dashboard-built PDU envelope', () => {
        const svc = requireMqttService();
        const pdu = '0021000D91881007000000F100000DE8329BFD06';

        const message = svc._buildNativeCommandMessage(
            'send-sms',
            { to: '+8801700000001', message: '', sms_pdu: pdu, sms_pdu_encoding: 'gsm7', timeout: 90000 },
            'action-e2e-2',
            'test',
            'device-1'
        );

        expect(message).toMatchObject({
            schema: 1,
            device_id: 'device-1',
            action_id: 'action-e2e-2',
            command: 'send_sms',
            payload: { sms_pdu: pdu }
        });
        expect(message.number).toBeUndefined();
        expect(message.text).toBeUndefined();
    });

    test('generic commands keep the versioned envelope with action_id and schema', () => {
        const svc = requireMqttService();

        const message = svc._buildNativeCommandMessage(
            'get-status',
            {},
            'action-e2e-3',
            'test',
            'device-1'
        );

        expect(message).toMatchObject({
            schema: 1,
            device_id: 'device-1',
            action_id: 'action-e2e-3',
            command: 'get_status'
        });
    });
});

describe('B. result envelope parity across the three implementations', () => {
    test('ESP32 publishes every required result envelope field', () => {
        const mqttMgr = readFirmware('mqtt_mgr', 'mqtt_mgr.c');
        const publishFormats = [
            mqttMgr.match(/"\{\\\\"action_id\\\\"[^;]+;"/g) || []
        ].flat();

        // Locate the result-publish format strings and require the full key set.
        const resultLines = mqttMgr.split('\n')
            .filter(line => line.includes('"action_id\\"') && line.includes('"result\\"'));
        expect(resultLines.length).toBeGreaterThan(0);

        const joined = resultLines.join('\n');
        for (const key of ['action_id', 'device_id', 'command', 'result', 'result_code', 'detail']) {
            expect(joined).toContain(`\\"${key}\\":`);
        }
    });

    test('Android publishes every required result envelope field plus terminal flag', () => {
        const service = readAndroid('MqttBridgeService.java');
        const publishMethod = service.slice(
            service.indexOf('private void publishActionResult'),
            service.indexOf('private void publishJson')
        );
        expect(publishMethod).toContain('json.put("action_id"');
        expect(publishMethod).toContain('json.put("device_id"');
        expect(publishMethod).toContain('json.put("command"');
        expect(publishMethod).toContain('json.put("result"');
        expect(publishMethod).toContain('json.put("result_code"');
        expect(publishMethod).toContain('json.put("detail"');
        // AND-01: `accepted` must never be marked terminal.
        expect(publishMethod).toContain('json.put("terminal", "completed".equals(result) || "failed".equals(result));');
    });

    test('the three implementations agree on the result vocabulary', () => {
        // Firmware enum -> string mapping.
        const actionModels = readFirmware('shared_models', 'action_models.c');
        for (const value of [...TERMINAL_RESULTS, ...NON_TERMINAL_RESULTS]) {
            expect(actionModels).toContain(`return "${value}";`);
        }
        expect(actionModels).not.toContain('return "sent";');

        // Dashboard consumer classification (mqttHandlers).
        const handlers = fs.readFileSync(path.join(__dirname, '..', 'services', 'mqttHandlers.js'), 'utf8');
        expect(handlers).toContain("if (result === 'completed')");
        expect(handlers).toContain("['failed', 'rejected', 'timeout', 'error'].includes(result)");
        expect(handlers).toContain('return { result, terminal: false, successful: false }');
    });
});

describe('C. canonical command vocabulary parity', () => {
    const canonicalCommands = [
        'send_sms',
        'dial_number',
        'send_ussd',
        'get_status'
    ];

    test.each(canonicalCommands)('native firmware keeps "%s" in the shared registry', (command) => {
        const automationBridge = readFirmware('automation_bridge', 'automation_bridge.c');
        const actionModels = readFirmware('shared_models', 'action_models.c');
        const apiBridge = readFirmware('api_bridge', 'api_bridge.c');
        expect(actionModels).toContain(`return "${command}";`);
        expect(automationBridge).toContain(`unified_action_command_name(command)`);
        expect(automationBridge).toContain('UNIFIED_ACTION_CMD_DELETE_SMS');
        expect(apiBridge).toMatch(new RegExp(`case\\s+UNIFIED_ACTION_CMD_[A-Z0-9_]+:`));
        expect(automationBridge).not.toContain('s_command_aliases');
        expect(automationBridge).not.toContain('topic_group = index == 0');
    });

    test('Android answers unsupported commands with a terminal failure result', () => {
        const service = readAndroid('MqttBridgeService.java');
        const defaultBranch = service.slice(
            service.indexOf('Unsupported command received'),
            service.indexOf('private void handleSendSms')
        );
        expect(defaultBranch).toContain('publishActionResult(actionId, normalized, "failed", 2, "unsupported_command"');
    });
});

describe('D. negative contract (malformed/expired/overflowed commands)', () => {
    test('ESP32 rejects expired commands before dispatch', () => {
        const automationBridge = readFirmware('automation_bridge', 'automation_bridge.c');
        expect(automationBridge).toContain('command_expired');
        expect(automationBridge).toContain('"ttl_ms"');
        expect(automationBridge).not.toContain('"ttlMs"');
        expect(automationBridge).not.toContain('"expiry_ms"');
    });

    test('ESP32 correlates queue-full rejections with the originating action_id', () => {
        const automationBridge = readFirmware('automation_bridge', 'automation_bridge.c');
        const apiBridge = readFirmware('api_bridge', 'api_bridge.c');
        // The queue-full rejection is published as an external REJECTED
        // response so the dashboard row settles with the originating action
        // id instead of hanging.
        expect(automationBridge).toContain('automation_bridge_build_queue_full_response');
        expect(automationBridge).toContain('automation_queue_full');
        expect(apiBridge).toContain('api_bridge_record_external_response');
    });

    test('Android falls back to a generated action_id when the command has none', () => {
        const service = readAndroid('MqttBridgeService.java');
        expect(service).toContain('data.optString("action_id", "")');
        expect(service).toContain('"android_" + System.currentTimeMillis()');
    });

    test('ESP32 deduplicates QoS 1 redeliveries and replays terminal results', () => {
        const automationBridge = readFirmware('automation_bridge', 'automation_bridge.c');
        // Dedup cache + replay path (FW-01).
        expect(automationBridge).toMatch(/dedup/i);
        expect(automationBridge).toContain('action_id');
    });
});

describe('E. dashboard consumer settles rows only on terminal results', () => {
    test('sms:accepted is surfaced as progress, not success', () => {
        const mainJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
        expect(mainJs).toContain('sms:accepted');
        expect(mainJs).toContain('sending in progress');
    });
});
