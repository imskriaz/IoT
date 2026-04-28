const BetterSqlite3 = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');
const { backfillSmsConversations } = require('../services/smsConversations');

// Ensure data directory exists
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DB_PATH || path.join(dataDir, 'database.sqlite');

/**
 * Wrap a better-sqlite3 Database in an async-compatible shim so all existing
 * `await db.run/all/get/exec()` call sites continue to work unchanged.
 *
 * Prepared statements are cached by SQL string for performance. DDL (exec)
 * bypasses the cache since it modifies schema state.
 */
function wrapDb(rawDb) {
    const stmtCache = new Map();

    function stmt(sql) {
        let s = stmtCache.get(sql);
        if (!s) {
            s = rawDb.prepare(sql);
            stmtCache.set(sql, s);
        }
        return s;
    }

    function params(args) {
        // args may be undefined, null, a single value, or an array
        if (args === undefined || args === null) return [];
        return Array.isArray(args) ? args : [args];
    }

    const SLOW_MS = 100;

    function timed(fn) {
        return function (sql, p) {
            const t0 = Date.now();
            const result = fn(sql, p);
            const elapsed = Date.now() - t0;
            if (elapsed > SLOW_MS) {
                const short = (typeof sql === 'string' ? sql : '?').replace(/\s+/g, ' ').trim().substring(0, 120);
                logger.warn(`Slow query (${elapsed}ms): ${short}`);
            }
            return Promise.resolve(result);
        };
    }

    return {
        _raw: rawDb,

        run: timed((sql, p) => {
            const s = stmt(sql);
            // better-sqlite3 throws if .run() is called on a reader (e.g. PRAGMA)
            if (s.reader) {
                s.all(...params(p));  // execute and discard rows
                return { lastID: 0, changes: 0 };
            }
            const r = s.run(...params(p));
            return { lastID: r.lastInsertRowid, changes: r.changes };
        }),

        all: timed((sql, p) => stmt(sql).all(...params(p))),

        get: timed((sql, p) => stmt(sql).get(...params(p)) ?? null),

        exec(sql) {
            // DDL / multi-statement — bypass stmt cache
            rawDb.exec(sql);
            return Promise.resolve();
        },

        close() {
            stmtCache.clear();
            rawDb.close();
            return Promise.resolve();
        }
    };
}

