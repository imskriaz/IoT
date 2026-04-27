'use strict';

function clean(value) {
    return String(value || '').trim();
}

function buildIdentityPayload(payload = {}) {
    const candidate = payload && typeof payload === 'object' ? payload : {};
    const status = candidate.status && typeof candidate.status === 'object' ? candidate.status : null;
    const identity = {
        name: clean(candidate.name || status?.device_name || status?.deviceName),
        model: clean(candidate.model || status?.model || status?.device_model),
        platform: clean(candidate.platform || status?.platform),
        board: clean(candidate.board || status?.board),
        bridge: clean(candidate.bridge || candidate.bridge_type || status?.bridge || status?.bridge_type),
        app: clean(candidate.app || status?.app),
        transport: clean(candidate.transport_mode || candidate.bridge_transport || status?.transport_mode || status?.bridge_transport),
        manufacturer: clean(candidate.manufacturer || status?.manufacturer),
        brand: clean(candidate.brand || status?.brand)
    };

    return Object.fromEntries(Object.entries(identity).filter(([, value]) => value));
}

async function isRegisteredDevice(db, deviceId) {
    const normalized = clean(deviceId);
    if (!db || !normalized) return false;
    const row = await db.get(`SELECT id FROM devices WHERE id = ?`, [normalized]);
    return Boolean(row?.id);
}

async function noteUnregisteredDevice(db, deviceId, eventType, payload = {}, notes = '') {
    const normalized = clean(deviceId);
    if (!db || !normalized) return false;

    const number = clean(
        payload?.number ||
        payload?.from ||
        payload?.to ||
        payload?.phone_number
    );

    let payloadText = '';
    let rawPayloadText = '';
    try {
        payloadText = JSON.stringify(buildIdentityPayload(payload)).slice(0, 1000);
    } catch (_) {}
    try {
        rawPayloadText = JSON.stringify(payload || {}).slice(0, 8000);
    } catch (_) {}

    await db.run(
        `INSERT INTO unregistered_devices
            (device_id, first_seen, last_seen, event_count, last_event_type, last_number, last_payload, notes)
         VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
            last_seen = CURRENT_TIMESTAMP,
            event_count = event_count + 1,
            last_event_type = excluded.last_event_type,
            last_number = excluded.last_number,
            last_payload = CASE
                WHEN excluded.last_payload IS NOT NULL AND excluded.last_payload != '' THEN excluded.last_payload
                ELSE unregistered_devices.last_payload
            END,
            notes = CASE
                WHEN excluded.notes IS NOT NULL AND excluded.notes != '' THEN excluded.notes
                ELSE unregistered_devices.notes
            END`,
        [normalized, clean(eventType || 'event') || 'event', number || null, payloadText || null, clean(notes) || null]
    );

    await db.run(
        `INSERT INTO unregistered_device_events (device_id, event_type, phone_number, payload)
         VALUES (?, ?, ?, ?)`,
        [normalized, clean(eventType || 'event') || 'event', number || null, rawPayloadText || null]
    );

    await db.run(
        `DELETE FROM unregistered_device_events
         WHERE device_id = ?
           AND id NOT IN (
               SELECT id
               FROM unregistered_device_events
               WHERE device_id = ?
               ORDER BY id DESC
               LIMIT 250
           )`,
        [normalized, normalized]
    );

    return true;
}

module.exports = {
    buildIdentityPayload,
    isRegisteredDevice,
    noteUnregisteredDevice
};
