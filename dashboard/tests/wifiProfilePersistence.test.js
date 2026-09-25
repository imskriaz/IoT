'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

test('forget clears only the matching device selected credentials atomically', () => {
    const source = fs.readFileSync(path.join(__dirname, '../config/database.js'), 'utf8');
    const trigger = source.match(/CREATE TRIGGER IF NOT EXISTS forget_wifi_selected_credentials[\s\S]*?END;/)?.[0];
    expect(trigger).toBeDefined();
    const db = new Database(':memory:');
    try {
        db.exec(`CREATE TABLE device_profiles (device_id TEXT PRIMARY KEY, wifi_ssid TEXT, wifi_pass TEXT, updated_at TEXT);
            CREATE TABLE device_wifi_networks (device_id TEXT, ssid TEXT, PRIMARY KEY(device_id, ssid));`);
        db.exec(trigger);
        const insertProfile = db.prepare('INSERT INTO device_profiles VALUES (?, ?, ?, NULL)');
        const insertNetwork = db.prepare('INSERT INTO device_wifi_networks VALUES (?, ?)');
        for (const device of ['one', 'two']) {
            insertProfile.run(device, "Riaz's Wi-Fi", 'test-secret');
            insertNetwork.run(device, "Riaz's Wi-Fi");
        }
        insertNetwork.run('one', 'second-network');
        db.prepare('DELETE FROM device_wifi_networks WHERE device_id = ? AND ssid = ?').run('one', "Riaz's Wi-Fi");
        expect(db.prepare('SELECT wifi_ssid, wifi_pass FROM device_profiles WHERE device_id = ?').get('one')).toEqual({ wifi_ssid: null, wifi_pass: null });
        expect(db.prepare('SELECT wifi_pass FROM device_profiles WHERE device_id = ?').get('two').wifi_pass).toBe('test-secret');
        expect(db.prepare('SELECT COUNT(*) AS count FROM device_wifi_networks').get().count).toBe(2);
    } finally { db.close(); }
});
