'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// ---------------------------------------------------------------------------
// Minimal DB mock that records every statement so tests can assert the
// ownership scoping actually reached SQL.
// ---------------------------------------------------------------------------
function makeRecordingDb(overrides = {}) {
    const statements = [];
    const db = {
        statements,
        get: jest.fn(async (sql, params = []) => {
            statements.push({ kind: 'get', sql, params });
            return overrides.get ? overrides.get(sql, params) : null;
        }),
        all: jest.fn(async (sql, params = []) => {
            statements.push({ kind: 'all', sql, params });
            return overrides.all ? overrides.all(sql, params) : [];
        }),
        run: jest.fn(async (sql, params = []) => {
            statements.push({ kind: 'run', sql, params });
            return overrides.run ? overrides.run(sql, params) : { lastID: 1, changes: 1 };
        })
    };
    return db;
}

function buildApp(db, sessionUser) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = { user: sessionUser };
        req.user = sessionUser;
        next();
    });
    app.locals.db = db;
    app.use('/api/contacts', require('../routes/contacts'));
    return app;
}

const ADMIN = { id: 1, role: 'admin', username: 'admin' };
const OPERATOR = { id: 2, role: 'operator', username: 'riaz' };
const OTHER_TENANT_ID = 999;

describe('contacts cross-tenant isolation', () => {
    afterEach(() => {
        jest.resetModules();
        delete global.io;
    });

    describe('GET /api/contacts', () => {
        test('scopes the list to the requesting non-admin user', async () => {
            const db = makeRecordingDb({
                all: () => [],
                get: () => ({ count: 0 })
            });
            const app = buildApp(db, OPERATOR);

            const res = await request(app).get('/api/contacts');

            expect(res.status).toBe(200);
            const list = db.statements.find(s => s.kind === 'all' && s.sql.includes('SELECT * FROM contacts'));
            expect(list).toBeTruthy();
            expect(list.sql).toContain('user_id = ?');
            expect(list.params).toContain(OPERATOR.id);
        });

        test('admins list every contact without a user filter', async () => {
            const db = makeRecordingDb({
                all: () => [],
                get: () => ({ count: 0 })
            });
            const app = buildApp(db, ADMIN);

            const res = await request(app).get('/api/contacts');

            expect(res.status).toBe(200);
            const list = db.statements.find(s => s.kind === 'all' && s.sql.includes('SELECT * FROM contacts'));
            expect(list.sql).not.toContain('user_id = ?');
        });

        test('search is scoped for non-admins', async () => {
            const db = makeRecordingDb({ all: () => [] });
            const app = buildApp(db, OPERATOR);

            await request(app).get('/api/contacts/search/alice');

            const search = db.statements.find(s => s.kind === 'all' && s.sql.includes('SELECT id, name, phone_number, favorite'));
            expect(search).toBeTruthy();
            expect(search.sql).toContain('user_id = ?');
            expect(search.params).toContain(OPERATOR.id);
        });
    });

    describe('GET /api/contacts/:id', () => {
        test("returns 404 for another tenant's contact without leaking existence", async () => {
            const db = makeRecordingDb({
                get: (sql) => sql.includes('FROM contacts WHERE id = ?')
                    ? { id: 7, name: 'Foreign', user_id: OTHER_TENANT_ID }
                    : null
            });
            const app = buildApp(db, OPERATOR);

            const res = await request(app).get('/api/contacts/7');

            expect(res.status).toBe(404);
            expect(res.body.success).toBe(false);
        });

        test('returns the contact for its owner', async () => {
            const db = makeRecordingDb({
                get: (sql) => sql.includes('FROM contacts WHERE id = ?')
                    ? { id: 7, name: 'Own', user_id: OPERATOR.id }
                    : null
            });
            const app = buildApp(db, OPERATOR);

            const res = await request(app).get('/api/contacts/7');

            expect(res.status).toBe(200);
            expect(res.body.data.name).toBe('Own');
        });

        test('admins can read any contact', async () => {
            const db = makeRecordingDb({
                get: (sql) => sql.includes('FROM contacts WHERE id = ?')
                    ? { id: 7, name: 'Foreign', user_id: OTHER_TENANT_ID }
                    : null
            });
            const app = buildApp(db, ADMIN);

            const res = await request(app).get('/api/contacts/7');

            expect(res.status).toBe(200);
        });
    });

    describe('POST /api/contacts', () => {
        test('stamps the creating user on the new row', async () => {
            const db = makeRecordingDb({
                get: (sql) => sql.includes('WHERE id = ?')
                    ? { id: 1, name: 'Alice', user_id: OPERATOR.id }
                    : null
            });
            const app = buildApp(db, OPERATOR);

            const res = await request(app)
                .post('/api/contacts')
                .send({ name: 'Alice', phone_number: '+8801700000001' });

            expect(res.status).toBe(200);
            const insert = db.statements.find(s => s.kind === 'run' && s.sql.includes('INSERT INTO contacts'));
            expect(insert).toBeTruthy();
            expect(insert.params[0]).toBe(OPERATOR.id);
        });
    });

    describe('PUT /api/contacts/:id', () => {
        test("non-admin cannot update another tenant's contact", async () => {
            const db = makeRecordingDb({
                get: (sql) => sql.includes('FROM contacts WHERE id = ?')
                    ? { id: 7, name: 'Foreign', user_id: OTHER_TENANT_ID }
                    : null
            });
            const app = buildApp(db, OPERATOR);

            const res = await request(app)
                .put('/api/contacts/7')
                .send({ name: 'Hijacked' });

            expect(res.status).toBe(404);
            const update = db.statements.find(s => s.kind === 'run' && s.sql.includes('UPDATE contacts'));
            expect(update).toBeUndefined();
        });
    });

    describe('DELETE /api/contacts/:id', () => {
        test("non-admin delete is ownership-scoped in SQL and settles 404 on foreign rows", async () => {
            const db = makeRecordingDb({
                run: () => ({ changes: 0 })
            });
            const app = buildApp(db, OPERATOR);

            const res = await request(app).delete('/api/contacts/7');

            expect(res.status).toBe(404);
            const del = db.statements.find(s => s.kind === 'run' && s.sql.includes('DELETE FROM contacts'));
            expect(del).toBeTruthy();
            expect(del.sql).toContain('user_id = ?');
            expect(del.params).toContain(OPERATOR.id);
        });
    });

    describe('PATCH /api/contacts/:id/favorite', () => {
        test("non-admin cannot favorite another tenant's contact", async () => {
            const db = makeRecordingDb({
                get: (sql) => sql.includes('FROM contacts WHERE id = ?')
                    ? { id: 7, name: 'Foreign', user_id: OTHER_TENANT_ID }
                    : null
            });
            const app = buildApp(db, OPERATOR);

            const res = await request(app)
                .patch('/api/contacts/7/favorite')
                .send({ favorite: true });

            expect(res.status).toBe(404);
            const update = db.statements.find(s => s.kind === 'run' && s.sql.includes('UPDATE contacts SET favorite'));
            expect(update).toBeUndefined();
        });
    });

    describe('exports', () => {
        test('CSV export is scoped for non-admins', async () => {
            const db = makeRecordingDb({ all: () => [] });
            const app = buildApp(db, OPERATOR);

            const res = await request(app).get('/api/contacts/export/csv');

            expect(res.status).toBe(200);
            const exportQuery = db.statements.find(s => s.kind === 'all' && s.sql.includes('SELECT name, phone_number, email, company, notes, favorite'));
            expect(exportQuery).toBeTruthy();
            expect(exportQuery.sql).toContain('user_id = ?');
        });

        test('vCard export is scoped for non-admins', async () => {
            const db = makeRecordingDb({ all: () => [] });
            const app = buildApp(db, OPERATOR);

            const res = await request(app).get('/api/contacts/export/vcf');

            expect(res.status).toBe(200);
            const exportQuery = db.statements.find(s => s.kind === 'all' && s.sql.includes('SELECT name, phone_number, email, company, notes FROM contacts'));
            expect(exportQuery).toBeTruthy();
            expect(exportQuery.sql).toContain('user_id = ?');
        });
    });

    describe('CSV import', () => {
        test("skips rows whose phone number is owned by another tenant", async () => {
            const db = makeRecordingDb({
                get: (sql, params) => {
                    if (sql.includes('FROM contacts WHERE phone_number = ?')) {
                        // The phone already belongs to another tenant.
                        return { id: 55, user_id: OTHER_TENANT_ID };
                    }
                    return null;
                }
            });
            const app = buildApp(db, OPERATOR);

            const csv = 'name,phone_number\nForeign Row,+8801700000099\n';
            const res = await request(app)
                .post('/api/contacts/import/csv')
                .attach('file', Buffer.from(csv), 'contacts.csv');

            expect(res.status).toBe(200);
            expect(res.body.imported).toBe(0);
            expect(res.body.skipped).toBe(1);
            const insert = db.statements.find(s => s.kind === 'run' && s.sql.includes('INSERT INTO contacts'));
            expect(insert).toBeUndefined();
        });

        test('imports rows stamped with the requesting user', async () => {
            const db = makeRecordingDb({
                get: (sql) => (sql.includes('FROM contacts WHERE phone_number = ?') ? null : null)
            });
            const app = buildApp(db, OPERATOR);

            const csv = 'name,phone_number\nNew Row,+8801700000002\n';
            const res = await request(app)
                .post('/api/contacts/import/csv')
                .attach('file', Buffer.from(csv), 'contacts.csv');

            expect(res.status).toBe(200);
            expect(res.body.imported).toBe(1);
            const insert = db.statements.find(s => s.kind === 'run' && s.sql.includes('INSERT INTO contacts'));
            expect(insert).toBeTruthy();
            expect(insert.params[0]).toBe(OPERATOR.id);
        });
    });

    describe('socket emissions', () => {
        test('contact events are emitted only to the owning user room', async () => {
            const to = jest.fn(() => ({ emit: jest.fn() }));
            global.io = { to };
            const db = makeRecordingDb({
                get: (sql) => sql.includes('WHERE id = ?')
                    ? { id: 1, name: 'Alice', user_id: OPERATOR.id }
                    : null
            });
            const app = buildApp(db, OPERATOR);

            await request(app)
                .post('/api/contacts')
                .send({ name: 'Alice', phone_number: '+8801700000001' });

            expect(to).toHaveBeenCalledWith(`user:${OPERATOR.id}`);
        });
    });
});
