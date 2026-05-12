'use strict';

function clean(value) {
    return String(value || '').trim();
}

function normalizeTypeToken(value) {
    return clean(value).toLowerCase();
}

function isHttpSmsDeviceLike(...values) {
    return values
        .flatMap(value => {
            if (!value || typeof value !== 'object') return [value];
            return [
                value.type,
                value.deviceType,
                value.device_type,
                value.board,
                value.model,
                value.bridge,
                value.bridge_type,
                value.app,
                value.platform,
                value.id,
                value.device_id
            ];
        })
        .map(normalizeTypeToken)
        .filter(Boolean)
        .some(token => (
            token === 'httpsms'
            || token === 'httpsms-bridge'
            || token.includes('httpsms')
            || (token.includes('http') && token.includes('sms'))
        ));
}

function buildHttpSmsStatusSnapshot(row = {}) {
    const deviceId = clean(row.id || row.device_id);
    const simNumber = clean(row.last_sim_number || row.sim_number || row.phone_number);
    const online = normalizeTypeToken(row.status) === 'online';
    const lastSeen = row.last_seen || row.last_seen_at || row.updated_at || null;

    return {
        deviceId,
        device_id: deviceId,
        id: deviceId,
        online,
        statusFresh: online,
        bridge_transport: 'http',
        transport_mode: 'http',
        active_path: online ? 'http' : 'offline',
        activePath: online ? 'http' : 'offline',
        app: 'httpSMS',
        platform: 'httpSMS',
        type: 'httpsms-bridge',
        model: 'httpsms-bridge',
        network: 'HTTP API',
        operator: 'httpSMS',
        simNumber: simNumber || null,
        subscriberNumber: simNumber || null,
        sim: simNumber ? {
            number: simNumber,
            simNumber,
            subscriberNumber: simNumber,
            slot: Number.isInteger(Number(row.slot_index)) ? Number(row.slot_index) : 0
        } : null,
        mqtt: {
            connected: false,
            configured: false,
            subscribed: false
        },
        transport: {
            mqttCommandAccepting: false,
            reason: 'http_sms_lane'
        },
        lastSeen,
        last_seen: lastSeen
    };
}

async function readHttpSmsStatusSnapshot(db, deviceId) {
    const normalizedDeviceId = clean(deviceId);
    if (!db?.get || !normalizedDeviceId) return null;

    const row = await db.get(
        `SELECT d.id, d.type, d.status, d.last_seen,
                p.board, p.last_sim_number,
                s.slot_index, s.sim_number, s.updated_at AS sim_updated_at
         FROM devices d
         LEFT JOIN device_profiles p ON p.device_id = d.id
         LEFT JOIN sims s ON s.device_id = d.id
         WHERE d.id = ?
         ORDER BY s.slot_index ASC
         LIMIT 1`,
        [normalizedDeviceId]
    );

    if (!row || !isHttpSmsDeviceLike(row)) return null;
    return buildHttpSmsStatusSnapshot({
        ...row,
        last_seen: row.last_seen || row.sim_updated_at
    });
}

module.exports = {
    buildHttpSmsStatusSnapshot,
    isHttpSmsDeviceLike,
    readHttpSmsStatusSnapshot
};
