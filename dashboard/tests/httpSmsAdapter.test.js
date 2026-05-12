'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../services/smsConversations', () => ({
    attachSmsToConversation: jest.fn().mockResolvedValue(0),
    refreshSmsConversationBySmsId: jest.fn().mockResolvedValue()
}));

jest.mock('../services/smsQueue', () => ({
    queueSmsForDelivery: jest.fn()
}));

function makeDbMock(overrides = {}) {
    return {
        get: jest.fn().mockResolvedValue({ id: 'httpsms-01' }),
        all: jest.fn().mockResolvedValue([]),
        run: jest.fn().mockResolvedValue({ lastID: 0, changes: 0 }),
        ...overrides
    };
}

function buildApp(router, dbMock, options = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = { user: { id: 1, role: 'admin', username: 'admin' } };
        req.user = req.session.user;
        req.apiKey = {
            id: 11,
            scopes: 'write',
            device_ids: JSON.stringify(options.deviceIds || ['httpsms-01'])
        };
        next();
    });
    app.locals.db = dbMock;
    app.use('/v1', router);
    return app;
}

describe('httpSmsAdapter routes', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
        delete global.io;
        delete global.modemService;
    });

    test('POST /messages/send accepts httpSMS send payloads and returns httpSMS message shape', async () => {
        const { queueSmsForDelivery } = require('../services/smsQueue');
        queueSmsForDelivery.mockResolvedValueOnce({
            id: 42,
            to: '+8801700000000',
            status: 'queued',
            messageId: 'sms_abc123',
            simSlot: 0
        });
        const db = makeDbMock();
        const router = require('../routes/httpSmsAdapter');
        const app = buildApp(router, db);

        const res = await request(app)
            .post('/v1/messages/send')
            .send({
                from: '+8801555000000',
                to: '+8801700000000',
                content: 'Queue through httpSMS',
                sim: 'SIM1',
                request_id: 'client-1',
                encrypted: true
            });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('success');
        expect(res.body.data).toEqual(expect.objectContaining({
            id: 'sms_abc123',
            owner: '+8801555000000',
            contact: '+8801700000000',
            content: 'Queue through httpSMS',
            type: 'mobile-terminated',
            status: 'pending',
            sim: 'SIM1',
            encrypted: true
        }));
        expect(queueSmsForDelivery).toHaveBeenCalledWith(expect.objectContaining({
            db,
            deviceId: 'httpsms-01',
            to: '+8801700000000',
            message: 'Queue through httpSMS',
            simSlot: 0,
            source: 'httpsms',
            encrypted: true
        }));
    });

    test('POST /messages/send creates scheduled SMS when send_at is in the future', async () => {
        const { queueSmsForDelivery } = require('../services/smsQueue');
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ lastID: 72, changes: 1 })
        });
        const router = require('../routes/httpSmsAdapter');
        const app = buildApp(router, db);
        const sendAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

        const res = await request(app)
            .post('/v1/messages/send')
            .send({
                from: '+8801555000000',
                to: '+8801700000000',
                content: 'Schedule through httpSMS',
                send_at: sendAt,
                request_id: 'schedule-1'
            });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(expect.objectContaining({
            id: 'schedule-1',
            contact: '+8801700000000',
            status: 'pending',
            scheduled_at: sendAt
        }));
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO scheduled_sms'),
            ['httpsms-01', '+8801700000000', 'Schedule through httpSMS', sendAt, null, 1]
        );
        expect(queueSmsForDelivery).not.toHaveBeenCalled();
    });

    test('POST /messages/send rejects MMS attachments instead of silently dropping them', async () => {
        const router = require('../routes/httpSmsAdapter');
        const app = buildApp(router, makeDbMock());

        const res = await request(app)
            .post('/v1/messages/send')
            .send({
                from: '+8801555000000',
                to: '+8801700000000',
                content: 'Has media',
                attachments: ['https://example.com/photo.jpg']
            });

        expect(res.status).toBe(422);
        expect(res.body.message).toContain('MMS attachments are not supported');
    });

    test('POST /messages/receive stores inbound httpSMS payloads', async () => {
        const emit = jest.fn();
        const { attachSmsToConversation } = require('../services/smsConversations');
        attachSmsToConversation.mockResolvedValueOnce(77);
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ lastID: 51, changes: 1 })
        });
        global.io = { to: jest.fn().mockReturnValue({ emit }) };
        const router = require('../routes/httpSmsAdapter');
        const app = buildApp(router, db);

        const res = await request(app)
            .post('/v1/messages/receive')
            .send({
                from: '+8801700000000',
                to: '+8801555000000',
                content: 'Inbound message',
                encrypted: true,
                sim: 'SIM2',
                timestamp: '2026-05-08T10:00:00.000Z'
            });

        expect(res.status).toBe(200);
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT OR IGNORE INTO sms'),
            ['httpsms-01', '+8801700000000', '+8801555000000', 'Inbound message', '2026-05-08T10:00:00.000Z', 1, null, 1]
        );
        expect(attachSmsToConversation).toHaveBeenCalledWith(db, expect.objectContaining({
            id: 51,
            device_id: 'httpsms-01',
            from_number: '+8801700000000',
            to_number: '+8801555000000',
            type: 'incoming'
        }));
        expect(emit).toHaveBeenCalledWith('sms:received', expect.objectContaining({
            id: 51,
            conversationId: 77,
            source: 'httpsms',
            sim_slot: 1,
            encrypted: true
        }));
    });

    test('POST /messages/receive accepts official CloudEvents webhook payload shape', async () => {
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ lastID: 52, changes: 1 })
        });
        const router = require('../routes/httpSmsAdapter');
        const app = buildApp(router, db);

        const res = await request(app)
            .post('/v1/messages/receive')
            .send({
                type: 'message.phone.received',
                data: {
                    contact: '+8801700000000',
                    owner: '+8801555000000',
                    content: 'Webhook inbound',
                    message_id: 'incoming-cloud-1',
                    sim: 'SIM1',
                    timestamp: '2026-05-08T10:00:00.000Z'
                }
            });

        expect(res.status).toBe(200);
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT OR IGNORE INTO sms'),
            ['httpsms-01', '+8801700000000', '+8801555000000', 'Webhook inbound', '2026-05-08T10:00:00.000Z', 0, 'incoming-cloud-1', 0]
        );
    });

    test('GET /messages/outstanding returns one queued message in httpSMS format and marks it sending', async () => {
        const db = makeDbMock();
        db.get
            .mockResolvedValueOnce({ id: 'httpsms-01' })
            .mockResolvedValueOnce({
                id: 41,
                external_id: 'sms_pending',
                from_number: 'self',
                to_number: '+8801700000000',
                message: 'Send me',
                timestamp: '2026-05-08T10:00:00.000Z',
                status: 'queued',
                sim_slot: 0,
                encrypted: 1
            });
        const router = require('../routes/httpSmsAdapter');
        const app = buildApp(router, db);

        const res = await request(app)
            .get('/v1/messages/outstanding')
            .query({ device_id: 'httpsms-01' });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(expect.objectContaining({
            id: 'sms_pending',
            contact: '+8801700000000',
            content: 'Send me',
            status: 'sending',
            encrypted: true
        }));
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining("UPDATE sms SET status = 'sending'"),
            ['httpsms-01', 41]
        );
    });

    test('POST /messages/:id/events stores SENT/FAILED/DELIVERED updates', async () => {
        const { refreshSmsConversationBySmsId } = require('../services/smsConversations');
        const db = makeDbMock();
        db.get
            .mockResolvedValueOnce({ id: 'httpsms-01' })
            .mockResolvedValueOnce({
                id: 41,
                external_id: 'sms_pending',
                from_number: 'self',
                to_number: '+8801700000000',
                message: 'Send me',
                status: 'delivered',
                timestamp: '2026-05-08T10:00:00.000Z',
                delivered_at: '2026-05-08T10:01:00.000Z'
            });
        const router = require('../routes/httpSmsAdapter');
        const app = buildApp(router, db);

        const res = await request(app)
            .post('/v1/messages/sms_pending/events')
            .send({
                device_id: 'httpsms-01',
                event_name: 'DELIVERED',
                timestamp: '2026-05-08T10:01:00.000Z'
            });

        expect(res.status).toBe(200);
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE sms'),
            ['delivered', 'delivered', '2026-05-08T10:01:00.000Z', 'delivered', 'httpSMS delivered', 'httpsms-01', 'sms_pending', -1]
        );
        expect(refreshSmsConversationBySmsId).toHaveBeenCalledWith(db, 41);
    });

    test('POST /messages/:id/events accepts CloudEvents expired status', async () => {
        const db = makeDbMock();
        db.get
            .mockResolvedValueOnce({ id: 'httpsms-01' })
            .mockResolvedValueOnce({
                id: 41,
                external_id: 'sms_pending',
                from_number: 'self',
                to_number: '+8801700000000',
                message: 'Send me',
                status: 'expired',
                timestamp: '2026-05-08T10:00:00.000Z'
            });
        const router = require('../routes/httpSmsAdapter');
        const app = buildApp(router, db);

        const res = await request(app)
            .post('/v1/messages/sms_pending/events')
            .send({
                type: 'message.send.expired',
                data: {
                    message_id: 'sms_pending',
                    owner: '+8801555000000',
                    timestamp: '2026-05-08T10:02:00.000Z'
                }
            });

        expect(res.status).toBe(200);
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE sms'),
            ['expired', 'expired', '2026-05-08T10:02:00.000Z', 'expired', 'httpSMS expired', 'httpsms-01', 'sms_pending', -1]
        );
        expect(res.body.data.status).toBe('expired');
    });

    test('DELETE /messages/:id marks a message deleted for httpSMS clients', async () => {
        const { refreshSmsConversationBySmsId } = require('../services/smsConversations');
        const db = makeDbMock();
        db.get
            .mockResolvedValueOnce({ id: 'httpsms-01' })
            .mockResolvedValueOnce({ id: 41 });
        const router = require('../routes/httpSmsAdapter');
        const app = buildApp(router, db);

        const res = await request(app)
            .delete('/v1/messages/sms_pending')
            .query({ device_id: 'httpsms-01' });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ id: 'sms_pending', status: 'deleted' });
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining("UPDATE sms SET status = 'deleted'"),
            ['httpsms-01', 41]
        );
        expect(refreshSmsConversationBySmsId).toHaveBeenCalledWith(db, 41);
    });

    test('POST /heartbeats updates phone and SIM state for httpSMS app devices', async () => {
        const emit = jest.fn();
        const updateDeviceStatus = jest.fn();
        global.io = { to: jest.fn().mockReturnValue({ emit }) };
        global.modemService = { updateDeviceStatus };
        const db = makeDbMock();
        const router = require('../routes/httpSmsAdapter');
        const app = buildApp(router, db);

        const res = await request(app)
            .post('/v1/heartbeats')
            .set('X-Client-Version', '0.3.0')
            .send({
                phone_numbers: ['+8801555000000'],
                charging: true
            });

        expect(res.status).toBe(201);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0]).toEqual(expect.objectContaining({
            owner: '+8801555000000',
            version: '0.3.0',
            charging: true
        }));
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining("UPDATE devices"),
            ['httpsms-01']
        );
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO sims'),
            ['httpsms-01', 0, '+8801555000000']
        );
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE device_profiles'),
            ['+8801555000000', 'httpsms-01']
        );
        expect(updateDeviceStatus).toHaveBeenCalledWith('httpsms-01', expect.objectContaining({
            bridge_transport: 'http',
            app: 'httpSMS',
            simNumber: '+8801555000000',
            charging: true
        }));
        expect(emit).toHaveBeenCalledWith('device:status', expect.objectContaining({
            deviceId: 'httpsms-01',
            simNumber: '+8801555000000'
        }));
    });

    test('PUT /phones/fcm-token accepts official httpSMS phone token updates', async () => {
        const db = makeDbMock();
        const router = require('../routes/httpSmsAdapter');
        const app = buildApp(router, db);

        const res = await request(app)
            .put('/v1/phones/fcm-token')
            .send({
                phone_number: '+8801555000000',
                sim: 'SIM2',
                fcm_token: 'fcm-token-123'
            });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(expect.objectContaining({
            device_id: 'httpsms-01',
            user_id: '1',
            phone_number: '+8801555000000',
            fcm_token: 'fcm-token-123',
            sim: 'SIM2'
        }));
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO sims'),
            ['httpsms-01', 1, '+8801555000000']
        );
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO device_push_tokens'),
            ['httpsms-01', 'fcm-token-123']
        );
    });
});
