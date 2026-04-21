'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Use an in-memory database for tests
process.env.DB_PATH = ':memory:';

let db;

beforeAll(async () => {
    const { initializeDatabase } = require('../config/database');
    db = await initializeDatabase();
});

afterAll(async () => {
    if (db) await db.close();
});

describe('Database schema', () => {
    test('users table exists and has expected columns', async () => {
        const cols = await db.all(`PRAGMA table_info(users)`);
        const names = cols.map(c => c.name);
        expect(names).toContain('id');
        expect(names).toContain('username');
        expect(names).toContain('password');
        expect(names).toContain('role');
        expect(names).toContain('totp_secret');
        expect(names).toContain('totp_enabled');
    });

    test('devices table exists', async () => {
        const cols = await db.all(`PRAGMA table_info(devices)`);
        expect(cols.length).toBeGreaterThan(0);
    });

    test('sims table exists with slot-based inventory columns', async () => {
        const cols = await db.all(`PRAGMA table_info(sims)`);
        const names = cols.map(c => c.name);

        expect(names).toEqual(expect.arrayContaining([
            'device_id',
            'slot_index',
            'sim_number',
            'operator_name',
            'carrier_name',
            'network_type',
            'is_ready',
            'is_registered',
            'last_seen_at'
        ]));
    });

    test('sms table has device_id FK to devices', async () => {
        const fks = await db.all(`PRAGMA foreign_key_list(sms)`);
        const hasDevicesFk = fks.some(r => r.table === 'devices');
        expect(hasDevicesFk).toBe(true);
    });

    test('calls table has device_id FK to devices', async () => {
        const fks = await db.all(`PRAGMA foreign_key_list(calls)`);
        const hasDevicesFk = fks.some(r => r.table === 'devices');
        expect(hasDevicesFk).toBe(true);
    });

    test('sim-scoped tables include sim slot metadata columns', async () => {
        const smsCols = (await db.all(`PRAGMA table_info(sms)`)).map(c => c.name);
        const callsCols = (await db.all(`PRAGMA table_info(calls)`)).map(c => c.name);
        const ussdCols = (await db.all(`PRAGMA table_info(ussd)`)).map(c => c.name);
        const scheduledSmsCols = (await db.all(`PRAGMA table_info(scheduled_sms)`)).map(c => c.name);

        expect(smsCols).toEqual(expect.arrayContaining(['user_id', 'sim_slot']));
        expect(callsCols).toEqual(expect.arrayContaining(['user_id', 'sim_slot']));
        expect(ussdCols).toEqual(expect.arrayContaining(['user_id', 'sim_slot']));
        expect(scheduledSmsCols).toEqual(expect.arrayContaining(['user_id', 'sim_slot']));
    });

    test('env admin user is seeded as protected superadmin', async () => {
        const admin = await db.get(`SELECT * FROM users WHERE username = 'admin'`);
        expect(admin).not.toBeNull();
        expect(admin.role).toBe('superadmin');
        expect(Number(admin.is_protected || 0)).toBe(1);
    });

    test('legacy SUPER_USER env seeds a single protected superadmin when admin vars are unset', async () => {
        const originalEnv = {
            DB_PATH: process.env.DB_PATH,
            ADMIN_USERNAME: process.env.ADMIN_USERNAME,
            ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
            ADMIN_NAME: process.env.ADMIN_NAME,
            ADMIN_EMAIL: process.env.ADMIN_EMAIL,
            SUPER_USER: process.env.SUPER_USER,
            SUPER_PASS: process.env.SUPER_PASS,
            SUPER_NAME: process.env.SUPER_NAME,
            SUPER_EMAIL: process.env.SUPER_EMAIL
        };
        const tempDbPath = path.join(os.tmpdir(), `iot-superadmin-${Date.now()}.sqlite`);

        try {
            jest.resetModules();
            process.env.DB_PATH = tempDbPath;
            process.env.ADMIN_USERNAME = '';
            process.env.ADMIN_PASSWORD = '';
            process.env.ADMIN_NAME = '';
            process.env.ADMIN_EMAIL = '';
            process.env.SUPER_USER = 'legacy-root';
            process.env.SUPER_PASS = 'legacy-root-pass';
            process.env.SUPER_NAME = 'Legacy Root';
            process.env.SUPER_EMAIL = 'legacy@example.com';

            const { initializeDatabase } = require('../config/database');
            const tempDb = await initializeDatabase();

            const superadmins = await tempDb.all(
                `SELECT username, role, is_protected, is_active
                 FROM users
                 WHERE role = 'superadmin'
                 ORDER BY username ASC`
            );

            expect(superadmins).toEqual([
                expect.objectContaining({
                    username: 'legacy-root',
                    role: 'superadmin',
                    is_protected: 1,
                    is_active: 1
                })
            ]);

            await tempDb.close();
        } finally {
            Object.entries(originalEnv).forEach(([key, value]) => {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            });
            if (fs.existsSync(tempDbPath)) {
                try {
                    fs.unlinkSync(tempDbPath);
                } catch (_) {}
            }
            jest.resetModules();
        }
    });

    test('legacy SUPER_USER row is deactivated when a separate ADMIN_USERNAME is the env-backed superadmin', async () => {
        const originalEnv = {
            DB_PATH: process.env.DB_PATH,
            ADMIN_USERNAME: process.env.ADMIN_USERNAME,
            ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
            ADMIN_NAME: process.env.ADMIN_NAME,
            ADMIN_EMAIL: process.env.ADMIN_EMAIL,
            SUPER_USER: process.env.SUPER_USER,
            SUPER_PASS: process.env.SUPER_PASS,
            SUPER_NAME: process.env.SUPER_NAME,
            SUPER_EMAIL: process.env.SUPER_EMAIL
        };
        const tempDbPath = path.join(os.tmpdir(), `iot-superadmin-cleanup-${Date.now()}.sqlite`);

        try {
            jest.resetModules();
            process.env.DB_PATH = tempDbPath;
            process.env.ADMIN_USERNAME = 'admin';
            process.env.ADMIN_PASSWORD = 'admin-secret';
            process.env.ADMIN_NAME = 'Admin Root';
            process.env.ADMIN_EMAIL = 'admin@example.com';
            process.env.SUPER_USER = 'superadmin';
            process.env.SUPER_PASS = 'legacy-pass';
            process.env.SUPER_NAME = 'Legacy Super';
            process.env.SUPER_EMAIL = 'legacy@example.com';

            const BetterSqlite3 = require('better-sqlite3');
            const bcrypt = require('bcryptjs');
            const rawDb = new BetterSqlite3(tempDbPath);
            rawDb.exec(`
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    password TEXT NOT NULL,
                    name TEXT,
                    email TEXT,
                    role TEXT NOT NULL DEFAULT 'viewer',
                    is_active INTEGER NOT NULL DEFAULT 1,
                    is_protected INTEGER NOT NULL DEFAULT 0,
                    must_change_password INTEGER NOT NULL DEFAULT 0,
                    preferences TEXT,
                    totp_secret TEXT,
                    totp_enabled INTEGER NOT NULL DEFAULT 0,
                    last_login DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);
            const legacyHash = await bcrypt.hash('legacy-pass', 4);
            rawDb.prepare(`
                INSERT INTO users (username, password, name, email, role, is_active, is_protected, must_change_password)
                VALUES (?, ?, ?, ?, 'superadmin', 1, 1, 0)
            `).run('superadmin', legacyHash, 'Legacy Super', 'legacy@example.com');
            rawDb.close();

            const { initializeDatabase } = require('../config/database');
            const tempDb = await initializeDatabase();

            const rows = await tempDb.all(
                `SELECT username, role, is_protected, is_active
                 FROM users
                 WHERE username IN ('admin', 'superadmin')
                 ORDER BY username ASC`
            );

            expect(rows).toEqual([
                expect.objectContaining({
                    username: 'admin',
                    role: 'superadmin',
                    is_protected: 1,
                    is_active: 1
                }),
                expect.objectContaining({
                    username: 'superadmin',
                    role: 'superadmin',
                    is_protected: 0,
                    is_active: 0
                })
            ]);

            await tempDb.close();
        } finally {
            Object.entries(originalEnv).forEach(([key, value]) => {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            });
            if (fs.existsSync(tempDbPath)) {
                try {
                    fs.unlinkSync(tempDbPath);
                } catch (_) {}
            }
            jest.resetModules();
        }
    });

    test('can insert and retrieve SMS with device FK satisfied', async () => {
        const devId = 'test-device-jest';
        await db.run(`INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)`, [devId, 'Test']);
        await db.run(
            `INSERT INTO sms (device_id, from_number, message, type) VALUES (?, ?, ?, ?)`,
            [devId, '+8801700000000', 'Hello test', 'incoming']
        );
        const row = await db.get(`SELECT * FROM sms WHERE from_number = ?`, ['+8801700000000']);
        expect(row).not.toBeNull();
        expect(row.message).toBe('Hello test');
    });
});
