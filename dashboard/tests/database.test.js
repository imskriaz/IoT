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
    test('incoming firmware storage dedup migration is idempotent and preserves same-second distinct messages', async () => {
        const previousPath = process.env.DB_PATH;
        const tempDbPath = path.join(os.tmpdir(), `iot-sms-dedup-migration-${process.pid}-${Date.now()}.sqlite`);
        let migrated;
        try {
            const Database = require('better-sqlite3');
            const legacy = new Database(tempDbPath);
            legacy.exec(`
                CREATE TABLE devices (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    type TEXT DEFAULT 'esp32',
                    status TEXT DEFAULT 'offline',
                    last_seen DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO devices (id, name) VALUES ('esp32-dedup', 'Legacy dedup fixture');
                CREATE TABLE sms (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT,
                    from_number TEXT NOT NULL,
                    message TEXT NOT NULL,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    type TEXT DEFAULT 'incoming',
                    firmware_storage_id INTEGER,
                    UNIQUE(device_id, timestamp, from_number)
                );
                INSERT INTO sms (device_id, from_number, message, timestamp, type, firmware_storage_id)
                VALUES
                    ('esp32-dedup', '+8801700000001', 'older duplicate', '2026-09-13T03:00:00.000Z', 'incoming', 41),
                    ('esp32-dedup', '+8801700000001', 'newer duplicate', '2026-09-13T03:00:01.000Z', 'incoming', 41);
            `);
            legacy.close();

            process.env.DB_PATH = tempDbPath;
            jest.resetModules();
            const { initializeDatabase } = require('../config/database');
            for (let startup = 0; startup < 2; startup++) {
                migrated = await initializeDatabase();
                const duplicateRows = await migrated.all(
                    `SELECT id, message FROM sms WHERE device_id = ? AND firmware_storage_id = ?`,
                    ['esp32-dedup', 41]
                );
                expect(duplicateRows.map(row => row.message)).toEqual(['older duplicate', 'newer duplicate']);

                const index = await migrated.get(
                    `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_sms_device_firmware_storage'`
                );
                expect(index.sql).toContain('firmware_storage_id');
                const trigger = await migrated.get(
                    `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_sms_device_firmware_storage_dedup'`
                );
                expect(trigger.sql).toContain('RAISE(IGNORE)');

                if (startup === 0) {
                    await migrated.run(`INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)`, ['esp32-dedup', 'Dedup fixture']);
                    await migrated.run(
                        `INSERT INTO sms (device_id, from_number, message, timestamp, type, firmware_storage_id)
                         VALUES (?, ?, ?, ?, 'incoming', ?)`,
                        ['esp32-dedup', '+8801700000001', 'same second A', '2026-09-13T04:00:00.000Z', 42]
                    );
                    await migrated.run(
                        `INSERT INTO sms (device_id, from_number, message, timestamp, type, firmware_storage_id)
                         VALUES (?, ?, ?, ?, 'incoming', ?)`,
                        ['esp32-dedup', '+8801700000001', 'same second B', '2026-09-13T04:00:00.000Z', 43]
                    );
                    const ignored = await migrated.run(
                        `INSERT OR IGNORE INTO sms (device_id, from_number, message, timestamp, type, firmware_storage_id)
                         VALUES (?, ?, ?, ?, 'incoming', ?)`,
                        ['esp32-dedup', '+8801700000001', 'duplicate replay', '2026-09-13T05:00:00.000Z', 42]
                    );
                    expect(ignored.changes).toBe(0);
                }
                await migrated.close();
                migrated = null;
            }

            const raw = new Database(tempDbPath, { readonly: true });
            const sameSecond = raw.prepare(
                `SELECT message FROM sms WHERE device_id = ? AND firmware_storage_id IN (42, 43) ORDER BY firmware_storage_id`
            ).all('esp32-dedup');
            raw.close();
            expect(sameSecond.map(row => row.message)).toEqual(['same second A', 'same second B']);
        } finally {
            if (migrated) await migrated.close();
            if (previousPath === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = previousPath;
            for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(tempDbPath + suffix)) fs.unlinkSync(tempDbPath + suffix);
            jest.resetModules();
        }
    });

    test('SMS delivery columns migrate existing queue rows and survive repeated startup', async () => {
        const previousPath = process.env.DB_PATH;
        const tempDbPath = path.join(os.tmpdir(), `iot-delivery-migration-${process.pid}-${Date.now()}.sqlite`);
        let migrated;
        try {
            process.env.DB_PATH = tempDbPath;
            jest.resetModules();
            const { initializeDatabase } = require('../config/database');
            migrated = await initializeDatabase();
            for (const column of ['delivery_status', 'delivery_report', 'delivery_at']) {
                await migrated.exec(`ALTER TABLE device_command_queue DROP COLUMN ${column}`);
            }
            await migrated.run("INSERT INTO devices (id, name) VALUES ('esp32-main', 'Migration fixture')");
            await migrated.run(`INSERT INTO device_command_queue (id, device_id, command, message_id, payload, status)
                VALUES ('legacy-delivery', 'esp32-main', 'send-sms', 'legacy-message', '{}', 'completed')`);
            await migrated.close(); migrated = null;
            for (let startup = 0; startup < 2; startup++) {
                migrated = await initializeDatabase();
                const row = await migrated.get("SELECT * FROM device_command_queue WHERE id = 'legacy-delivery'");
                expect(row).toMatchObject({ status: 'completed', delivery_status: null, delivery_report: null, delivery_at: null });
                await migrated.close(); migrated = null;
            }
        } finally {
            if (migrated) await migrated.close();
            if (previousPath === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = previousPath;
            for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(tempDbPath + suffix)) fs.unlinkSync(tempDbPath + suffix);
        }
    });
    test('hardware request migration preserves legacy intent and survives repeated startup', async () => {
        const previousPath = process.env.DB_PATH;
        const tempDbPath = path.join(os.tmpdir(), `iot-hardware-migration-${process.pid}-${Date.now()}.sqlite`);
        let migrated;
        try {
            const Database = require('better-sqlite3');
            const legacy = new Database(tempDbPath);
            legacy.exec(`
                CREATE TABLE device_hardware_apply_jobs (
                    action_id TEXT PRIMARY KEY, device_id TEXT NOT NULL,
                    enrollment_epoch TEXT, requested_revision INTEGER NOT NULL,
                    requested_hash TEXT NOT NULL, previous_hash TEXT,
                    status TEXT NOT NULL DEFAULT 'queued', error_json TEXT,
                    created_by INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO device_hardware_apply_jobs
                    (action_id, device_id, requested_revision, requested_hash, status)
                    VALUES ('legacy-job', 'legacy-device', 4, 'original-hash', 'blocked_driver');
            `);
            legacy.close();
            process.env.DB_PATH = tempDbPath;
            jest.resetModules();
            const { initializeDatabase } = require('../config/database');
            for (let startup = 0; startup < 2; startup++) {
                migrated = await initializeDatabase();
                const job = await migrated.get('SELECT * FROM device_hardware_apply_jobs WHERE action_id = ?', ['legacy-job']);
                expect(job).toMatchObject({
                    requested_revision: 4, requested_hash: 'original-hash',
                    requested_config_json: null, catalog_version: null, status: 'blocked_driver'
                });
                expect(() => migrated._raw.prepare("UPDATE device_hardware_apply_jobs SET requested_hash = 'changed'").run()).toThrow('Hardware apply request is immutable');
                expect(() => migrated._raw.prepare("UPDATE device_hardware_apply_jobs SET error_json = '{\"reason\":\"legacy snapshot unavailable\"}'").run()).not.toThrow();
                await migrated.close();
                migrated = null;
            }
        } finally {
            if (migrated) await migrated.close();
            if (previousPath === undefined) delete process.env.DB_PATH;
            else process.env.DB_PATH = previousPath;
            for (const suffix of ['', '-wal', '-shm']) {
                if (fs.existsSync(tempDbPath + suffix)) fs.unlinkSync(tempDbPath + suffix);
            }
            jest.resetModules();
        }
    });

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

    test('durable device action results retain database acknowledgement state', async () => {
        const cols = await db.all(`PRAGMA table_info(device_action_results)`);
        const names = cols.map(c => c.name);
        expect(names).toEqual(expect.arrayContaining([
            'device_id', 'action_id', 'command', 'schema_version', 'result',
            'canonical_payload', 'broker_published_at', 'ack_attempts',
            'conflict_count', 'last_ack_error'
        ]));
        const indexes = await db.all(`PRAGMA index_list(device_action_results)`);
        expect(indexes.some(index => index.unique === 1)).toBe(true);
    });

    test('durable command queue has expiry and enforces its per-device admission cap', async () => {
        const cols = await db.all(`PRAGMA table_info(device_command_queue)`);
        expect(cols.map(column => column.name)).toContain('expires_at');
        const raw = db._raw;
        raw.prepare(`INSERT OR IGNORE INTO devices (id, name, type) VALUES (?, ?, ?)`)
            .run('queue-cap-test', 'Queue cap test', 'esp32-s3');
        const insert = raw.prepare(`INSERT INTO device_command_queue
            (id, device_id, command, payload, message_id, status, expires_at)
            VALUES (?, 'queue-cap-test', 'get-status', '{}', ?, 'pending', datetime('now', '+1 day'))`);
        const stage = raw.transaction(() => {
            for (let index = 0; index < 256; index++) {
                insert.run(`cap-${index}`, `cap-message-${index}`);
            }
        });
        try {
            stage.immediate();
            expect(() => insert.run('cap-overflow', 'cap-message-overflow'))
                .toThrow('device command queue capacity reached');
        } finally {
            raw.prepare(`DELETE FROM device_command_queue WHERE device_id = ?`).run('queue-cap-test');
            raw.prepare(`DELETE FROM devices WHERE id = ?`).run('queue-cap-test');
        }
    });

    test('SMS modem-reference correlation survives completed queue cleanup', async () => {
        const raw = db._raw;
        raw.prepare(`INSERT OR IGNORE INTO devices (id, name, type) VALUES (?, ?, ?)`)
            .run('delivery-retention-test', 'Delivery retention test', 'esp32-s3');
        try {
            raw.prepare(`INSERT INTO device_command_queue
                (id, device_id, command, payload, message_id, status, expires_at)
                VALUES (?, ?, 'send-sms-multipart', ?, ?, 'waiting_response', datetime('now', '+1 day'))`)
                .run(
                    'delivery-retention-queue',
                    'delivery-retention-test',
                    JSON.stringify({ smsId: 812, sms_base_message_id: 'sms-retained',
                        sms_part_index: 2, sms_part_count: 3, to: '+8801555000000' }),
                    'sms-retained_p2'
                );
            raw.prepare(`UPDATE device_command_queue
                SET status = 'completed', response_payload = ? WHERE id = ?`)
                .run(JSON.stringify({ result: 'completed', message_reference: 73 }), 'delivery-retention-queue');

            raw.prepare(`DELETE FROM device_command_queue WHERE id = ?`).run('delivery-retention-queue');
            const correlation = raw.prepare(`SELECT * FROM sms_delivery_correlations
                WHERE device_id = ? AND message_reference = ?`).get('delivery-retention-test', 73);
            expect(correlation).toMatchObject({
                message_id: 'sms-retained_p2',
                queue_id: 'delivery-retention-queue',
                base_message_id: 'sms-retained',
                sms_id: 812,
                part_index: 2,
                part_count: 3,
                to_number: '+8801555000000'
            });
        } finally {
            raw.prepare(`DELETE FROM sms_delivery_correlations WHERE device_id = ?`).run('delivery-retention-test');
            raw.prepare(`DELETE FROM device_command_queue WHERE device_id = ?`).run('delivery-retention-test');
            raw.prepare(`DELETE FROM devices WHERE id = ?`).run('delivery-retention-test');
        }
    });

    test('device_status_cache table exists for restart-safe live status', async () => {
        const cols = await db.all(`PRAGMA table_info(device_status_cache)`);
        const names = cols.map(c => c.name);

        expect(names).toEqual(expect.arrayContaining([
            'device_id',
            'payload_json',
            'updated_at'
        ]));
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
