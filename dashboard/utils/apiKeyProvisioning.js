'use strict';

const crypto = require('crypto');

function generateApiKey(prefix = 'edk_') {
    const normalizedPrefix = String(prefix || 'edk_').trim() || 'edk_';
    return `${normalizedPrefix}${crypto.randomBytes(32).toString('hex')}`;
}

function hashApiKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

async function createDeviceProvisioningApiKey(db, options = {}) {
    const userId = Number.parseInt(options.userId, 10);
    const deviceId = String(options.deviceId || '').trim();
    const name = String(options.name || 'Device provisioning').trim();
    const scopes = String(options.scopes || 'write').trim() || 'write';
    const rateLimitRpm = Number.parseInt(options.rateLimitRpm, 10) || 120;
    const apiKeyPrefix = String(options.apiKeyPrefix || 'edk_').trim() || 'edk_';

    if (!db || !userId || !deviceId) {
        return { key: '', name: '' };
    }

    const deviceScope = JSON.stringify([deviceId]);
    await db.run(
        `DELETE FROM api_keys
         WHERE user_id = ?
           AND device_ids = ?
           AND scopes = ?
           AND COALESCE(rate_limit_rpm, 0) = ?
           AND (
                name = ?
                OR name LIKE 'Android %'
                OR name LIKE '% recovery'
           )`,
        [userId, deviceScope, scopes, rateLimitRpm, name]
    );

    const key = generateApiKey(apiKeyPrefix);
    const keyPrefix = key.substring(0, 12);
    await db.run(
        `INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, device_ids, expires_at, rate_limit_rpm)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
        [userId, name, hashApiKey(key), keyPrefix, scopes, deviceScope, rateLimitRpm]
    );

    return { key, name, keyPrefix };
}

module.exports = {
    createDeviceProvisioningApiKey,
    generateApiKey,
    hashApiKey
};
