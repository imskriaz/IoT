(function () {
    'use strict';

    const state = {
        presets: [],
        vendorNotes: [],
        currentDeviceId: window.getActiveDeviceId ? window.getActiveDeviceId() : '',
        entries: []
    };

    const elements = {
        output: document.getElementById('esp32ConsoleOutput'),
        command: document.getElementById('esp32CommandInput'),
        payload: document.getElementById('esp32PayloadInput'),
        timeout: document.getElementById('esp32TimeoutInput'),
        wait: document.getElementById('esp32WaitSelect'),
        send: document.getElementById('esp32SendCommandBtn'),
        clear: document.getElementById('esp32ConsoleClearBtn'),
        export: document.getElementById('esp32ConsoleExportBtn'),
        format: document.getElementById('esp32FormatPayloadBtn'),
        presets: document.getElementById('esp32PresetGrid'),
        vendorNotes: document.getElementById('esp32VendorNotes'),
        deviceBadge: document.getElementById('esp32ConsoleDeviceBadge'),
        mqttBadge: document.getElementById('esp32ConsoleMqttBadge'),
        lastRun: document.getElementById('esp32ConsoleLastRun')
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    async function init() {
        attachEvents();
        attachSocketEvents();
        updateDeviceBadge();
        await Promise.all([
            loadCatalog(),
            refreshMqttStatus()
        ]);
        appendLine('system', 'Loaded command presets and compact vendor notes.', 'success');
    }

    function attachEvents() {
        elements.send?.addEventListener('click', sendCommand);
        elements.clear?.addEventListener('click', clearConsole);
        elements.export?.addEventListener('click', exportConsole);
        elements.format?.addEventListener('click', formatPayload);
        elements.payload?.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                sendCommand();
            }
        });
        elements.command?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                sendCommand();
            }
        });
        window.addEventListener('device:changed', () => {
            state.currentDeviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';
            updateDeviceBadge();
            appendLine('system', `Active device switched to ${state.currentDeviceId || 'none'}.`, 'info');
        });
    }

    function attachSocketEvents() {
        if (!window.socket) return;
        window.socket.on('command:response', (payload) => {
            const deviceId = String(payload?.deviceId || '').trim();
            if (deviceId && state.currentDeviceId && deviceId !== state.currentDeviceId) return;
            appendLine('mqtt', 'async command response', 'info', payload);
        });
        window.socket.on('mqtt:status', (status) => {
            renderMqttStatus(status);
        });
    }

    async function loadCatalog() {
        const response = await fetch('/api/esp32-console/commands', { credentials: 'same-origin' });
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.message || 'Failed to load ESP32 console command catalog');
        }
        state.presets = data.data?.presets || [];
        state.vendorNotes = data.data?.vendorNotes || [];
        renderPresets();
        renderVendorNotes();
    }

    async function refreshMqttStatus() {
        try {
            const response = await fetch('/api/mqtt/status', { credentials: 'same-origin', cache: 'no-store' });
            const data = await response.json();
            renderMqttStatus(data);
        } catch (error) {
            renderMqttStatus({ connected: false, message: error.message });
        }
    }

    function renderMqttStatus(status) {
        if (!elements.mqttBadge) return;
        const connected = status?.connected === true;
        elements.mqttBadge.className = `badge ${connected ? 'text-bg-success' : 'text-bg-danger'}`;
        elements.mqttBadge.textContent = connected ? 'MQTT: connected' : 'MQTT: offline';
        elements.mqttBadge.title = status?.broker ? `Broker: ${status.broker}` : '';
    }

    function updateDeviceBadge() {
        if (!elements.deviceBadge) return;
        state.currentDeviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : state.currentDeviceId;
        elements.deviceBadge.textContent = `Device: ${state.currentDeviceId || '--'}`;
    }

    function renderPresets() {
        if (!elements.presets) return;
        elements.presets.innerHTML = state.presets.map((preset, index) => `
            <button type="button" class="btn btn-sm btn-outline-secondary preset-btn" data-preset-index="${index}">
                <span class="fw-semibold">${escapeHtml(preset.label || preset.command)}</span>
                <span class="small text-muted">${escapeHtml(preset.group || 'Command')} / ${escapeHtml(preset.command || '')}</span>
            </button>
        `).join('');

        elements.presets.querySelectorAll('[data-preset-index]').forEach((button) => {
            button.addEventListener('click', () => {
                const preset = state.presets[Number(button.dataset.presetIndex)];
                applyPreset(preset);
            });
        });
    }

    function renderVendorNotes() {
        if (!elements.vendorNotes) return;
        elements.vendorNotes.innerHTML = state.vendorNotes.map((note) => `
            <div class="vendor-note">
                <div class="fw-semibold small mb-1">${escapeHtml(note.title || '')}</div>
                <div class="mb-1">${(note.commands || []).map(command => `<span class="command-chip">${escapeHtml(command)}</span>`).join('')}</div>
                <div class="small text-muted">${escapeHtml(note.note || '')}</div>
            </div>
        `).join('');
    }

    function applyPreset(preset) {
        if (!preset) return;
        if (elements.command) elements.command.value = preset.command || '';
        if (elements.payload) elements.payload.value = JSON.stringify(preset.payload || {}, null, 2);
        if (elements.timeout) elements.timeout.value = String(preset.timeoutMs || 30000);
        if (elements.wait) elements.wait.value = preset.waitForResponse === false ? 'false' : 'true';
        appendLine('preset', preset.note || `Loaded ${preset.command}`, 'info');
    }

    async function sendCommand() {
        updateDeviceBadge();
        const command = String(elements.command?.value || '').trim();
        const waitForResponse = elements.wait?.value !== 'false';
        const timeoutMs = Number(elements.timeout?.value || 30000);
        let payload;

        if (!command) {
            appendLine('error', 'Command is required.', 'danger');
            return;
        }

        try {
            payload = parsePayload();
        } catch (error) {
            appendLine('error', error.message, 'danger');
            return;
        }

        setSending(true);
        appendLine('send', `${command} ${waitForResponse ? '(waiting)' : '(publish only)'}`, 'primary', payload);

        try {
            const response = await fetch('/api/esp32-console/command', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || ''
                },
                credentials: 'same-origin',
                body: JSON.stringify({
                    deviceId: state.currentDeviceId,
                    command,
                    payload,
                    waitForResponse,
                    timeoutMs
                })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.success) {
                throw new Error(data.message || `Command failed with HTTP ${response.status}`);
            }
            appendLine('response', `${command} completed in ${data.durationMs}ms`, 'success', data);
            if (elements.lastRun) elements.lastRun.textContent = `${command} / ${data.durationMs}ms`;
        } catch (error) {
            appendLine('error', `${command}: ${error.message}`, 'danger');
            if (window.showToast) window.showToast(error.message || 'Command failed', 'danger');
        } finally {
            setSending(false);
            refreshMqttStatus();
        }
    }

    function parsePayload() {
        const raw = String(elements.payload?.value || '').trim();
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Payload must be a JSON object.');
        }
        return parsed;
    }

    function formatPayload() {
        try {
            const parsed = parsePayload();
            if (elements.payload) elements.payload.value = JSON.stringify(parsed, null, 2);
        } catch (error) {
            appendLine('error', error.message, 'danger');
        }
    }

    function setSending(isSending) {
        if (!elements.send) return;
        elements.send.disabled = isSending;
        elements.send.innerHTML = isSending
            ? '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Send'
            : '<i class="bi bi-send"></i> Send';
    }

    function appendLine(source, message, level, data) {
        if (!elements.output) return;
        const timestamp = new Date().toLocaleTimeString();
        const className = levelClass(level);
        const dataText = data === undefined || data === null ? '' : `\n${JSON.stringify(data, null, 2)}`;
        const line = document.createElement('div');
        line.className = `console-line ${className}`;
        line.textContent = `[${timestamp}] [${source}] ${message}${dataText}`;
        elements.output.appendChild(line);
        elements.output.scrollTop = elements.output.scrollHeight;
        state.entries.push({ timestamp, source, message, data });
        if (state.entries.length > 300) state.entries.shift();
    }

    function levelClass(level) {
        switch (level) {
            case 'success': return 'text-success';
            case 'danger': return 'text-danger';
            case 'warning': return 'text-warning';
            case 'primary': return 'text-info';
            case 'info': return 'text-info';
            default: return 'text-light';
        }
    }

    function clearConsole() {
        if (!elements.output) return;
        elements.output.innerHTML = '';
        state.entries = [];
        appendLine('system', 'Console cleared.', 'info');
    }

    function exportConsole() {
        const text = state.entries.map((entry) => {
            const data = entry.data === undefined || entry.data === null ? '' : `\n${JSON.stringify(entry.data, null, 2)}`;
            return `[${entry.timestamp}] [${entry.source}] ${entry.message}${data}`;
        }).join('\n\n');
        const blob = new Blob([text || 'No console entries'], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `esp32-mqtt-console-${Date.now()}.log`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
})();
