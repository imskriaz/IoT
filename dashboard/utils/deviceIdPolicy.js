'use strict';

function clean(value) {
    return String(value || '').trim();
}

function deviceKindFromPayload(payload = {}) {
    const tokens = [
        payload.bridge_type,
        payload.type,
        payload.model,
        payload.board,
        payload.platform
    ].map(value => clean(value).toLowerCase()).filter(Boolean);

    if (tokens.some(token => token === 'android' || token === 'android-sms-bridge' || token.startsWith('android-'))) {
        return 'android';
    }
    if (tokens.some(token => token === 'esp32' || token === 'esp32-s3' || token.startsWith('esp32') || token.includes('a7670'))) {
        return 'esp';
    }
    return '';
}

function validateDeviceIdPrefix(deviceId, payload = {}) {
    const id = clean(deviceId).toLowerCase();
    const kind = deviceKindFromPayload(payload);

    if (kind === 'android' && !id.startsWith('android-')) {
        return 'Android device IDs must start with android-';
    }
    if (kind === 'esp' && !id.startsWith('esp-')) {
        return 'ESP device IDs must start with esp-';
    }
    return '';
}

module.exports = {
    deviceKindFromPayload,
    validateDeviceIdPrefix
};
