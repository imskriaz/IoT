'use strict';

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const automationEngine = require('../services/automationEngine');

function makeDb(flows = []) {
    return {
        run: jest.fn().mockResolvedValue({ lastID: 1, changes: 1 }),
        get: jest.fn().mockResolvedValue({ local_ip: '192.168.4.1' }),
        _raw: {
            prepare: jest.fn((sql) => {
                if (sql.includes('SELECT id, name, nodes, edges, device_id FROM automation_flows')) {
                    return { all: () => flows };
                }
                if (sql.includes('SELECT * FROM automation_flows WHERE id = ?')) {
                    return { get: (id) => flows.find((flow) => flow.id === id) || null };
                }
                return {
                    all: () => [],
                    get: () => null,
                    run: () => ({ changes: 1, lastInsertRowid: 1 })
                };
            })
        }
    };
}

describe('automationEngine', () => {
    afterEach(() => {
        automationEngine.destroy();
        automationEngine.db = null;
        automationEngine.mqttService = null;
        automationEngine.io = null;
        automationEngine._flows = [];
        automationEngine._deviceState.clear();
        automationEngine._lastScheduleHits.clear();
        jest.clearAllMocks();
    });

    test('runs an SMS-triggered flow and writes execution logs', async () => {
        const flows = [{
            id: 1,
            name: 'SMS alert',
            device_id: 'dev-1',
            nodes: JSON.stringify([
                { id: 't1', type: 'trigger.sms_incoming', config: { keyword: 'help' } },
                { id: 'a1', type: 'action.log_event', config: { message: 'sms from {{trigger.from}}' } }
            ]),
            edges: JSON.stringify([{ sourceId: 't1', targetId: 'a1' }])
        }];
        const db = makeDb(flows);

        automationEngine.init(db, { connected: false }, { emit: jest.fn() });
        await automationEngine.onEvent('sms.incoming', { from: '+8801', message: 'need help now' }, 'dev-1');

        const queries = db.run.mock.calls.map(([sql]) => sql);
        expect(queries.some((sql) => sql.includes('INSERT INTO system_logs'))).toBe(true);
        expect(queries.some((sql) => sql.includes('INSERT INTO automation_logs'))).toBe(true);
        expect(queries.some((sql) => sql.includes('UPDATE automation_flows'))).toBe(true);
    });

    test('normalizes malformed flow node and edge payloads to empty arrays', async () => {
        const flows = [{
            id: 4,
            name: 'Malformed flow',
            device_id: 'dev-4',
            nodes: '{}',
            edges: '{"sourceId":"t1","targetId":"a1"}'
        }];
        const db = makeDb(flows);

        automationEngine.init(db, { connected: false }, { emit: jest.fn() });

        expect(automationEngine._flows[0].nodes).toEqual([]);
        expect(automationEngine._flows[0].edges).toEqual([]);
        await expect(automationEngine.onEvent('telemetry', { signal: 20 }, 'dev-4')).resolves.toBeUndefined();
        await expect(automationEngine._runSchedules()).resolves.toBeUndefined();
    });

    test('tracks previous telemetry state for value_changed conditions without persisting a device twin row', async () => {
        const flows = [{
            id: 2,
            name: 'Temperature delta',
            device_id: 'dev-2',
            nodes: JSON.stringify([
                { id: 't1', type: 'trigger.telemetry', config: { field: 'temperature' } },
                { id: 'c1', type: 'condition.value_changed', config: { field: 'temperature', from: '30', to: '40' } },
                { id: 'a1', type: 'action.update_twin', config: { property: 'targetTemp', value: '{{trigger.temperature}}' } }
            ]),
            edges: JSON.stringify([
                { sourceId: 't1', targetId: 'c1' },
                { sourceId: 'c1', sourceHandle: 'yes', targetId: 'a1' }
            ])
        }];
        const db = makeDb(flows);

        automationEngine.init(db, { connected: false }, { emit: jest.fn() });
        await automationEngine.onEvent('telemetry', { temperature: 30 }, 'dev-2');
        await automationEngine.onEvent('telemetry', { temperature: 40 }, 'dev-2');

        const twinUpdates = db.run.mock.calls.filter(([sql]) => sql.includes('device_twin'));
        expect(twinUpdates).toHaveLength(0);
    });

    test('queues automation SMS with dashboard-built Unicode PDU parts', async () => {
        const unicodeMessage = '\u0985'.repeat(80);
        const flows = [{
            id: 3,
            name: 'Unicode SMS alert',
            device_id: 'dev-3',
            nodes: JSON.stringify([
                { id: 't1', type: 'trigger.telemetry', config: { field: 'temperature' } },
                {
                    id: 'a1',
                    type: 'action.send_sms',
                    config: { to: '+8801555123456', message: unicodeMessage }
                }
            ]),
            edges: JSON.stringify([{ sourceId: 't1', targetId: 'a1' }])
        }];
        const db = makeDb(flows);
        const mqttService = {
            connected: true,
            publishCommand: jest.fn().mockResolvedValue({ success: true })
        };

        automationEngine.init(db, mqttService, { emit: jest.fn() });
        await automationEngine.onEvent('telemetry', { temperature: 35 }, 'dev-3');

        expect(mqttService.publishCommand).toHaveBeenCalledTimes(2);
        expect(mqttService.publishCommand).toHaveBeenNthCalledWith(
            1,
            'dev-3',
            'send-sms',
            expect.objectContaining({
                to: '+8801555123456',
                message: '',
                sms_pdu: expect.stringMatching(/^00[0-9A-F]+$/),
                sms_pdu_encoding: 'ucs2',
                sms_status_report_requested: true,
                sms_part_index: 1,
                sms_part_count: 2
            }),
            false,
            60000,
            expect.objectContaining({
                source: 'automation-sms',
                messageId: expect.stringMatching(/^sms_.*_p1$/)
            })
        );
        expect(mqttService.publishCommand).toHaveBeenNthCalledWith(
            2,
            'dev-3',
            'send-sms',
            expect.objectContaining({
                to: '+8801555123456',
                message: '',
                sms_pdu: expect.stringMatching(/^00[0-9A-F]+$/),
                sms_pdu_encoding: 'ucs2',
                sms_status_report_requested: true,
                sms_part_index: 2,
                sms_part_count: 2
            }),
            false,
            60000,
            expect.objectContaining({
                source: 'automation-sms',
                messageId: expect.stringMatching(/^sms_.*_p2$/)
            })
        );
    });
});
