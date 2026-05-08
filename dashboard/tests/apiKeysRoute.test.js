'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

function makeDbMock(overrides = {}) {
    return {
        get: jest.fn().mockResolvedValue(null),
        all: jest.fn().mockResolvedValue([]),
        run: jest.fn().mockResolvedValue({ lastID: 0, changes: 0 }),
        ...overrides
    };
}

function buildApp(dbMock = makeDbMock()) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = { user: { id: 7, role: 'admin', username: 'admin' } };
        req.user = req.session.user;
        next();
    });
    app.locals.db = dbMock;
    app.use('/api/keys', require('../routes/apiKeys'));
    return app;
}

describe('api key routes', () => {
    test('lists only active API keys by default so revoked keys stay hidden after delete', async () => {
        const db = makeDbMock({
            all: jest.fn((sql) => {
                if (String(sql).includes('SELECT id, device_ids')) {
                    return Promise.resolve([]);
                }
                return Promise.resolve([
                    { id: 1, name: 'Active key', is_active: 1 }
                ]);
            })
        });
        const app = buildApp(db);

        const res = await request(app).get('/api/keys');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(db.all.mock.calls.some(([sql, params]) => String(sql).includes('AND is_active = 1') && params?.[0] === 7)).toBe(true);
    });

    test('can include inactive API keys explicitly for audit views', async () => {
        const db = makeDbMock({
            all: jest.fn().mockResolvedValue([
                { id: 1, name: 'Active key', is_active: 1 },
                { id: 2, name: 'Revoked key', is_active: 0 }
            ])
        });
        const app = buildApp(db);

        const res = await request(app).get('/api/keys?include_inactive=1');

        expect(res.status).toBe(200);
        expect(res.body.keys).toHaveLength(2);
        expect(db.all).toHaveBeenCalledWith(
            expect.not.stringContaining('AND is_active = 1'),
            [7]
        );
    });

    test('prunes orphan device-scoped keys and trims stale device IDs before listing active keys', async () => {
        const db = makeDbMock({
            all: jest.fn((sql) => {
                const text = String(sql);
                if (text.includes('SELECT id, device_ids')) {
                    return Promise.resolve([
                        { id: 10, device_ids: JSON.stringify(['missing-device']) },
                        { id: 11, device_ids: JSON.stringify(['android-live', 'android-gone']) }
                    ]);
                }
                if (text.includes('SELECT id FROM devices')) {
                    return Promise.resolve([{ id: 'android-live' }]);
                }
                return Promise.resolve([
                    { id: 11, name: 'Trimmed key', device_ids: JSON.stringify(['android-live']), is_active: 1 }
                ]);
            }),
            run: jest.fn().mockResolvedValue({ changes: 1 })
        });
        const app = buildApp(db);

        const res = await request(app).get('/api/keys');

        expect(res.status).toBe(200);
        expect(res.body.reconciled).toEqual({ deleted: 1, updated: 1 });
        expect(db.run).toHaveBeenCalledWith(
            'DELETE FROM api_keys WHERE id = ? AND user_id = ?',
            [10, 7]
        );
        expect(db.run).toHaveBeenCalledWith(
            'UPDATE api_keys SET device_ids = ? WHERE id = ? AND user_id = ?',
            [JSON.stringify(['android-live']), 11, 7]
        );
    });

    test('delete only revokes an active owned key once', async () => {
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ changes: 1 })
        });
        const app = buildApp(db);

        const res = await request(app).delete('/api/keys/12');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'API key revoked' });
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('AND is_active = 1'),
            ['12', 7]
        );
    });

    test('delete returns not found when the key was already revoked', async () => {
        const db = makeDbMock({
            run: jest.fn().mockResolvedValue({ changes: 0 })
        });
        const app = buildApp(db);

        const res = await request(app).delete('/api/keys/12');

        expect(res.status).toBe(404);
        expect(res.body).toEqual({
            success: false,
            message: 'Key not found or already revoked'
        });
    });
});
