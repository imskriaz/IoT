/**
 * db.js — Dexie.js IndexedDB schema for the ESP32 dashboard.
 *
 * Loaded before common.js and all page scripts.
 * Exposes window.localDb for use across all pages.
 *
 * Schema version history
 *   v1 — initial: sms, calls, contacts, gps, outbox
 *   v2 — add sms server_id/device_id indexes for multi-device cache safety
 */
(function () {
    'use strict';

    const db = new Dexie('esp32dashboard');

    db.version(1).stores({
        // SMS messages. ++id = auto-increment local key; timestamp indexed for delta sync.
        sms: '++id, timestamp, read, type',

        // Call log. start_time indexed for delta sync.
        calls: '++id, start_time, type, status',

        // Contacts. server_id is the server-side id; phone_number indexed for lookup.
        contacts: '++id, server_id, phone_number',

        // GPS track points. timestamp indexed for history range queries.
        gps: '++id, timestamp, device_id',

        // Offline outbox — pending write operations to replay on reconnect.
        // type: 'sms-send' | 'mark-read' etc.
        outbox: '++id, timestamp, type'
    });

    db.version(2).stores({
        sms: '++id, server_id, device_id, timestamp, read, type',
        calls: '++id, start_time, type, status',
        contacts: '++id, server_id, phone_number',
        gps: '++id, timestamp, device_id',
        outbox: '++id, timestamp, type'
    });

    window.localDb = db;
})();
