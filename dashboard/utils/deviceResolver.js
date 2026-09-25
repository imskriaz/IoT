const { DEFAULT_DEVICE_ID } = require('../config/device');

function normalizeDeviceId(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

// Return all explicitly supplied selectors. A request containing two different
// selectors is ambiguous and must never silently choose the first one.
function explicitDeviceIds(req) {
    const values = [
        req?.params?.deviceId, req?.params?.device_id, req?.params?.device,
        req?.body?.deviceId, req?.body?.device_id, req?.body?.device,
        req?.query?.deviceId, req?.query?.device_id, req?.query?.device,
        req?.headers?.['x-device-id'], req?.headers?.['x-device_id']
    ].map(normalizeDeviceId).filter(Boolean);
    return [...new Set(values)];
}

function getSingleOnlineDeviceId() {
    const devices = global.modemService?.getAllDevices?.();
    if (!Array.isArray(devices)) return '';

    const online = devices
        .map(device => ({
            id: normalizeDeviceId(device?.id),
            online: !!device?.online
        }))
        .filter(device => device.online && device.id);

    if (online.length !== 1) return '';
    return online[0].id;
}

function isDeviceOnline(deviceId) {
    const normalized = normalizeDeviceId(deviceId);
    if (!normalized) return false;
    return !!global.modemService?.isDeviceOnline?.(normalized);
}

function resolveDeviceId(req, fallback = DEFAULT_DEVICE_ID) {
    // Middleware resolves and authorizes once. Discovery/session state can change
    // while assignment storage is awaited; handlers must keep that same target.
    const authorized = normalizeDeviceId(req?.authorizedDeviceId);
    if (authorized) return authorized;

    const requestScoped = explicitDeviceIds(req)[0] || '';
    if (requestScoped) return requestScoped;

    const sessionDeviceId = normalizeDeviceId(req?.session?.deviceId);
    if (sessionDeviceId) {
        return sessionDeviceId;
    }

    const fallbackDeviceId = normalizeDeviceId(fallback);
    if (fallbackDeviceId && isDeviceOnline(fallbackDeviceId)) {
        return fallbackDeviceId;
    }

    const onlineFallback = getSingleOnlineDeviceId();
    if (onlineFallback) {
        return onlineFallback;
    }

    return fallbackDeviceId;
}

module.exports = { resolveDeviceId };
module.exports.normalizeDeviceId = normalizeDeviceId;
module.exports.explicitDeviceIds = explicitDeviceIds;
