'use strict';

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const automationEngine = require('../services/automationEngine');

function makeDb(flows = []) {
    const rawRuns = [];
    const raw = {
        transaction: jest.fn((operation) => ({ immediate: operation })),
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
                run: (...args) => {
                    rawRuns.push({ sql, args });
                    return { changes: 1, lastInsertRowid: 1 };
                }
            };
        })
    };
    return {
        run: jest.fn().mockResolvedValue({ lastID: 1, changes: 1 }),
        get: jest.fn().mockResolvedValue({ local_ip: '192.168.4.1' }),
        all: jest.fn().mockResolvedValue([]),
        _raw: raw,
        _rawRuns: rawRuns
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
            publishCommand: jest.fn(),
            processPersistentQueue: jest.fn().mockResolvedValue()
        };
        // Conversation refresh reads back the outgoing row before dispatch.
        db.all.mockResolvedValue([{
            id: 1,
            device_id: 'dev-3',
            from_number: 'self',
            to_number: '+8801555123456',
            message: unicodeMessage,
            timestamp: '2026-09-13T08:00:00.000',
            type: 'outgoing',
            status: 'queued',
            source: 'automation',
            read: 1,
            sim_slot: 0
        }]);

        automationEngine.init(db, mqttService, { emit: jest.fn() });
        await automationEngine.onEvent('telemetry', { temperature: 35 }, 'dev-3');

        expect(db.all).toHaveBeenCalledWith(
            expect.stringContaining('WHERE conversation_id = ?'),
            [1]
        );
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE sms_conversations'),
            expect.arrayContaining([unicodeMessage])
        );
        const queueRuns = db._rawRuns.filter(({ sql }) => sql.includes('INSERT INTO device_command_queue'));
        expect(queueRuns).toHaveLength(5);
        const queuedParts = queueRuns.map(({ args }) => ({
            payload: JSON.parse(args[2]),
            messageId: args[3]
        }));
        expect(queuedParts.map(({ payload }) => payload.sms_part_index)).toEqual([1, 2, 3, 4, 5]);
        expect(queuedParts.every(({ payload }) => payload.sms_part_count === 5 &&
            payload.to === '+8801555123456' && payload.message === '' &&
            payload.sms_pdu_encoding === 'ucs2' && payload.sms_status_report_requested === true &&
            /^00[0-9A-F]+$/.test(payload.sms_pdu))).toBe(true);
        expect(queuedParts[0].messageId).toMatch(/^sms_.*_p1$/);
        expect(queuedParts[4].messageId).toMatch(/^sms_.*_p5$/);
        expect(mqttService.processPersistentQueue).toHaveBeenCalledTimes(1);
    });
});
