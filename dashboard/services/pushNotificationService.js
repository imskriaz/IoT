'use strict';

const fs = require('fs');
const http2 = require('http2');
const crypto = require('crypto');
const logger = require('../utils/logger');

function base64UrlEncode(value) {
    return Buffer.from(value)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

class PushNotificationService {
    constructor(options = {}) {
        this.app = options.app || global.app || null;
        this.fetchFn = options.fetchFn || globalThis.fetch?.bind(globalThis) || null;
        this.http2Module = options.http2Module || http2;
        this._apnsJwt = null;
        this._apnsJwtIssuedAt = 0;
    }

    _db() {
        return this.app?.locals?.db || global.app?.locals?.db || null;
    }

    async notifyLinkedDevices(targetDeviceId, payload = {}) {
        const db = this._db();
        if (!db || !targetDeviceId) {
            return { sent: 0, failed: 0, skipped: 0, results: [] };
        }

        const rows = await db.all(
            `SELECT dpt.push_token, dpt.platform, dpt.app_id, pdl.phone_device_id
             FROM phone_device_links pdl
             INNER JOIN device_push_tokens dpt ON dpt.device_id = pdl.phone_device_id
             WHERE pdl.target_device_id = ? AND dpt.is_active = 1`,
            [targetDeviceId]
        );

        return this.sendToTokens(rows, payload);
    }

    async sendToTokens(rows = [], payload = {}) {
        const dedupedRows = [];
        const seen = new Set();

        for (const row of rows || []) {
            const token = String(row?.push_token || '').trim();
            if (!token || seen.has(token)) continue;
            seen.add(token);
            dedupedRows.push({ ...row, push_token: token });
        }

        const results = [];
        for (const row of dedupedRows) {
            results.push(await this.sendToToken(row, payload));
        }

        return {
            sent: results.filter((entry) => entry.ok).length,
            failed: results.filter((entry) => entry.ok === false).length,
            skipped: results.filter((entry) => entry.skipped).length,
            results
        };
    }

    async sendToToken(row, payload = {}) {
        const provider = this._selectProvider(row);
        if (!provider) {
            return { ok: false, skipped: true, provider: 'none', token: row?.push_token || null };
        }

        try {
            const normalized = this._normalizePayload(payload);
            if (provider === 'expo') {
                await this._sendExpo(row.push_token, normalized);
            } else if (provider === 'fcm') {
                await this._sendFcm(row.push_token, normalized);
            } else if (provider === 'apns') {
                await this._sendApns(row.push_token, normalized);
            }

            return { ok: true, skipped: false, provider, token: row.push_token };
        } catch (error) {
            logger.error(`pushNotificationService: ${provider} send failed`, error.message);
            return {
                ok: false,
                skipped: false,
                provider,
                token: row?.push_token || null,
                error: error.message
            };
        }
    }

    _selectProvider(row = {}) {
        const token = String(row.push_token || '').trim();
        const platform = String(row.platform || '').toLowerCase();
        const appId = String(row.app_id || '').toLowerCase();

        if (!token) return null;
        if (token.startsWith('ExpoPushToken[') || token.startsWith('ExponentPushToken[') || appId.includes('expo')) {
            return this.fetchFn ? 'expo' : null;
        }
        if (platform === 'ios' || /^[a-f0-9]{64,}$/i.test(token)) {
            return this._hasApnsConfig() ? 'apns' : null;
        }
        if (platform === 'android' || this._hasFcmConfig()) {
            return this._hasFcmConfig() && this.fetchFn ? 'fcm' : null;
        }

        return null;
    }

    _normalizePayload(payload = {}) {
        const title = String(payload.title || 'IoT Dashboard').trim();
        const body = String(payload.body || title).trim();
        const data = payload.data && typeof payload.data === 'object' ? payload.data : {};

        return {
            title,
            body,
            data,
            sound: payload.sound || 'default'
        };
    }

    _hasFcmConfig() {
        return Boolean(process.env.FCM_SERVER_KEY || process.env.FIREBASE_SERVER_KEY);
    }

    _hasApnsConfig() {
        return Boolean(
            process.env.APNS_TEAM_ID
            && process.env.APNS_KEY_ID
            && (process.env.APNS_PRIVATE_KEY || process.env.APNS_PRIVATE_KEY_PATH)
            && (process.env.APNS_BUNDLE_ID || process.env.APNS_TOPIC)
        );
    }

    async _sendExpo(token, payload) {
        if (!this.fetchFn) throw new Error('Fetch is not available for Expo push');

        const response = await this.fetchFn('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                to: token,
                title: payload.title,
                body: payload.body,
                data: payload.data,
                sound: payload.sound
            })
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Expo push failed (${response.status}): ${text}`);
        }
    }

    async _sendFcm(token, payload) {
        if (!this.fetchFn) throw new Error('Fetch is not available for FCM push');

        const serverKey = process.env.FCM_SERVER_KEY || process.env.FIREBASE_SERVER_KEY;
        if (!serverKey) throw new Error('FCM server key is not configured');

        const response = await this.fetchFn('https://fcm.googleapis.com/fcm/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `key=${serverKey}`
            },
            body: JSON.stringify({
                to: token,
                priority: 'high',
                notification: {
                    title: payload.title,
                    body: payload.body
                },
                data: payload.data
            })
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`FCM push failed (${response.status}): ${text}`);
        }
    }

    async _sendApns(token, payload) {
        const teamId = process.env.APNS_TEAM_ID;
        const keyId = process.env.APNS_KEY_ID;
        const topic = process.env.APNS_TOPIC || process.env.APNS_BUNDLE_ID;
        if (!teamId || !keyId || !topic) {
            throw new Error('APNs credentials are not configured');
        }

        const jwt = this._apnsAuthToken();
        const host = process.env.APNS_USE_PRODUCTION === 'true'
            ? 'https://api.push.apple.com'
            : 'https://api.sandbox.push.apple.com';

        await new Promise((resolve, reject) => {
            const client = this.http2Module.connect(host);
            client.on('error', reject);

            const request = client.request({
                ':method': 'POST',
                ':path': `/3/device/${token}`,
                'authorization': `bearer ${jwt}`,
                'apns-topic': topic,
                'apns-push-type': 'alert',
                'content-type': 'application/json'
            });

            let responseBody = '';
            request.setEncoding('utf8');
            request.on('response', (headers) => {
                const status = Number(headers[':status'] || 0);
                request.on('data', (chunk) => { responseBody += chunk; });
                request.on('end', () => {
                    client.close();
                    if (status >= 200 && status < 300) {
                        resolve();
                    } else {
                        reject(new Error(`APNs push failed (${status}): ${responseBody || 'unknown error'}`));
                    }
                });
            });
            request.on('error', (error) => {
                client.close();
                reject(error);
            });

            request.end(JSON.stringify({
                aps: {
                    alert: {
                        title: payload.title,
                        body: payload.body
                    },
                    sound: payload.sound
                },
                data: payload.data
            }));
        });
    }

    _apnsAuthToken() {
        const now = Math.floor(Date.now() / 1000);
        if (this._apnsJwt && (now - this._apnsJwtIssuedAt) < 3000) {
            return this._apnsJwt;
        }

        const keyId = process.env.APNS_KEY_ID;
        const teamId = process.env.APNS_TEAM_ID;
        const privateKey = process.env.APNS_PRIVATE_KEY
            || (process.env.APNS_PRIVATE_KEY_PATH ? fs.readFileSync(process.env.APNS_PRIVATE_KEY_PATH, 'utf8') : null);

        if (!keyId || !teamId || !privateKey) {
            throw new Error('APNs JWT credentials are incomplete');
        }

        const header = base64UrlEncode(JSON.stringify({ alg: 'ES256', kid: keyId }));
        const claims = base64UrlEncode(JSON.stringify({ iss: teamId, iat: now }));
        const signer = crypto.createSign('sha256');
        signer.update(`${header}.${claims}`);
        signer.end();
        const signature = signer.sign(privateKey);

        this._apnsJwt = `${header}.${claims}.${base64UrlEncode(signature)}`;
        this._apnsJwtIssuedAt = now;
        return this._apnsJwt;
    }
}

const pushNotificationService = new PushNotificationService();

module.exports = pushNotificationService;
module.exports.PushNotificationService = PushNotificationService;
