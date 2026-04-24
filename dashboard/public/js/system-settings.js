(function () {
    'use strict';

    const state = {
        settings: null,
        logsModal: null
    };

    function $(id) {
        return document.getElementById(id);
    }

    function csrfToken() {
        return document.querySelector('meta[name="csrf-token"]')?.content || '';
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function notify(message, type = 'info') {
        if (window.showToast) {
            window.showToast(message, type);
            return;
        }
        if (type === 'danger') {
            alert(message);
        } else {
            console.log(message);
        }
    }

    function setText(id, value) {
        const el = $(id);
        if (el) el.textContent = value;
    }

    function setValue(id, value) {
        const el = $(id);
        if (el) el.value = value ?? '';
    }

    function setChecked(id, checked) {
        const el = $(id);
        if (el) el.checked = !!checked;
    }

    function timezoneOptions() {
        let zones = [];
        try {
            if (typeof Intl.supportedValuesOf === 'function') {
                zones = Intl.supportedValuesOf('timeZone') || [];
            }
        } catch (_) {
            zones = [];
        }
        return Array.from(new Set([
            'UTC',
            'Asia/Dhaka',
            'Asia/Kolkata',
            'Asia/Dubai',
            'Asia/Singapore',
            'Europe/London',
            'Europe/Berlin',
            'America/New_York',
            'America/Chicago',
            'America/Denver',
            'America/Los_Angeles',
            ...zones
        ])).sort((a, b) => a.localeCompare(b));
    }

    function renderTimezoneOptions(selected) {
        const select = $('systemTimezone');
        if (!select) return;
        const localZone = window.DashboardTime?.browserTimeZone || 'UTC';
        const selectedZone = String(selected || localZone || 'UTC').trim();
        const zones = timezoneOptions();
        if (selectedZone && !zones.includes(selectedZone)) zones.unshift(selectedZone);
        select.innerHTML = zones.map(zone => {
            const label = zone === localZone ? `${zone} (local)` : zone;
            return `<option value="${escapeHtml(zone)}"${zone === selectedZone ? ' selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('');
        select.value = selectedZone;
    }

    function setSource(id, effective, fallback = 'Saved in dashboard settings') {
        const el = $(id);
        if (!el) return;

        const meta = effective || {};
        if (meta.source === 'env') {
            el.textContent = 'Controlled outside dashboard';
            return;
        }
        if (meta.source === 'dashboard_env') {
            el.textContent = 'Saved in dashboard settings (.env)';
            return;
        }
        if (meta.source === 'database') {
            el.textContent = fallback;
            return;
        }
        el.textContent = meta.source === 'default' ? 'Using default value' : fallback;
    }

    function setControlDisabled(id, locked) {
        const el = $(id);
        if (!el) return;
        if (!el.dataset.baseDisabled) {
            el.dataset.baseDisabled = el.disabled ? 'true' : 'false';
        }
        el.disabled = locked || el.dataset.baseDisabled === 'true';
    }

    function applyLockedState(effective = {}, entries = []) {
        entries.forEach(({ key, ids }) => {
            const locked = effective[key]?.source === 'env';
            ids.forEach(id => setControlDisabled(id, locked));
        });
    }

    function formatBytes(bytes) {
        const value = Number(bytes || 0);
        if (!Number.isFinite(value) || value <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
        return `${(value / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
    }

    function formatDate(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return window.formatDashboardDateTime ? window.formatDashboardDateTime(date) : date.toLocaleString();
    }

    async function fetchJson(url, options = {}) {
        const { allowFailure = false, ...fetchOptions } = options;
        const response = await fetch(url, {
            cache: 'no-store',
            credentials: 'same-origin',
            ...fetchOptions,
            headers: {
                'Cache-Control': 'no-cache',
                ...(fetchOptions.headers || {})
            }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || (!allowFailure && payload.success === false)) {
            throw new Error(payload.message || `Request failed: ${response.status}`);
        }
        return payload;
    }

    async function withButton(button, label, task) {
        const btn = button?.closest ? button.closest('button') : button;
        const originalHtml = btn?.innerHTML || '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>${label}`;
        }
        try {
            return await task();
        } catch (error) {
            notify(error.message || 'Request failed', 'danger');
            return null;
        } finally {
            if (btn) {
                btn.innerHTML = originalHtml;
                btn.disabled = false;
            }
        }
    }

    function renderSystem(system = {}, effective = {}) {
        renderTimezoneOptions(system.timezone || 'UTC');
        if (system.timezone && window.DashboardTime) {
            window.DashboardTime.setTimeZone(system.timezone);
        }
        setValue('systemPhoneCountryCode', system.phoneCountryCode || '');
        setValue('systemLogLevel', system.logLevel || 'info');
        setValue('deviceStatusRefreshSeconds', system.deviceStatusRefreshSeconds || Math.round(Number(system.deviceStatusRefreshMs || 60000) / 1000));
        setValue('statusWatchIntervalSeconds', system.statusWatchIntervalSeconds || Math.round(Number(system.statusWatchIntervalMs || 45000) / 1000));
        setValue('statusWatchTtlSeconds', system.statusWatchTtlSeconds || Math.round(Number(system.statusWatchTtlMs || 180000) / 1000));
        setValue('statusWatchRefreshSeconds', system.statusWatchRefreshSeconds || Math.round(Number(system.statusWatchRefreshMs || 120000) / 1000));
        setValue('logRetentionDays', system.logRetentionDays || 30);
        setValue('systemPublicBaseUrl', system.publicBaseUrl || '');
        setValue('systemOtaBaseUrl', system.otaBaseUrl || '');

        setSource('systemTimezoneSource', effective.timezone, 'Saved in dashboard settings');
        setSource('systemPhoneCountryCodeSource', effective.phoneCountryCode, 'Used for dashboard phone-number formatting.');
        setSource('systemLogLevelSource', effective.logLevel, 'Saved in dashboard settings');
        setSource('deviceStatusRefreshSource', effective.deviceStatusRefreshMs, 'Saved in dashboard settings');
        setSource('statusWatchIntervalSource', effective.statusWatchIntervalMs, 'How often the dashboard asks the device to publish status while visible.');
        setSource('statusWatchTtlSource', effective.statusWatchTtlMs, 'How long the device keeps the temporary watch alive.');
        setSource('statusWatchRefreshSource', effective.statusWatchRefreshMs, 'How often the dashboard renews the device watch command.');
        setSource('logRetentionSource', effective.logRetentionDays, 'Saved in dashboard settings');
        setSource('systemPublicBaseUrlSource', effective.publicBaseUrl, 'Used when the dashboard must generate public links.');
        setSource('systemOtaBaseUrlSource', effective.otaBaseUrl, 'Override this if devices cannot reach the dashboard URL directly.');

        setText('systemHostname', system.hostname || '-');
        setText('systemNodeVersion', system.nodeVersion || '-');
        setText('systemCpu', system.cpu ? `${system.cpu} cores` : '-');
        setText('systemMemory', formatBytes(system.memory?.rss));
        setText('systemPlatformBadge', system.platform || '-');
        applyLockedState(effective, [
            { key: 'timezone', ids: ['systemTimezone', 'useLocalTimezoneBtn'] },
            { key: 'phoneCountryCode', ids: ['systemPhoneCountryCode'] },
            { key: 'logLevel', ids: ['systemLogLevel'] },
            { key: 'deviceStatusRefreshMs', ids: ['deviceStatusRefreshSeconds'] },
            { key: 'statusWatchIntervalMs', ids: ['statusWatchIntervalSeconds'] },
            { key: 'statusWatchTtlMs', ids: ['statusWatchTtlSeconds'] },
            { key: 'statusWatchRefreshMs', ids: ['statusWatchRefreshSeconds'] },
            { key: 'logRetentionDays', ids: ['logRetentionDays'] },
            { key: 'publicBaseUrl', ids: ['systemPublicBaseUrl'] },
            { key: 'otaBaseUrl', ids: ['systemOtaBaseUrl'] }
        ]);

        const badge = $('systemSettingsLoadedBadge');
        if (badge) {
            badge.textContent = 'Loaded';
            badge.className = 'badge bg-success';
        }
    }

    function renderMqtt(mqtt = {}, effective = {}) {
        setValue('mqttProtocol', mqtt.protocol || 'mqtt');
        setValue('mqttHost', mqtt.host || '');
        setValue('mqttPort', mqtt.port || 1883);
        setValue('mqttUsername', mqtt.username || '');
        setValue('mqttClientId', mqtt.clientId || '');
        setChecked('mqttRejectUnauthorized', mqtt.rejectUnauthorized);
        applyLockedState(effective, [
            { key: 'mqttProtocol', ids: ['mqttProtocol'] },
            { key: 'mqttHost', ids: ['mqttHost'] },
            { key: 'mqttPort', ids: ['mqttPort'] },
            { key: 'mqttUser', ids: ['mqttUsername'] },
            { key: 'mqttPassword', ids: ['mqttPassword', 'mqttPasswordToggle'] },
            { key: 'mqttRejectUnauthorized', ids: ['mqttRejectUnauthorized'] }
        ]);

        const password = $('mqttPassword');
        if (password) {
            password.value = '';
            password.placeholder = mqtt.passwordSet ? 'Password is set - leave blank to keep current' : 'Leave blank to keep current';
        }

        const status = $('mqttConnectionStatus');
        const detail = $('mqttStatusDetail');
        if (!status) return;

        if (mqtt.connected) {
            status.textContent = 'Connected';
            status.className = 'badge bg-success';
        } else if (mqtt.connecting || mqtt.reconnecting) {
            status.textContent = mqtt.reconnecting ? 'Reconnecting' : 'Connecting';
            status.className = 'badge bg-warning text-dark';
        } else {
            status.textContent = mqtt.lastError ? 'Error' : 'Disconnected';
            status.className = mqtt.lastError ? 'badge bg-danger' : 'badge bg-secondary';
        }

        status.title = mqtt.lastError || mqtt.state || '';
        if (detail) {
            const broker = `${mqtt.protocol || 'mqtt'}://${mqtt.host || 'localhost'}:${mqtt.port || 1883}`;
            detail.textContent = mqtt.lastError ? `${broker} • ${mqtt.lastError}` : broker;
        }
    }

    function shouldFocusMqttSettings() {
        const params = new URLSearchParams(window.location.search || '');
        return params.get('mqttDown') === '1' || window.location.hash === '#mqtt-broker';
    }

    function focusMqttSettingsPanel() {
        if (!shouldFocusMqttSettings()) return;

        const panel = $('mqtt-broker');
        const notice = $('mqttRedirectNotice');
        if (notice) {
            notice.classList.remove('d-none');
            notice.classList.add('d-flex');
        }
        if (panel) {
            panel.classList.add('system-panel--attention');
            panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        const firstEditable = ['mqttHost', 'mqttPort', 'mqttUsername', 'mqttClientId', 'mqttProtocol']
            .map(id => $(id))
            .find(el => el && !el.disabled && !el.readOnly);
        if (firstEditable) {
            setTimeout(() => firstEditable.focus({ preventScroll: true }), 350);
        }
    }

    function renderEnvironmentOverrides(overrides = []) {
        const container = $('activeOverrideList');
        if (!container) return;

        const active = overrides.filter(item => item.active);
        if (!active.length) {
            container.innerHTML = '<div class="text-muted">No externally locked settings.</div>';
            return;
        }

        container.innerHTML = active.map(item => {
            const value = item.value ? `<code>${escapeHtml(item.value)}</code>` : '<span class="text-muted">set</span>';
            return `
                <div class="override-item">
                    <div class="override-meta">
                        <div class="fw-semibold">${escapeHtml(item.label || item.key)}</div>
                        <div class="small text-muted">${escapeHtml(item.envName || '')}</div>
                    </div>
                    <div>${value}</div>
                </div>
            `;
        }).join('');
    }

    async function loadBackups() {
        const tbody = $('backupsTableBody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="3" class="text-muted text-center py-3">Loading backups...</td></tr>';
        }
        try {
            const payload = await fetchJson('/api/settings/backups');
            const backups = (Array.isArray(payload.data) ? payload.data : []).slice(0, 8);
            if (!tbody) return backups;
            if (!backups.length) {
                tbody.innerHTML = '<tr><td colspan="3" class="text-muted text-center py-3">No backups found.</td></tr>';
                return backups;
            }
            tbody.innerHTML = backups.map(backup => `
                <tr>
                    <td>
                        <div class="font-monospace small">${escapeHtml(backup.name)}</div>
                        <small class="text-muted">${escapeHtml(formatDate(backup.modified || backup.created))}</small>
                    </td>
                    <td><small>${formatBytes(backup.size)}</small></td>
                    <td class="text-end">
                        <a class="btn btn-sm btn-outline-secondary" href="/api/settings/backups/${encodeURIComponent(backup.name)}/download" title="Download">
                            <i class="bi bi-download"></i>
                        </a>
                        <button class="btn btn-sm btn-outline-danger" type="button" onclick="deleteBackup('${escapeHtml(backup.name)}', this)" title="Delete">
                            <i class="bi bi-trash"></i>
                        </button>
                    </td>
                </tr>
            `).join('');
            return backups;
        } catch (error) {
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="3" class="text-danger text-center py-3">${escapeHtml(error.message)}</td></tr>`;
            }
            return [];
        }
    }

    async function loadSystemSettings(force = false) {
        try {
            if (force) {
                const badge = $('systemSettingsLoadedBadge');
                if (badge) {
                    badge.textContent = 'Refreshing';
                    badge.className = 'badge bg-secondary';
                }
            }
            const payload = await fetchJson('/api/settings');
            const settings = payload.data || {};
            state.settings = settings;
            renderSystem(settings.system || {}, settings.effective || {});
            renderMqtt(settings.mqtt || {}, settings.effective || {});
            renderEnvironmentOverrides(settings.environmentOverrides || []);
            await loadBackups();
            return settings;
        } catch (error) {
            const badge = $('systemSettingsLoadedBadge');
            if (badge) {
                badge.textContent = 'Error';
                badge.className = 'badge bg-danger';
            }
            notify(error.message || 'Failed to load system settings', 'danger');
            return null;
        }
    }

    function readSystemForm() {
        const refreshSeconds = Number.parseInt($('deviceStatusRefreshSeconds')?.value || '60', 10);
        const statusWatchIntervalSeconds = Number.parseInt($('statusWatchIntervalSeconds')?.value || '45', 10);
        const statusWatchTtlSeconds = Number.parseInt($('statusWatchTtlSeconds')?.value || '180', 10);
        const statusWatchRefreshSeconds = Number.parseInt($('statusWatchRefreshSeconds')?.value || '120', 10);
        const currentSystem = state.settings?.system || {};
        return {
            deviceName: currentSystem.deviceName || 'Dashboard',
            phoneCountryCode: $('systemPhoneCountryCode')?.value?.trim() || '',
            publicBaseUrl: $('systemPublicBaseUrl')?.value?.trim() || '',
            otaBaseUrl: $('systemOtaBaseUrl')?.value?.trim() || '',
            timezone: $('systemTimezone')?.value?.trim() || 'UTC',
            logLevel: $('systemLogLevel')?.value || 'info',
            autoRestart: !!currentSystem.autoRestart,
            restartSchedule: currentSystem.restartSchedule || '03:00',
            backupConfig: currentSystem.backupConfig !== false,
            deviceStatusRefreshMs: Math.max(5, Math.min(3600, Number.isFinite(refreshSeconds) ? refreshSeconds : 60)) * 1000,
            statusWatchIntervalMs: Math.max(10, Math.min(300, Number.isFinite(statusWatchIntervalSeconds) ? statusWatchIntervalSeconds : 45)) * 1000,
            statusWatchTtlMs: Math.max(60, Math.min(900, Number.isFinite(statusWatchTtlSeconds) ? statusWatchTtlSeconds : 180)) * 1000,
            statusWatchRefreshMs: Math.max(30, Math.min(600, Number.isFinite(statusWatchRefreshSeconds) ? statusWatchRefreshSeconds : 120)) * 1000,
            logRetentionDays: Math.max(1, Math.min(3650, Number.parseInt($('logRetentionDays')?.value || '30', 10) || 30))
        };
    }

    async function saveSystemSettings(button) {
        await withButton(button, 'Saving', async () => {
            const payload = await fetchJson('/api/settings/system', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken()
                },
                body: JSON.stringify(readSystemForm())
            });
            notify(payload.message || 'System settings saved', 'success');
            if (payload.data?.system) {
                window.DASHBOARD_RUNTIME_SETTINGS = {
                    deviceStatusRefreshMs: payload.data.system.deviceStatusRefreshMs,
                    statusWatchIntervalMs: payload.data.system.statusWatchIntervalMs,
                    statusWatchTtlMs: payload.data.system.statusWatchTtlMs,
                    statusWatchRefreshMs: payload.data.system.statusWatchRefreshMs,
                    logRetentionDays: payload.data.system.logRetentionDays,
                    timezone: payload.data.system.timezone
                };
                if (window.DashboardTime) window.DashboardTime.setTimeZone(payload.data.system.timezone);
            }
            if (window.loadDashboardRuntimeSettings) {
                window.loadDashboardRuntimeSettings(true);
            }
            await loadSystemSettings(true);
        });
    }

    function readMqttForm() {
        return {
            protocol: $('mqttProtocol')?.value || 'mqtt',
            host: $('mqttHost')?.value?.trim() || '',
            port: Number.parseInt($('mqttPort')?.value || '1883', 10),
            username: $('mqttUsername')?.value?.trim() || '',
            password: $('mqttPassword')?.value || '',
            clientId: $('mqttClientId')?.value?.trim() || '',
            rejectUnauthorized: !!$('mqttRejectUnauthorized')?.checked
        };
    }

    async function saveMQTTSettings(button) {
        await withButton(button, 'Saving', async () => {
            const payload = await fetchJson('/api/settings/mqtt', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken()
                },
                body: JSON.stringify(readMqttForm())
            });
            notify(payload.message || 'MQTT settings saved', 'success');
            setValue('mqttPassword', '');
            await loadSystemSettings(true);
            if (window.refreshConnectionStatus) {
                window.refreshConnectionStatus();
            }
        });
    }

    async function testMQTTConnection(button) {
        await withButton(button, 'Testing', async () => {
            const payload = await fetchJson('/api/settings/test/mqtt', {
                method: 'POST',
                allowFailure: true,
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken()
                },
                body: JSON.stringify(readMqttForm())
            });
            const status = $('mqttConnectionStatus');
            if (status) {
                status.textContent = payload.success ? 'Test OK' : 'Test Failed';
                status.className = payload.success ? 'badge bg-success' : 'badge bg-danger';
            }
            notify(payload.message || (payload.success ? 'MQTT connection successful' : 'MQTT test failed'), payload.success ? 'success' : 'danger');
        });
    }

    async function restartDashboard(button) {
        const confirmed = await (window.appConfirm?.({
            title: 'Restart Dashboard',
            message: 'Restart the dashboard server now?',
            confirmText: 'Restart',
            confirmClass: 'btn btn-danger'
        }) ?? Promise.resolve(confirm('Restart the dashboard server now?')));
        if (!confirmed) return;

        await withButton(button, 'Restarting', async () => {
            const payload = await fetchJson('/api/settings/restart', {
                method: 'POST',
                headers: { 'X-CSRF-Token': csrfToken() }
            });
            notify(payload.message || 'Dashboard restart requested', 'warning');
            waitForDashboardRestart(payload.data?.restartPath || window.location.href);
        });
    }

    function waitForDashboardRestart(targetUrl) {
        const url = new URL(targetUrl || window.location.href, window.location.origin);
        const reloadUrl = `${url.pathname}${url.search}${url.hash}`;
        let attempts = 0;
        const timer = setInterval(async () => {
            attempts += 1;
            try {
                const response = await fetch('/api/settings/runtime', {
                    cache: 'no-store',
                    credentials: 'same-origin',
                    headers: { 'Cache-Control': 'no-cache' }
                });
                if (response.ok) {
                    clearInterval(timer);
                    window.location.assign(reloadUrl || '/settings');
                }
            } catch (_) {
                if (attempts > 60) clearInterval(timer);
            }
        }, 1500);
    }

    async function viewLogs(button) {
        await withButton(button, 'Loading', async () => {
            const payload = await fetchJson('/api/settings/logs');
            setText('logsContent', payload.data || 'No logs found');
            const modalEl = $('logsModal');
            if (modalEl && window.bootstrap) {
                state.logsModal = state.logsModal || window.bootstrap.Modal.getOrCreateInstance(modalEl);
                state.logsModal.show();
            }
        });
    }

    async function clearLogs(button) {
        const confirmed = await (window.appConfirm?.({
            title: 'Clear Logs',
            message: 'Clear the current dashboard log file?',
            confirmText: 'Clear Logs',
            confirmClass: 'btn btn-danger'
        }) ?? Promise.resolve(confirm('Clear the current dashboard log file?')));
        if (!confirmed) return;

        await withButton(button, 'Clearing', async () => {
            const payload = await fetchJson('/api/settings/logs/clear', {
                method: 'POST',
                headers: { 'X-CSRF-Token': csrfToken() }
            });
            setText('logsContent', '');
            notify(payload.message || 'Logs cleared', 'success');
        });
    }

    async function createBackup(button) {
        await withButton(button, 'Creating', async () => {
            const payload = await fetchJson('/api/settings/backup/create', {
                method: 'POST',
                headers: { 'X-CSRF-Token': csrfToken() }
            });
            notify(payload.message || 'Backup created', 'success');
            await loadBackups();
        });
    }

    async function deleteBackup(filename, button) {
        const confirmed = await (window.appConfirm?.({
            title: 'Delete Backup',
            message: `Delete backup ${filename}?`,
            confirmText: 'Delete',
            confirmClass: 'btn btn-danger'
        }) ?? Promise.resolve(confirm(`Delete backup ${filename}?`)));
        if (!confirmed) return;

        await withButton(button, 'Deleting', async () => {
            const payload = await fetchJson(`/api/settings/backups/${encodeURIComponent(filename)}`, {
                method: 'DELETE',
                headers: { 'X-CSRF-Token': csrfToken() }
            });
            notify(payload.message || 'Backup deleted', 'success');
            await loadBackups();
        });
    }

    function toggleSystemPassword(id) {
        const input = $(id);
        if (!input) return;
        input.type = input.type === 'password' ? 'text' : 'password';
    }

    window.loadSystemSettings = loadSystemSettings;
    window.saveSystemSettings = saveSystemSettings;
    window.saveMQTTSettings = saveMQTTSettings;
    window.testMQTTConnection = testMQTTConnection;
    window.restartDashboard = restartDashboard;
    window.viewLogs = viewLogs;
    window.clearLogs = clearLogs;
    window.createBackup = createBackup;
    window.deleteBackup = deleteBackup;
    window.loadBackups = loadBackups;
    window.toggleSystemPassword = toggleSystemPassword;

    document.addEventListener('DOMContentLoaded', () => {
        renderTimezoneOptions(window.DashboardTime?.browserTimeZone || 'UTC');
        $('useLocalTimezoneBtn')?.addEventListener('click', () => {
            let localZone = window.DashboardTime?.browserTimeZone || 'UTC';
            try {
                localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || localZone;
            } catch (_) {}
            renderTimezoneOptions(localZone);
        });
        loadSystemSettings().then(() => focusMqttSettingsPanel());
    });
})();
