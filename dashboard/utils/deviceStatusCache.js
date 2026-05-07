'use strict';

const DEFAULT_DEVICE_STATUS_CACHE_TTL_MS = 2 * 60 * 1000;

function normalizeDeviceId(deviceId) {
    return String(deviceId || '').trim();
}

function parseIsoTimestamp(value) {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeCacheTtl(ttlMs) {
    const parsed = Number(ttlMs);
    return Number.isFinite(parsed) && parsed > 0
        ? parsed
        : DEFAULT_DEVICE_STATUS_CACHE_TTL_MS;
}

async function persistDeviceStatusCache(db, deviceId, payload = {}) {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    if (!db || typeof db.run !== 'function' || !normalizedDeviceId || !payload || typeof payload !== 'object') {
        return false;
    }

    await db.run(
        `INSERT INTO device_status_cache (device_id, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
             payload_json = excluded.payload_json,
             updated_at = excluded.updated_at`,
        [
            normalizedDeviceId,
            JSON.stringify(payload),
            new Date().toISOString()
        ]
    );
    return true;
}

async function readFreshDeviceStatusCache(db, deviceId, options = {}) {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    if (!db || typeof db.get !== 'function' || !normalizedDeviceId) {
        return null;
    }

    const row = await db.get(
        `SELECT payload_json, updated_at
         FROM device_status_cache
         WHERE device_id = ?`,
        [normalizedDeviceId]
    );
    if (!row?.payload_json) return null;

    const updatedAtMs = parseIsoTimestamp(row.updated_at);
    const ageMs = updatedAtMs ? Date.now() - updatedAtMs : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(ageMs) || ageMs > normalizeCacheTtl(options.ttlMs)) {
        return null;
    }

    let payload;
    try {
        payload = JSON.parse(row.payload_json);
    } catch (_) {
        return null;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
    }

    return {
        ...payload,
        device_id: payload.device_id || normalizedDeviceId,
        cached_status: true,
        cached_status_age_ms: Math.max(0, ageMs),
        cached_status_updated_at: row.updated_at
    };
}

async function hydrateDeviceStatusFromCache(db, modemService, deviceId, options = {}) {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    if (!normalizedDeviceId || !modemService || typeof modemService.updateDeviceStatus !== 'function') {
        return null;
    }

    const current = typeof modemService.getDeviceStatus === 'function'
        ? modemService.getDeviceStatus(normalizedDeviceId)
        : null;
    if (current?.online === true) {
        return current;
    }

    const cached = await readFreshDeviceStatusCache(db, normalizedDeviceId, options);
    if (!cached) {
        return current || null;
    }

    modemService.updateDeviceStatus(normalizedDeviceId, cached);
    return typeof modemService.getDeviceStatus === 'function'
        ? modemService.getDeviceStatus(normalizedDeviceId)
        : cached;
}

module.exports = {
    DEFAULT_DEVICE_STATUS_CACHE_TTL_MS,
    hydrateDeviceStatusFromCache,
    persistDeviceStatusCache,
    readFreshDeviceStatusCache
};
