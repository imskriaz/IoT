'use strict';
/**
 * Webhook delivery service.
 * Retry queue is persisted in webhook_queue DB table — survives server restarts.
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const logger = require('../utils/logger');

const TIMEOUT_MS = 8000;
const RETRY_DELAYS = [5000, 30000, 300000]; // 5s, 30s, 5min

class WebhookService {
    constructor(app) {
        this.app = app;
        this._queueInterval = setInterval(() => this._processQueue().catch(() => {}), 60000);
        this._queueInterval.unref();
    }

    get db() { return this.app?.locals?.db; }

    async fire(event, deviceId, payload) {
        if (!this.db) return;
        try {
            const hooks = await this.db.all(`SELECT * FROM webhooks WHERE is_active = 1`, []);
            for (const hook of hooks) {
                const events = (hook.events || '').split(',').map(e => e.trim());
                if (!events.includes(event) && !events.includes('*')) continue;
                if (hook.device_ids) {
                    let allowed;
                    try { allowed = JSON.parse(hook.device_ids); } catch { allowed = []; }
                    if (!allowed.includes(deviceId)) continue;
                }
                this._deliver(hook, event, deviceId, payload, { attempt: 0 }).catch(() => {});
            }
        } catch (err) {
            logger.error('webhookService.fire error:', err);
        }
    }

    async _deliver(hook, event, deviceId, payload, options = {}) {
        const body = JSON.stringify({
            event, device_id: deviceId, timestamp: new Date().toISOString(), data: payload
        });
        const sig = hook.secret
            ? 'sha256=' + crypto.createHmac('sha256', hook.secret).update(body).digest('hex')
            : null;
        let parsed;
        try { parsed = new URL(hook.url); } catch {
            logger.warn(`Webhook ${hook.id} has invalid URL: ${hook.url}`);
            return;
        }
        const lib = parsed.protocol === 'https:' ? https : http;
        const status = await new Promise((resolve) => {
            const req = lib.request({
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'X-ESP32-Event': event,
                    'X-ESP32-DeviceId': deviceId,
                    ...(sig ? { 'X-Hub-Signature-256': sig } : {})
                },
                timeout: TIMEOUT_MS
            }, (res) => { res.resume(); resolve(res.statusCode); });
            req.on('error', () => resolve(0));
            req.on('timeout', () => { req.destroy(); resolve(0); });
            req.write(body);
            req.end();
        });

        if (this.db) {
            this.db.run(
                `UPDATE webhooks SET last_fired_at = CURRENT_TIMESTAMP, last_status = ? WHERE id = ?`,
                [status, hook.id]
            ).catch(() => {});
        }

        if (status >= 200 && status < 300) {
            logger.info(`Webhook ${hook.id} (${event}) delivered: HTTP ${status}`);
            if (this.db) {
                this.db.run(
                    `DELETE FROM webhook_queue WHERE webhook_id = ? AND event_type = ? AND status IN ('pending','processing')`,
                    [hook.id, event]
                ).catch(() => {});
            }
        } else {
            logger.warn(`Webhook ${hook.id} (${event}) failed: HTTP ${status || 'timeout/error'}`);
            const attempt = options?.attempt ?? 0;
            if (attempt < RETRY_DELAYS.length) {
                const delay = RETRY_DELAYS[attempt];
                const nextRetry = new Date(Date.now() + delay).toISOString();
                logger.info(`Webhook ${hook.id} queuing retry ${attempt + 1}/${RETRY_DELAYS.length} in ${delay / 1000}s`);
                if (this.db) {
                    this.db.run(
                        `INSERT INTO webhook_queue (webhook_id, event_type, payload, attempts, max_attempts, next_retry_at, status)
                         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
                        [hook.id, event, JSON.stringify({ deviceId, payload }), attempt + 1, RETRY_DELAYS.length, nextRetry]
                    ).catch(() => {});
                }
                const timer = setTimeout(() => {
                    this._deliver(hook, event, deviceId, payload, { attempt: attempt + 1 }).catch(() => {});
                }, delay);
                timer.unref();
            } else {
                logger.warn(`Webhook ${hook.id} (${event}) exhausted all retries`);
                if (this.db) {
                    this.db.run(
                        `UPDATE webhook_queue SET status = 'failed', last_error = 'max retries exceeded'
                         WHERE webhook_id = ? AND event_type = ? AND status IN ('pending','processing')`,
                        [hook.id, event]
                    ).catch(() => {});
                }
            }
        }
    }

    async _processQueue() {
        if (!this.db) return;
        try {
            const due = await this.db.all(
                `SELECT wq.*, w.url, w.secret FROM webhook_queue wq
                 JOIN webhooks w ON wq.webhook_id = w.id
                 WHERE wq.status = 'pending' AND wq.next_retry_at <= datetime('now')
                 LIMIT 20`
            );
            for (const row of due) {
                let data;
                try { data = JSON.parse(row.payload); } catch { data = {}; }
                const hook = { id: row.webhook_id, url: row.url, secret: row.secret };
                await this.db.run(`UPDATE webhook_queue SET status = 'processing' WHERE id = ?`, [row.id]).catch(() => {});
                this._deliver(hook, row.event_type, data.deviceId, data.payload, { attempt: row.attempts })
                    .then(() => this.db.run(`DELETE FROM webhook_queue WHERE id = ?`, [row.id]).catch(() => {}))
                    .catch(() => this.db.run(`UPDATE webhook_queue SET status = 'pending' WHERE id = ?`, [row.id]).catch(() => {}));
            }
        } catch (err) {
            logger.error('webhook queue processor error:', err);
        }
    }
}

module.exports = WebhookService;
