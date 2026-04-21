'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const express = require('express');
const request = require('supertest');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

process.env.DB_PATH = ':memory:';
process.env.PHONE_COUNTRY_CODE = '880';

function buildRenderedApp(router, basePath, sessionUser, db) {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => {
        req.session = {
            user: sessionUser,
            deviceId: sessionUser?.deviceId || ''
        };
        res.render = (view, locals = {}) => res.json({ view, locals });
        next();
    });
    app.locals.db = db;
    app.use(basePath, router);
    return app;
}

function buildApiApp(db, sessionUser) {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((req, _res, next) => {
        req.session = {
            user: sessionUser,
            deviceId: sessionUser?.deviceId || ''
        };
        next();
    });
    app.locals.db = db;
    app.use('/api/sms', require('../routes/sms'));
    return app;
}

describe('sms rendered workflow', () => {
    let db;
    const sessionUser = { id: 11, role: 'admin', username: 'workflow-admin', deviceId: 'workflow-device' };

    beforeAll(async () => {
        const { initializeDatabase } = require('../config/database');
        db = await initializeDatabase();
    });

    beforeEach(async () => {
        jest.resetModules();
        global.io = {
            emit: jest.fn(),
            to: jest.fn(() => ({ emit: jest.fn() }))
        };
        global.mqttService = {
            connected: true,
            publishCommand: jest.fn().mockResolvedValue({
                success: true,
                queued: true,
                queueId: 'queue-1',
                messageId: 'send-sms_test123',
                status: 'pending'
            }),
            getDeviceQueueState: jest.fn().mockResolvedValue({
                summary: {
                    pending: 0,
                    active: 0,
                    failed: 0,
                    ambiguous: 0,
                    totalOpen: 0
                },
                recent: []
            })
        };
        global.modemService = {
            isDeviceOnline: jest.fn().mockReturnValue(true),
            getDeviceStatus: jest.fn().mockReturnValue({
                active_path: 'modem',
                telephonySupported: true,
                telephonyEnabled: true,
                dataModeEnabled: true,
                operator: 'robi axiata',
                ip: '10.0.0.5'
            })
        };

        await db.run('DELETE FROM sms_conversation_participants');
        await db.run('DELETE FROM sms_conversations');
        await db.run('DELETE FROM scheduled_sms');
        await db.run('DELETE FROM sms');
        await db.run('DELETE FROM calls');
        await db.run('DELETE FROM ussd');
        await db.run('DELETE FROM devices WHERE id = ?', [sessionUser.deviceId]);
        await db.run('DELETE FROM users WHERE id = ?', [sessionUser.id]);
        await db.run(
            'INSERT INTO users (id, username, password, role, is_active) VALUES (?, ?, ?, ?, ?)',
            [sessionUser.id, sessionUser.username, 'test-hash', sessionUser.role, 1]
        );
        await db.run('INSERT INTO devices (id, name) VALUES (?, ?)', [sessionUser.deviceId, 'Workflow Device']);

        const incoming = await db.run(
            `INSERT INTO sms
                (device_id, from_number, to_number, message, timestamp, read, type, status, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [sessionUser.deviceId, '+8801628301525', null, 'Inbox hello', '2026-04-16T10:00:00.000Z', 0, 'incoming', 'received', 'device']
        );
        const outgoing = await db.run(
            `INSERT INTO sms
                (device_id, from_number, to_number, message, timestamp, read, type, status, user_id, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [sessionUser.deviceId, 'self', '+8801628301525', 'Reply hello', '2026-04-16T10:05:00.000Z', 1, 'outgoing', 'sent', sessionUser.id, 'dashboard']
        );

        const { attachSmsToConversation, refreshSmsConversationsForDevice } = require('../services/smsConversations');
        await attachSmsToConversation(db, {
            id: incoming.lastID,
            device_id: sessionUser.deviceId,
            from_number: '+8801628301525',
            to_number: null,
            type: 'incoming'
        });
        await attachSmsToConversation(db, {
            id: outgoing.lastID,
            device_id: sessionUser.deviceId,
            from_number: 'self',
            to_number: '+8801628301525',
            type: 'outgoing'
        });
        await refreshSmsConversationsForDevice(db, sessionUser.deviceId);
    });

    afterAll(async () => {
        if (db) await db.close();
    });

    afterEach(() => {
        delete global.io;
        delete global.mqttService;
        delete global.modemService;
    });

    test('home card link, instant send, and scheduled send stay aligned to the same thread', async () => {
        const indexRouter = require('../routes/index');
        const indexApp = buildRenderedApp(indexRouter, '/', sessionUser, db);
        const conversation = await db.get(
            'SELECT id, primary_number, title FROM sms_conversations WHERE device_id = ? ORDER BY id ASC LIMIT 1',
            [sessionUser.deviceId]
        );

        const homeRes = await request(indexApp).get(`/?device=${sessionUser.deviceId}`);

        expect(homeRes.status).toBe(200);
        expect(homeRes.body.view).toBe('pages/index');

        const templatePath = path.join(__dirname, '..', 'views', 'pages', 'index.html');
        const template = fs.readFileSync(templatePath, 'utf8');
        const html = ejs.render(template, {
            ...homeRes.body.locals,
            deviceId: sessionUser.deviceId,
            moment: require('moment')
        }, { filename: templatePath });

        const expectedThreadHref = `/sms?device=${encodeURIComponent(sessionUser.deviceId)}&amp;thread=${encodeURIComponent('+8801628301525')}&amp;conversation=${encodeURIComponent(String(conversation.id))}&amp;title=${encodeURIComponent(conversation.title || conversation.primary_number || '+8801628301525')}`;
        expect(html).toContain('Conversations');
        expect(html).toContain('Reply hello');
        expect(html).toContain(expectedThreadHref);

        const smsApp = buildApiApp(db, sessionUser);

        const initialThread = await request(smsApp)
            .get(`/api/sms/thread?deviceId=${sessionUser.deviceId}&conversationId=${conversation.id}&limit=100`);

        expect(initialThread.status).toBe(200);
        expect(initialThread.body.meta).toMatchObject({
            deviceId: sessionUser.deviceId,
            conversationId: conversation.id,
            number: '+8801628301525',
            count: 2
        });
        expect(initialThread.body.data.map((item) => item.message)).toEqual(['Inbox hello', 'Reply hello']);

        const instantSend = await request(smsApp)
            .post(`/api/sms/send?deviceId=${sessionUser.deviceId}`)
            .send({
                recipients: ['01628301525'],
                message: 'Instant follow-up'
            });

        expect(instantSend.status).toBe(200);
        expect(instantSend.body).toEqual(expect.objectContaining({
            success: true,
            queued: true,
            to: '+8801628301525',
            status: 'queued'
        }));

        const conversationsAfterSend = await request(smsApp)
            .get(`/api/sms/conversations?deviceId=${sessionUser.deviceId}&limit=20`);

        expect(conversationsAfterSend.status).toBe(200);
        expect(conversationsAfterSend.body.data[0]).toEqual(expect.objectContaining({
            conversation_id: conversation.id,
            thread_number: '+8801628301525',
            message: 'Instant follow-up',
            status: 'queued',
            total_count: 3,
            last_direction: 'outgoing'
        }));

        const threadAfterSend = await request(smsApp)
            .get(`/api/sms/thread?deviceId=${sessionUser.deviceId}&conversationId=${conversation.id}&limit=100`);

        expect(threadAfterSend.status).toBe(200);
        expect(threadAfterSend.body.data.map((item) => item.message)).toEqual([
            'Inbox hello',
            'Reply hello',
            'Instant follow-up'
        ]);

        const sendAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const scheduledSend = await request(smsApp)
            .post(`/api/sms/scheduled?deviceId=${sessionUser.deviceId}`)
            .send({
                recipients: ['01628301525'],
                message: 'Scheduled follow-up',
                send_at: sendAt
            });

        expect(scheduledSend.status).toBe(200);
        expect(scheduledSend.body).toEqual(expect.objectContaining({
            success: true,
            message: 'SMS scheduled'
        }));

        const scheduledItems = await db.all(
            'SELECT id, to_number, message, status FROM scheduled_sms WHERE device_id = ? ORDER BY id ASC',
            [sessionUser.deviceId]
        );
        expect(scheduledItems).toEqual([
            expect.objectContaining({
                to_number: '+8801628301525',
                message: 'Scheduled follow-up',
                status: 'pending'
            })
        ]);

        const conversationsAfterSchedule = await request(smsApp)
            .get(`/api/sms/conversations?deviceId=${sessionUser.deviceId}&limit=20`);

        expect(conversationsAfterSchedule.status).toBe(200);
        expect(conversationsAfterSchedule.body.data[0]).toEqual(expect.objectContaining({
            conversation_id: conversation.id,
            thread_number: '+8801628301525',
            message: 'Instant follow-up',
            total_count: 3
        }));

        const threadAfterSchedule = await request(smsApp)
            .get(`/api/sms/thread?deviceId=${sessionUser.deviceId}&conversationId=${conversation.id}&limit=100`);

        expect(threadAfterSchedule.status).toBe(200);
        expect(threadAfterSchedule.body.meta).toMatchObject({
            conversationId: conversation.id,
            number: '+8801628301525',
            count: 3
        });
        expect(threadAfterSchedule.body.data.map((item) => item.message)).toEqual([
            'Inbox hello',
            'Reply hello',
            'Instant follow-up'
        ]);
    });
});
