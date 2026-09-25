'use strict';
/**
 * Webhook delivery service (SEC-02 / QUEUE-01 remediation).
 *
 * Delivery model:
 *  - Every delivery attempt goes through the durable `webhook_queue` table
 *    (one row per event delivery, settled by row id). In-memory timers only
 *    KICK a drain pass — they never deliver directly — so there is exactly one
 *    retry path and one settlement path.
 *  - Claiming is conditional (`status='pending' -> 'processing'` WHERE id), so
 *    overlapping drains / multiple workers cannot double-deliver.
 *  - Retries use escalating delays; exhausted rows are marked `failed`.
 *
 * Destination validation (SSRF):
 *  - https-only by default (WEBHOOK_ALLOW_HTTP=true permits http for local
 *    integrations, still blocked from private/link-local/loopback ranges
 *    unless WEBHOOK_ALLOW_PRIVATE=true).
 *  - Hostnames are resolved at delivery time; ALL resolved addresses must be
 *    public. The request pins the connection to the validated address so a
 *    racing DNS record cannot redirect it after validation.
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const dns = require('dns');
const { URL } = require('url');
const net = require('net');
const logger = require('../utils/logger');

const TIMEOUT_MS = 8000;
const RETRY_DELAYS = [5000, 30000, 300000]; // 5s, 30s, 5min
const MAX_BODY_BYTES = 256 * 1024;
const DRAIN_INTERVAL_MS = 60000;

function allowHttpOverride() {
    return String(process.env.WEBHOOK_ALLOW_HTTP || '').trim().toLowerCase() === 'true';
}
function allowPrivateOverride() {
    return String(process.env.WEBHOOK_ALLOW_PRIVATE || '').trim().toLowerCase() === 'true';
}

/** True when the address is not a public unicast address. */
function isPrivateAddress(address) {
    if (net.isIPv4(address)) {
        const [a, b] = address.split('.').map(Number);
        if (a === 0 || a === 10 || a === 127) return true;                 // this-network, private, loopback
        if (a === 169 && b === 254) return true;                            // link-local incl. 169.254.169.254
        if (a === 172 && b >= 16 && b <= 31) return true;                   // private
        if (a === 192 && b === 168) return true;                            // private
        if (a >= 224) return true;                                          // multicast + reserved
        return false;
    }
    const lower = String(address || '').toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true; // link-local / ULA
    if (lower.startsWith('ff')) return true;                                // multicast
    return false;
}

/** Static + DNS validation of a webhook destination. Throws on policy violation. */
async function assertDeliverableUrl(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { throw new Error('Invalid webhook URL'); }
    const isHttps = parsed.protocol === 'https:';
    if (!isHttps && !(parsed.protocol === 'http:' && allowHttpOverride())) {
        throw new Error('Webhook destination must use HTTPS');
    }
    const port = parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80);
    if (port !== (isHttps ? 443 : 80) && !(allowHttpOverride() && !isHttps && port === 80)) {
        throw new Error(`Webhook destination port ${port} is not allowed`);
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(hostname)) {
        if (isPrivateAddress(hostname) && !allowPrivateOverride()) {
            throw new Error('Webhook destination resolves to a private address');
        }
        return { parsed, hostname, pinnedAddress: hostname, family: net.isIPv6(hostname) ? 6 : 4 };
    }
    const records = await dns.promises.lookup(hostname, { all: true }).catch(() => []);
    if (!records.length) throw new Error('Webhook host does not resolve');
    const bad = records.find(record => isPrivateAddress(record.address));
    if (bad && !allowPrivateOverride()) {
        throw new Error('Webhook destination resolves to a private address');
    }
    return { parsed, hostname, pinnedAddress: records[0].address, family: records[0].family };
}

class WebhookService {
    constructor(app) {
        this.app = app;
        this._draining = false;
        this._queueInterval = setInterval(() => this._drain().catch(() => {}), DRAIN_INTERVAL_MS);
        this._queueInterval.unref();
    }

    get db() { return this.app?.locals?.db; }

    /** Fire an event: enqueue one durable row per matching hook, then kick a drain. */
    async fire(event, deviceId, payload) {
        if (!this.db) return;
        try {
            const hooks = await this.db.all(`SELECT * FROM webhooks WHERE is_active = 1`, []);
            let queued = 0;
            for (const hook of hooks) {
                const events = String(hook.events || '').split(',').map(e => e.trim());
                if (!events.includes(event) && !events.includes('*')) continue;
                if (hook.device_ids) {
                    let allowed;
                    try { allowed = JSON.parse(hook.device_ids); } catch { allowed = []; }
                    if (!Array.isArray(allowed) || !allowed.includes(deviceId)) continue;
                }
                await this.db.run(
                    `INSERT INTO webhook_queue (webhook_id, event_type, payload, attempts, max_attempts, next_retry_at, status)
                     VALUES (?, ?, ?, 0, ?, ?, 'pending')`,
                    [hook.id, event, JSON.stringify({ deviceId, payload }), RETRY_DELAYS.length, new Date().toISOString()]
                );
                queued += 1;
            }
            if (queued > 0) {
                // Kick: the durable queue is the single delivery path. The kick
                // only advances the drain, it never delivers directly.
                this._kickDrain();
            }
        } catch (err) {
            logger.error('webhookService.fire error:', err);
        }
    }

    _kickDrain() {
        clearTimeout(this._kickTimer);
        this._kickTimer = setTimeout(() => this._drain().catch(() => {}), 1000);
        if (this._kickTimer.unref) this._kickTimer.unref();
    }