async function initializeDatabase(options = {}) {
    const runSmsBackfill = options.backfillSmsConversations !== false;
    let rawDb = null;
    try {
        rawDb = new BetterSqlite3(dbPath);

        // Performance & safety PRAGMAs
        rawDb.pragma('busy_timeout = 5000');
        rawDb.pragma('journal_mode = WAL');
        rawDb.pragma('foreign_keys = ON');
        rawDb.pragma('synchronous = NORMAL');  // safe with WAL; faster than FULL
        rawDb.pragma('cache_size = -8000');    // 8 MB page cache

        const db = wrapDb(rawDb);

        // ==================== SCHEMA ====================

        await db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                name TEXT,
                email TEXT,
                role TEXT DEFAULT 'user',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_login DATETIME,
                is_active BOOLEAN DEFAULT 1,
                preferences TEXT
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY,
                name TEXT,
                type TEXT DEFAULT 'esp32',
                status TEXT DEFAULT 'offline',
                last_seen DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS unregistered_devices (
                device_id TEXT PRIMARY KEY,
                first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                event_count INTEGER DEFAULT 1,
                last_event_type TEXT,
                last_number TEXT,
                last_payload TEXT,
                notes TEXT
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS unregistered_device_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                event_type TEXT,
                phone_number TEXT,
                payload TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_unregistered_device_events_device
                ON unregistered_device_events(device_id, created_at DESC, id DESC);
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS sms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT,
                conversation_id INTEGER,
                from_number TEXT NOT NULL,
                to_number TEXT,
                message TEXT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                read BOOLEAN DEFAULT 0,
                type TEXT DEFAULT 'incoming',
                status TEXT DEFAULT 'received',
                delivered_at DATETIME,
                error TEXT,
                folder TEXT DEFAULT 'inbox',
                tags TEXT,
                user_id INTEGER,
                source TEXT DEFAULT 'device',
                batch_id TEXT,
                sim_slot INTEGER,
                external_id TEXT,
                UNIQUE(device_id, timestamp, from_number),
                FOREIGN KEY (device_id) REFERENCES devices(id),
                FOREIGN KEY (user_id) REFERENCES users(id),
                FOREIGN KEY (conversation_id) REFERENCES sms_conversations(id) ON DELETE SET NULL
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS sms_conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                conversation_key TEXT NOT NULL,
                primary_number TEXT NOT NULL,
                title TEXT,
                participant_count INTEGER DEFAULT 1,
                message_count INTEGER DEFAULT 0,
                unread_count INTEGER DEFAULT 0,
                last_message_id INTEGER,
                last_message_preview TEXT,
                last_message_direction TEXT,
                last_message_status TEXT,
                last_message_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(device_id, conversation_key),
                FOREIGN KEY (device_id) REFERENCES devices(id),
                FOREIGN KEY (last_message_id) REFERENCES sms(id) ON DELETE SET NULL
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS sms_conversation_participants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                phone_number TEXT NOT NULL,
                lookup_key TEXT NOT NULL,
                display_name TEXT,
                is_self BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(conversation_id, lookup_key),
                FOREIGN KEY (conversation_id) REFERENCES sms_conversations(id) ON DELETE CASCADE
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS calls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT,
                phone_number TEXT NOT NULL,
                contact_name TEXT,
                type TEXT DEFAULT 'outgoing',
                status TEXT DEFAULT 'dialing',
                start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
                end_time DATETIME,
                duration INTEGER DEFAULT 0,
                recording_url TEXT,
                notes TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                missed BOOLEAN DEFAULT 0,
                tags TEXT,
                sim_slot INTEGER,
                user_id INTEGER,
                FOREIGN KEY (user_id) REFERENCES users(id),
                FOREIGN KEY (device_id) REFERENCES devices(id)
            )
        `);

        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_calls_phone ON calls(phone_number);
            CREATE INDEX IF NOT EXISTS idx_calls_start_time ON calls(start_time);
            CREATE INDEX IF NOT EXISTS idx_calls_type ON calls(type);
            CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
            CREATE INDEX IF NOT EXISTS idx_calls_device ON calls(device_id);
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone_number TEXT NOT NULL,
                email TEXT,
                company TEXT,
                favorite BOOLEAN DEFAULT 0,
                notes TEXT,
                photo TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_called DATETIME,
                call_count INTEGER DEFAULT 0,
                tags TEXT,
                UNIQUE(phone_number)
            )
        `);

        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_number);
            CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
            CREATE INDEX IF NOT EXISTS idx_contacts_favorite ON contacts(favorite);
            CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT,
                type TEXT DEFAULT 'string',
                category TEXT DEFAULT 'general',
                description TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_by INTEGER,
                FOREIGN KEY (updated_by) REFERENCES users(id)
            )
        `);

        // Ensure sessions table is managed by connect-sqlite3 (expects 'expired' INTEGER).
        // If our old schema (with 'expires' DATETIME) exists, drop it for recreation.
        try {
            const sessionCols = rawDb.prepare(`PRAGMA table_info(sessions)`).all();
            const hasExpired = sessionCols.some(c => c.name === 'expired');
            if (sessionCols.length > 0 && !hasExpired) {
                rawDb.exec(`DROP TABLE sessions`);
                logger.info('Dropped old sessions table; connect-sqlite3 will recreate it');
            }
        } catch (e) {
            // table may not exist yet — fine
        }

        await db.exec(`
            CREATE TABLE IF NOT EXISTS ussd (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT,
                code TEXT NOT NULL,
                description TEXT,
                response TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                status TEXT DEFAULT 'success',
                type TEXT DEFAULT 'balance',
                session_id TEXT,
                menu_level INTEGER DEFAULT 0,
                duration INTEGER,
                error TEXT,
                sim_slot INTEGER,
                user_id INTEGER,
                FOREIGN KEY (device_id) REFERENCES devices(id),
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `);

        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_ussd_timestamp ON ussd(timestamp);
            CREATE INDEX IF NOT EXISTS idx_ussd_type ON ussd(type);
            CREATE INDEX IF NOT EXISTS idx_ussd_code ON ussd(code);
            CREATE INDEX IF NOT EXISTS idx_ussd_device ON ussd(device_id);
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS ussd_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                service_key TEXT UNIQUE NOT NULL,
                service_name TEXT NOT NULL,
                ussd_code TEXT NOT NULL,
                description TEXT,
                icon TEXT,
                enabled BOOLEAN DEFAULT 1,
                sort_order INTEGER DEFAULT 0,
                requires_pin BOOLEAN DEFAULT 0,
                category TEXT DEFAULT 'general',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS intercom_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL UNIQUE,
                video_enabled BOOLEAN DEFAULT 0,
                audio_enabled BOOLEAN DEFAULT 0,
                resolution TEXT DEFAULT '640x480',
                fps INTEGER DEFAULT 15,
                quality INTEGER DEFAULT 80,
                audio_bitrate INTEGER DEFAULT 64000,
                echo_cancellation BOOLEAN DEFAULT 1,
                noise_suppression BOOLEAN DEFAULT 1,
                auto_gain_control BOOLEAN DEFAULT 1,
                mic_sensitivity INTEGER DEFAULT 50,
                speaker_volume INTEGER DEFAULT 80,
                stun_server TEXT DEFAULT 'stun.l.google.com:19302',
                turn_server TEXT,
                turn_username TEXT,
                turn_password TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS intercom_calls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                type TEXT DEFAULT 'video',
                duration INTEGER DEFAULT 0,
                start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
                end_time DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_intercom_calls_device ON intercom_calls(device_id, start_time);
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS intercom_sessions (
                device_id TEXT PRIMARY KEY,
                in_call INTEGER NOT NULL DEFAULT 0,
                call_type TEXT,
                peer_id TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS automation_flows (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                name           TEXT    NOT NULL,
                description    TEXT    DEFAULT '',
                nodes          TEXT    NOT NULL DEFAULT '[]',
                edges          TEXT    NOT NULL DEFAULT '[]',
                enabled        INTEGER NOT NULL DEFAULT 1,
                device_id      TEXT    DEFAULT '',
                created_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_triggered TEXT,
                trigger_count  INTEGER NOT NULL DEFAULT 0,
                last_result    TEXT
            )
        `);

        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_automation_flows_enabled ON automation_flows(enabled)
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS automation_logs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                flow_id    INTEGER NOT NULL REFERENCES automation_flows(id) ON DELETE CASCADE,
                status     TEXT    NOT NULL,
                trigger    TEXT,
                context    TEXT,
                log        TEXT,
                created_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_automation_logs_flow ON automation_logs(flow_id, created_at DESC)
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS automation_data_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                flow_id INTEGER,
                device_id TEXT NOT NULL,
                tags TEXT,
                payload TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (flow_id) REFERENCES automation_flows(id) ON DELETE SET NULL,
                FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
            )
        `);

        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_automation_data_records_device ON automation_data_records(device_id, created_at DESC)
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS storage_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                size INTEGER,
                type TEXT,
                modified DATETIME,
                created DATETIME,
                is_directory BOOLEAN DEFAULT 0,
                parent_path TEXT,
                storage_type TEXT DEFAULT 'internal',
                tags TEXT,
                UNIQUE(path, storage_type)
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS mqtt_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                topic TEXT NOT NULL,
                message TEXT,
                direction TEXT DEFAULT 'in',
                device_id TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                qos INTEGER,
                retained BOOLEAN DEFAULT 0
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS system_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                level TEXT DEFAULT 'info',
                message TEXT NOT NULL,
                module TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                user_id INTEGER,
                data TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS backups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                path TEXT NOT NULL,
                size INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                type TEXT DEFAULT 'manual',
                status TEXT DEFAULT 'completed',
                checksum TEXT,
                UNIQUE(path)
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                type TEXT DEFAULT 'info',
                title TEXT NOT NULL,
                message TEXT,
                read BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                expires_at DATETIME,
                action_url TEXT,
                action_text TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS gps_locations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                altitude REAL,
                speed REAL,
                heading REAL,
                satellites INTEGER,
                accuracy REAL,
                fix_quality INTEGER,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                address TEXT,
                tags TEXT
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS gpio_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                pin INTEGER NOT NULL,
                name TEXT,
                mode TEXT DEFAULT 'input',
                pull TEXT DEFAULT 'none',
                frequency INTEGER DEFAULT 1000,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(device_id, pin)
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS gpio_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                pin INTEGER NOT NULL,
                value INTEGER NOT NULL,
                type TEXT DEFAULT 'digital',
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (device_id) REFERENCES devices(id)
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS gpio_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                name TEXT NOT NULL,
                pins TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS gpio_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                name TEXT NOT NULL,
                condition TEXT NOT NULL,
                action TEXT NOT NULL,
                enabled BOOLEAN DEFAULT 1,
                trigger_count INTEGER DEFAULT 0,
                last_triggered DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS webcam (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT,
                name TEXT NOT NULL,
                enabled BOOLEAN DEFAULT 0,
                resolution TEXT DEFAULT '640x480',
                fps INTEGER DEFAULT 15,
                quality INTEGER DEFAULT 80,
                motion_detection BOOLEAN DEFAULT 0,
                face_detection BOOLEAN DEFAULT 0,
                recognition_enabled BOOLEAN DEFAULT 0,
                retention_days INTEGER DEFAULT 30,
                privacy_mode TEXT DEFAULT 'events-only',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS webcam_captures (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT,
                webcam_id INTEGER,
                filename TEXT NOT NULL,
                path TEXT NOT NULL,
                size INTEGER,
                format TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                tags TEXT,
                capture_type TEXT DEFAULT 'snapshot',
                motion_detected BOOLEAN DEFAULT 0,
                face_detected BOOLEAN DEFAULT 0,
                face_count INTEGER DEFAULT 0,
                recognized_label TEXT,
                recognition_confidence REAL,
                metadata TEXT,
                source TEXT DEFAULT 'mqtt',
                FOREIGN KEY (webcam_id) REFERENCES webcam(id)
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS device_module_health (
                device_id TEXT NOT NULL,
                module_key TEXT NOT NULL,
                supported BOOLEAN DEFAULT 1,
                state TEXT DEFAULT 'unknown',
                last_success_at DATETIME,
                last_failure_at DATETIME,
                last_message TEXT,
                details TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (device_id, module_key),
                FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS device_profiles (
                device_id TEXT PRIMARY KEY,
                location TEXT,
                apn TEXT,
                mqtt_host TEXT,
                mqtt_user TEXT,
                mqtt_pass TEXT,
                current_package_code TEXT,
                current_package_name TEXT,
                current_package_price INTEGER DEFAULT 0,
                current_package_limits TEXT,
                current_package_status TEXT,
                current_package_approved_at DATETIME,
                device_id_override TEXT,
                wifi_ssid TEXT,
                wifi_pass TEXT,
                last_sim_number TEXT,
                local_ip TEXT,
                capabilities TEXT,
                firmware_version TEXT,
                model TEXT,
                board TEXT,
                hardware_uid TEXT,
                has_gps INTEGER DEFAULT 0,
                has_battery INTEGER DEFAULT 0,
                has_sd INTEGER DEFAULT 0,
                has_camera INTEGER DEFAULT 0,
                has_audio INTEGER DEFAULT 0,
                has_display INTEGER DEFAULT 0,
                has_nfc INTEGER DEFAULT 0,
                has_rfid INTEGER DEFAULT 0,
                has_touch INTEGER DEFAULT 0,
                has_keyboard INTEGER DEFAULT 0,
                probed_at DATETIME,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS sims (
                device_id TEXT NOT NULL,
                slot_index INTEGER NOT NULL,
                sim_number TEXT,
                operator_name TEXT,
                carrier_name TEXT,
                network_type TEXT,
                is_ready INTEGER DEFAULT 0,
                is_registered INTEGER DEFAULT 0,
                last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (device_id, slot_index),
                FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS device_wifi_networks (
                device_id TEXT NOT NULL,
                ssid TEXT NOT NULL,
                security TEXT,
                password TEXT,
                password_set INTEGER DEFAULT 0,
                connection_count INTEGER DEFAULT 0,
                last_selected_at DATETIME,
                last_connected_at DATETIME,
                last_signal INTEGER,
                last_channel INTEGER,
                last_bssid TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (device_id, ssid),
                FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
            )
        `);

        for (const [table, col, def] of [
            ['device_profiles', 'wifi_ssid', 'TEXT'],
            ['device_profiles', 'wifi_pass', 'TEXT'],
            ['device_profiles', 'device_id_override', 'TEXT'],
            ['device_profiles', 'hardware_uid', 'TEXT'],
            ['device_profiles', 'model', 'TEXT'],
            ['device_profiles', 'last_sim_number', 'TEXT'],
            ['device_profiles', 'current_package_code', 'TEXT'],
            ['device_profiles', 'current_package_name', 'TEXT'],
            ['device_profiles', 'current_package_price', 'INTEGER DEFAULT 0'],
            ['device_profiles', 'current_package_limits', 'TEXT'],
            ['device_profiles', 'current_package_status', 'TEXT'],
            ['device_profiles', 'current_package_approved_at', 'DATETIME']
        ]) {
            const cols = await db.all(`PRAGMA table_info(${table})`);
            if (cols && !cols.some(c => c.name === col)) {
                await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
                logger.info(`Migration: added column ${col} to ${table}`);
            }
        }

        await db.exec(`
            CREATE TABLE IF NOT EXISTS device_users (
                device_id TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                can_write INTEGER DEFAULT 1,
                assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (device_id, user_id),
                FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_device_users_user   ON device_users(user_id);
            CREATE INDEX IF NOT EXISTS idx_device_users_device ON device_users(device_id);
            CREATE INDEX IF NOT EXISTS idx_device_profiles_device ON device_profiles(device_id);
            CREATE INDEX IF NOT EXISTS idx_device_profiles_hardware_uid ON device_profiles(hardware_uid);
            CREATE INDEX IF NOT EXISTS idx_device_wifi_networks_device ON device_wifi_networks(device_id, updated_at DESC);
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS device_package_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                package_code TEXT NOT NULL,
                package_name TEXT NOT NULL,
                price_bdt INTEGER NOT NULL DEFAULT 0,
                limits_json TEXT NOT NULL DEFAULT '{}',
                payment_method TEXT NOT NULL DEFAULT 'bkash',
                payment_number TEXT NOT NULL,
                payment_reference TEXT,
                notes TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                reviewed_at DATETIME,
                reviewed_by INTEGER,
                review_notes TEXT,
                FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS idx_device_package_requests_device ON device_package_requests(device_id, requested_at DESC);
            CREATE INDEX IF NOT EXISTS idx_device_package_requests_status ON device_package_requests(status, requested_at DESC);
            CREATE INDEX IF NOT EXISTS idx_device_package_requests_user ON device_package_requests(user_id, requested_at DESC);
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS device_push_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                push_token TEXT NOT NULL,
                platform TEXT DEFAULT 'unknown',
                app_id TEXT,
                is_active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(device_id, push_token),
                FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_device_push_tokens_device ON device_push_tokens(device_id, is_active);
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS phone_device_links (
                phone_device_id TEXT NOT NULL,
                target_device_id TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (phone_device_id, target_device_id),
                FOREIGN KEY (phone_device_id) REFERENCES devices(id) ON DELETE CASCADE,
                FOREIGN KEY (target_device_id) REFERENCES devices(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_phone_device_links_phone ON phone_device_links(phone_device_id);
            CREATE INDEX IF NOT EXISTS idx_phone_device_links_target ON phone_device_links(target_device_id);
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS device_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT,
                owner_id INTEGER NOT NULL,
                color TEXT DEFAULT '#0d6efd',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS device_group_members (
                group_id INTEGER NOT NULL,
                device_id TEXT NOT NULL,
                PRIMARY KEY (group_id, device_id),
                FOREIGN KEY (group_id) REFERENCES device_groups(id) ON DELETE CASCADE,
                FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
            )
        `);

        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_group_members_group  ON device_group_members(group_id);
            CREATE INDEX IF NOT EXISTS idx_group_members_device ON device_group_members(device_id);
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS api_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                key_hash TEXT NOT NULL UNIQUE,
                key_prefix TEXT NOT NULL,
                scopes TEXT DEFAULT 'read',
                device_ids TEXT,
                last_used DATETIME,
                expires_at DATETIME,
                is_active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_api_keys_user   ON api_keys(user_id, is_active);
            CREATE INDEX IF NOT EXISTS idx_api_keys_hash   ON api_keys(key_hash);
            CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS geofences (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                name TEXT NOT NULL,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                radius_m REAL NOT NULL,
                alert_on TEXT DEFAULT 'both',
                active BOOLEAN DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_geofences_device ON geofences(device_id, active);
        `);

        // Track last known fence state to detect entry/exit transitions
        await db.exec(`
            CREATE TABLE IF NOT EXISTS geofence_state (
                geofence_id INTEGER NOT NULL,
                device_id TEXT NOT NULL,
                inside BOOLEAN NOT NULL DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (geofence_id, device_id),
                FOREIGN KEY (geofence_id) REFERENCES geofences(id) ON DELETE CASCADE
            )
        `);

        // ==================== MIGRATIONS ====================

        // gpio_config.value column (added later)
        try { await db.exec(`ALTER TABLE gpio_config ADD COLUMN value INTEGER DEFAULT 0`); } catch (e) {}

        // users auth columns
        try { await db.exec(`ALTER TABLE users ADD COLUMN must_change_password BOOLEAN DEFAULT 0`); } catch (e) {}
        try { await db.exec(`ALTER TABLE users ADD COLUMN password_reset_token TEXT`); } catch (e) {}
        try { await db.exec(`ALTER TABLE users ADD COLUMN password_reset_expires DATETIME`); } catch (e) {}

        // users 2FA columns
        try { await db.exec(`ALTER TABLE users ADD COLUMN totp_secret TEXT`); } catch (e) {}
        try { await db.exec(`ALTER TABLE users ADD COLUMN totp_enabled BOOLEAN DEFAULT 0`); } catch (e) {}
        try { await db.exec(`ALTER TABLE users ADD COLUMN totp_pending TEXT`); } catch (e) {}

        // users role/protection columns
        try { await db.exec(`ALTER TABLE users ADD COLUMN is_protected BOOLEAN DEFAULT 0`); } catch (e) {}

        // magic link login columns
        try { await db.exec(`ALTER TABLE users ADD COLUMN magic_login_token TEXT`); } catch (e) {}
        try { await db.exec(`ALTER TABLE users ADD COLUMN magic_login_expires DATETIME`); } catch (e) {}

        // API key rate limiting
        try { await db.exec(`ALTER TABLE api_keys ADD COLUMN rate_limit_rpm INTEGER`); } catch (e) {}

        // Per-device MQTT credentials (for NVS config push via onboarding)
        try { await db.exec(`ALTER TABLE device_profiles ADD COLUMN mqtt_host TEXT`); } catch (e) {}
        try { await db.exec(`ALTER TABLE device_profiles ADD COLUMN mqtt_pass TEXT`); } catch (e) {}
        try { await db.exec(`ALTER TABLE device_profiles ADD COLUMN local_ip TEXT`); } catch (e) {}
        try { await db.exec(`ALTER TABLE device_profiles ADD COLUMN device_id_override TEXT`); } catch (e) {}

        // device_profiles — hardware capability flags (from MQTT capabilities topic)
        try { await db.exec(`ALTER TABLE device_profiles ADD COLUMN has_nfc      INTEGER DEFAULT 0`); } catch (e) {}
        try { await db.exec(`ALTER TABLE device_profiles ADD COLUMN has_rfid     INTEGER DEFAULT 0`); } catch (e) {}
        try { await db.exec(`ALTER TABLE device_profiles ADD COLUMN has_touch    INTEGER DEFAULT 0`); } catch (e) {}
        try { await db.exec(`ALTER TABLE device_profiles ADD COLUMN has_keyboard INTEGER DEFAULT 0`); } catch (e) {}
        try { await db.exec(`ALTER TABLE sms ADD COLUMN conversation_id INTEGER`); } catch (e) {}
        try { await db.exec(`ALTER TABLE sms ADD COLUMN source TEXT DEFAULT 'device'`); } catch (e) {}
        try { await db.exec(`ALTER TABLE sms ADD COLUMN batch_id TEXT`); } catch (e) {}
        try { await db.exec(`ALTER TABLE sms ADD COLUMN external_id TEXT`); } catch (e) {}
        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_sms_device_timestamp ON sms(device_id, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_sms_conversation ON sms(conversation_id, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_sms_unassigned_conversation
                ON sms(device_id, id)
                WHERE conversation_id IS NULL OR conversation_id = 0;
            CREATE INDEX IF NOT EXISTS idx_sms_batch ON sms(batch_id);
            CREATE INDEX IF NOT EXISTS idx_sms_conversations_device ON sms_conversations(device_id, last_message_at DESC);
            CREATE INDEX IF NOT EXISTS idx_sms_conversations_key ON sms_conversations(device_id, conversation_key);
            CREATE INDEX IF NOT EXISTS idx_sms_conversation_participants_conv ON sms_conversation_participants(conversation_id);
        `);

        // OTA flash history (last 10 per device for rollback)
        await db.exec(`
            CREATE TABLE IF NOT EXISTS device_ota_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                firmware_version TEXT,
                file_size INTEGER,
                flashed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                flashed_by TEXT,
                notes TEXT
            )
        `);
        try { await db.exec(`ALTER TABLE device_ota_history ADD COLUMN firmware_version TEXT`); } catch (e) {}
        try { await db.exec(`ALTER TABLE device_ota_history ADD COLUMN file_size INTEGER`); } catch (e) {}
        try { await db.exec(`ALTER TABLE device_ota_history ADD COLUMN notes TEXT`); } catch (e) {}
        try { await db.exec(`CREATE INDEX IF NOT EXISTS idx_ota_history_device ON device_ota_history(device_id, flashed_at DESC)`); } catch (e) {}

        // login_audit table
        await db.exec(`
            CREATE TABLE IF NOT EXISTS login_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                user_id INTEGER,
                success INTEGER NOT NULL DEFAULT 0,
                ip TEXT,
                user_agent TEXT,
                reason TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            )
        `);
        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_login_audit_user   ON login_audit(user_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_login_audit_created ON login_audit(created_at);
        `);

        // Active login sessions tracking
        await db.exec(`
            CREATE TABLE IF NOT EXISTS login_sessions (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                session_id TEXT NOT NULL,
                ip_address TEXT,
                user_agent TEXT,
                device_info TEXT,
                logged_in_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
                is_active INTEGER DEFAULT 1,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_login_sessions_user ON login_sessions(user_id)`);
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_login_sessions_session ON login_sessions(session_id)`);

        // FK constraint migration: rebuild sms/calls/gpio_history with device_id FKs
        // (CREATE TABLE IF NOT EXISTS above only applies to fresh installs; existing DBs need a rebuild)
        try {
            // Helper: check whether a table already has a FK to devices
            const hasFk = (table) =>
                rawDb.prepare(`PRAGMA foreign_key_list(${table})`).all().some(r => r.table === 'devices');
            const getColumnNames = (table) =>
                rawDb.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
            const legacySimScopeColumn = ['sim', 'subscription', 'id'].join('_');
            const tableHasColumn = (table, column) => getColumnNames(table).includes(column);
            const buildSelectColumns = (existingColumns, desiredColumns, defaults = {}) =>
                desiredColumns.map((column) => {
                    if (existingColumns.includes(column)) {
                        return column;
                    }
                    const fallback = Object.prototype.hasOwnProperty.call(defaults, column)
                        ? defaults[column]
                        : 'NULL';
                    return `${fallback} AS ${column}`;
                }).join(', ');
            const rebuildTable = (table, tempTable, desiredColumns, createSql, logMessage) => {
                const existingColumns = getColumnNames(table);
                rawDb.pragma('foreign_keys = OFF');
                rawDb.exec(`
                    BEGIN;
                    ${createSql}
                    INSERT INTO ${tempTable} (${desiredColumns.join(', ')})
                    SELECT ${buildSelectColumns(existingColumns, desiredColumns)} FROM ${table};
                    DROP TABLE ${table};
                    ALTER TABLE ${tempTable} RENAME TO ${table};
                    COMMIT;
                `);
                rawDb.pragma('foreign_keys = ON');
                logger.info(logMessage);
            };

            if (!hasFk('sms') || tableHasColumn('sms', legacySimScopeColumn)) {
                const smsColumns = [
                    'id',
                    'device_id',
                    'conversation_id',
                    'from_number',
                    'to_number',
                    'message',
                    'timestamp',
                    'read',
                    'type',
                    'status',
                    'delivered_at',
                    'error',
                    'folder',
                    'tags',
                    'user_id',
                    'source',
                    'batch_id',
                    'sim_slot',
                    'external_id'
                ];
                rebuildTable(
                    'sms',
                    'sms_new',
                    smsColumns,
                    `CREATE TABLE sms_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        device_id TEXT,
                        conversation_id INTEGER,
                        from_number TEXT NOT NULL,
                        to_number TEXT,
                        message TEXT NOT NULL,
                        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                        read BOOLEAN DEFAULT 0,
                        type TEXT DEFAULT 'incoming',
                        status TEXT DEFAULT 'received',
                        delivered_at DATETIME,
                        error TEXT,
                        folder TEXT DEFAULT 'inbox',
                        tags TEXT,
                        user_id INTEGER,
                        source TEXT DEFAULT 'device',
                        batch_id TEXT,
                        sim_slot INTEGER,
                        external_id TEXT,
                        UNIQUE(device_id, timestamp, from_number),
                        FOREIGN KEY (device_id) REFERENCES devices(id),
                        FOREIGN KEY (user_id) REFERENCES users(id),
                        FOREIGN KEY (conversation_id) REFERENCES sms_conversations(id) ON DELETE SET NULL
                    );`,
                    'Migration: sms table rebuilt for SIM slot-only schema'
                );
            }

            if (!hasFk('calls') || tableHasColumn('calls', legacySimScopeColumn)) {
                const callsColumns = [
                    'id',
                    'device_id',
                    'phone_number',
                    'contact_name',
                    'type',
                    'status',
                    'start_time',
                    'end_time',
                    'duration',
                    'recording_url',
                    'notes',
                    'created_at',
                    'missed',
                    'tags',
                    'sim_slot',
                    'user_id'
                ];
                rebuildTable(
                    'calls',
                    'calls_new',
                    callsColumns,
                    `CREATE TABLE calls_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        device_id TEXT,
                        phone_number TEXT NOT NULL,
                        contact_name TEXT,
                        type TEXT DEFAULT 'outgoing',
                        status TEXT DEFAULT 'dialing',
                        start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
                        end_time DATETIME,
                        duration INTEGER DEFAULT 0,
                        recording_url TEXT,
                        notes TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        missed BOOLEAN DEFAULT 0,
                        tags TEXT,
                        sim_slot INTEGER,
                        user_id INTEGER,
                        FOREIGN KEY (user_id) REFERENCES users(id),
                        FOREIGN KEY (device_id) REFERENCES devices(id)
                    );`,
                    'Migration: calls table rebuilt for SIM slot-only schema'
                );
            }

            if (tableHasColumn('ussd', legacySimScopeColumn)) {
                const ussdColumns = [
                    'id',
                    'device_id',
                    'code',
                    'description',
                    'response',
                    'timestamp',
                    'status',
                    'type',
                    'session_id',
                    'menu_level',
                    'duration',
                    'error',
                    'sim_slot',
                    'user_id'
                ];
                rebuildTable(
                    'ussd',
                    'ussd_new',
                    ussdColumns,
                    `CREATE TABLE ussd_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        device_id TEXT,
                        code TEXT NOT NULL,
                        description TEXT,
                        response TEXT,
                        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                        status TEXT DEFAULT 'success',
                        type TEXT DEFAULT 'balance',
                        session_id TEXT,
                        menu_level INTEGER DEFAULT 0,
                        duration INTEGER,
                        error TEXT,
                        sim_slot INTEGER,
                        user_id INTEGER,
                        FOREIGN KEY (device_id) REFERENCES devices(id),
                        FOREIGN KEY (user_id) REFERENCES users(id)
                    );`,
                    'Migration: ussd table rebuilt for SIM slot-only schema'
                );
            }

            if (tableHasColumn('scheduled_sms', legacySimScopeColumn)) {
                const scheduledSmsColumns = [
                    'id',
                    'device_id',
                    'to_number',
                    'message',
                    'send_at',
                    'status',
                    'sent_at',
                    'error',
                    'sim_slot',
                    'user_id',
                    'created_at'
                ];
                rebuildTable(
                    'scheduled_sms',
                    'scheduled_sms_new',
                    scheduledSmsColumns,
                    `CREATE TABLE scheduled_sms_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        device_id TEXT NOT NULL,
                        to_number TEXT NOT NULL,
                        message TEXT NOT NULL,
                        send_at DATETIME NOT NULL,
                        status TEXT DEFAULT 'pending',
                        sent_at DATETIME,
                        error TEXT,
                        sim_slot INTEGER,
                        user_id INTEGER,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (user_id) REFERENCES users(id)
                    );`,
                    'Migration: scheduled_sms table rebuilt for SIM slot-only schema'
                );
            }

            if (!hasFk('gpio_history')) {
                rawDb.pragma('foreign_keys = OFF');
                rawDb.exec(`
                    BEGIN;
                    CREATE TABLE gpio_history_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        device_id TEXT NOT NULL,
                        pin INTEGER NOT NULL,
                        value INTEGER NOT NULL,
                        type TEXT DEFAULT 'digital',
                        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (device_id) REFERENCES devices(id)
                    );
                    INSERT INTO gpio_history_new SELECT * FROM gpio_history;
                    DROP TABLE gpio_history;
                    ALTER TABLE gpio_history_new RENAME TO gpio_history;
                    COMMIT;
                `);
                rawDb.pragma('foreign_keys = ON');
                logger.info('Migration: gpio_history table rebuilt with device_id FK');
            }
        } catch (e) {
            logger.warn('FK migration warning (non-fatal):', e.message);
        }

        // ==================== COLUMN MIGRATIONS ====================
        // ALTER TABLE ADD COLUMN is safe (ignored if already exists via try-catch)
        const _addCol = (table, col, type) => {
            try { rawDb.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch (_) {}
        };
        _addCol('webcam', 'device_id', 'TEXT');
        _addCol('webcam_captures', 'device_id', 'TEXT');
        _addCol('sms', 'user_id', 'INTEGER');
        _addCol('sms', 'sim_slot', 'INTEGER');
        _addCol('calls', 'sim_slot', 'INTEGER');
        _addCol('calls', 'user_id', 'INTEGER');
        _addCol('ussd', 'sim_slot', 'INTEGER');
        _addCol('ussd', 'user_id', 'INTEGER');
        _addCol('scheduled_sms', 'sim_slot', 'INTEGER');
        _addCol('scheduled_sms', 'user_id', 'INTEGER');

        // ==================== INDEXES ====================

        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_gpio_history_device ON gpio_history(device_id, pin, timestamp);
            CREATE INDEX IF NOT EXISTS idx_gpio_config_device ON gpio_config(device_id, pin);

            CREATE INDEX IF NOT EXISTS idx_sms_timestamp   ON sms(timestamp);
            CREATE INDEX IF NOT EXISTS idx_sms_read_type   ON sms(read, type);
            CREATE INDEX IF NOT EXISTS idx_sms_from_number ON sms(from_number);
            CREATE INDEX IF NOT EXISTS idx_sms_to_number   ON sms(to_number);
            CREATE INDEX IF NOT EXISTS idx_sms_read        ON sms(read);
            CREATE INDEX IF NOT EXISTS idx_sms_type        ON sms(type);
            CREATE INDEX IF NOT EXISTS idx_sms_from        ON sms(from_number);
            CREATE INDEX IF NOT EXISTS idx_sms_to          ON sms(to_number);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_device_external_id ON sms(device_id, external_id) WHERE external_id IS NOT NULL;

            CREATE INDEX IF NOT EXISTS idx_gps_device_timestamp ON gps_locations(device_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_gps_device           ON gps_locations(device_id);
            CREATE INDEX IF NOT EXISTS idx_gps_timestamp        ON gps_locations(timestamp);

            CREATE INDEX IF NOT EXISTS idx_calls_phone_number ON calls(phone_number);
            CREATE INDEX IF NOT EXISTS idx_calls_device_sim ON calls(device_id, sim_slot, start_time DESC);
            CREATE INDEX IF NOT EXISTS idx_ussd_device_sim ON ussd(device_id, sim_slot, timestamp DESC);

            CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
            CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);

            CREATE INDEX IF NOT EXISTS idx_logs_level     ON system_logs(level);
            CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON system_logs(timestamp);

            CREATE INDEX IF NOT EXISTS idx_mqtt_device    ON mqtt_logs(device_id);
            CREATE INDEX IF NOT EXISTS idx_mqtt_timestamp ON mqtt_logs(timestamp);

            CREATE INDEX IF NOT EXISTS idx_backups_created ON backups(created_at);

            CREATE INDEX IF NOT EXISTS idx_webcam_captures_timestamp ON webcam_captures(timestamp);
            CREATE INDEX IF NOT EXISTS idx_webcam_captures_device_timestamp ON webcam_captures(device_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_webcam_device_id ON webcam(device_id);
            CREATE INDEX IF NOT EXISTS idx_device_module_health_device ON device_module_health(device_id, module_key);
            CREATE INDEX IF NOT EXISTS idx_sims_device ON sims(device_id, slot_index);
        `);

        // Conditional index: only create idx_sms_device if column exists (migration may not have run on old DBs)
        try {
            const smsCols = rawDb.prepare(`PRAGMA table_info(sms)`).all();
            if (smsCols.some(c => c.name === 'device_id')) {
                rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_sms_device ON sms(device_id)`);
            }
        } catch (_) { /* non-fatal */ }

        await db.exec(`
            CREATE TABLE IF NOT EXISTS webhooks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                secret TEXT,
                events TEXT NOT NULL DEFAULT 'sms.incoming',
                device_ids TEXT,
                is_active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_fired_at DATETIME,
                last_status INTEGER,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_webhooks_user   ON webhooks(user_id);
            CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks(is_active);
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS webhook_queue (
                id TEXT PRIMARY KEY,
                webhook_id INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                attempts INTEGER DEFAULT 0,
                max_attempts INTEGER DEFAULT 3,
                next_retry_at DATETIME,
                last_error TEXT,
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
            )
        `);
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_queue_status ON webhook_queue(status, next_retry_at)`);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS device_command_queue (
                id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                command TEXT NOT NULL,
                payload TEXT NOT NULL DEFAULT '{}',
                message_id TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'pending',
                requires_response INTEGER NOT NULL DEFAULT 0,
                replay_safe INTEGER NOT NULL DEFAULT 0,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 6,
                timeout_ms INTEGER NOT NULL DEFAULT 30000,
                priority INTEGER NOT NULL DEFAULT 100,
                next_attempt_at DATETIME,
                published_at DATETIME,
                completed_at DATETIME,
                last_error TEXT,
                response_payload TEXT,
                source TEXT,
                user_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            )
        `);
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_device_command_queue_status ON device_command_queue(status, next_attempt_at, device_id, created_at)`);
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_device_command_queue_device ON device_command_queue(device_id, created_at DESC)`);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS pin_names (
                device_id TEXT NOT NULL,
                pin INTEGER NOT NULL,
                name TEXT NOT NULL,
                color TEXT DEFAULT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (device_id, pin),
                FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_pin_names_device ON pin_names(device_id);
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS invite_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT NOT NULL UNIQUE,
                email TEXT,
                role TEXT DEFAULT 'viewer',
                created_by INTEGER NOT NULL,
                used_by INTEGER,
                expires_at DATETIME NOT NULL,
                used_at DATETIME,
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_invites_token   ON invite_tokens(token);
            CREATE INDEX IF NOT EXISTS idx_invites_expires ON invite_tokens(expires_at);
        `);

        // ==================== COLUMN MIGRATIONS ====================
        // Add columns that may not exist in older databases
        for (const { table, col, def } of [
            { table: 'storage_files', col: 'device_id', def: 'TEXT' },
            { table: 'gpio_rules',    col: 'device_id', def: "TEXT NOT NULL DEFAULT ''" },
            { table: 'gpio_groups',   col: 'device_id', def: "TEXT NOT NULL DEFAULT ''" },
            { table: 'sms',           col: 'user_id',    def: 'INTEGER' },
            { table: 'calls',         col: 'user_id',    def: 'INTEGER' },
            { table: 'ussd',          col: 'user_id',    def: 'INTEGER' },
            { table: 'devices',       col: 'description', def: 'TEXT' },
            { table: 'webcam',        col: 'device_id', def: 'TEXT' },
            { table: 'webcam',        col: 'recognition_enabled', def: 'BOOLEAN DEFAULT 0' },
            { table: 'webcam',        col: 'retention_days', def: 'INTEGER DEFAULT 30' },
            { table: 'webcam',        col: 'privacy_mode', def: "TEXT DEFAULT 'events-only'" },
            { table: 'webcam_captures', col: 'capture_type', def: "TEXT DEFAULT 'snapshot'" },
            { table: 'webcam_captures', col: 'motion_detected', def: 'BOOLEAN DEFAULT 0' },
            { table: 'webcam_captures', col: 'face_detected', def: 'BOOLEAN DEFAULT 0' },
            { table: 'webcam_captures', col: 'face_count', def: 'INTEGER DEFAULT 0' },
            { table: 'webcam_captures', col: 'recognized_label', def: 'TEXT' },
            { table: 'webcam_captures', col: 'recognition_confidence', def: 'REAL' },
            { table: 'webcam_captures', col: 'metadata', def: 'TEXT' },
            { table: 'webcam_captures', col: 'source', def: "TEXT DEFAULT 'mqtt'" },
        ]) {
            const cols = await db.all(`PRAGMA table_info(${table})`);
            if (cols && !cols.some(c => c.name === col)) {
                await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
                logger.info(`Migration: added column ${col} to ${table}`);
            }
        }

        // SMS templates
        await db.exec(`
            CREATE TABLE IF NOT EXISTS sms_templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                created_by INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users(id)
            )
        `);

        // Scheduled SMS
        await db.exec(`
            CREATE TABLE IF NOT EXISTS scheduled_sms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                to_number TEXT NOT NULL,
                message TEXT NOT NULL,
                send_at DATETIME NOT NULL,
                status TEXT DEFAULT 'pending',
                sent_at DATETIME,
                error TEXT,
                sim_slot INTEGER,
                user_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE INDEX IF NOT EXISTS idx_scheduled_sms_status  ON scheduled_sms(status, send_at);
            CREATE INDEX IF NOT EXISTS idx_scheduled_sms_device  ON scheduled_sms(device_id);
        `);

        // GPIO cron_expr column migration
        {
            const cols = await db.all(`PRAGMA table_info(gpio_rules)`);
            if (cols && !cols.some(c => c.name === 'cron_expr')) {
                await db.exec(`ALTER TABLE gpio_rules ADD COLUMN cron_expr TEXT`);
                logger.info('Migration: added column cron_expr to gpio_rules');
            }
        }

        for (const retiredTable of ['deleted_devices', 'device_twin', 'test_steps', 'test_results']) {
            const exists = rawDb.prepare(
                `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`
            ).get(retiredTable);
            if (exists) {
                await db.exec(`DROP TABLE IF EXISTS ${retiredTable}`);
                logger.info(`Migration: dropped retired table ${retiredTable}`);
            }
        }

        // ==================== MISSING INDEXES (added) ====================
        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_users_active_role     ON users(is_active, role);
            CREATE INDEX IF NOT EXISTS idx_devices_status        ON devices(status);
            CREATE INDEX IF NOT EXISTS idx_devices_last_seen     ON devices(last_seen DESC);
            CREATE INDEX IF NOT EXISTS idx_storage_device        ON storage_files(device_id, storage_type);
            CREATE INDEX IF NOT EXISTS idx_gpio_rules_device     ON gpio_rules(device_id, enabled);
            CREATE INDEX IF NOT EXISTS idx_gpio_groups_device    ON gpio_groups(device_id);
        `);

        // Flow execution log (last 100 per rule, kept via in-app pruning)
        await db.exec(`
            CREATE TABLE IF NOT EXISTS flow_execution_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                rule_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                rule_name TEXT NOT NULL,
                condition_values TEXT,
                triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_flow_log_rule   ON flow_execution_log(rule_id, triggered_at DESC);
            CREATE INDEX IF NOT EXISTS idx_flow_log_device ON flow_execution_log(device_id, triggered_at DESC);
        `);

        // ==================== SEED DATA ====================

        const legacySuperUsername = String(process.env.SUPER_USER || '').trim();
        const adminUsername = process.env.ADMIN_USERNAME || legacySuperUsername || 'admin';
        const adminPassword = process.env.ADMIN_PASSWORD || process.env.SUPER_PASS || 'admin123';
        const adminUser = await db.get('SELECT * FROM users WHERE username = ?', [adminUsername]);
        const adminDisplayName = process.env.ADMIN_NAME || process.env.SUPER_NAME || 'System Administrator';
        const adminEmail = process.env.ADMIN_EMAIL || process.env.SUPER_EMAIL || '';
        const hasConfiguredAdminPassword = Boolean(process.env.ADMIN_PASSWORD || process.env.SUPER_PASS);

        if (!adminUser) {
            const hashedAdminPassword = await bcrypt.hash(adminPassword, 10);
            const result = await db.run(
                'INSERT INTO users (username, password, name, email, role, is_active, is_protected, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    adminUsername,
                    hashedAdminPassword,
                    adminDisplayName,
                    adminEmail,
                    'superadmin',
                    1,
                    1,
                    hasConfiguredAdminPassword ? 0 : 1
                ]
            );
            logger.info('Default admin user created');
            await db.run(`
                INSERT INTO notifications (user_id, type, title, message)
                VALUES (?, 'success', 'Welcome to Device Bridge', 'Your dashboard is ready. Check the settings to configure your device.')
            `, [result.lastID]);
        } else {
            const updateFields = [
                'role = ?',
                'is_active = 1',
                'is_protected = 1',
                'name = ?',
                'email = ?'
            ];
            const updateParams = ['superadmin', adminDisplayName, adminEmail];

            if (hasConfiguredAdminPassword) {
                const passwordAlreadyMatches = await bcrypt.compare(adminPassword, adminUser.password || '').catch(() => false);
                updateFields.push('password = ?');
                updateFields.push('must_change_password = 0');
                updateParams.push(passwordAlreadyMatches ? adminUser.password : await bcrypt.hash(adminPassword, 10));
            }

            updateParams.push(adminUsername);
            await db.run(
                `UPDATE users
                 SET ${updateFields.join(', ')}
                 WHERE username = ?`,
                updateParams
            );
        }

        if (legacySuperUsername && legacySuperUsername !== adminUsername) {
            await db.run(
                `UPDATE users
                 SET is_active = 0,
                     is_protected = 0,
                     must_change_password = 1
                 WHERE username = ?
                   AND role = 'superadmin'`,
                [legacySuperUsername]
            );
        }

        const webcamCount = await db.get('SELECT COUNT(*) as count FROM webcam');
        if (webcamCount.count === 0) {
            await db.run(
                `INSERT INTO webcam
                    (name, enabled, resolution, fps, quality, motion_detection, face_detection, recognition_enabled, retention_days, privacy_mode)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                ['ESP32-CAM', 0, '640x480', 15, 80, 0, 0, 0, 30, 'events-only']
            );
        }

        const settingsCount = await db.get('SELECT COUNT(*) as count FROM ussd_settings');
        if (settingsCount.count === 0) {
            const defaultSettings = [
                ['balance',   'Check Balance',    '', 'Configure your carrier balance code',        'cash-stack', 0, 1, 'balance'],
                ['data',      'Data Balance',     '', 'Configure your carrier data balance code',   'wifi',       0, 2, 'data'],
                ['minutes',   'Minutes Balance',  '', 'Configure your carrier voice balance code',  'telephone',  0, 3, 'calls'],
                ['sms',       'SMS Balance',      '', 'Configure your carrier SMS balance code',    'chat-dots',  0, 4, 'sms'],
                ['support',   'Customer Care',    '', 'Configure your carrier support shortcode',   'headset',    0, 5, 'support'],
                ['ownNumber', 'My Number',        '', 'Configure your carrier own-number code',     'phone',      0, 6, 'info']
            ];
            for (const s of defaultSettings) {
                await db.run(
                    `INSERT INTO ussd_settings (service_key, service_name, ussd_code, description, icon, enabled, sort_order, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    s
                );
            }
        }

        const systemSettings = [
            ['theme',                   'light',                'string',  'appearance',    'UI theme preference'],
            ['language',                'en',                   'string',  'general',       'Interface language'],
            ['notifications_enabled',   'true',                 'boolean', 'notifications', 'Enable system notifications'],
            ['auto_refresh',            '30',                   'number',  'performance',   'Auto refresh interval in seconds'],
            ['items_per_page',          '20',                   'number',  'general',       'Number of items per page'],
            ['date_format',             'YYYY-MM-DD HH:mm:ss',  'string',  'general',       'Date display format'],
            ['timezone',                'UTC',                  'string',  'general',       'System timezone'],
            ['log_retention_days',      '30',                   'number',  'system',        'Days to keep logs'],
            ['backup_retention_count',  '10',                   'number',  'backup',        'Number of backups to keep'],
            ['mqtt_reconnect_interval', '5',                    'number',  'mqtt',          'MQTT reconnect interval in seconds'],
            ['require_2fa_roles',       '[]',                   'json',    'security',      'Roles that must have 2FA enabled (JSON array, e.g. ["admin","superadmin"])'],
            ['n8n_enabled',            'false',                'boolean', 'integrations',  'Forward device events to n8n workflow'],
            ['n8n_webhook_url',        '',                     'string',  'integrations',  'n8n webhook URL to receive events'],
            ['n8n_events',             '[]',                   'json',    'integrations',  'Events to forward to n8n (empty = all)']
        ];
        for (const s of systemSettings) {
            const exists = await db.get('SELECT key FROM settings WHERE key = ?', [s[0]]);
            if (!exists) {
                await db.run(
                    `INSERT INTO settings (key, value, type, category, description) VALUES (?, ?, ?, ?, ?)`,
                    s
                );
            }
        }

        if (runSmsBackfill) {
            await backfillSmsConversations(db);
        }
        return db;

    } catch (error) {
        logger.error('Database initialization failed:', error);
        if (rawDb) {
            try { rawDb.close(); } catch (e) {}
        }
        throw error;
    }
}

