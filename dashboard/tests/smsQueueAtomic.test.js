'use strict';

const BetterSqlite3 = require('better-sqlite3');

jest.mock('../utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));
jest.mock('../services/packageService', () => ({
    assertSmsWithinPackageLimit: jest.fn().mockResolvedValue()
}));
jest.mock('../services/userAccessService', () => ({
    assertUserSmsWithinLimits: jest.fn().mockResolvedValue()
}));
jest.mock('../services/smsConversations', () => ({
    attachSmsToConversation: jest.fn().mockResolvedValue(88)
}));

function database() {
    const raw = new BetterSqlite3(':memory:');
    raw.exec(`
        CREATE TABLE devices (id TEXT PRIMARY KEY, type TEXT);
        CREATE TABLE device_profiles (device_id TEXT PRIMARY KEY, capabilities TEXT);
        CREATE TABLE sms (
            id INTEGER PRIMARY KEY, device_id TEXT, from_number TEXT, to_number TEXT,
            message TEXT, type TEXT, status TEXT, timestamp TEXT, user_id INTEGER,
            source TEXT, batch_id INTEGER, sim_slot INTEGER, external_id TEXT,
            encrypted INTEGER, error TEXT, conversation_id INTEGER
        );
        CREATE TABLE device_command_queue (
            id TEXT PRIMARY KEY, device_id TEXT, command TEXT, payload TEXT,
            message_id TEXT UNIQUE, status TEXT, requires_response INTEGER,
            replay_safe INTEGER, attempt_count INTEGER, max_attempts INTEGER,
            timeout_ms INTEGER, priority INTEGER, next_attempt_at TEXT,
            expires_at TEXT,
            source TEXT, user_id INTEGER, created_at TEXT, updated_at TEXT
        );
        INSERT INTO devices (id, type) VALUES ('esp32-1', 'esp32-s3');
    `);
    return {
        raw,
        db: {
            _raw: raw,
            get: async (sql, args = []) => raw.prepare(sql).get(...args),
            run: async (sql, args = []) => {
                const result = raw.prepare(sql).run(...args);
                return { lastID: result.lastInsertRowid, changes: result.changes };
            },
            all: async (sql, args = []) => raw.prepare(sql).all(...args)
        }
    };
}

describe('atomic modem multipart queue', () => {
    const originalPhoneCountryCode = process.env.PHONE_COUNTRY_CODE;
    let raw;
    let db;
    let mqttService;

    beforeEach(() => {
        jest.resetModules();
        ({ raw, db } = database());
        process.env.PHONE_COUNTRY_CODE = '880';
        mqttService = {
            processPersistentQueue: jest.fn(async () => {
                const sms = raw.prepare('SELECT * FROM sms').all();
                const parts = raw.prepare('SELECT * FROM device_command_queue ORDER BY priority').all();
                expect(sms).toHaveLength(1);
                expect(parts).toHaveLength(5);
                expect(parts.every((part, index) => JSON.parse(part.payload).sms_part_index === index + 1)).toBe(true);
            })
        };
    });

    afterEach(() => {
        raw.close();
        if (originalPhoneCountryCode === undefined) delete process.env.PHONE_COUNTRY_CODE;
        else process.env.PHONE_COUNTRY_CODE = originalPhoneCountryCode;
    });

    const send = (db, mqttService, existingSmsId = null, message = '\u0985'.repeat(80)) => require('../services/smsQueue').queueSmsForDelivery({
        db, mqttService, deviceId: 'esp32-1', to: '+8801555123456',
        message, existingSmsId
    });

    test('rolls back parent and every part when a middle insert fails', async () => {
        raw.exec(`CREATE TRIGGER reject_second_part BEFORE INSERT ON device_command_queue
            WHEN NEW.priority = 51 BEGIN SELECT RAISE(ABORT, 'injected part failure'); END;`);
        let injectedError;
        try {
            await send(db, mqttService);
        } catch (error) {
            injectedError = error;
        }
        expect(injectedError).toBeDefined();
        expect(injectedError.message).toContain('injected part failure');
        expect(raw.prepare('SELECT COUNT(*) AS n FROM sms').get().n).toBe(0);
        expect(raw.prepare('SELECT COUNT(*) AS n FROM device_command_queue').get().n).toBe(0);
        expect(mqttService.processPersistentQueue).not.toHaveBeenCalled();
    });

    test('preserves an existing parent on failed insert, then reuses committed parts after restart', async () => {
        raw.prepare(`INSERT INTO sms (id, device_id, status, message, external_id)
            VALUES (17, 'esp32-1', 'scheduled', 'original', 'original-id')`).run();
        raw.exec(`CREATE TRIGGER reject_second_part BEFORE INSERT ON device_command_queue
            WHEN NEW.priority = 51 BEGIN SELECT RAISE(ABORT, 'injected part failure'); END;`);
        let injectedError;
        try {
            await send(db, mqttService, 17);
        } catch (error) {
            injectedError = error;
        }
        expect(injectedError).toBeDefined();
        expect(injectedError.message).toContain('injected part failure');
        expect(raw.prepare('SELECT status, message, external_id FROM sms WHERE id = 17').get())
            .toEqual({ status: 'scheduled', message: 'original', external_id: 'original-id' });
        expect(raw.prepare('SELECT COUNT(*) AS n FROM device_command_queue').get().n).toBe(0);
        expect(mqttService.processPersistentQueue).not.toHaveBeenCalled();

        raw.exec('DROP TRIGGER reject_second_part');
        const first = await send(db, mqttService, 17);
        expect(first.queueIds).toHaveLength(5);
        expect(mqttService.processPersistentQueue).toHaveBeenCalledTimes(1);
        const recovered = await send(db, { processPersistentQueue: jest.fn() }, 17);
        expect(recovered.messageId).toBe(first.messageId);
        expect(recovered.queueIds).toEqual(first.queueIds);
        expect(raw.prepare('SELECT COUNT(*) AS n FROM device_command_queue').get().n).toBe(5);
        expect(mqttService.processPersistentQueue).toHaveBeenCalledTimes(1);
        await expect(send(db, { processPersistentQueue: jest.fn() }, 17, '\u0985'.repeat(79)))
            .rejects.toMatchObject({ code: 'SMS_RETRY_PAYLOAD_CONFLICT' });
        expect(raw.prepare('SELECT COUNT(*) AS n FROM device_command_queue').get().n).toBe(5);
    });

    test('stages every PDU when modem segmentation exceeds logical SMS part count', async () => {
        const queue = { processPersistentQueue: jest.fn().mockResolvedValue() };
        const result = await send(db, queue, null, '\u0985'.repeat(25));
        const parts = raw.prepare('SELECT payload FROM device_command_queue ORDER BY priority').all();
        expect(result.segmentedPdu).toBe(true);
        expect(parts).toHaveLength(2);
        expect(parts.map((row) => JSON.parse(row.payload).sms_part_index)).toEqual([1, 2]);
        expect(queue.processPersistentQueue).toHaveBeenCalledTimes(1);
    });

    test('refuses to recreate parts when command history was removed after a possible send', async () => {
        raw.prepare(`INSERT INTO sms (id, device_id, status, message, external_id)
            VALUES (19, 'esp32-1', 'sent', 'old content', 'old-id')`).run();
        const queue = { processPersistentQueue: jest.fn() };
        await expect(send(db, queue, 19)).rejects.toMatchObject({ code: 'SMS_QUEUE_HISTORY_MISSING' });
        expect(raw.prepare('SELECT status, message FROM sms WHERE id = 19').get())
            .toEqual({ status: 'sent', message: 'old content' });
        expect(raw.prepare('SELECT COUNT(*) AS n FROM device_command_queue').get().n).toBe(0);
        expect(queue.processPersistentQueue).not.toHaveBeenCalled();
    });

    test('refuses a duplicate or conflicting part history on retry', async () => {
        const queue = { processPersistentQueue: jest.fn().mockResolvedValue() };
        const first = await send(db, queue);
        const original = raw.prepare('SELECT payload FROM device_command_queue WHERE message_id = ?')
            .get(`${first.messageId}_p1`);
        raw.prepare(`INSERT INTO device_command_queue
            (id, device_id, command, payload, message_id, status, priority)
            VALUES (?, 'esp32-1', 'send-sms', ?, ?, 'pending', 51)`)
            .run('duplicate-part', original.payload, `${first.messageId}_p1_duplicate`);
        await expect(send(db, queue, first.id)).rejects.toMatchObject({ code: 'SMS_PARTIAL_QUEUE_AMBIGUOUS' });
        expect(raw.prepare('SELECT COUNT(*) AS n FROM device_command_queue').get().n).toBe(6);
        expect(queue.processPersistentQueue).toHaveBeenCalledTimes(1);
    });
});
