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
        systemLogTimer: null,
        entries: [],
        systemLogs: [],
        activeTab: 'system',
        systemLogSource: 'app',
        systemLogSearch: '',
        clearedViews: {
            serial: 0,
            mqtt: 0,
            'log:app': 0,
            'log:mqtt': 0,
            'log:error': 0,
            'log:manual': 0
        },
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
        detailJson: document.getElementById('esp32EventDetailJson'),
        page: document.querySelector('.esp32-console-page'),
        commandPanel: document.getElementById('esp32CommandPanel'),
        systemLogPanel: document.getElementById('esp32SystemLogPanel'),
        systemLogLevel: document.getElementById('esp32SystemLogLevel'),
        systemLogLimit: document.getElementById('esp32SystemLogLimit'),
        systemLogSearch: document.getElementById('esp32SystemLogSearch'),
        systemCounts: {
            app: document.getElementById('esp32SystemAppCount'),
            mqtt: document.getElementById('esp32SystemMqttCount'),
            error: document.getElementById('esp32SystemErrorCount'),
            manual: document.getElementById('esp32SystemManualCount')
        }
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
        setConsoleTab(initialTab());
        setMode('single');
        await Promise.allSettled([
            loadCatalog(),
            loadTests(),
            loadPersistedEvents(),
            loadSystemLogs(),
            refreshMqttStatus()
        ]);
        rebuildOptions();
        renderEvents();
    }

    function attachEvents() {
        elements.send?.addEventListener('click', sendSelected);
        elements.clear?.addEventListener('click', clearConsole);
        elements.export?.addEventListener('click', exportConsole);
        elements.format?.addEventListener('click', formatPayload);
        document.querySelectorAll('[data-console-tab]').forEach((button) => {
            button.addEventListener('click', () => setConsoleTab(button.dataset.consoleTab || 'mqtt'));
        });
        document.querySelectorAll('[data-system-log-source]').forEach((button) => {
            button.addEventListener('click', () => setSystemLogSource(button.dataset.systemLogSource || 'app'));
        });
        elements.systemLogLevel?.addEventListener('change', () => loadSystemLogs());
        elements.systemLogLimit?.addEventListener('change', () => loadSystemLogs());
        elements.systemLogSearch?.addEventListener('input', () => {
            state.systemLogSearch = String(elements.systemLogSearch.value || '').toLowerCase();
            renderEvents();
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
            appendLine('system', `Active device switched to ${state.currentDeviceId || 'none'}.`, 'info', null, { scope: 'system', tab: 'system' });
        });
        window.addEventListener('beforeunload', () => {
            stopStatusPoll();
            stopSystemLogRefresh();
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
        state.entries = (data.data || []).map(normalizeConsoleEvent).slice(-MAX_EVENTS);
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

    async function loadSystemLogs(source = state.systemLogSource) {
        if (state.activeTab !== 'system' && source === state.systemLogSource) return;
        if (source === 'manual') {
            state.systemLogs = [];
            updateSystemCount('manual', visibleManualLogRows().length);
            renderEvents();
            return;
        }
        const params = new URLSearchParams({
            source,
            limit: String(elements.systemLogLimit?.value || 100)
        });
        const level = String(elements.systemLogLevel?.value || '').trim();
        if (level) params.set('level', level);
        try {
            const response = await fetch('/api/logs?' + params.toString(), {
                credentials: 'same-origin',
                cache: 'no-store'
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.success) throw new Error(data.message || 'Failed to load logs');
            state.systemLogs = (data.entries || []).map((entry) => normalizeSystemLogEntry(entry, source));
            updateSystemCount(source, visibleSystemLogRows(source).length);
            renderEvents();
        } catch (error) {
            state.systemLogs = [normalizeSystemLogEntry({
                timestamp: new Date().toISOString(),
                level: 'error',
                message: error.message || 'Failed to load logs'
            }, source)];
            updateSystemCount(source, 0);
            renderEvents();
        }
    }

    function rebuildOptions() {
        const options = [];
        state.hidden = { unsupported: 0, device: 0 };
        if (state.activeTab === 'system') {
            state.options = [];
            renderOptionPicker();
            renderOptionDetails();
            updateControlVisibility();
            return;
        }

        state.presets.forEach((preset, index) => {
            if (!deviceAllowed(preset)) {
                state.hidden.device += 1;
                return;
            }
            const category = preset.category === 'manual' ? 'manual' : 'system';
            if (state.activeTab === 'serial' && category !== 'manual') return;
            if (state.activeTab === 'mqtt' && category !== 'manual' && category !== 'system') return;
            options.push({
                key: `command:${index}`,
                type: 'command',
                category,
                group: `${commandGroupPrefix(category)} / ${preset.group || 'Commands'}`,
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
            }
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
            : '<dt>Category</dt><dd>Dashboard-owned runtime action sent over MQTT.</dd>';

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

    function setSystemLogSource(source) {
        const normalized = ['app', 'mqtt', 'error', 'manual'].includes(source) ? source : 'app';
        state.systemLogSource = normalized;
        document.querySelectorAll('[data-system-log-source]').forEach((button) => {
            const isActive = button.dataset.systemLogSource === normalized;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        loadSystemLogs(normalized);
    }

    function setConsoleTab(tab) {
        const normalizedTab = ['system', 'serial', 'mqtt'].includes(tab) ? tab : 'system';
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
        if (elements.commandPanel) {
            elements.commandPanel.style.display = normalizedTab === 'system' ? 'none' : '';
        }
        if (elements.systemLogPanel) {
            elements.systemLogPanel.style.display = normalizedTab === 'system' ? '' : 'none';
        }
        elements.page?.classList.toggle('is-logs-tab', normalizedTab === 'system');
        elements.page?.classList.toggle('is-serial-tab', normalizedTab === 'serial');
        elements.page?.classList.toggle('is-mqtt-tab', normalizedTab === 'mqtt');
        if (elements.sessionLabel) elements.sessionLabel.textContent = normalizedTab === 'system' ? 'logs' : normalizedTab;
        renderTabHint();
        renderSerialStatus();
        rebuildOptions();
        updateControlVisibility();
        if (normalizedTab === 'system') {
            loadSystemLogs();
            startSystemLogRefresh();
        } else {
            stopSystemLogRefresh();
            renderEvents();
        }
    }

    function renderTabHint() {
        if (!elements.tabHint) return;
        const hints = {
            system: 'App, MQTT, error, and manual command logs. Rows are clickable for details.',
            serial: 'Serial sends selected manual terminal lines through browser Web Serial.',
            mqtt: 'MQTT sends selected manual vendor lines through the modem-at passthrough.'
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
                const resultText = summarizeCommandResult(command, data);
                appendLine('response', resultText, commandResultLevel(data), data);
                if (elements.lastRun) elements.lastRun.textContent = `${command} / ${resultText}`;
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

    function startSystemLogRefresh() {
        stopSystemLogRefresh();
        state.systemLogTimer = window.setInterval(() => {
            if (state.activeTab === 'system') loadSystemLogs();
        }, 10000);
    }

    function stopSystemLogRefresh() {
        if (state.systemLogTimer) window.clearInterval(state.systemLogTimer);
        state.systemLogTimer = null;
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
        const manualSources = new Set(['send', 'response', 'console', 'serial', 'serial-tx', 'serial-rx', 'picker', 'error']);
        const scope = options.scope || (state.activeTab !== 'system' && manualSources.has(source) ? 'manual' : 'system');
        const entry = {
            timestamp: new Date().toISOString(),
            deviceId: state.currentDeviceId || getCurrentDeviceId(),
            deviceType: activeDeviceType(),
            consoleTab: options.tab || state.activeTab,
            scope,
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
        const rows = state.activeTab === 'system'
            ? filteredLogRows()
            : state.entries
                .map((entry, index) => ({ ...entry, __entryIndex: index }))
                .filter((entry) => entry.scope === 'manual' && entry.consoleTab === state.activeTab)
                .filter((entry) => !isClearedFromView(entry, state.activeTab));

        if (!rows.length) {
            elements.output.innerHTML = `
                <button type="button" class="console-event text-muted" disabled>
                    <span class="event-time">--</span>
                    <span class="event-source">${escapeHtml(displayTabName(state.activeTab))}</span>
                    <span class="event-message">${escapeHtml(emptyConsoleMessage())}</span>
                </button>
            `;
            return;
        }

        elements.output.innerHTML = rows.map((entry) => `
            <button type="button" class="console-event ${levelClass(entry.level)}" data-entry-index="${entry.__entryIndex ?? ''}" data-system-index="${entry.__systemIndex ?? ''}">
                <span class="event-time">${escapeHtml(formatEventTime(entry.timestamp))}</span>
                <span class="event-source">${escapeHtml(entry.source)}</span>
                <span class="event-message">${escapeHtml(entry.message)}</span>
            </button>
        `).join('');
        elements.output.querySelectorAll('[data-entry-index]').forEach((button) => {
            button.addEventListener('click', () => {
                if (button.dataset.entryIndex !== '') {
                    showEventDetails(Number(button.dataset.entryIndex));
                    return;
                }
                if (button.dataset.systemIndex !== '') {
                    showSystemLogDetails(Number(button.dataset.systemIndex));
                    return;
                }
            });
        });
        elements.output.scrollTop = elements.output.scrollHeight;
    }

    function filteredLogRows() {
        const search = state.systemLogSearch;
        const systemRows = state.systemLogSource === 'manual' ? [] : visibleSystemLogRows(state.systemLogSource);
        const manualRows = state.systemLogSource === 'manual' ? visibleManualLogRows() : [];
        return [...systemRows, ...manualRows]
            .filter((entry) => !search || JSON.stringify(entry).toLowerCase().includes(search))
            .sort((left, right) => toTimestampMs(left.timestamp) - toTimestampMs(right.timestamp));
    }

    function visibleSystemLogRows(source) {
        return state.systemLogs
            .map((entry, index) => ({ ...entry, __systemIndex: index }))
            .filter((entry) => !isClearedFromView(entry, `log:${source}`));
    }

    function visibleManualLogRows() {
        return state.entries
            .map((entry, index) => ({ ...entry, __entryIndex: index }))
            .filter((entry) => entry.scope === 'manual')
            .filter((entry) => !isClearedFromView(entry, 'log:manual'))
            .map((entry) => ({
                ...entry,
                source: `manual:${entry.consoleTab || 'command'}:${entry.source || 'console'}`
            }));
    }

    function emptyConsoleMessage() {
        if (state.activeTab === 'system') return 'No log entries for this source/filter.';
        return 'Pick a manual command option and send it to see rows here.';
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
        renderDetailJson(entry, entry.data ?? entry);
        if (window.bootstrap?.Modal && elements.detailModal) window.bootstrap.Modal.getOrCreateInstance(elements.detailModal).show();
    }

    function showSystemLogDetails(index) {
        const entry = state.systemLogs[index];
        if (!entry) return;
        if (elements.detailTitle) elements.detailTitle.textContent = `${entry.source} / ${entry.message}`;
        if (elements.detailSummary) {
            elements.detailSummary.innerHTML = `
                <dt class="col-sm-3">Time</dt><dd class="col-sm-9">${escapeHtml(entry.timestamp || '--')}</dd>
                <dt class="col-sm-3">Source</dt><dd class="col-sm-9">${escapeHtml(entry.source || '--')}</dd>
                <dt class="col-sm-3">Level</dt><dd class="col-sm-9">${escapeHtml(entry.level || 'info')}</dd>
                <dt class="col-sm-3">Message</dt><dd class="col-sm-9">${escapeHtml(entry.message || '')}</dd>
            `;
        }
        renderDetailJson(entry, entry.data ?? entry);
        if (window.bootstrap?.Modal && elements.detailModal) window.bootstrap.Modal.getOrCreateInstance(elements.detailModal).show();
    }

    function renderDetailJson(entry, value) {
        if (!elements.detailJson) return;
        elements.detailJson.textContent = JSON.stringify(buildReadableDetail(entry, value), null, 2);
    }

    function buildReadableDetail(entry, value) {
        const parsed = parseNestedJson(value);
        const chain = extractCommandChain(entry, parsed);
        const summary = {
            timestamp: entry?.timestamp || '',
            source: entry?.source || '',
            level: entry?.level || 'info',
            tab: displayTabName(entry?.consoleTab || state.activeTab),
            scope: entry?.scope || ''
        };
        return chain.length
            ? { summary, chain, parsed }
            : { summary, parsed };
    }

    async function clearConsole() {
        const viewKey = state.activeTab === 'system' ? `log:${state.systemLogSource}` : state.activeTab;
        state.clearedViews[viewKey] = Date.now();
        if (state.activeTab === 'system') {
            updateSystemCount(state.systemLogSource, 0);
        }
        renderEvents();
    }

    function exportConsole() {
        const sourceRows = state.activeTab === 'system'
            ? filteredLogRows()
            : state.entries
                .filter((entry) => entry.scope === 'manual' && entry.consoleTab === state.activeTab)
                .filter((entry) => !isClearedFromView(entry, state.activeTab));
        const text = sourceRows.map((entry) => JSON.stringify(entry)).join('\n');
        const blob = new Blob([text || ''], { type: 'application/x-ndjson;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `console-${state.activeTab}-${Date.now()}.ndjson`;
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
            : (option.type === 'vendor'
                ? (state.activeTab === 'mqtt' ? 'MQTT AT' : 'Serial AT')
                : (option.category === 'system' ? 'MQTT Runtime' : (state.activeTab === 'mqtt' ? 'MQTT Manual' : 'Serial Manual')));
        return `${prefix} - ${option.label || option.command || 'Command'}`;
    }

    function commandGroupPrefix(category) {
        if (category === 'system') return 'MQTT Runtime';
        return state.activeTab === 'mqtt' ? 'MQTT Manual' : 'Serial Manual';
    }

    function normalizeSystemLogEntry(entry, source) {
        const log = entry && typeof entry === 'object' ? entry : {};
        const message = String(log.message || log.msg || log.event || JSON.stringify(log));
        return {
            timestamp: log.timestamp || log.time || new Date().toISOString(),
            source: `system:${source}`,
            level: String(log.level || (source === 'error' ? 'error' : 'info')).toLowerCase(),
            message,
            data: log
        };
    }

    function normalizeConsoleEvent(entry) {
        const event = entry && typeof entry === 'object' ? entry : {};
        const source = String(event.source || 'console');
        const manualSources = new Set(['send', 'response', 'serial', 'serial-tx', 'serial-rx', 'picker', 'error']);
        return {
            ...event,
            consoleTab: event.consoleTab || (source.startsWith('serial') ? 'serial' : (manualSources.has(source) ? 'mqtt' : 'system')),
            scope: event.scope || (manualSources.has(source) ? 'manual' : 'system')
        };
    }

    function parseNestedJson(value, depth = 0) {
        if (depth > 6) return value;
        if (typeof value === 'string') {
            const parsed = parseJsonString(value);
            return parsed === value ? value : parseNestedJson(parsed, depth + 1);
        }
        if (Array.isArray(value)) {
            return value.map((item) => parseNestedJson(item, depth + 1));
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(
                Object.entries(value).map(([key, item]) => [key, parseNestedJson(item, depth + 1)])
            );
        }
        return value;
    }

    function parseJsonString(value) {
        const text = String(value || '').trim();
        if (!text || !/^[{[]/.test(text)) return value;
        try {
            return JSON.parse(text);
        } catch (_) {
            return value;
        }
    }

    function extractCommandChain(entry, parsed) {
        const source = entry?.data && typeof entry.data === 'object' ? entry.data : {};
        const root = parsed && typeof parsed === 'object' ? parsed : {};
        const transport = entry?.consoleTab || state.activeTab || '';
        const payload = root.payload || source.payload || {};
        const explicitCommands = Array.isArray(root.commands) ? root.commands : (Array.isArray(source.commands) ? source.commands : []);
        const chainText = root.command_chain || root.commandChain || source.command_chain || source.commandChain || '';
        const commandText = root.command || source.command || '';
        const commands = explicitCommands.length
            ? explicitCommands
            : String(chainText || commandText || '')
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);

        if (!commands.length) return [];
        return commands.map((command, index) => ({
            step: index + 1,
            transport: displayTabName(transport),
            command: typeof command === 'string' ? command : command?.command || command?.line || command,
            payload: parseNestedJson(command?.payload || payload || {}),
            raw: Boolean(root.raw || source.raw || looksLikeRawModemLine(command?.command || command?.line || command))
        }));
    }

    function updateSystemCount(source, count) {
        const badge = elements.systemCounts?.[source];
        if (badge) badge.textContent = String(count || 0);
    }

    function initialTab() {
        try {
            const tab = new URL(window.location.href).searchParams.get('tab');
            if (['system', 'serial', 'mqtt'].includes(tab)) return tab;
            if (tab === 'logs') return 'system';
        } catch (_) {}
        return 'system';
    }

    function displayTabName(tab) {
        return tab === 'system' ? 'logs' : String(tab || '');
    }

    function isClearedFromView(entry, tab) {
        const clearedAt = Number(state.clearedViews?.[tab] || 0);
        if (!clearedAt) return false;
        return toTimestampMs(entry?.timestamp) <= clearedAt;
    }

    function toTimestampMs(value) {
        const parsed = Date.parse(value || '');
        return Number.isFinite(parsed) ? parsed : 0;
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
        return summarizeCommandResult(command, payload);
    }

    function summarizeCommandResult(command, payload) {
        const data = parseNestedJson(payload || {});
        const result = data.result || data.data?.result || data.response || data.data?.response || {};
        const resultObject = result && typeof result === 'object' ? result : {};
        const status = data.status || data.data?.status || resultObject.status || resultObject.result || (data.success ? 'ok' : '');
        const message = data.message || data.data?.message || resultObject.message || resultObject.error || '';
        const rawLine = data.rawLine || data.raw_line || data.data?.rawLine || data.data?.raw_line || '';
        const modemText = resultObject.line || resultObject.response || resultObject.raw || resultObject.text || '';
        const duration = data.durationMs != null ? `${data.durationMs}ms` : '';
        const parts = [
            command || data.command || 'command',
            status ? String(status) : '',
            message ? String(message) : '',
            rawLine ? String(rawLine) : '',
            modemText ? String(modemText) : '',
            duration
        ].filter(Boolean);
        return parts.join(' / ') || `${command || 'command'} / result received`;
    }

    function commandResultLevel(payload) {
        const data = parseNestedJson(payload || {});
        const statusText = JSON.stringify([
            data.status,
            data.message,
            data.result,
            data.data?.status,
            data.data?.result
        ]).toLowerCase();
        if (data.success === false || /fail|error|timeout|denied|invalid/.test(statusText)) return 'danger';
        if (/warn|skip|partial/.test(statusText)) return 'warning';
        return 'success';
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
