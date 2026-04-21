const { DEFAULT_DEVICE_ID } = require('../config/device');

function normalizeDeviceId(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
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
    const requestScoped = normalizeDeviceId(
        req?.body?.deviceId ||
        req?.body?.device ||
        req?.query?.deviceId ||
        req?.query?.device ||
        req?.params?.deviceId ||
        req?.params?.device
    );
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
