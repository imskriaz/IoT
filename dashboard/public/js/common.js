/**
 * common.js — Shared utility functions loaded on every page after main.js.
 * Exposes helpers as window globals so all page-specific scripts can use them
 * without duplicating the implementations.
 */

(function () {
    'use strict';

    // ==================== HTML ESCAPING ====================

    /**
     * Escape a string for safe insertion into HTML content or attribute values.
     * Returns an empty string for null/undefined.
     */
    function escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // ==================== FORMATTING ====================

    /**
     * Format a byte count as a human-readable string (B / KB / MB / GB / TB).
     */
    function formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Format a duration in seconds as MM:SS.
     */
    function formatDuration(seconds) {
        if (!seconds || seconds === 0) return '--:--';
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    /**
     * Format a date string into a locale-aware display string.
     * Falls back to the raw value if parsing fails.
     */
    function formatDate(dateStr) {
        if (!dateStr) return '-';
        try {
            return window.formatDashboardDateTime
                ? window.formatDashboardDateTime(dateStr)
                : new Date(dateStr).toLocaleString();
        } catch (e) {
            return dateStr;
        }
    }

    // ==================== DEBOUNCE ====================

    /**
     * Returns a debounced version of func that delays invoking it until after
     * `wait` milliseconds have elapsed since the last call.
     */
    function debounce(func, wait) {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    // ==================== PAGINATION ====================

    /**
     * Render a Bootstrap pagination control.
     *
     * @param {string} containerId  - ID of the <ul class="pagination"> element
     * @param {number} currentPage  - 1-based current page number
     * @param {number} totalPages   - total number of pages
     * @param {Function} loadFn     - called with the page number when a link is clicked
     */
    function renderPagination(containerId, currentPage, totalPages, loadFn) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (totalPages <= 1) {
            container.innerHTML = '';
            return;
        }

        let html = `
            <li class="page-item ${currentPage === 1 ? 'disabled' : ''}">
                <a class="page-link" href="#" data-page="${currentPage - 1}" aria-label="Previous">
                    <span aria-hidden="true">&laquo;</span>
                </a>
            </li>
        `;

        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
                html += `
                    <li class="page-item ${i === currentPage ? 'active' : ''}">
                        <a class="page-link" href="#" data-page="${i}">${i}</a>
                    </li>
                `;
            } else if (i === currentPage - 3 || i === currentPage + 3) {
                html += `<li class="page-item disabled"><span class="page-link">&hellip;</span></li>`;
            }
        }

        html += `
            <li class="page-item ${currentPage === totalPages ? 'disabled' : ''}">
                <a class="page-link" href="#" data-page="${currentPage + 1}" aria-label="Next">
                    <span aria-hidden="true">&raquo;</span>
                </a>
            </li>
        `;

        container.innerHTML = html;

        // Attach click handlers using delegation (avoids inline onclick)
        container.querySelectorAll('.page-link[data-page]').forEach(link => {
            link.addEventListener('click', function (e) {
                e.preventDefault();
                const page = parseInt(this.dataset.page);
                if (!isNaN(page) && page >= 1 && page <= totalPages) {
                    loadFn(page);
                }
            });
        });
    }

    // ==================== TOAST ====================

    /**
     * Show a toast notification. Delegates to window.showToast (defined in
     * main.js) if available; otherwise falls back to alert().
     */
    function showToast(message, type) {
        if (typeof window.showToast === 'function' && window.showToast !== showToast) {
            window.showToast(message, type || 'info');
        } else {
            alert(message);
        }
    }

    // ==================== MQTT WAIT FEEDBACK ====================

    /**
     * Shows progressive status text on a button while waiting for a slow MQTT command.
     * Returns a cancel function that restores the button to its original state.
     *
     * Usage:
     *   const cancel = mqttWaitFeedback(btn, labelEl);
     *   fetch(...).finally(cancel);
     *
     * @param {HTMLElement} btn       - The button to update (spinner should already be shown)
     * @param {HTMLElement} [labelEl] - Optional separate label element; if omitted, btn.lastChild text is updated
     */
    function mqttWaitFeedback(btn, labelEl) {
        const stages = [
            { after: 4000,  text: 'Waiting for device…' },
            { after: 15000, text: 'Device is responding…' },
            { after: 35000, text: 'Still waiting (up to 60s)…' }
        ];

        // Find the text node to update
        function setText(t) {
            if (labelEl) {
                labelEl.textContent = t;
            } else {
                // Find last text node inside button
                const nodes = Array.from(btn.childNodes);
                const textNode = nodes.reverse().find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
                if (textNode) textNode.textContent = ' ' + t;
            }
        }

        const origTexts = labelEl
            ? labelEl.textContent
            : (() => {
                const nodes = Array.from(btn.childNodes);
                const tn = nodes.reverse().find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
                return tn ? tn.textContent : null;
            })();

        const timers = stages.map(s => setTimeout(() => setText(s.text), s.after));

        return function cancel() {
            timers.forEach(clearTimeout);
            if (origTexts !== null) {
                if (labelEl) labelEl.textContent = origTexts;
                else {
                    const nodes = Array.from(btn.childNodes);
                    const tn = nodes.reverse().find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
                    if (tn) tn.textContent = origTexts;
                }
            }
        };
    }

    // ==================== TAB URL SYNC ====================

    function getTabUrlParamName(tablist, index, total) {
        const explicit = String(tablist?.dataset?.tabUrlParam || '').trim();
        if (explicit) return explicit;
        if (total <= 1) return 'tab';
        const id = String(tablist?.id || '').trim();
        return id || `tab${index + 1}`;
    }

    function getTabUrlValue(tabEl) {
        const explicit = String(tabEl?.dataset?.tabUrl || '').trim();
        if (explicit) return explicit;

        const target = String(tabEl?.getAttribute('data-bs-target') || tabEl?.getAttribute('href') || '').trim();
        if (target.startsWith('#') && target.length > 1) {
            return target.slice(1);
        }

        const id = String(tabEl?.id || '').trim();
        return id ? id.replace(/-tab$/i, '') : '';
    }

    function findTabByUrlValue(tabs, value) {
        const wanted = String(value || '').trim().toLowerCase();
        if (!wanted) return null;

        return tabs.find((tabEl) => {
            const candidates = [
                getTabUrlValue(tabEl),
                tabEl?.id,
                String(tabEl?.getAttribute('data-bs-target') || '').replace(/^#/, '')
            ];

            return candidates.some((candidate) => String(candidate || '').trim().toLowerCase() === wanted);
        }) || null;
    }

    function syncBootstrapTabsWithUrl(root = document) {
        if (typeof bootstrap === 'undefined' || !bootstrap.Tab) return;

        const tablists = Array.from(root.querySelectorAll('.nav-tabs[role="tablist"]'));
        if (!tablists.length) return;

        tablists.forEach((tablist, index) => {
            if (tablist.dataset.urlSynced === 'true') return;
            tablist.dataset.urlSynced = 'true';

            const tabs = Array.from(tablist.querySelectorAll('[data-bs-toggle="tab"]'));
            if (!tabs.length) return;

            const paramName = getTabUrlParamName(tablist, index, tablists.length);
            const applyFromUrl = () => {
                const url = new URL(window.location.href);
                const targetValue = url.searchParams.get(paramName);
                if (!targetValue) return;

                const targetTab = findTabByUrlValue(tabs, targetValue);
                if (!targetTab || targetTab.classList.contains('active')) return;

                bootstrap.Tab.getOrCreateInstance(targetTab).show();
            };

            tabs.forEach((tabEl) => {
                tabEl.addEventListener('shown.bs.tab', () => {
                    const tabValue = getTabUrlValue(tabEl);
                    if (!tabValue) return;

                    const url = new URL(window.location.href);
                    url.searchParams.set(paramName, tabValue);
                    window.history.replaceState(window.history.state, '', url);
                });
            });

            applyFromUrl();
            window.addEventListener('popstate', applyFromUrl);
        });
    }

    // ==================== CSRF FETCH INTERCEPTOR ====================
    // Automatically adds X-CSRF-Token header to all non-safe fetch() calls.
    // Reads the token from <meta name="csrf-token"> injected by the EJS layout.
    (function patchFetch() {
        const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
        const _fetch = window.fetch.bind(window);
        window.__rawFetch = _fetch;
        const DEVICE_ACTION_PREFIXES = [
            '/api/sms/',
            '/api/calls/',
            '/api/gpio/',
            '/api/location/',
            '/api/storage/',
            '/api/modem/',
            '/api/ussd/',
            '/api/test/',
            '/api/ota/'
        ];
        window.fetch = function (resource, init) {
            init = init || {};
            const method = (init.method || 'GET').toUpperCase();
            const url = typeof resource === 'string' ? resource : String(resource?.url || '');
            const isDeviceAction = !SAFE_METHODS.has(method) && DEVICE_ACTION_PREFIXES.some(prefix => url.startsWith(prefix));
            const httpDeviceHealthy = isDeviceAction
                && typeof window.deviceHttpOnline === 'function'
                && window.deviceHttpOnline() === true;

            if (isDeviceAction && !httpDeviceHealthy && window._serverConnected === false) {
                if (typeof window.showToast === 'function') {
                    window.showToast('Live connection looks stale. Trying the request directly via HTTP.', 'warning');
                }
            }

            if (isDeviceAction && !httpDeviceHealthy && window._serverConnected !== false && window._mqttConnected === false) {
                if (typeof window.showToast === 'function') {
                    window.showToast('Dashboard MQTT is reconnecting. Device actions may queue until the broker link is back.', 'info');
                }
            }

            if (!SAFE_METHODS.has(method)) {
                const token = document.querySelector('meta[name="csrf-token"]')?.content;
                if (token) {
                    // Merge into existing headers without overwriting caller-supplied values
                    const existing = init.headers;
                    if (!existing) {
                        init.headers = { 'X-CSRF-Token': token };
                    } else if (existing instanceof Headers) {
                        if (!existing.has('X-CSRF-Token')) existing.set('X-CSRF-Token', token);
                    } else {
                        const key = Object.keys(existing).find(k => k.toLowerCase() === 'x-csrf-token');
                        if (!key) init.headers = Object.assign({ 'X-CSRF-Token': token }, existing);
                    }
                }
            }
            return _fetch(resource, init);
        };
    })();

    // ==================== EXPORTS ====================

    window.escapeHtml          = escapeHtml;
    window.formatBytes         = formatBytes;
    window.formatSize          = formatBytes; // alias used in storage.js
    window.formatDuration      = formatDuration;
    window.formatDate          = formatDate;
    window.debounce            = debounce;
    window.renderPagination    = renderPagination;
    window.mqttWaitFeedback    = mqttWaitFeedback;
    window.syncBootstrapTabsWithUrl = syncBootstrapTabsWithUrl;
    // showToast is intentionally NOT overridden here — main.js owns the real implementation.
    // Each page module can call window.showToast() directly.

})();

