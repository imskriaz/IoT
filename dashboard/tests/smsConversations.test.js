'use strict';

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

process.env.DB_PATH = ':memory:';

const {
    backfillSmsConversations,
    normalizeConversationParticipant,
    rebuildSmsConversationIndex
} = require('../services/smsConversations');

let db;

beforeAll(async () => {
    const { initializeDatabase } = require('../config/database');
    db = await initializeDatabase();
});

afterAll(async () => {
    if (db) await db.close();
});

describe('sms conversation participant normalization', () => {
    test('maps punctuation-only counterpart to service inbox', () => {
        expect(normalizeConversationParticipant(',')).toEqual({
            number: 'service-inbox',
            key: 'service:inbox',
            title: 'Service messages'
        });
    });

    test('keeps shortcode-style service counterpart stable', () => {
        expect(normalizeConversationParticipant('*123#')).toEqual({
            number: '*123#',
            key: 'service:*123#',
            title: '*123#'
        });
    });

    test('keeps malformed carrier senders as service conversations with inferred names', () => {
        expect(normalizeConversationParticipant('3=:24;82=8<3=86<2:41', {
            message: 'visit https://cutt.ly/myRobiOffer'
        })).toEqual({
            number: '3=:24;82=8<3=86<2:41',
            key: 'service:3=:24;82=8<3=86<2:41',
            title: 'Robi'
        });
    });
});

describe('sms conversation backfill', () => {
    const deviceId = 'test-device-sms-conversations';

    beforeEach(async () => {
        await db.run('DELETE FROM sms_conversation_participants');
        await db.run('DELETE FROM sms_conversations');
        await db.run('DELETE FROM sms WHERE device_id = ?', [deviceId]);
        await db.run('DELETE FROM devices WHERE id = ?', [deviceId]);
        await db.run(`INSERT INTO devices (id, name) VALUES (?, ?)`, [deviceId, 'SMS Conversation Test Device']);
    });

    test('backfills malformed incoming sender into service messages conversation', async () => {
        const inserted = await db.run(
            `INSERT INTO sms (device_id, from_number, to_number, message, timestamp, type, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [deviceId, ',', '', 'Operator notice', '2026-04-16 10:00:00', 'incoming', 'received']
        );

        await backfillSmsConversations(db);

        const message = await db.get(
            'SELECT conversation_id FROM sms WHERE id = ?',
            [inserted.lastID]
        );
        expect(message?.conversation_id).toBeTruthy();

        const conversation = await db.get(
            `SELECT primary_number, conversation_key, title, message_count, unread_count, last_message_preview
             FROM sms_conversations
             WHERE id = ?`,
            [message.conversation_id]
        );

        expect(conversation).toEqual(expect.objectContaining({
            primary_number: 'service-inbox',
            conversation_key: 'service:inbox',
            title: 'Service messages',
            message_count: 1,
            unread_count: 1,
            last_message_preview: 'Operator notice'
        }));
    });

    test('rebuild reindexes an existing malformed conversation into service messages', async () => {
        await db.run(
            `INSERT INTO sms_conversations
                (id, device_id, conversation_key, primary_number, title, participant_count, message_count)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [123, deviceId, ',', ',', ',', 1, 1]
        );

        const insert = await db.run(
            `INSERT INTO sms (device_id, from_number, to_number, message, timestamp, type, status, conversation_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [deviceId, ',', '', 'Legacy notice', '2026-04-16 10:05:00', 'incoming', 'received', 123]
        );

        await rebuildSmsConversationIndex(db, deviceId);

        const message = await db.get(
            'SELECT conversation_id FROM sms WHERE id = ?',
            [insert.lastID]
        );
        expect(message?.conversation_id).toBeTruthy();
        expect(message.conversation_id).not.toBe(123);

        const conversation = await db.get(
            `SELECT primary_number, conversation_key, title
             FROM sms_conversations
             WHERE id = ?`,
            [message.conversation_id]
        );

        expect(conversation).toEqual({
            primary_number: 'service-inbox',
            conversation_key: 'service:inbox',
            title: 'Service messages'
        });
    });

    test('backfills shifted carrier sender without turning embedded digits into a fake phone number', async () => {
        const sender = '3=:24;82=8<3=86<2:41';
        const inserted = await db.run(
            `INSERT INTO sms (device_id, from_number, to_number, message, timestamp, type, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [deviceId, sender, '', 'visit https://cutt.ly/myRobiOffer', '2026-04-16 10:10:00', 'incoming', 'received']
        );

        await backfillSmsConversations(db);

        const message = await db.get(
            'SELECT conversation_id FROM sms WHERE id = ?',
            [inserted.lastID]
        );
        const conversation = await db.get(
            `SELECT primary_number, conversation_key, title
             FROM sms_conversations
             WHERE id = ?`,
            [message.conversation_id]
        );

        expect(conversation).toEqual({
            primary_number: sender,
            conversation_key: `service:${sender.toLowerCase()}`,
            title: 'Robi'
        });
    });
});