    /** Conditionally claim due rows and deliver each exactly once. */
    async _drain() {
        if (!this.db || this._draining) return;
        this._draining = true;
        try {
            const due = await this.db.all(
                `SELECT wq.id AS queue_id, wq.webhook_id, wq.event_type, wq.payload, wq.attempts, wq.max_attempts
                 FROM webhook_queue wq
                 JOIN webhooks w ON wq.webhook_id = w.id AND w.is_active = 1
                 WHERE wq.status = 'pending' AND wq.next_retry_at <= datetime('now')
                 ORDER BY wq.id ASC
                 LIMIT 20`
            );
            for (const row of due) {
                const claim = await this.db.run(
                    `UPDATE webhook_queue SET status = 'processing', claimed_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND status = 'pending'`,
                    [row.queue_id]
                );
                if (!claim.changes) continue; // another drain claimed it
                await this._processRow(row);
            }
        } catch (err) {
            logger.error('webhook queue processor error:', err);
        } finally {
            this._draining = false;
        }
    }

    /** Deliver one claimed queue row and settle it by row id. */
    async _processRow(row) {
        let data;
        try { data = JSON.parse(row.payload) || {}; } catch { data = {}; }
        const hookRow = await this.db.get(`SELECT * FROM webhooks WHERE id = ?`, [row.webhook_id]).catch(() => null);
        if (!hookRow) {
            // Hook deleted while queued: settle the row as cancelled.
            await this.db.run(`DELETE FROM webhook_queue WHERE id = ?`, [row.queue_id]).catch(() => {});
            return;
        }
        const outcome = await this._deliver(hookRow, row.event_type, data.deviceId, data.payload, row.attempts);
        if (outcome.ok) {
            await this.db.run(`DELETE FROM webhook_queue WHERE id = ?`, [row.queue_id]).catch(() => {});
            await this.db.run(
                `UPDATE webhooks SET last_fired_at = CURRENT_TIMESTAMP, last_status = ? WHERE id = ?`,
                [outcome.status, hookRow.id]
            ).catch(() => {});
            return;
        }
        const attempts = Number(row.attempts || 0) + 1;
        const maxAttempts = Number(row.max_attempts || RETRY_DELAYS.length);
        if (attempts >= maxAttempts) {
            await this.db.run(
                `UPDATE webhook_queue SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`,
                [attempts, outcome.error, row.queue_id]
            ).catch(() => {});
            await this.db.run(
                `UPDATE webhooks SET last_fired_at = CURRENT_TIMESTAMP, last_status = ? WHERE id = ?`,
                [outcome.status || 0, hookRow.id]
            ).catch(() => {});
            logger.warn(`Webhook ${hookRow.id} (${row.event_type}) exhausted retries: ${outcome.error}`);
            return;
        }
        const delay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)];
        await this.db.run(
            `UPDATE webhook_queue SET status = 'pending', attempts = ?, next_retry_at = ?, last_error = ? WHERE id = ?`,
            [attempts, new Date(Date.now() + delay).toISOString(), outcome.error, row.queue_id]
        ).catch(() => {});
    }

    /**
     * Single POST attempt. Never retries by itself; returns the outcome so the
     * queue can settle the row.
     */
    async _deliver(hook, event, deviceId, payload, attempt = 0) {
        const body = JSON.stringify({
            event, device_id: deviceId, timestamp: new Date().toISOString(), data: payload
        });
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
            return { ok: false, status: 0, error: 'payload exceeds 256KB limit' };
        }
        const sig = hook.secret
            ? 'sha256=' + crypto.createHmac('sha256', hook.secret).update(body).digest('hex')
            : null;

        let target;
        try {
            target = await assertDeliverableUrl(hook.url);
        } catch (err) {
            return { ok: false, status: 0, error: err.message };
        }

        const lib = target.parsed.protocol === 'https:' ? https : http;
        const status = await new Promise((resolve) => {
            const req = lib.request({
                hostname: target.hostname,
                port: target.parsed.port ? Number(target.parsed.port) : (target.parsed.protocol === 'https:' ? 443 : 80),
                path: target.parsed.pathname + target.parsed.search,
                method: 'POST',
                // Pin the connection to the address validated above so a racing
                // DNS change cannot redirect the delivery after validation.
                lookup: (hostname, options, callback) => {
                    callback(null, target.pinnedAddress, target.family);
                },
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'X-ESP32-Event': event,
                    'X-ESP32-DeviceId': deviceId || '',
                    'X-Webhook-Attempt': String(attempt + 1),
                    ...(sig ? { 'X-Hub-Signature-256': sig } : {})
                },
                timeout: TIMEOUT_MS
            }, (res) => { res.resume(); resolve(res.statusCode); });
            req.on('error', () => resolve(0));
            req.on('timeout', () => { req.destroy(); resolve(0); });
            req.write(body);
            req.end();
        }).catch(() => 0);

        if (status >= 200 && status < 300) {
            logger.info(`Webhook ${hook.id} (${event}) delivered: HTTP ${status}`);
            return { ok: true, status };
        }
        logger.warn(`Webhook ${hook.id} (${event}) failed: HTTP ${status || 'timeout/error'}`);
        return { ok: false, status, error: status ? `HTTP ${status}` : 'timeout or connection error' };
    }

    /** Backwards-compatible alias used by the test endpoint. */
    async deliverOnce(hook, event, deviceId, payload) {
        return this._deliver(hook, event, deviceId, payload, 0);
    }
}

module.exports = WebhookService;
module.exports.assertDeliverableUrl = assertDeliverableUrl;
module.exports.isPrivateAddress = isPrivateAddress;