/**
 * Backup the database using SQLite's online backup API.
 * Does NOT require closing the connection.
 */
async function backupDatabase(db, backupPath = null) {
    try {
        if (!backupPath) {
            const backupDir = path.join(__dirname, '../backups');
            if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            backupPath = path.join(backupDir, `database-backup-${ts}.db`);
        }

        // better-sqlite3's async backup() uses SQLite's online backup API
        await db._raw.backup(backupPath);

        logger.info(`Database backed up to: ${backupPath}`);
        return { success: true, path: backupPath };
    } catch (error) {
        logger.error('Backup failed:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Restore from a backup by closing the current connection, overwriting the
 * database file, and returning a fresh wrapped connection.
 */
async function restoreDatabase(currentDb, backupPath) {
    try {
        if (!fs.existsSync(backupPath)) throw new Error('Backup file not found');

        await currentDb.close();
        fs.copyFileSync(backupPath, dbPath);

        const rawDb = new BetterSqlite3(dbPath);
        rawDb.pragma('journal_mode = WAL');
        rawDb.pragma('foreign_keys = ON');

        logger.info(`Database restored from: ${backupPath}`);
        return { success: true, db: wrapDb(rawDb) };
    } catch (error) {
        logger.error('Restore failed:', error);
        return { success: false, error: error.message };
    }
}

async function getDatabaseStats(db) {
    try {
        const tables = await db.all(`SELECT name FROM sqlite_master WHERE type='table'`);
        const stats = {};
        for (const table of tables) {
            const row = await db.get(`SELECT COUNT(*) as count FROM "${table.name}"`);
            stats[table.name] = row.count;
        }
        const fileStats = fs.statSync(dbPath);
        stats.database_size = fileStats.size;
        stats.database_path = dbPath;
        stats.last_modified = fileStats.mtime;
        return stats;
    } catch (error) {
        logger.error('Error getting database stats:', error);
        return null;
    }
}

async function vacuumDatabase(db) {
    try {
        await db.exec('VACUUM');
        logger.info('Database vacuum completed');
        return { success: true };
    } catch (error) {
        logger.error('Vacuum failed:', error);
        return { success: false, error: error.message };
    }
}

// Module-level reference so getDatabase() can be called without app.locals
let _dbInstance = null;

const _origInitializeDatabase = initializeDatabase;
async function initializeDatabaseWithCache(...args) {
    const db = await _origInitializeDatabase(...args);
    _dbInstance = db;
    return db;
}

/**
 * Return the initialized database instance.
 * Must be called after initializeDatabase() has resolved.
 */
function getDatabase() {
    return _dbInstance;
}

module.exports = {
    initializeDatabase: initializeDatabaseWithCache,
    backupDatabase,
    restoreDatabase,
    getDatabaseStats,
    vacuumDatabase,
    getDatabase
};
