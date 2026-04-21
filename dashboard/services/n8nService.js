'use strict';
/**
 * n8n integration service.
 * Forwards device events to an n8n workflow webhook URL.
 *
 * Settings (stored in the `settings` table):
 *   n8n_enabled      — "true" / "false"
 *   n8n_webhook_url  — full URL, e.g. http://n8n.local:5678/webhook/esp32
 *   n8n_events       — JSON array of event names to forward, e.g. ["sms.incoming","gps.location"]
 *                      Empty array or missing = all events forwarded.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const logger = require('../utils/logger');

const TIMEOUT_MS = 8000;

class N8nService {
    constructor(app) {
        this.app = app;
    }

    get db() {
        return this.app?.locals?.db;
    }

    /** Load n8n settings from DB (cached for 30 s to avoid constant queries). */
    async _settings() {
        const now = Date.now();
        if (this._cache && now - this._cacheTime < 30_000) return this._cache;

        if (!this.db) return null;
        const rows = await this.db.all(
            `SELECT key, value FROM settings WHERE key IN ('n8n_enabled','n8n_webhook_url','n8n_events')`
        ).catch(() => []);

        const map = {};
        for (const r of rows) map[r.key] = r.value;
        this._cache = map;
        this._cacheTime = now;
        return map;
    }

    /** Bust the config cache (call after settings change). */
    invalidateCache() {
        this._cache = null;
    }

    /**
     * Forward an event to n8n if enabled and URL is configured.
     * @param {string} event    e.g. 'sms.incoming'
     * @param {string} deviceId
     * @param {object} payload
     */
    async fire(event, deviceId, payload) {
        try {
            const cfg = await this._settings();
            if (!cfg) return;
            if (cfg.n8n_enabled !== 'true') return;
            if (!cfg.n8n_webhook_url) return;

            // Event filter — if n8n_events is a non-empty array, only forward matching events
            if (cfg.n8n_events) {
                let allowed;
                try { allowed = JSON.parse(cfg.n8n_events); } catch { allowed = []; }
                if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(event)) return;
            }

            this._deliver(cfg.n8n_webhook_url, event, deviceId, payload).catch(() => {});
        } catch (err) {
            logger.error('n8nService.fire error:', err.message);
        }
    }

    async _deliver(webhookUrl, event, deviceId, payload) {
        let parsed;
        try { parsed = new URL(webhookUrl); } catch {
            logger.warn(`n8n: invalid webhook URL: ${webhookUrl}`);
            return;
        }

        const body = JSON.stringify({
            event,
            device_id: deviceId,
            timestamp: new Date().toISOString(),
            data: payload
        });

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
                    'X-Source': 'iot-manager',
                    'X-Event': event
                },
                timeout: TIMEOUT_MS
            }, (res) => { res.resume(); resolve(res.statusCode); });
            req.on('error', () => resolve(0));
            req.on('timeout', () => { req.destroy(); resolve(0); });
            req.write(body);
            req.end();
        });

        if (status >= 200 && status < 300) {
            logger.debug(`n8n (${event}) → HTTP ${status}`);
        } else {
            logger.warn(`n8n (${event}) → HTTP ${status || 'timeout/error'}`);
        }
    }
}

module.exports = N8nService;
