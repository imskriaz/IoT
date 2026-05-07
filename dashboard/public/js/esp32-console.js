(function () {
    'use strict';

    const MAX_EVENTS = 350;

    const state = {
        presets: [],
        vendorCommands: [],
        tests: {},
        categories: {},
        caps: {},
        options: [],
        currentDeviceId: getCurrentDeviceId(),
        currentRunId: null,
        statusPollTimer: null,
        entries: [],
        activeTab: 'mqtt',
        transport: 'mqtt',
        mode: 'single',
        hidden: { unsupported: 0, device: 0 },
        serial: {
            port: null,
            reader: null,
            writer: null,
            readLoopActive: false,
            buffer: ''
        }
    };

    const elements = {
        output: document.getElementById('esp32ConsoleOutput'),
        chain: document.getElementById('esp32ChainInput'),
        payload: document.getElementById('esp32PayloadInput'),
        timeout: document.getElementById('esp32TimeoutInput'),
        wait: document.getElementById('esp32WaitSelect'),
        send: document.getElementById('esp32SendCommandBtn'),
        clear: document.getElementById('esp32ConsoleClearBtn'),
        export: document.getElementById('esp32ConsoleExportBtn'),
        format: document.getElementById('esp32FormatPayloadBtn'),
        deviceBadge: document.getElementById('esp32ConsoleDeviceBadge'),
        mqttBadge: document.getElementById('esp32ConsoleMqttBadge'),
        serialBadge: document.getElementById('esp32ConsoleSerialBadge'),
        lastRun: document.getElementById('esp32ConsoleLastRun'),
        sessionLabel: document.getElementById('esp32ConsoleSessionLabel'),
        tabHint: document.getElementById('esp32ConsoleTabHint'),
        mode: document.getElementById('esp32CommandModeSelect'),
        preset: document.getElementById('esp32CommandPresetSelect'),
        optionDetails: document.getElementById('esp32OptionDetails'),
        serialConnect: document.getElementById('esp32SerialConnectBtn'),
        serialBaud: document.getElementById('esp32SerialBaudSelect'),
        serialEnding: document.getElementById('esp32SerialLineEndingSelect'),
        detailModal: document.getElementById('esp32EventDetailModal'),
        detailTitle: document.getElementById('esp32EventDetailTitle'),
        detailSummary: document.getElementById('esp32EventDetailSummary'),
        detailJson: document.getElementById('esp32EventDetailJson')
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
        renderMqttStatus(window.INITIAL_MQTT_STATUS || window._mqttStatus || { connected: false, state: 'connecting', connecting: true });
        renderSerialStatus();
        setConsoleTab('mqtt');
        setMode('single');
        await Promise.allSettled([
            loadCatalog(),
            loadTests(),
            loadPersistedEvents(),
            refreshMqttStatus()
        ]);
        rebuildOptions();
        appendLine('system', 'Console ready. Events, tests, MQTT commands, and serial lines are merged here.', 'success', {
            clickRowsForDetails: true
        });
    }

    function attachEvents() {
        elements.send?.addEventListener('click', sendSelected);
        elements.clear?.addEventListener('click', clearConsole);
        elements.export?.addEventListener('click', exportConsole);
        elements.format?.addEventListener('click', formatPayload);
        document.querySelectorAll('[data-console-tab]').forEach((button) => {
            button.addEventListener('click', () => setConsoleTab(button.dataset.consoleTab || 'mqtt'));
        });
        elements.mode?.addEventListener('change', () => setMode(elements.mode.value));
        elements.preset?.addEventListener('change', () => applySelectedOption(true));
        elements.serialConnect?.addEventListener('click', toggleSerialConnection);

        [elements.payload, elements.chain].forEach((node) => {
            node?.addEventListener('keydown', (event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault();
                    sendSelected();
                }
            });
        });
        window.addEventListener('device:changed', async () => {
            state.currentDeviceId = getCurrentDeviceId();
            stopStatusPoll();
            updateDeviceBadge();
            await Promise.allSettled([loadTests(), loadPersistedEvents()]);
            rebuildOptions();
            appendLine('system', `Active device switched to ${state.currentDeviceId || 'none'}.`, 'info');
        });
        window.addEventListener('beforeunload', () => {
            stopStatusPoll();
            closeSerialConnection().catch(() => {});
        });
    }

    function attachSocketEvents() {
        if (!window.socket) return;
        window.socket.off?.('command:response');
        window.socket.on('command:response', (payload) => {
            if (!sameDevice(payload?.deviceId)) return;
            appendLine('console', summarizeAsyncResponse(payload), 'info', payload);
        });
        window.socket.off?.('mqtt:status');
        window.socket.on('mqtt:status', renderMqttStatus);

        window.socket.off?.('test:trace');
        window.socket.on('test:trace', (trace) => {
            if (!sameRun(trace)) return;
            appendLine('test', trace.message || trace.step || trace.status || 'trace', trace.level || 'info', trace);
        });
        window.socket.off?.('test:progress');
        window.socket.on('test:progress', (payload) => {
            if (!sameRun(payload)) return;
            appendLine('test', payload.message || `Progress ${payload.progress || 0}%`, 'info', payload);
            if (elements.lastRun && payload.progress != null) elements.lastRun.textContent = `test / ${payload.progress}%`;
        });
        window.socket.off?.('test:status');
        window.socket.on('test:status', (payload) => {
            if (!sameRun(payload)) return;
            const level = payload.status === 'failed' ? 'danger' : payload.status === 'completed' ? 'success' : 'warning';
            appendLine('test', payload.message || payload.status || 'status', level, payload);
            if (payload.status === 'completed' || payload.status === 'failed' || payload.status === 'skipped') {
                stopStatusPoll();
                if (elements.lastRun) elements.lastRun.textContent = `test / ${payload.status}`;
            }
        });
    }

    async function loadCatalog() {
        const response = await fetch('/api/esp32-console/commands', { credentials: 'same-origin', cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || 'Failed to load command catalog');
        state.presets = data.data?.presets || [];
        state.vendorCommands = data.data?.vendorCommands || [];
    }

    async function loadTests() {
        const deviceId = getCurrentDeviceId();
        const [availableRes, categoriesRes] = await Promise.all([
            fetch(`/api/test/available?deviceId=${encodeURIComponent(deviceId)}`, { credentials: 'same-origin', cache: 'no-store' }),
            fetch(`/api/test/categories?deviceId=${encodeURIComponent(deviceId)}`, { credentials: 'same-origin', cache: 'no-store' })
        ]);
        const available = await availableRes.json().catch(() => ({}));
        const categories = await categoriesRes.json().catch(() => ({}));
        if (available.success) {
            state.tests = available.data || {};
            state.caps = available.caps || {};
        }
        if (categories.success) {
            state.categories = categories.data || {};
        }
    }

    async function loadPersistedEvents() {
        const deviceId = getCurrentDeviceId();
        const response = await fetch(`/api/esp32-console/events?deviceId=${encodeURIComponent(deviceId)}&limit=120`, {
            credentials: 'same-origin',
            cache: 'no-store'
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) return;
        state.entries = (data.data || []).slice(-MAX_EVENTS);
        renderEvents();
    }

    async function refreshMqttStatus() {
        try {
            const response = await fetch('/api/mqtt/status', { credentials: 'same-origin', cache: 'no-store' });
            renderMqttStatus(await response.json());
        } catch (error) {
            renderMqttStatus({ connected: false, message: error.message });
        }
    }

    function rebuildOptions() {
        const options = [];
        state.hidden = { unsupported: 0, device: 0 };

        state.presets.forEach((preset, index) => {
            if (!deviceAllowed(preset)) {
                state.hidden.device += 1;
                return;
            }
            const category = preset.category === 'manual' ? 'manual' : 'system';
            if (state.activeTab === 'serial' && category !== 'manual') return;
            if (state.activeTab === 'mqtt' && (category !== 'system' || preset.group === 'System')) return;
            if (state.activeTab === 'system' && (category !== 'system' || preset.group !== 'System')) return;
            options.push({
                key: `command:${index}`,
                type: 'command',
                category,
                group: `${category === 'manual' ? 'Manual' : 'System'} / ${preset.group || 'Commands'}`,
                label: preset.label || preset.command,
                command: preset.command,
                payload: preset.payload || {},
                timeoutMs: preset.timeoutMs || 30000,
                waitForResponse: preset.waitForResponse !== false,
                note: preset.note || '',
                raw: preset.command === 'modem-at',
                source: preset
            });
        });

        Object.values(state.tests || {}).forEach((test) => {
            if (!test.supported) {
                state.hidden.unsupported += 1;
                return;
            }
            if (state.activeTab !== 'system') return;
            options.push({
                key: `test:${test.id}`,
                type: 'test',
                category: 'system',
                group: `System / Tests / ${test.category || 'general'}`,
                label: test.name || test.id,
                command: `test:${test.id}`,
                payload: parameterDefaults(test),
                timeoutMs: test.timeout || 30000,
                waitForResponse: true,
                note: test.description || test.supportMessage || '',
                source: test
            });
        });

        state.vendorCommands.forEach((vendorCommand, commandIndex) => {
            const transports = Array.isArray(vendorCommand.transports) ? vendorCommand.transports : [];
            if (!transports.includes(state.activeTab)) return;
            if (activeDeviceType() === 'android') {
                state.hidden.device += 1;
                return;
            }
            const command = String(vendorCommand.line || vendorCommand.command || '').trim();
            if (!command) return;
            options.push({
                key: `vendor:${commandIndex}:${state.activeTab}`,
                type: 'vendor',
                category: 'manual',
                group: `${state.activeTab === 'mqtt' ? 'MQTT AT' : 'Serial AT'} / ${vendorCommand.group || 'Vendor'}`,
                label: vendorCommand.label || command,
                command,
                payload: {},
                timeoutMs: 10000,
                waitForResponse: true,
                note: vendorCommand.note || 'Vendor AT command.',
                raw: true,
                source: vendorCommand
            });
        });

        state.options = options;
        renderOptionPicker();
        applySelectedOption(false);
    }

    function renderOptionPicker() {
        if (!elements.preset) return;
        const previous = elements.preset.value;
        const grouped = {};
        state.options.forEach((option) => {
            const group = option.group || 'Commands';
            grouped[group] = grouped[group] || [];
            grouped[group].push(option);
        });

        elements.preset.innerHTML = [
            ...Object.entries(grouped).map(([group, options]) => `
                <optgroup label="${escapeAttr(group)}">
                    ${options.map((option) => `
                        <option value="${escapeAttr(option.key)}">${escapeHtml(commandLabel(option))}</option>
                    `).join('')}
                </optgroup>
            `)
        ].join('');

        const values = new Set(Array.from(elements.preset.options).map((option) => option.value));
        if (values.has(previous)) {
            elements.preset.value = previous;
        } else if (state.options[0]) {
            elements.preset.value = state.options[0].key;
        }
    }

    function selectedOption() {
        const key = elements.preset?.value || '';
        return state.options.find((option) => option.key === key) || null;
    }

    function applySelectedOption(announce) {
        const option = selectedOption();
        if (!option) {
            renderOptionDetails();
            updateControlVisibility();
            return;
        }
        if (elements.payload) elements.payload.value = JSON.stringify(option.payload || {}, null, 2);
        if (elements.timeout) elements.timeout.value = String(option.timeoutMs || 30000);
        if (elements.wait) elements.wait.value = option.waitForResponse === false ? 'false' : 'true';
        renderOptionDetails(option);
        updateControlVisibility();
        if (announce) appendLine('picker', `Loaded ${option.label}`, 'info', option);
    }

    function renderOptionDetails(override) {
        if (!elements.optionDetails) return;
        const option = override || selectedOption();

        if (!option) {
            const active = activeDeviceType() || 'unknown';
            elements.optionDetails.innerHTML = `
                <dl class="mb-0">
                    <dt>Command</dt>
                    <dd>No command is selected for this transport/device yet.</dd>
                    <dt>Device</dt>
                    <dd>${escapeHtml(active)} / ${escapeHtml(state.currentDeviceId || '--')}</dd>
                </dl>
            `;
            return;
        }

        const supportLine = option.type === 'test'
            ? `<dt>Support</dt><dd>${escapeHtml(option.source?.supportMessage || 'Ready to run')}</dd>`
            : '';
        const sourceLine = option.source?.sources?.length
            ? `<dt>Source</dt><dd>${escapeHtml(option.source.sources.map((source) => source.file).join(', '))}</dd>`
            : '';
        const manualLine = option.category === 'manual'
            ? '<dt>Category</dt><dd>Vendor AT command. Serial sends direct; MQTT sends through modem-at passthrough.</dd>'
            : '<dt>Category</dt><dd>System owned runtime action.</dd>';

        elements.optionDetails.innerHTML = `
            <dl class="mb-0">
                <dt>${escapeHtml(option.label || option.command || 'Option')}</dt>
                <dd>${escapeHtml(option.note || 'No extra detail for this option.')}</dd>
                ${manualLine}
                <dt>Command</dt>
                <dd><code>${escapeHtml(option.command || '')}</code></dd>
                ${sourceLine}
                ${supportLine}
            </dl>
        `;
    }

    function setConsoleTab(tab) {
        const normalizedTab = ['mqtt', 'serial', 'system'].includes(tab) ? tab : 'mqtt';
        state.activeTab = normalizedTab;
        state.transport = normalizedTab === 'serial' ? 'serial' : 'mqtt';
        if (normalizedTab === 'system') {
            setMode('single');
        }
        document.querySelectorAll('[data-console-tab]').forEach((button) => {
            const isActive = button.dataset.consoleTab === normalizedTab;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        document.querySelectorAll('.mqtt-control').forEach((node) => {
            node.style.display = state.transport === 'mqtt' ? '' : 'none';
        });
        document.querySelectorAll('.serial-control').forEach((node) => {
            node.style.display = state.transport === 'serial' ? '' : 'none';
        });
        if (elements.sessionLabel) elements.sessionLabel.textContent = normalizedTab;
        renderTabHint();
        renderSerialStatus();
        rebuildOptions();
        updateControlVisibility();
    }

    function renderTabHint() {
        if (!elements.tabHint) return;
        const hints = {
            mqtt: 'MQTT publishes runtime commands to the active device.',
            serial: 'Serial sends selected manual terminal lines through browser Web Serial.',
            system: 'System runs dashboard-owned tests and system recovery actions.'
        };
        elements.tabHint.textContent = hints[state.activeTab] || '';
    }

    function setMode(mode) {
        state.mode = mode === 'chain' ? 'chain' : 'single';
        if (elements.mode) elements.mode.value = state.mode;
        document.querySelectorAll('.single-command-row').forEach((node) => {
            node.style.display = state.mode === 'single' ? '' : 'none';
        });
        document.querySelectorAll('.chain-command-row').forEach((node) => {
            node.style.display = state.mode === 'chain' ? '' : 'none';
        });
        updateControlVisibility();
    }

    function updateControlVisibility() {
        const option = selectedOption();
        if (elements.send) {
            const icon = option?.type === 'test' ? 'bi-play-fill' : 'bi-send';
            const label = option?.type === 'test' ? 'Run' : 'Send';
            elements.send.innerHTML = `<i class="bi ${icon}"></i> ${label}`;
        }
        const payloadPanel = document.getElementById('esp32PayloadPanel');
        if (payloadPanel) {
            payloadPanel.style.display = state.transport === 'mqtt' ? '' : 'none';
        }
        if (elements.mode) {
            elements.mode.disabled = state.activeTab === 'system';
        }
    }

    async function sendSelected() {
        updateDeviceBadge();
        const option = selectedOption();
        if (option?.type === 'test') {
            await runTestOption(option);
            return;
        }

        const commands = state.mode === 'chain'
            ? String(elements.chain?.value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
            : [String(option?.command || '').trim()].filter(Boolean);

        if (commands.length === 0) {
            appendLine('error', 'Command is required.', 'danger');
            return;
        }

        setSending(true, option?.type === 'test');
        try {
            if (state.transport === 'serial') {
                await sendSerialCommands(commands);
            } else {
                await sendConsoleCommands(commands);
            }
        } finally {
            setSending(false, false);
            if (state.transport === 'mqtt') refreshMqttStatus();
        }
    }

    async function runTestOption(option) {
        const testId = option.source?.id || option.command?.replace(/^test:/, '');
        if (!testId) return;
        let parameters = {};
        try {
            parameters = parsePayload();
        } catch (error) {
            appendLine('error', error.message, 'danger');
            return;
        }

        setSending(true, true);
        stopStatusPoll();
        appendLine('test', `Run ${option.label}`, 'primary', { testId, parameters, deviceId: state.currentDeviceId });
        try {
            const response = await fetch('/api/test/run', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken()
                },
                credentials: 'same-origin',
                body: JSON.stringify({ deviceId: state.currentDeviceId, testId, parameters })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.success) throw new Error(data.message || `Test failed with HTTP ${response.status}`);
            state.currentRunId = data.data?.runId || data.runId || null;
            appendLine('test', data.data?.skipped ? `${option.label} skipped` : `${option.label} started`, data.data?.skipped ? 'warning' : 'success', data);
            if (elements.lastRun) elements.lastRun.textContent = state.currentRunId ? `test / ${state.currentRunId}` : 'test / started';
            if (state.currentRunId && !data.data?.skipped) startStatusPoll();
        } catch (error) {
            appendLine('error', error.message || 'Test run failed', 'danger', { testId, message: error.message });
            if (window.showToast) window.showToast(error.message || 'Test run failed', 'danger');
        } finally {
            setSending(false, false);
        }
    }

    async function sendConsoleCommands(commands) {
        let payload;
        try {
            payload = parsePayload();
        } catch (error) {
            appendLine('error', error.message, 'danger');
            return;
        }

        const waitForResponse = elements.wait?.value !== 'false';
        const timeoutMs = Number(elements.timeout?.value || 30000);
        for (const command of commands) {
            const raw = looksLikeRawModemLine(command);
            appendLine('send', raw ? `${command} -> modem-at` : command, 'primary', {
                command,
                payload,
                raw,
                waitForResponse,
                timeoutMs
            });
            try {
                const response = await fetch('/api/esp32-console/command', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrfToken()
                    },
                    credentials: 'same-origin',
                    body: JSON.stringify({
                        deviceId: state.currentDeviceId,
                        command,
                        payload,
                        raw,
                        waitForResponse,
                        timeoutMs
                    })
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || !data.success) throw new Error(data.message || `Command failed with HTTP ${response.status}`);
                appendLine('response', `${command} completed in ${data.durationMs}ms`, 'success', data);
                if (elements.lastRun) elements.lastRun.textContent = `${command} / ${data.durationMs}ms`;
            } catch (error) {
                appendLine('error', `${command}: ${error.message}`, 'danger', { command, message: error.message });
                if (window.showToast) window.showToast(error.message || 'Command failed', 'danger');
                if (state.mode !== 'chain') return;
            }
        }
    }

    async function sendSerialCommands(commands) {
        if (!state.serial.port || !state.serial.writer) {
            appendLine('error', 'Connect serial monitor first.', 'danger');
            if (window.showToast) window.showToast('Connect serial monitor first', 'warning');
            return;
        }
        const encoder = new TextEncoder();
        for (const command of commands) {
            await state.serial.writer.write(encoder.encode(command + serialLineEnding()));
            appendLine('serial-tx', command, 'primary', {
                command,
                baudRate: Number(elements.serialBaud?.value || 115200),
                ending: elements.serialEnding?.value || 'crlf'
            });
            if (elements.lastRun) elements.lastRun.textContent = `serial / ${command}`;
        }
    }

    function startStatusPoll() {
        stopStatusPoll();
        state.statusPollTimer = window.setInterval(fetchCurrentTestStatus, 1500);
        fetchCurrentTestStatus();
    }

    function stopStatusPoll() {
        if (state.statusPollTimer) window.clearInterval(state.statusPollTimer);
        state.statusPollTimer = null;
    }

    async function fetchCurrentTestStatus() {
        if (!state.currentRunId) return;
        try {
            const response = await fetch(`/api/test/status/${encodeURIComponent(state.currentRunId)}?deviceId=${encodeURIComponent(state.currentDeviceId)}`, {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            const data = await response.json().catch(() => ({}));
            if (!data.success || !data.data) return;
            const snapshot = data.data;
            const status = snapshot.status || (snapshot.completed ? 'completed' : 'running');
            appendLine('test-poll', snapshot.message || status, status === 'failed' ? 'danger' : status === 'completed' ? 'success' : 'info', snapshot);
            if (snapshot.completed || ['completed', 'failed', 'skipped'].includes(status)) stopStatusPoll();
        } catch (error) {
            appendLine('test-poll', error.message || 'status poll error', 'danger', { message: error.message });
        }
    }

    function serialLineEnding() {
        switch (elements.serialEnding?.value) {
            case 'lf': return '\n';
            case 'cr': return '\r';
            case 'none': return '';
            case 'crlf':
            default: return '\r\n';
        }
    }

    async function toggleSerialConnection() {
        if (state.serial.port) {
            await closeSerialConnection();
            appendLine('serial', 'Serial monitor disconnected.', 'info');
            return;
        }
        await openSerialConnection();
    }

    async function openSerialConnection() {
        if (!navigator.serial) {
            appendLine('serial', 'Web Serial is not supported in this browser.', 'warning');
            if (window.showToast) window.showToast('Web Serial is not supported in this browser', 'warning');
            return;
        }
        try {
            const baudRate = Number(elements.serialBaud?.value || 115200);
            const port = await navigator.serial.requestPort();
            await port.open({ baudRate });
            state.serial.port = port;
            state.serial.writer = port.writable.getWriter();
            state.serial.reader = port.readable.getReader();
            state.serial.readLoopActive = true;
            state.serial.buffer = '';
            renderSerialStatus();
            appendLine('serial', `Serial monitor connected at ${baudRate}.`, 'success', { baudRate });
            readSerialLoop();
        } catch (error) {
            appendLine('serial', error.message || 'Serial connect failed.', 'danger', { message: error.message });
            if (window.showToast) window.showToast(error.message || 'Serial connect failed', 'danger');
            await closeSerialConnection();
        }
    }

    async function readSerialLoop() {
        const decoder = new TextDecoder();
        while (state.serial.readLoopActive && state.serial.reader) {
            try {
                const { value, done } = await state.serial.reader.read();
                if (done) break;
                if (!value) continue;
                state.serial.buffer += decoder.decode(value);
                const lines = state.serial.buffer.split(/\r?\n/);
                state.serial.buffer = lines.pop() || '';
                lines.filter(Boolean).forEach((line) => appendLine('serial-rx', line, 'info', { line }));
            } catch (error) {
                if (state.serial.readLoopActive) appendLine('serial', error.message || 'Serial read failed.', 'danger', { message: error.message });
                break;
            }
        }
    }

    async function closeSerialConnection() {
        state.serial.readLoopActive = false;
        try { await state.serial.reader?.cancel(); } catch (_) {}
        try { state.serial.reader?.releaseLock(); } catch (_) {}
        try { state.serial.writer?.releaseLock(); } catch (_) {}
        try { await state.serial.port?.close(); } catch (_) {}
        state.serial.reader = null;
        state.serial.writer = null;
        state.serial.port = null;
        state.serial.buffer = '';
        renderSerialStatus();
    }

    function renderMqttStatus(status) {
        if (!elements.mqttBadge) return;
        const connected = status?.connected === true;
        elements.mqttBadge.className = `badge ${connected ? 'text-bg-success' : 'text-bg-danger'}`;
        elements.mqttBadge.textContent = connected ? 'MQTT: connected' : 'MQTT: offline';
        elements.mqttBadge.title = status?.broker ? `Broker: ${status.broker}` : '';
    }

    function renderSerialStatus() {
        if (!elements.serialBadge) return;
        const connected = Boolean(state.serial.port);
        elements.serialBadge.className = `badge ${connected ? 'text-bg-success' : 'text-bg-secondary'}`;
        elements.serialBadge.textContent = connected ? 'Serial: connected' : 'Serial: idle';
        if (elements.serialConnect) {
            elements.serialConnect.innerHTML = connected
                ? '<i class="bi bi-x-circle"></i> Disconnect'
                : '<i class="bi bi-usb-symbol"></i> Connect';
            elements.serialConnect.className = connected ? 'btn btn-outline-danger btn-sm' : 'btn btn-outline-primary btn-sm';
        }
    }

    function updateDeviceBadge() {
        state.currentDeviceId = getCurrentDeviceId();
        if (!elements.deviceBadge) return;
        const type = activeDeviceType();
        elements.deviceBadge.textContent = `Device: ${state.currentDeviceId || '--'}${type ? ' / ' + type : ''}`;
    }

    function parsePayload() {
        const raw = String(elements.payload?.value || '').trim();
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Payload must be a JSON object.');
        return parsed;
    }

    function formatPayload() {
        try {
            if (elements.payload) elements.payload.value = JSON.stringify(parsePayload(), null, 2);
        } catch (error) {
            appendLine('error', error.message, 'danger');
        }
    }

    function setSending(isSending, isRun) {
        if (!elements.send) return;
        elements.send.disabled = isSending;
        if (isSending) {
            elements.send.innerHTML = `<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>${isRun ? 'Run' : 'Send'}`;
            return;
        }
        updateControlVisibility();
    }

    function appendLine(source, message, level, data, options = {}) {
        if (!elements.output) return;
        const entry = {
            timestamp: new Date().toISOString(),
            deviceId: state.currentDeviceId || getCurrentDeviceId(),
            deviceType: activeDeviceType(),
            source,
            message,
            level: level || 'info',
            data: data === undefined ? null : data
        };
        state.entries.push(entry);
        if (state.entries.length > MAX_EVENTS) state.entries.shift();
        renderEvents();
        if (options.persist !== false) persistEvent(entry).catch(() => {});
    }

    async function persistEvent(entry) {
        await fetch('/api/esp32-console/events', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken()
            },
            credentials: 'same-origin',
            body: JSON.stringify(entry)
        });
    }

    function renderEvents() {
        if (!elements.output) return;
        elements.output.innerHTML = state.entries.map((entry, index) => `
            <button type="button" class="console-event ${levelClass(entry.level)}" data-entry-index="${index}">
                <span class="event-time">${escapeHtml(formatEventTime(entry.timestamp))}</span>
                <span class="event-source">${escapeHtml(entry.source)}</span>
                <span class="event-message">${escapeHtml(entry.message)}</span>
            </button>
        `).join('');
        elements.output.querySelectorAll('[data-entry-index]').forEach((button) => {
            button.addEventListener('click', () => showEventDetails(Number(button.dataset.entryIndex)));
        });
        elements.output.scrollTop = elements.output.scrollHeight;
    }

    function showEventDetails(index) {
        const entry = state.entries[index];
        if (!entry) return;
        if (elements.detailTitle) elements.detailTitle.textContent = `${entry.source} / ${entry.message}`;
        if (elements.detailSummary) {
            elements.detailSummary.innerHTML = `
                <dt class="col-sm-3">Time</dt><dd class="col-sm-9">${escapeHtml(entry.timestamp)}</dd>
                <dt class="col-sm-3">Device</dt><dd class="col-sm-9">${escapeHtml(entry.deviceId || '--')} ${escapeHtml(entry.deviceType || '')}</dd>
                <dt class="col-sm-3">Source</dt><dd class="col-sm-9">${escapeHtml(entry.source)}</dd>
                <dt class="col-sm-3">Level</dt><dd class="col-sm-9">${escapeHtml(entry.level || 'info')}</dd>
                <dt class="col-sm-3">Message</dt><dd class="col-sm-9">${escapeHtml(entry.message)}</dd>
            `;
        }
        if (elements.detailJson) elements.detailJson.textContent = JSON.stringify(entry.data ?? entry, null, 2);
        if (window.bootstrap?.Modal && elements.detailModal) window.bootstrap.Modal.getOrCreateInstance(elements.detailModal).show();
    }

    async function clearConsole() {
        state.entries = [];
        renderEvents();
        try {
            await fetch('/api/esp32-console/events', {
                method: 'DELETE',
                headers: { 'X-CSRF-Token': csrfToken() },
                credentials: 'same-origin'
            });
        } catch (_) {}
        appendLine('system', 'Events cleared.', 'info');
    }

    function exportConsole() {
        const text = state.entries.map((entry) => JSON.stringify(entry)).join('\n');
        const blob = new Blob([text || ''], { type: 'application/x-ndjson;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `console-events-${Date.now()}.ndjson`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    function deviceAllowed(item) {
        const types = Array.isArray(item.deviceTypes) ? item.deviceTypes.map(normalizeDeviceType) : [];
        const type = activeDeviceType();
        if (!types.length || !type) return true;
        return types.includes(type);
    }

    function parameterDefaults(test) {
        const defaults = {};
        (test?.parameters || []).forEach((param) => {
            if (param.default !== undefined) defaults[param.name] = param.default;
        });
        return defaults;
    }

    function commandLabel(option) {
        const prefix = option.type === 'test'
            ? 'Test'
            : (option.type === 'vendor' ? (state.activeTab === 'mqtt' ? 'MQTT AT' : 'Serial AT') : (state.activeTab === 'mqtt' ? 'MQTT' : 'System'));
        return `${prefix} - ${option.label || option.command || 'Command'}`;
    }

    function sameDevice(deviceId) {
        const normalized = String(deviceId || '').trim();
        return !normalized || !state.currentDeviceId || normalized === state.currentDeviceId;
    }

    function sameRun(payload) {
        return sameDevice(payload?.deviceId) && (!state.currentRunId || payload?.runId === state.currentRunId);
    }

    function looksLikeRawModemLine(value) {
        const line = String(value || '').trim();
        if (!line) return false;
        const normalized = line.toLowerCase();
        const knownPreset = state.presets.some((preset) => String(preset.command || '').toLowerCase() === normalized);
        if (knownPreset || normalized === 'modem-at') return false;
        if (/^a(?:t)?(?:$|[+?=,])/i.test(line)) return true;
        return !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(line) && /[+?=,"\s]/.test(line);
    }

    function summarizeAsyncResponse(payload) {
        const command = payload?.command || payload?.data?.command || 'command';
        const result = payload?.result || payload?.status || payload?.data?.result || 'response';
        return `${command}: ${result}`;
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

    function getCurrentDeviceId() {
        if (typeof window.getActiveDeviceId === 'function') return String(window.getActiveDeviceId() || '').trim();
        return String(window.DEVICE_ID || localStorage.getItem('activeDeviceId') || '').trim();
    }

    function activeDeviceType() {
        if (typeof window.getActiveDeviceType === 'function') return normalizeDeviceType(window.getActiveDeviceType());
        return normalizeDeviceType(window.ACTIVE_DEVICE_TYPE || localStorage.getItem('activeDeviceType') || '');
    }

    function normalizeDeviceType(value) {
        return String(value || '').trim().toLowerCase();
    }

    function csrfToken() {
        return document.querySelector('meta[name="csrf-token"]')?.content || '';
    }

    function formatEventTime(value) {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return String(value || '').slice(0, 12);
        return date.toLocaleTimeString();
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeAttr(value) {
        return escapeHtml(value);
    }
})();
