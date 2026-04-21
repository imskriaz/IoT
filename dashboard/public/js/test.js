(function () {
    'use strict';

    const state = {
        categories: {},
        availableTests: {},
        caps: {},
        history: [],
        currentDeviceId: window.getActiveDeviceId ? window.getActiveDeviceId() : '',
        currentRunId: null,
        seenLogs: new Set(),
        statusPollTimer: null
    };

    const elements = {
        testConsole: document.getElementById('testConsole'),
        testCategory: document.getElementById('testCategory'),
        testSelector: document.getElementById('testSelector'),
        parameterContainer: document.getElementById('testParameters'),
        runTestBtn: document.getElementById('runTestBtn'),
        stopTestBtn: document.getElementById('stopTestBtn'),
        runAllBtn: document.getElementById('runAllBtn'),
        clearResultsBtn: document.getElementById('clearResultsBtn'),
        testProgressBar: document.getElementById('testProgressBar'),
        testStatus: document.getElementById('testStatus'),
        currentTestName: document.getElementById('currentTestName'),
        liveTestResult: document.getElementById('liveTestResult'),
        testSuccessCount: document.getElementById('testSuccessCount'),
        testFailCount: document.getElementById('testFailCount'),
        testTotalCount: document.getElementById('testTotalCount'),
        deviceTestStatusText: document.getElementById('deviceTestStatusText'),
        deviceTestStatus: document.getElementById('deviceTestStatus'),
        detailedResults: document.getElementById('detailedResults'),
        resultTimestamp: document.getElementById('resultTimestamp'),
        supportNotice: document.getElementById('testSupportNotice')
    };

    const socket = window.socket || null;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    async function init() {
        attachEventListeners();
        attachSocketListeners();
        await Promise.all([
            loadAvailableTests(),
            loadCategories(),
            loadHistory()
        ]);
        updateDeviceBadge('ready', 'Ready');
        addConsoleLine('System', 'Test explorer ready. Pick a test from the dropdown or run all.', 'success');
        renderQuickTestBadges();
    }

    async function loadAvailableTests() {
        const res = await fetch(`/api/test/available?deviceId=${encodeURIComponent(state.currentDeviceId)}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Failed to load tests');
        state.availableTests = data.data || {};
        state.caps = data.caps || {};
    }

    async function loadCategories() {
        const res = await fetch(`/api/test/categories?deviceId=${encodeURIComponent(state.currentDeviceId)}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Failed to load test categories');
        state.categories = data.data || {};
        renderCategoryOptions();
    }

    async function loadHistory() {
        const res = await fetch(`/api/test/results?deviceId=${encodeURIComponent(state.currentDeviceId)}&limit=50`);
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Failed to load test history');
        state.history = data.data || [];
        renderHistory();
        updateHistoryStats();
    }

    function attachEventListeners() {
        elements.testCategory?.addEventListener('change', onCategoryChange);
        elements.testSelector?.addEventListener('change', onTestChange);
        elements.runTestBtn?.addEventListener('click', runSelectedTest);
        elements.runAllBtn?.addEventListener('click', runAllTests);
        elements.stopTestBtn?.addEventListener('click', stopCurrentTest);
        elements.clearResultsBtn?.addEventListener('click', clearTestResults);
        window.addEventListener('device:changed', async () => {
            state.currentDeviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';
            await Promise.all([loadAvailableTests(), loadCategories(), loadHistory()]);
            renderQuickTestBadges();
            onCategoryChange();
            updateDeviceBadge('ready', 'Ready');
            addConsoleLine('System', `Active device switched to ${state.currentDeviceId}`, 'info');
        });
    }

    function attachSocketListeners() {
        if (!socket) return;

        socket.off?.('test:trace');
        socket.on('test:trace', (trace) => {
            if (trace.deviceId !== state.currentDeviceId || trace.runId !== state.currentRunId) return;
            appendTrace(trace);
        });

        socket.off?.('test:progress');
        socket.on('test:progress', (payload) => {
            if (payload.deviceId !== state.currentDeviceId || payload.runId !== state.currentRunId) return;
            if (payload.message) {
                addConsoleLine('Progress', payload.message, 'info', payload.progress == null ? null : { progress: payload.progress });
            }
            if (payload.progress != null) {
                setProgress(payload.progress, payload.message || 'Running...');
            }
        });

        socket.off?.('test:status');
        socket.on('test:status', (payload) => {
            if (payload.deviceId !== state.currentDeviceId || payload.runId !== state.currentRunId) return;
            if (payload.message) {
                addConsoleLine('Status', payload.message, payload.status === 'failed' ? 'danger' : payload.status === 'completed' ? 'success' : 'warning', payload.details);
            }
            finishRun(payload);
        });
    }

    function renderCategoryOptions() {
        if (!elements.testCategory) return;
        const options = ['<option value="">Select Category</option>'];
        for (const [categoryId, category] of Object.entries(state.categories)) {
            options.push(`<option value="${escapeHtml(categoryId)}">${escapeHtml(category.name)}</option>`);
        }
        elements.testCategory.innerHTML = options.join('');
    }

    function onCategoryChange() {
        const categoryId = elements.testCategory?.value;
        const options = ['<option value="">Select a test to run...</option>'];
        if (categoryId && state.categories[categoryId]) {
            for (const test of state.categories[categoryId].tests) {
                const suffix = test.supported ? '' : ' [pending firmware]';
                options.push(`<option value="${escapeHtml(test.id)}">${escapeHtml(test.name + suffix)}</option>`);
            }
        }
        if (elements.testSelector) elements.testSelector.innerHTML = options.join('');
        if (elements.parameterContainer) elements.parameterContainer.innerHTML = '';
        renderSelectedTestSupport(null);
    }

    function onTestChange() {
        const testId = elements.testSelector?.value;
        const test = state.availableTests[testId];
        if (!test || !elements.parameterContainer) {
            elements.parameterContainer.innerHTML = '';
            renderSelectedTestSupport(null);
            return;
        }

        if (!Array.isArray(test.parameters) || test.parameters.length === 0) {
            elements.parameterContainer.innerHTML = '<div class="small text-muted pt-2">No parameters required</div>';
            renderSelectedTestSupport(test);
            return;
        }

        elements.parameterContainer.innerHTML = test.parameters.map((param) => renderParameterField(param)).join('');
        renderSelectedTestSupport(test);
    }

    function renderSelectedTestSupport(test) {
        if (!elements.supportNotice) return;

        if (!test) {
            elements.supportNotice.classList.add('d-none');
            elements.supportNotice.textContent = '';
            if (elements.runTestBtn) elements.runTestBtn.disabled = false;
            return;
        }

        if (test.supported) {
            elements.supportNotice.classList.add('d-none');
            elements.supportNotice.textContent = '';
            if (elements.runTestBtn) elements.runTestBtn.disabled = false;
            return;
        }

        elements.supportNotice.classList.remove('d-none');
        elements.supportNotice.textContent = test.supportMessage || 'This test is waiting for firmware support.';
        if (elements.runTestBtn) elements.runTestBtn.disabled = false;
    }

    function renderQuickTestBadges() {
        document.querySelectorAll('[data-test-badge]').forEach((badge) => {
            const testId = badge.getAttribute('data-test-badge');
            const test = state.availableTests[testId];
            if (!test) return;

            badge.classList.remove('opacity-50');
            badge.title = test.supported ? test.description || test.name : (test.supportMessage || 'Waiting for firmware support');

            if (!test.supported) {
                badge.classList.add('opacity-50');
            }
        });
    }

    function renderParameterField(param) {
        const label = `<label class="form-label form-label-sm mb-1 small">${escapeHtml(param.name)}</label>`;
        if (param.type === 'select') {
            const options = (param.options || []).map((option) => {
                const selected = option === param.default ? ' selected' : '';
                return `<option value="${escapeHtml(option)}"${selected}>${escapeHtml(option)}</option>`;
            }).join('');
            return `<div class="mb-1">${label}<select class="form-select form-select-sm test-param" data-param="${escapeHtml(param.name)}">${options}</select></div>`;
        }

        const inputType = param.type === 'password' ? 'password' : param.type === 'number' ? 'number' : 'text';
        const value = param.default == null ? '' : String(param.default);
        const min = param.min != null ? ` min="${param.min}"` : '';
        const max = param.max != null ? ` max="${param.max}"` : '';
        return `<div class="mb-1">${label}<input type="${inputType}" class="form-control form-control-sm test-param" data-param="${escapeHtml(param.name)}" value="${escapeHtml(value)}"${min}${max}></div>`;
    }

    function collectParameters() {
        const params = {};
        document.querySelectorAll('.test-param').forEach((input) => {
            const key = input.dataset.param;
            if (!key) return;
            if (input.type === 'number') {
                params[key] = input.value === '' ? null : Number(input.value);
            } else {
                params[key] = input.value;
            }
        });
        return params;
    }

    async function runSelectedTest() {
        const testId = elements.testSelector?.value;
        if (!testId) {
            addConsoleLine('Explorer', 'Select a test first.', 'warning');
            return;
        }
        if (state.availableTests[testId] && !state.availableTests[testId].supported) {
            addConsoleLine('Explorer', state.availableTests[testId].supportMessage, 'warning');
        }
        await startRun(testId, collectParameters());
    }

    async function runAllTests() {
        await startRun('fullSystem', {});
    }

    async function startRun(testId, parameters) {
        const payload = { testId, parameters, deviceId: state.currentDeviceId };
        const testName = state.availableTests[testId]?.name || testId;

        resetRunState();
        state.currentRunId = null;
        setBusy(true);
        setProgress(3, 'Preparing...');
        updateCurrentTest(testName, 'Running');

        addConsoleLine('Explorer', 'test initiated', 'info', { testId, testName, deviceId: state.currentDeviceId });
        addConsoleLine('Explorer', 'send to api', 'info', { url: '/api/test/run', payload });

        try {
            const res = await fetch('/api/test/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!data.success) {
                throw new Error(data.message || 'Failed to start test');
            }

            state.currentRunId = data.data.runId;
            addConsoleLine('API', 'api accepted', 'success', data);
            if (data.data.skipped) {
                addConsoleLine('Explorer', data.message || 'test skipped', 'warning', data.data);
                finishRun({ status: 'skipped', message: data.message || 'Test skipped', details: data.data });
                return;
            }
            addConsoleLine('Explorer', 'delivered to device, waiting for response', 'info');
            setProgress(8, 'Queued...');
            startStatusPolling();
        } catch (error) {
            addConsoleLine('Error', 'api error', 'danger', { message: error.message });
            finishRun({ status: 'failed', message: error.message });
        }
    }

    function startStatusPolling() {
        stopStatusPolling();
        if (!state.currentRunId) return;
        state.statusPollTimer = window.setInterval(fetchCurrentStatus, 1000);
        fetchCurrentStatus();
    }

    function stopStatusPolling() {
        if (state.statusPollTimer) {
            window.clearInterval(state.statusPollTimer);
            state.statusPollTimer = null;
        }
    }

    async function fetchCurrentStatus() {
        if (!state.currentRunId) return;
        try {
            const res = await fetch(`/api/test/status/${encodeURIComponent(state.currentRunId)}?deviceId=${encodeURIComponent(state.currentDeviceId)}`);
            const data = await res.json();
            if (!data.success) return;
            processStatusSnapshot(data.data);
        } catch (error) {
            addConsoleLine('Poll', 'status poll error', 'danger', { message: error.message });
        }
    }

    function processStatusSnapshot(status) {
        if (!status) return;

        if (Array.isArray(status.logs)) {
            status.logs.forEach(appendTrace);
        }

        if (status.progress != null) {
            setProgress(status.progress, status.message || status.status || 'Running...');
        }

        if (status.message) {
            elements.liveTestResult.innerHTML = `<span class="text-muted">${escapeHtml(status.message)}</span>`;
        }

        if (status.completed || ['completed', 'failed', 'stopped', 'skipped'].includes(status.status)) {
            finishRun(status);
        }
    }

    function appendTrace(trace) {
        const key = `${trace.timestamp || ''}|${trace.message || ''}|${JSON.stringify(trace.data || null)}`;
        if (state.seenLogs.has(key)) return;
        state.seenLogs.add(key);
        addConsoleLine('Trace', trace.message, normalizeLevel(trace.level), trace.data, trace.timestamp);
    }

    async function stopCurrentTest() {
        if (!state.currentRunId) return;
        try {
            const res = await fetch(`/api/test/stop/${encodeURIComponent(state.currentRunId)}?deviceId=${encodeURIComponent(state.currentDeviceId)}`, {
                method: 'POST'
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.message || 'Failed to stop test');
            addConsoleLine('Explorer', 'test stopped by user', 'warning');
        } catch (error) {
            addConsoleLine('Error', 'stop failed', 'danger', { message: error.message });
        }
    }

    async function clearTestResults() {
        if (!window.confirm('Clear all test history?')) return;
        try {
            const res = await fetch(`/api/test/history?deviceId=${encodeURIComponent(state.currentDeviceId)}`, { method: 'DELETE' });
            const data = await res.json();
            if (!data.success) throw new Error(data.message || 'Failed to clear history');
            state.history = [];
            renderHistory();
            updateHistoryStats();
            addConsoleLine('Explorer', 'test history cleared', 'success');
        } catch (error) {
            addConsoleLine('Error', 'clear failed', 'danger', { message: error.message });
        }
    }

    function finishRun(status) {
        if (!status) status = { status: 'completed', message: 'Test finished' };
        stopStatusPolling();
        setBusy(false);
        const success = status.status === 'completed';
        const skipped = status.status === 'skipped';
        updateCurrentTest(
            elements.currentTestName?.textContent || 'None',
            success ? 'Completed' : skipped ? 'Skipped' : status.status || 'Idle'
        );
        setProgress((success || skipped) ? 100 : 0, success ? 'Completed' : (status.message || (skipped ? 'Skipped' : 'Stopped')));
        addConsoleLine(
            'Explorer',
            success ? 'test completed' : skipped ? 'test skipped' : 'test ended with error',
            success ? 'success' : skipped ? 'warning' : 'danger',
            status.details || status
        );
        state.currentRunId = null;
        loadHistory().catch(() => {});
    }

    function renderHistory() {
        if (!elements.detailedResults) return;
        if (!state.history.length) {
            elements.detailedResults.innerHTML = '<div class="text-muted">No tests run yet. Select a test from dropdown and click Run.</div>';
            if (elements.resultTimestamp) elements.resultTimestamp.textContent = '';
            return;
        }

        if (elements.resultTimestamp) {
            elements.resultTimestamp.textContent = `Last update: ${new Date().toLocaleString()}`;
        }

        elements.detailedResults.innerHTML = state.history.slice(0, 20).map((item) => {
            const ok = item.result === 'pass';
            const skipped = item.result === 'skipped';
            return `
                <div class="test-result ${ok ? 'pass' : skipped ? 'skip' : 'fail'} small mb-2 p-2 border-start border-3 border-${ok ? 'success' : skipped ? 'secondary' : 'danger'}">
                    <div class="d-flex justify-content-between align-items-start gap-2">
                        <div>
                            <div class="fw-semibold">${escapeHtml(item.name || item.testId || item.runId)}</div>
                            <div class="text-muted">${new Date(item.timestamp).toLocaleString()}</div>
                        </div>
                        <div class="d-flex align-items-center gap-2">
                            <span class="badge bg-${ok ? 'success' : skipped ? 'secondary' : 'danger'}">${escapeHtml(item.result || 'unknown')}</span>
                            <button class="btn btn-sm btn-outline-secondary" onclick="viewTestDetails('${escapeHtml(item.runId)}')">
                                <i class="bi bi-eye"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function updateHistoryStats() {
        const total = state.history.length;
        const passed = state.history.filter((item) => item.result === 'pass').length;
        const failed = state.history.filter((item) => item.result === 'fail').length;

        if (elements.testSuccessCount) elements.testSuccessCount.textContent = passed;
        if (elements.testFailCount) elements.testFailCount.textContent = failed;
        if (elements.testTotalCount) elements.testTotalCount.textContent = total;
    }

    function setBusy(isBusy) {
        if (elements.runTestBtn) {
            elements.runTestBtn.disabled = isBusy;
            elements.runTestBtn.innerHTML = isBusy
                ? '<span class="spinner-border spinner-border-sm me-1"></span>Running...'
                : '<i class="bi bi-play-fill"></i> Run';
        }
        if (elements.runAllBtn) elements.runAllBtn.disabled = isBusy;
        if (elements.stopTestBtn) elements.stopTestBtn.disabled = !isBusy;
    }

    function setProgress(percent, label) {
        if (!elements.testProgressBar) return;
        const value = Math.max(0, Math.min(100, Math.round(percent || 0)));
        elements.testProgressBar.style.width = `${value}%`;
        elements.testProgressBar.textContent = `${value}%`;
        if (label && elements.liveTestResult) {
            elements.liveTestResult.innerHTML = `<span class="text-muted">${escapeHtml(label)}</span>`;
        }
    }

    function updateCurrentTest(name, statusText) {
        if (elements.currentTestName) elements.currentTestName.textContent = name || 'None';
        if (elements.testStatus) {
            const cls = statusText === 'Completed' ? 'success'
                : statusText === 'Running' ? 'primary'
                : statusText === 'Skipped' ? 'warning'
                : statusText === 'Failed' ? 'danger'
                : 'secondary';
            elements.testStatus.innerHTML = `<span class="badge bg-${cls}">${escapeHtml(statusText || 'Idle')}</span>`;
        }
    }

    function updateDeviceBadge(kind, text) {
        if (!elements.deviceTestStatusText || !elements.deviceTestStatus) return;
        elements.deviceTestStatusText.textContent = text;
        elements.deviceTestStatus.className = `badge d-flex align-items-center bg-${kind === 'ready' ? 'success' : kind === 'error' ? 'danger' : 'secondary'}`;
    }

    function resetRunState() {
        state.seenLogs.clear();
        stopStatusPolling();
    }

    function addConsoleLine(source, message, level, data, isoTime) {
        if (!elements.testConsole) return;

        const line = document.createElement('div');
        line.className = `p-2 small console-line text-${consoleColor(level)}`;
        const timestamp = isoTime ? new Date(isoTime).toLocaleTimeString() : new Date().toLocaleTimeString();
        const payload = data == null ? '' : `<div class="mt-1"><pre class="mb-0 text-light small">${escapeHtml(JSON.stringify(data, null, 2))}</pre></div>`;
        line.innerHTML = `<span class="text-muted">[${escapeHtml(timestamp)}]</span> <span class="text-info">${escapeHtml(source)}</span> ${escapeHtml(message)}${payload}`;
        elements.testConsole.appendChild(line);
        elements.testConsole.scrollTop = elements.testConsole.scrollHeight;
    }

    function consoleColor(level) {
        if (level === 'danger' || level === 'error') return 'danger';
        if (level === 'success') return 'success';
        if (level === 'warning') return 'warning';
        return 'light';
    }

    function normalizeLevel(level) {
        if (level === 'error') return 'danger';
        return level || 'info';
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function exportTestLog() {
        if (!elements.testConsole) return;
        const text = Array.from(elements.testConsole.querySelectorAll('.console-line'))
            .map((line) => line.textContent)
            .join('\n');
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `test-console-${Date.now()}.log`;
        a.click();
        URL.revokeObjectURL(url);
    }

    function viewTestDetails(runId) {
        const item = state.history.find((entry) => entry.runId === runId);
        if (!item) return;
        document.getElementById('detailsTestName').textContent = item.name || item.testId || runId;
        document.getElementById('detailsTimestamp').textContent = new Date(item.timestamp).toLocaleString();
        document.getElementById('detailsResult').innerHTML = `<span class="badge bg-${item.result === 'pass' ? 'success' : item.result === 'skipped' ? 'secondary' : 'danger'}">${escapeHtml(item.result || 'unknown')}</span>`;
        document.getElementById('detailsContent').textContent = JSON.stringify(item.details || item, null, 2);
        const modalEl = document.getElementById('testDetailsModal');
        if (modalEl && window.bootstrap) {
            window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
        }
    }

    window.runAllTests = runAllTests;
    window.clearTestResults = clearTestResults;
    window.exportTestLog = exportTestLog;
    window.viewTestDetails = viewTestDetails;
    window.quickTest = (testId) => {
        const test = state.availableTests[testId];
        if (test && !test.supported) {
            addConsoleLine('Explorer', test.supportMessage, 'warning');
        }
        return startRun(testId, {});
    };
})();