// ── User preference helpers ───────────────────────────────────────────────────
window.userPrefs = {
    _cache: null,

    async load() {
        try {
            const res = await fetch('/admin/api/user/preferences');
            const data = await res.json();
            this._cache = data.success ? data.preferences : {};
        } catch (_) { this._cache = {}; }
        return this._cache;
    },

    async save(patch) {
        const prefs = Object.assign(this._cache || {}, patch);
        this._cache = prefs;
        try {
            await fetch('/admin/api/user/preferences', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(prefs)
            });
        } catch (_) {}
    },

    get(key, defaultVal) {
        return this._cache?.[key] ?? defaultVal;
    }
};

// ==================== IndexedDB / Dexie helpers ====================
// Runs after the IIFE above. Requires window.localDb (db.js) and
// window.socket (main.js) to be available.

(function () {
    'use strict';

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            window.syncBootstrapTabsWithUrl?.(document);
        });
    } else {
        window.syncBootstrapTabsWithUrl?.(document);
    }

    // Wait until DOM + socket are ready before wiring up IDB listeners
    document.addEventListener('DOMContentLoaded', function () {
        const db = window.localDb;
        const socket = window.socket;
        if (!db) return; // Dexie not loaded (should not happen)

        // ---- Socket.IO → IndexedDB sync ----

        if (socket) {
            // New incoming SMS — store in IDB
            socket.on('sms:received', function (data) {
                db.sms.add({
                    server_id: data.id,
                    device_id: data.deviceId || null,
                    from_number: data.from_number || data.from || null,
                    to_number: data.to_number || data.to || null,
                    message: data.message,
                    type: 'incoming',
                    read: 0,
                    timestamp: data.timestamp || new Date().toISOString()
                }).catch(function () {}); // ignore duplicates
            });

            // SMS deleted — remove from IDB
            socket.on('sms:deleted', function (data) {
                db.sms.where('server_id').equals(data.id).delete().catch(function () {});
            });

            // SMS marked read
            socket.on('sms:read', function (data) {
                db.sms.where('server_id').equals(Number(data.id))
                    .modify({ read: 1 }).catch(function () {});
            });

            socket.on('sms:bulk-read', function (data) {
                // Bulk mark — can't efficiently target by id list here;
                // page-specific scripts handle the detail.
            });

            // Contact created / updated / deleted — invalidate the whole cache
            socket.on('contact:created', function () { db.contacts.clear().catch(function () {}); });
            socket.on('contact:updated', function () { db.contacts.clear().catch(function () {}); });
            socket.on('contact:deleted', function () { db.contacts.clear().catch(function () {}); });

            // GPS location — store point
            socket.on('gps:location', function (data) {
                db.gps.add({
                    device_id: data.deviceId,
                    latitude: data.latitude,
                    longitude: data.longitude,
                    altitude: data.altitude,
                    satellites: data.satellites,
                    accuracy: data.accuracy,
                    timestamp: data.timestamp || new Date().toISOString()
                }).then(function () {
                    // Keep only last 1000 GPS points per device
                    return db.gps
                        .where('device_id').equals(data.deviceId)
                        .count()
                        .then(function (count) {
                            if (count > 1000) {
                                return db.gps
                                    .where('device_id').equals(data.deviceId)
                                    .sortBy('timestamp')
                                    .then(function (rows) {
                                        const toDelete = rows.slice(0, count - 1000).map(function (r) { return r.id; });
                                        return db.gps.bulkDelete(toDelete);
                                    });
                            }
                        });
                }).catch(function () {});
            });

            // On reconnect — flush the offline outbox
            socket.on('connect', function () {
                flushOutbox();
            });
        }

        // ---- Offline outbox flush ----

        function flushOutbox() {
            if (!db) return;
            db.outbox.toArray().then(function (items) {
                items.forEach(function (item) {
                    if (item.type === 'sms-send') {
                        fetch('/api/sms/send', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                ...item.payload,
                                deviceId: item.payload?.deviceId || (window.getActiveDeviceId ? window.getActiveDeviceId() : '')
                            })
                        })
                        .then(function (r) { return r.json(); })
                        .then(function (res) {
                            if (res.success) db.outbox.delete(item.id).catch(function () {});
                        })
                        .catch(function () {});
                    }
                });
            }).catch(function () {});
        }

        window.flushOutbox = flushOutbox;

        // ---- Delta sync helpers (used by page scripts) ----

        /**
         * Get the most recent timestamp stored for a table.
         * Returns null if the table is empty.
         */
        window.idbLastTimestamp = function (tableName, field) {
            return db[tableName]
                .orderBy(field || 'timestamp')
                .last()
                .then(function (row) { return row ? (row[field] || row.timestamp) : null; })
                .catch(function () { return null; });
        };

        /**
         * Queue an SMS send for offline retry.
         */
        window.queueOutboxSms = function (payload) {
            return db.outbox.add({
                type: 'sms-send',
                payload: payload,
                timestamp: new Date().toISOString()
            });
        };
    });
})();
