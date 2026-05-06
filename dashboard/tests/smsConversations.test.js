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

    test('maps encoded system sender to inferred service instead of a fake phone number', () => {
        expect(normalizeConversationParticipant('3=:24;82=8<3=86<2:41', {
            message: '\u09b8\u09aa\u09cd\u09a4\u09be\u09b9 \u09b8\u09c1\u09aa\u09be\u09b0 \u0985\u09ab\u09be\u09b0 \u09b0\u09ac\u09bf'
        })).toEqual({
            number: '3=:24;82=8<3=86<2:41',
            key: 'service:robi',
            title: 'Robi',
            encodedService: true,
            encodedLookupKey: 'encoded-service:3=:24;82=8<3=86<2:41'
        });
    });
});

describe('sms conversation backfill', () => {
    const deviceId = 'test-device-sms-conversations';
    const robiLead = '\u09b8\u09aa\u09cd\u09a4\u09be\u09b9 \u09b8\u09c1\u09aa\u09be\u09b0 \u0985\u09ab\u09be\u09b0 \u09b0\u09ac\u09bf';
    const genericMiddle = ', \u09f3\u09e8\u09eb\u09ec-\u09e8\u09e6\u099c\u09bf\u09ac\u09bf+\u09e7\u09eb\u09e6\u09ae\u09bf\u09a8\u09bf\u099f';
    const robiTail = ' \u09aa\u09c7\u09a4\u09c7 \u09a1\u09be\u09df\u09be\u09b2 \u09ac\u09be \u09ad\u09bf\u099c\u09bf\u099f https://cutt.ly/myRobiOffer';

    beforeEach(async () => {
        await db.run('DELETE FROM sms_conversation_participants');
        await db.run('DELETE FROM sms_conversations');
        await db.run('DELETE FROM sms WHERE device_id = ?', [deviceId]);
        await db.run('DELETE FROM devices WHERE id = ?', [deviceId]);
        await db.run('INSERT INTO devices (id, name) VALUES (?, ?)', [deviceId, 'SMS Conversation Test Device']);
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

    test('backfills encoded Robi multipart fragments into one service conversation', async () => {
        const encodedSender = '3=:24;82=8<3=86<2:41';
        const rows = [robiLead, genericMiddle, robiTail];

        for (let index = 0; index < rows.length; index += 1) {
            await db.run(
                `INSERT INTO sms (device_id, from_number, to_number, message, timestamp, type, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    deviceId,
                    encodedSender,
                    '',
                    rows[index],
                    `2026-04-16T10:0${index}:00.000Z`,
                    'incoming',
                    'received'
                ]
            );
        }

        await backfillSmsConversations(db);

        const conversations = await db.all(
            `SELECT conversation_key, primary_number, title, message_count, last_message_preview
             FROM sms_conversations
             WHERE device_id = ?`,
            [deviceId]
        );
        expect(conversations).toHaveLength(1);
        expect(conversations[0]).toEqual(expect.objectContaining({
            conversation_key: 'service:robi',
            primary_number: encodedSender,
            title: 'Robi',
            message_count: 3,
            last_message_preview: rows[2].trim()
        }));

        const messageRows = await db.all(
            `SELECT COUNT(DISTINCT conversation_id) AS conversation_count
             FROM sms
             WHERE device_id = ?`,
            [deviceId]
        );
        expect(messageRows[0].conversation_count).toBe(1);
    });

    test('upgrades generic encoded conversation when a later fragment reveals the service name', async () => {
        const encodedSender = '3=:24;82=8<3=86<2:41';
        const rows = [genericMiddle, robiLead, ' \u09aa\u09c7\u09a4\u09c7 \u09a1\u09be\u09df\u09be\u09b2'];

        for (let index = 0; index < rows.length; index += 1) {
            await db.run(
                `INSERT INTO sms (device_id, from_number, to_number, message, timestamp, type, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    deviceId,
                    encodedSender,
                    '',
                    rows[index],
                    `2026-04-16T11:0${index}:00.000Z`,
                    'incoming',
                    'received'
                ]
            );
        }

        await backfillSmsConversations(db);

        const conversation = await db.get(
            `SELECT id, conversation_key, title, message_count
             FROM sms_conversations
             WHERE device_id = ?`,
            [deviceId]
        );
        expect(conversation).toEqual(expect.objectContaining({
            conversation_key: 'service:robi',
            title: 'Robi',
            message_count: 3
        }));

        const participants = await db.all(
            `SELECT lookup_key, display_name
             FROM sms_conversation_participants
             WHERE conversation_id = ?
             ORDER BY lookup_key`,
            [conversation.id]
        );
        expect(participants).toEqual(expect.arrayContaining([
            expect.objectContaining({
                lookup_key: 'encoded-service:3=:24;82=8<3=86<2:41',
                display_name: 'Robi'
            })
        ]));
    });
});
