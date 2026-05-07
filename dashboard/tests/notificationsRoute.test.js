'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../services/notificationService', () => ({
    capture: jest.fn()
}));

function buildApp(db) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = { user: { id: 7, role: 'admin', username: 'admin' } };
        req.user = req.session.user;
        next();
    });
    app.locals.db = db;
    app.use('/api/notifications', require('../routes/notifications'));
    return app;
}

describe('notifications route', () => {
    test('lists notifications with read, category, device, and search filters', async () => {
        const db = {
            all: jest.fn().mockResolvedValue([
                { id: 1, title: 'Low battery', metadata: '{"level":15}', read: 0 }
            ]),
            get: jest.fn().mockResolvedValue({ count: 1 }),
            run: jest.fn()
        };
        const app = buildApp(db);

        const res = await request(app)
            .get('/api/notifications?read=unread&category=device&deviceId=esp32-1&q=battery&limit=25&offset=50')
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.unreadCount).toBe(1);
        expect(res.body.notifications[0].metadata).toEqual({ level: 15 });
        const sql = db.all.mock.calls[0][0];
        const params = db.all.mock.calls[0][1];
        expect(sql).toContain('COALESCE(read, 0) = 0');
        expect(sql).toContain('category = ?');
        expect(sql).toContain('(device_id = ? OR device_id IS NULL)');
        expect(sql).toContain('(title LIKE ? OR message LIKE ? OR device_id LIKE ?)');
        expect(params).toEqual([7, 'device', 'esp32-1', '%battery%', '%battery%', '%battery%', 25, 50]);
        expect(res.body.totalCount).toBe(1);
        expect(res.body.limit).toBe(25);
        expect(res.body.offset).toBe(50);
    });

    test('can mark selected notifications read and unread', async () => {
        const db = {
            all: jest.fn(),
            get: jest.fn(),
            run: jest.fn().mockResolvedValue({ changes: 2 })
        };
        const app = buildApp(db);

        await request(app)
            .post('/api/notifications/read')
            .send({ ids: [1, 2] })
            .expect(200);

        expect(db.run.mock.calls[0][0]).toContain('SET read = 1');
        expect(db.run.mock.calls[0][1]).toEqual([1, 2]);

        await request(app)
            .post('/api/notifications/unread')
            .send({ ids: [1, 2] })
            .expect(200);

        expect(db.run.mock.calls[1][0]).toContain('SET read = 0');
        expect(db.run.mock.calls[1][1]).toEqual([1, 2]);
    });

    test('can remove selected and filtered notifications', async () => {
        const db = {
            all: jest.fn(),
            get: jest.fn(),
            run: jest.fn().mockResolvedValue({ changes: 2 })
        };
        const app = buildApp(db);

        await request(app)
            .post('/api/notifications/delete')
            .send({ ids: [4, 5] })
            .expect(200);

        expect(db.run.mock.calls[0][0]).toContain('DELETE FROM notifications');
        expect(db.run.mock.calls[0][1]).toEqual([4, 5]);

        await request(app)
            .post('/api/notifications/delete-all?read=unread&category=sms')
            .send({})
            .expect(200);

        expect(db.run.mock.calls[1][0]).toContain('DELETE FROM notifications');
        expect(db.run.mock.calls[1][0]).toContain('COALESCE(read, 0) = 0');
        expect(db.run.mock.calls[1][0]).toContain('category = ?');
        expect(db.run.mock.calls[1][1]).toEqual([7, 'sms']);
    });

    test('delete-all without filters clears every visible notification for the user', async () => {
        const db = {
            all: jest.fn(),
            get: jest.fn(),
            run: jest.fn().mockResolvedValue({ changes: 5 })
        };
        const app = buildApp(db);

        await request(app)
            .post('/api/notifications/delete-all?read=all&category=all')
            .send({})
            .expect(200);

        expect(db.run.mock.calls[0][0]).toContain('DELETE FROM notifications');
        expect(db.run.mock.calls[0][0]).not.toContain('category = ?');
        expect(db.run.mock.calls[0][0]).not.toContain('COALESCE(read, 0) = 0');
        expect(db.run.mock.calls[0][1]).toEqual([7]);
    });
});
