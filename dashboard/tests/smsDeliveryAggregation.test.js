'use strict';

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/smsConversations', () => ({
    refreshSmsConversationBySmsId: jest.fn().mockResolvedValue(null)
}));
const Database = require('better-sqlite3');
let raw, svc;

function service() {
    jest.resetModules();
    svc = require('../services/mqttService');
    global.app = { locals: { db: {
        all: async (sql, args = []) => raw.prepare(sql).all(...args),
        get: async (sql, args = []) => raw.prepare(sql).get(...args),
        run: async (sql, args = []) => raw.prepare(sql).run(...args)
    } } };
    svc._emitDeviceQueueState = jest.fn().mockResolvedValue();
    return svc;
}
const report = (index, status = 'delivered') => svc.processSmsDelivery('device', { messageId: `sms_base_p${index}`, status });
const parent = () => raw.prepare('SELECT * FROM sms WHERE id = 1').get();

beforeEach(() => {
    jest.clearAllMocks();
    raw = new Database(':memory:');
    raw.exec(`CREATE TABLE sms (id INTEGER PRIMARY KEY, device_id TEXT, external_id TEXT, status TEXT, error TEXT, delivered_at TEXT);
        CREATE TABLE device_command_queue (id TEXT PRIMARY KEY, device_id TEXT, command TEXT, message_id TEXT, payload TEXT,
        status TEXT, response_payload TEXT, delivery_status TEXT, delivery_report TEXT, delivery_at TEXT,
        updated_at TEXT, created_at TEXT, published_at TEXT, completed_at TEXT, last_error TEXT, next_attempt_at TEXT);
        CREATE TABLE sms_delivery_correlations (device_id TEXT, message_id TEXT, queue_id TEXT,
        message_reference INTEGER, base_message_id TEXT, sms_id INTEGER, part_index INTEGER, part_count INTEGER,
        to_number TEXT, delivery_status TEXT, delivery_report TEXT, delivery_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, expires_at TEXT, PRIMARY KEY (device_id, message_id));
        INSERT INTO sms VALUES (1, 'device', 'sms_base', 'sent', NULL, NULL);`);
    for (let index = 1; index <= 2; index++) {
        raw.prepare('INSERT INTO device_command_queue (id, device_id, command, message_id, payload, status) VALUES (?, ?, ?, ?, ?, ?)')
            .run(`part${index}`, 'device', 'send-sms', `sms_base_p${index}`, JSON.stringify({ smsId: 1, sms_base_message_id: 'sms_base', sms_part_index: index, sms_part_count: 2 }), 'completed');
    }
    service();
});
afterEach(() => { svc.disconnect(); delete global.app; raw.close(); });

test('out of order and duplicate reports require every segment, including after service restart', async () => {
    await report(2);
    expect(parent().status).toBe('sent');
    await report(2);
    expect(parent().delivered_at).toBeNull();
    svc.disconnect(); service();
    await report(1);
    expect(parent().status).toBe('delivered');
    expect(parent().delivered_at).toBeTruthy();
    await report(1, 'pending');
    expect(parent().status).toBe('delivered');
});
test('failed segment survives sibling success and late execution completion', async () => {
    await report(1, 'failed');
    await report(2);
    const row = raw.prepare('SELECT * FROM device_command_queue WHERE id = ?').get('part1');
    await svc._markPersistentQueueCompleted(row, { success: true, result: 'completed' });
    expect(parent().status).toBe('failed');
    expect(raw.prepare('SELECT delivery_status FROM device_command_queue WHERE id = ?').get('part1').delivery_status).toBe('failed');
});
test('missing segment does not deliver and exact unknown ids never use destination fallback', async () => {
    raw.prepare('DELETE FROM device_command_queue WHERE id = ?').run('part2');
    await report(1);
    expect(parent().status).toBe('sending');
    const result = await svc.processSmsDelivery('device', { messageId: 'unknown', to: '+8801111111111', status: 'delivered' });
    expect(result.correlation).toBe('unmatched');
    expect(parent().status).toBe('sending');
});
test('concurrent reports serialize and all parts deliver', async () => {
    await Promise.all([report(1), report(2), report(1)]);
    expect(parent().status).toBe('delivered');
});
test('exact multipart delivery IDs survive completed queue cleanup and service restart', async () => {
    for (let index = 1; index <= 2; index++) {
        raw.prepare(`INSERT INTO sms_delivery_correlations
            (device_id, message_id, queue_id, message_reference, base_message_id,
             sms_id, part_index, part_count, to_number, expires_at)
            VALUES ('device', ?, ?, ?, 'sms_base', 1, ?, 2, '+8801555000000', datetime('now', '+30 days'))`)
            .run(`sms_base_p${index}`, `part${index}`, 70 + index, index);
    }
    raw.prepare('DELETE FROM device_command_queue').run();
    svc.disconnect(); service();

    const second = await report(2);
    expect(second.correlation).toBe('matched');
    expect(parent().status).not.toBe('delivered');

    const first = await report(1);
    expect(first.correlation).toBe('matched');
    expect(parent().status).toBe('delivered');
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sms_delivery_correlations
        WHERE delivery_status = 'delivered'`).get().count).toBe(2);
});
test('wrong part count or foreign parent cannot fill a missing index', async () => {
    raw.prepare('UPDATE device_command_queue SET payload = ? WHERE id = ?').run(JSON.stringify({ smsId: 1, sms_base_message_id: 'sms_base', sms_part_index: 2, sms_part_count: 3 }), 'part2');
    await report(1);
    await report(2);
    expect(parent().status).not.toBe('delivered');
});
test('queue sync cannot mutate another device by smsId or external id', async () => {
    const row = raw.prepare('SELECT * FROM device_command_queue WHERE id = ?').get('part1');
    await svc._syncSmsStatusFromQueueRow({ ...row, device_id: 'other' }, 'failed');
    expect(parent().status).toBe('sent');
    await svc._syncSmsStatusFromQueueRow({ ...row, device_id: 'other', message_id: 'sms_base', payload: '{}' }, 'failed');
    expect(parent().status).toBe('sent');
});
test('send completion rejects malformed membership metadata', async () => {
    const row = raw.prepare('SELECT * FROM device_command_queue WHERE id = ?').get('part1');
    raw.prepare('UPDATE device_command_queue SET payload = ? WHERE id = ?').run('{}', 'part2');
    await svc._syncSmsStatusFromQueueRow(row, 'sent');
    expect(parent().status).toBe('sending');
});

test('queue and delivery settlement refresh the denormalized conversation status', async () => {
    const conversations = require('../services/smsConversations');
    const row = raw.prepare('SELECT * FROM device_command_queue WHERE id = ?').get('part1');

    await svc._syncSmsStatusFromQueueRow(row, 'sent');
    expect(conversations.refreshSmsConversationBySmsId).toHaveBeenCalledWith(expect.any(Object), 1);

    conversations.refreshSmsConversationBySmsId.mockClear();
    await report(1);
    expect(conversations.refreshSmsConversationBySmsId).toHaveBeenCalledWith(expect.any(Object), 1);
});
