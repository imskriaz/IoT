// USSD Services JavaScript
(function () {
    'use strict';

    console.log('USSD.js loaded - ' + new Date().toISOString());

    // State
    let currentPage = 1;
    let totalPages = 1;
    let currentSession = null;
    let updateInterval = null;
    let settings = [];
    let dragEnabled = false;
    let historyResponseMap = {}; // id -> response text
    let requestControllers = new Map();

    function newSignal(key = 'default') {
        const previous = requestControllers.get(key);
        if (previous) previous.abort();
        const pageCtrl = new AbortController();
        requestControllers.set(key, pageCtrl);
        return pageCtrl.signal;
    }

    function abortAllRequests() {
        requestControllers.forEach((controller) => controller.abort());
        requestControllers.clear();
    }

    window.addEventListener('beforeunload', abortAllRequests);

    function getUssdActiveDeviceId() {
        const activeDeviceId = window.getActiveDeviceId
            ? window.getActiveDeviceId()
            : (window.DEVICE_ID || localStorage.getItem('activeDeviceId') || '');
        return String(activeDeviceId || '').trim();
    }

    function getUssdActiveSimSlot() {
        return getUssdActiveSimContext().simSlot;
    }

    function getUssdActiveSimContext() {
        if (typeof window.getActiveDeviceSimContext === 'function') {
            return window.getActiveDeviceSimContext() || {
                deviceId: getUssdActiveDeviceId(),
                simSlot: null
            };
        }
        return {
            deviceId: getUssdActiveDeviceId(),
            simSlot: typeof window.getActiveDeviceSimSlot === 'function' ? window.getActiveDeviceSimSlot() : null
        };
    }

    function matchesUssdScope(payload = {}) {
        const activeDeviceId = getUssdActiveDeviceId();
        const payloadDeviceId = String(payload?.deviceId || payload?.device_id || '').trim();
        if (activeDeviceId && payloadDeviceId && payloadDeviceId !== activeDeviceId) {
            return false;
        }

        const activeSimSlot = getUssdActiveSimContext().simSlot;
        if (activeSimSlot === null) {
            return true;
        }
        const payloadSimSlot = payload?.simSlot ?? payload?.sim_slot ?? null;
        if (payloadSimSlot === null || payloadSimSlot === undefined || payloadSimSlot === '') {
            return true;
        }

        return Number(payloadSimSlot) === Number(activeSimSlot);
    }

    function buildUssdApiUrl(path, params = {}) {
        const url = new URL(path, window.location.origin);
        const simContext = getUssdActiveSimContext();
        if (simContext.deviceId && !url.searchParams.has('deviceId')) {
            url.searchParams.set('deviceId', simContext.deviceId);
        }
        if (simContext.simSlot !== null && !url.searchParams.has('simSlot')) {
            url.searchParams.set('simSlot', String(simContext.simSlot));
        }
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.set(key, value);
            }
        });
        return `${url.pathname}${url.search}`;
    }

    function activeDevicePayload(extra = {}) {
        const simContext = getUssdActiveSimContext();
        const payload = { ...extra, deviceId: simContext.deviceId };
        if (simContext.simSlot !== null && payload.simSlot === undefined && payload.sim_slot === undefined) {
            payload.simSlot = simContext.simSlot;
        }
        return payload;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        console.log('Initializing USSD page...');

        if (typeof window.syncBootstrapTabsWithUrl === 'function') {
            window.syncBootstrapTabsWithUrl(document);
        }

        loadHistory();
        loadRecentCodes();
        loadSettings();
        loadEnabledSettings();
        checkSession();
        attachEventListeners();
        attachDeviceChangeHandler();
        startUpdates();
        attachSocketListeners();
    }

    // ==================== HISTORY FUNCTIONS ====================

    function loadHistory(page = 1) {
        currentPage = page;

        fetch(buildUssdApiUrl('/api/ussd/history', { page, limit: 10 }), { signal: newSignal('history') })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                if (data.success) {
                    displayHistory(data.data);
                    updatePagination(data.pagination);
                } else {
                    showToast(data.message || 'Failed to load history', 'danger');
                }
            })
            .catch(error => {
                if (error.name === 'AbortError') return;
                console.error('Error loading history:', error);
                showToast('Error loading USSD history', 'danger');
            });
    }

    function displayHistory(history) {
        const tableBody = document.getElementById('historyTable');
        const mobileContainer = document.getElementById('historyMobile');

        if (!tableBody || !mobileContainer) return;

        if (!history || history.length === 0) {
            const emptyHtml = `
                <tr>
                    <td colspan="5" class="text-center py-4">
                        <i class="bi bi-clock-history fs-1 d-block mb-3"></i>
                        <p class="text-muted">No USSD history found</p>
                    </td>
                </tr>
            `;
            tableBody.innerHTML = emptyHtml;
            mobileContainer.innerHTML = emptyHtml;
            return;
        }

        // Desktop table
        let tableHtml = '';

        // Mobile cards
        let mobileHtml = '';

        // Populate response map for safe lookup in viewResponse
        history.forEach(item => { if (item.response) historyResponseMap[item.id] = item.response; });

        history.forEach(item => {
            const date = new Date(item.timestamp).toLocaleString();
            const statusBadge = item.status === 'success' ? 'bg-success' :
                item.status === 'active' ? 'bg-info' :
                item.status === 'pending' ? 'bg-warning' : 'bg-danger';
            const responsePreview = item.response
                ? escapeHtml(item.response.substring(0, 50)) + (item.response.length > 50 ? '...' : '')
                : 'Waiting for response...';
            const responseMobilePreview = item.response
                ? escapeHtml(item.response.substring(0, 80)) + (item.response.length > 80 ? '...' : '')
                : 'Waiting for response...';

            // Table row
            tableHtml += `
                <tr>
                    <td><small>${escapeHtml(date)}</small></td>
                    <td><span class="badge bg-primary">${escapeHtml(item.code)}</span></td>
                    <td>${escapeHtml(item.description || '-')}</td>
                    <td>
                        <span class="badge ${statusBadge} me-2">${escapeHtml(item.status)}</span>
                        <small class="text-truncate" style="max-width: 200px; display: block;">
                            ${responsePreview}
                        </small>
                    </td>
                    <td>
                        ${item.response ? `
                        <button class="btn btn-sm btn-outline-primary" data-id="${item.id}" onclick="viewResponse(this.dataset.id)">
                            <i class="bi bi-eye"></i>
                        </button>
                        ` : ''}
                        <button class="btn btn-sm btn-outline-danger" onclick="deleteHistory(${item.id})">
                            <i class="bi bi-trash"></i>
                        </button>
                    </td>
                </tr>
            `;

            // Mobile card
            mobileHtml += `
                <div class="card mb-2">
                    <div class="card-body">
                        <div class="d-flex justify-content-between mb-2">
                            <span class="badge bg-primary">${escapeHtml(item.code)}</span>
                            <span class="badge ${statusBadge}">${escapeHtml(item.status)}</span>
                        </div>
                        <p class="mb-1"><strong>${escapeHtml(item.description || 'USSD Request')}</strong></p>
                        <p class="mb-2 small">${responseMobilePreview}</p>
                        <div class="d-flex justify-content-end gap-2">
                            ${item.response ? `
                            <button class="btn btn-sm btn-outline-primary" data-id="${item.id}" onclick="viewResponse(this.dataset.id)">
                                <i class="bi bi-eye"></i> View
                            </button>
                            ` : ''}
                            <button class="btn btn-sm btn-outline-danger" onclick="deleteHistory(${item.id})">
                                <i class="bi bi-trash"></i> Delete
                            </button>
                        </div>
                    </div>
                </div>
            `;
        });

        tableBody.innerHTML = tableHtml;
        mobileContainer.innerHTML = mobileHtml;
    }

    function updatePagination(pagination) {
        currentPage = pagination.page;
        totalPages = pagination.pages;

        const container = document.getElementById('historyPagination');
        if (!container) return;

        if (totalPages <= 1) {
            container.innerHTML = '';
            return;
        }

        let html = '';

        // Previous
        html += `
            <li class="page-item ${currentPage === 1 ? 'disabled' : ''}">
                <a class="page-link" href="#" onclick="loadHistory(${currentPage - 1}); return false;">Previous</a>
            </li>
        `;

        // Page numbers
        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
                html += `
                    <li class="page-item ${i === currentPage ? 'active' : ''}">
                        <a class="page-link" href="#" onclick="loadHistory(${i}); return false;">${i}</a>
                    </li>
                `;
            } else if (i === currentPage - 3 || i === currentPage + 3) {
                html += `<li class="page-item disabled"><span class="page-link">...</span></li>`;
            }
        }

        // Next
        html += `
            <li class="page-item ${currentPage === totalPages ? 'disabled' : ''}">
                <a class="page-link" href="#" onclick="loadHistory(${currentPage + 1}); return false;">Next</a>
            </li>
        `;

        container.innerHTML = html;
    }

    function deleteHistory(id) {
        if (!confirm('Delete this USSD history entry?')) return;

        fetch(buildUssdApiUrl(`/api/ussd/history/${id}`), {
            method: 'DELETE'
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                if (data.success) {
                    showToast('History deleted', 'success');
                    loadHistory(currentPage);
                } else {
                    showToast(data.message || 'Failed to delete', 'danger');
                }
            })
            .catch(error => {
                console.error('Error deleting history:', error);
                showToast('Error deleting history', 'danger');
            });
    }

    function clearHistory() {
        if (!confirm('Clear all USSD history? This cannot be undone.')) return;

        fetch(buildUssdApiUrl('/api/ussd/history'), {
            method: 'DELETE'
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                if (data.success) {
                    showToast('All history cleared', 'success');
                    loadHistory(1);
                } else {
                    showToast(data.message || 'Failed to clear', 'danger');
                }
            })
            .catch(error => {
                console.error('Error clearing history:', error);
                showToast('Error clearing history', 'danger');
            });
    }

    // ==================== USSD DIALER FUNCTIONS ====================

    function sendUSSD(overrideCode = null) {
        const codeInput = document.getElementById('ussdCode');
        const menuReplyInput = document.getElementById('menuOptionInput');
        const code = String(overrideCode != null ? overrideCode : (codeInput?.value || '')).trim();

        if (!code) {
            showToast('Please enter a USSD code', 'warning');
            return;
        }

        if (!/^[*#0-9]+$/.test(code)) {
            showToast('Invalid USSD code format', 'warning');
            return;
        }

        if (codeInput) {
            codeInput.value = code;
        }
        if (menuReplyInput && overrideCode != null) {
            menuReplyInput.value = '';
        }

        const responseDiv = document.getElementById('ussdResponse');
        const menuNav = document.getElementById('menuNavigation');
        const sendBtn = document.querySelector('button[onclick="sendUSSD()"]');
        const originalHtml = sendBtn?.innerHTML;

        responseDiv.innerHTML = `
            <div class="text-center py-4">
                <div class="spinner-border text-primary" role="status"></div>
                <p class="mt-2">Sending USSD request...</p>
            </div>
        `;
        menuNav.style.display = 'none';

        if (sendBtn) {
            sendBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status"></span> Sending...';
            sendBtn.disabled = true;
        }

        fetch(buildUssdApiUrl('/api/ussd/send'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(activeDevicePayload({
                code,
                description: currentSession?.active ? `USSD Option ${code}` : undefined
            }))
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                if (data.success) {
                    showToast(data.message || 'USSD request dispatched', 'success');
                    const dispatchedCode = String(data?.data?.code || code).trim() || code;
                    setSessionState({
                        active: true,
                        currentCode: dispatchedCode,
                        lastRequest: new Date().toISOString(),
                        menuLevel: Number(data?.data?.menuLevel || currentSession?.menuLevel || 0),
                        sessionId: data?.data?.sessionId || currentSession?.sessionId || null,
                        pending: true,
                        lastResponse: currentSession?.lastResponse || '',
                        menuOptions: currentSession?.menuOptions || []
                    });

                    responseDiv.innerHTML = `
                    <div class="text-center py-4">
                        <div class="spinner-border text-primary" role="status"></div>
                        <p class="mt-2">Waiting for response...</p>
                        <p class="text-muted small">Request ID: ${data.data.id}</p>
                    </div>
                `;

                    loadHistory(1);
                    loadRecentCodes();
                } else {
                    responseDiv.innerHTML = `
                    <div class="text-center py-4 text-danger">
                        <i class="bi bi-exclamation-triangle fs-1 d-block mb-3"></i>
                        <p>${data.message || 'Failed to send USSD request'}</p>
                    </div>
                `;
                    showToast(data.message || 'Failed to send USSD', 'danger');
                }
            })
            .catch(error => {
                console.error('Error:', error);
                responseDiv.innerHTML = `
                <div class="text-center py-4 text-danger">
                    <i class="bi bi-exclamation-triangle fs-1 d-block mb-3"></i>
                    <p>Connection error: ${error.message}</p>
                    <button class="btn btn-outline-primary mt-3" onclick="sendUSSD()">Try Again</button>
                </div>
            `;
                showToast('Error sending USSD: ' + error.message, 'danger');
            })
            .finally(() => {
                if (sendBtn) {
                    sendBtn.innerHTML = originalHtml;
                    sendBtn.disabled = false;
                }
            });
    }

    function loadRecentCodes() {
        const container = document.getElementById('recentCodes');
        if (!container) return;

        fetch(buildUssdApiUrl('/api/ussd/history', { limit: 5 }), { signal: newSignal('recentHistory') })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                if (data.success && data.data.length > 0) {
                    let html = '';
                    data.data.forEach(item => {
                        html += `
                            <div class="list-group-item list-group-item-action cursor-pointer" data-code="${escapeHtml(item.code)}" onclick="setCode(this.dataset.code)">
                                <div class="d-flex justify-content-between">
                                    <span><strong>${escapeHtml(item.code)}</strong></span>
                                    <small class="text-muted">${escapeHtml(item.description || 'USSD')}</small>
                                </div>
                            </div>
                        `;
                    });
                    container.innerHTML = html;
                } else {
                    container.innerHTML = '<div class="list-group-item text-muted">No recent codes</div>';
                }
            })
            .catch(error => {
                console.error('Error loading recent codes:', error);
                container.innerHTML = '<div class="list-group-item text-danger">Error loading codes</div>';
            });
    }

    function setCode(code) {
        document.getElementById('ussdCode').value = code;
        document.getElementById('dial-tab').click();
    }

    function quickService(code) {
        document.getElementById('ussdCode').value = code;
        document.getElementById('dial-tab').click();
        sendUSSD();
    }

    function viewResponse(id) {
        const response = historyResponseMap[id] || '';
        const modalResponse = document.getElementById('modalResponse');
        setMultilineTextContent(modalResponse, response);

        const modal = new bootstrap.Modal(document.getElementById('ussdResponseModal'));
        modal.show();
    }

    function copyResponse() {
        const response = document.getElementById('modalResponse').innerText;
        navigator.clipboard.writeText(response).then(() => {
            showToast('Response copied to clipboard', 'success');
        }).catch(() => {
            showToast('Failed to copy', 'danger');
        });
    }

    // ==================== SETTINGS FUNCTIONS ====================

    function loadSettings() {
        fetch('/api/ussd/settings', { signal: newSignal('settings') })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                if (data.success) {
                    settings = data.data;
                    displaySettings(data.data);
                } else {
                    showToast(data.message || 'Failed to load settings', 'danger');
                }
            })
            .catch(error => {
                console.error('Error loading settings:', error);
                showToast('Error loading USSD settings', 'danger');
            });
    }

    function loadEnabledSettings() {
        fetch('/api/ussd/settings/enabled', { signal: newSignal('enabledSettings') })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                if (data.success) {
                    displayQuickServices(data.data);
                    displayQuickCodeSuggestions(data.data);
                }
            })
            .catch(error => {
                console.error('Error loading enabled settings:', error);
            });
    }

    function displaySettings(settings) {
        const tbody = document.getElementById('servicesTable');
        if (!tbody) return;

        if (!settings || settings.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" class="text-center py-4">
                        <p class="text-muted">No services configured</p>
                        <button class="btn btn-primary btn-sm" onclick="showAddServiceModal()">
                            <i class="bi bi-plus"></i> Add your first service
                        </button>
                    </td>
                </tr>
            `;
            return;
        }

        let html = '';
        settings.forEach((service, index) => {
            html += `
                <tr data-key="${escapeHtml(service.service_key)}" data-order="${service.sort_order}">
                    <td>
                        <span class="drag-handle"><i class="bi bi-grip-vertical"></i></span>
                        ${index + 1}
                    </td>
                    <td>
                        <strong>${escapeHtml(service.service_name)}</strong>
                        <br>
                        <small class="text-muted">${escapeHtml(service.service_key)}</small>
                    </td>
                    <td><code>${escapeHtml(service.ussd_code)}</code></td>
                    <td><small>${escapeHtml(service.description || '-')}</small></td>
                    <td>
                        <div class="form-check form-switch">
                            <input class="form-check-input" type="checkbox"
                                   ${service.enabled ? 'checked' : ''}
                                   data-key="${escapeHtml(service.service_key)}" data-enabled="${!service.enabled}"
                                   onchange="toggleService(this.dataset.key, this.dataset.enabled === 'true')">
                        </div>
                    </td>
                    <td>
                        <button class="btn btn-sm btn-outline-primary" data-key="${escapeHtml(service.service_key)}" onclick="editService(this.dataset.key)">
                            <i class="bi bi-pencil"></i>
                        </button>
                        <button class="btn btn-sm btn-outline-danger" data-key="${escapeHtml(service.service_key)}" onclick="deleteService(this.dataset.key)">
                            <i class="bi bi-trash"></i>
                        </button>
                    </td>
                </tr>
            `;
        });

        tbody.innerHTML = html;

        // Enable drag and drop if not already enabled
        if (!dragEnabled) {
            enableDragAndDrop();
            dragEnabled = true;
        }
    }

    function displayQuickServices(services) {
        const grid = document.getElementById('quickServicesGrid');
        if (!grid) return;

        if (!services || services.length === 0) {
            grid.innerHTML = `
                <div class="col-12 text-center py-5">
                    <i class="bi bi-grid-3x3-gap-fill fs-1 text-muted d-block mb-3"></i>
                    <p class="text-muted">No quick services configured</p>
                    <button class="btn btn-primary" onclick="document.getElementById('settings-tab').click()">
                        <i class="bi bi-gear"></i> Go to Settings
                    </button>
                </div>
            `;
            return;
        }

        let html = '';
        services.forEach(service => {
            const icon = escapeHtml(getIconClass(service.icon));

            html += `
                <div class="col-12 col-md-6 col-lg-4">
                    <div class="card service-card" data-code="${escapeHtml(service.ussd_code)}" onclick="quickService(this.dataset.code)">
                        <div class="card-body text-center">
                            <div class="display-1 mb-3 text-primary">
                                <i class="bi bi-${icon}"></i>
                            </div>
                            <h5>${escapeHtml(service.service_name)}</h5>
                            <p class="text-muted small">${escapeHtml(service.description || 'USSD Service')}</p>
                            <span class="badge bg-primary">${escapeHtml(service.ussd_code)}</span>
                        </div>
                    </div>
                </div>
            `;
        });

        grid.innerHTML = html;
    }

    function displayQuickCodeSuggestions(services) {
        const container = document.getElementById('quickCodeSuggestions');
        if (!container) return;

        if (!services || services.length === 0) {
            container.innerHTML = '<span class="text-muted">No quick codes available</span>';
            return;
        }

        let html = '';
        services.slice(0, 6).forEach(service => {
            html += `
                <span class="badge bg-light text-dark p-2 cursor-pointer" data-code="${escapeHtml(service.ussd_code)}" onclick="setCode(this.dataset.code)">
                    ${escapeHtml(service.ussd_code)}
                </span>
            `;
        });

        container.innerHTML = html;
    }

    function toggleService(key, enabled) {
        fetch(`/api/ussd/settings/${key}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                if (data.success) {
                    showToast(`Service ${enabled ? 'enabled' : 'disabled'}`, 'success');
                    loadSettings();
                    loadEnabledSettings();
                } else {
                    showToast(data.message || 'Failed to toggle service', 'danger');
                    // Revert checkbox
                    const checkbox = document.querySelector(`input[onchange*="toggleService('${key}'"]`);
                    if (checkbox) {
                        checkbox.checked = !enabled;
                    }
                }
            })
            .catch(error => {
                console.error('Error toggling service:', error);
                showToast('Error toggling service', 'danger');
                // Revert checkbox
                const checkbox = document.querySelector(`input[onchange*="toggleService('${key}'"]`);
                if (checkbox) {
                    checkbox.checked = !enabled;
                }
            });
    }

    function showAddServiceModal() {
        document.getElementById('serviceModalTitle').textContent = 'Add New Service';
        document.getElementById('serviceForm').reset();
        document.getElementById('serviceKey').value = '';
        document.getElementById('serviceKeyInput').value = '';
        document.getElementById('serviceKeyInput').readOnly = false;
        document.getElementById('deleteServiceBtn').style.display = 'none';
        document.getElementById('enabledInput').checked = true;

        const modal = new bootstrap.Modal(document.getElementById('serviceModal'));
        modal.show();
    }

    function editService(key) {
        const service = settings.find(s => s.service_key === key);
        if (!service) return;

        document.getElementById('serviceModalTitle').textContent = 'Edit Service';
        document.getElementById('serviceKey').value = service.service_key;
        document.getElementById('serviceKeyInput').value = service.service_key;
        document.getElementById('serviceKeyInput').readOnly = true;
        document.getElementById('serviceNameInput').value = service.service_name;
        document.getElementById('ussdCodeInput').value = service.ussd_code;
        document.getElementById('descriptionInput').value = service.description || '';
        document.getElementById('iconInput').value = service.icon || 'question';
        document.getElementById('enabledInput').checked = service.enabled === 1;
        document.getElementById('deleteServiceBtn').style.display = 'inline-block';

        const modal = new bootstrap.Modal(document.getElementById('serviceModal'));
        modal.show();
    }

    function saveService() {
        const key = document.getElementById('serviceKey').value;
        const data = {
            service_key: document.getElementById('serviceKeyInput').value.trim(),
            service_name: document.getElementById('serviceNameInput').value.trim(),
            ussd_code: document.getElementById('ussdCodeInput').value.trim(),
            description: document.getElementById('descriptionInput').value.trim(),
            icon: document.getElementById('iconInput').value,
            enabled: document.getElementById('enabledInput').checked
        };

        // Validate
        if (!data.service_key || !data.service_name || !data.ussd_code) {
            showToast('Please fill in all required fields', 'warning');
            return;
        }

        if (!/^[a-z0-9-]+$/.test(data.service_key)) {
            showToast('Service key must be lowercase letters, numbers, and hyphens only', 'warning');
            return;
        }

        if (!/^[*#0-9]+$/.test(data.ussd_code)) {
            showToast('USSD code must contain only numbers, *, and #', 'warning');
            return;
        }

        const saveBtn = document.querySelector('button[onclick="saveService()"]');
        const originalHtml = saveBtn?.innerHTML;

        if (saveBtn) {
            saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status"></span> Saving...';
            saveBtn.disabled = true;
        }

        const url = key ? `/api/ussd/settings/${key}` : '/api/ussd/settings';
        const method = key ? 'PUT' : 'POST';

        fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                if (data.success) {
                    showToast(key ? 'Service updated' : 'Service created', 'success');

                    const modal = bootstrap.Modal.getInstance(document.getElementById('serviceModal'));
                    if (modal) modal.hide();

                    loadSettings();
                    loadEnabledSettings();
                } else {
                    showToast(data.message || 'Failed to save service', 'danger');
                }
            })
            .catch(error => {
                console.error('Error saving service:', error);
                showToast('Error saving service: ' + error.message, 'danger');
            })
            .finally(() => {
                if (saveBtn) {
                    saveBtn.innerHTML = originalHtml;
                    saveBtn.disabled = false;
                }
            });
    }

    function deleteService(key) {
        if (!confirm('Delete this service? This cannot be undone.')) return;

        fetch(`/api/ussd/settings/${key}`, {
            method: 'DELETE'
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                if (data.success) {
                    showToast('Service deleted', 'success');

                    const modal = bootstrap.Modal.getInstance(document.getElementById('serviceModal'));
                    if (modal) modal.hide();

                    loadSettings();
                    loadEnabledSettings();
                } else {
                    showToast(data.message || 'Failed to delete service', 'danger');
                }
            })
            .catch(error => {
                console.error('Error deleting service:', error);
                showToast('Error deleting service', 'danger');
            });
    }

    // ==================== SOCKET LISTENERS ====================

    function attachSocketListeners() {
        if (typeof socket === 'undefined') {
            console.warn('Socket not available');
            return;
        }

        window.socket.off('ussd:response');
        window.socket.off('ussd:settings-updated');
        window.socket.off('ussd:settings-created');
        window.socket.off('ussd:settings-deleted');
        window.socket.off('ussd:settings-reordered');

        window.socket.on('ussd:response', (data) => {
            console.log('USSD response received:', data);
            if (!matchesUssdScope(data)) return;

            const responseText = String(data?.response || '');
            const menuOptions = Array.isArray(data?.menuOptions)
                ? data.menuOptions
                : parseUssdMenuOptions(responseText);
            const sessionActive = data?.session_active === true || menuOptions.length > 0;

            // Update response display
            const responseDiv = document.getElementById('ussdResponse');
            if (responseDiv) {
                renderLiveUssdResponse(responseDiv, responseText, data?.code || currentSession?.currentCode || '');
            }
            showMenuOptions(sessionActive ? menuOptions : []);
            setSessionState(sessionActive ? {
                active: true,
                currentCode: data?.code || currentSession?.currentCode || '',
                lastRequest: data?.timestamp || new Date().toISOString(),
                menuLevel: Number(data?.menuLevel || currentSession?.menuLevel || 0),
                sessionId: data?.sessionId || currentSession?.sessionId || null,
                pending: false,
                lastResponse: responseText,
                menuOptions
            } : null);

            showToast('New USSD response received', 'info');
            loadHistory(1);
            loadRecentCodes();
            checkSession();
        });

        window.socket.on('ussd:settings-updated', () => {
            loadSettings();
            loadEnabledSettings();
        });

        window.socket.on('ussd:settings-created', () => {
            loadSettings();
            loadEnabledSettings();
        });

        window.socket.on('ussd:settings-deleted', () => {
            loadSettings();
            loadEnabledSettings();
        });

        window.socket.on('ussd:settings-reordered', () => {
            loadSettings();
            loadEnabledSettings();
        });
    }

    function startUpdates() {
        if (updateInterval) clearInterval(updateInterval);
        updateInterval = setInterval(checkSession, 30000);
    }

    function setSessionState(session) {
        const sessionStatus = document.getElementById('sessionStatus');
        const endSessionBtn = document.getElementById('endSessionBtn');
        const menuNavigation = document.getElementById('menuNavigation');
        if (!sessionStatus || !endSessionBtn || !menuNavigation) return;

        if (session?.active) {
            currentSession = session;
            sessionStatus.textContent = `Session Active${session.currentCode ? `: ${session.currentCode}` : ''}`;
            sessionStatus.className = 'badge bg-success';
            endSessionBtn.style.display = 'inline-block';
            if (session?.lastResponse) {
                const responseDiv = document.getElementById('ussdResponse');
                if (responseDiv) {
                    renderLiveUssdResponse(responseDiv, session.lastResponse, session.currentCode || '');
                }
            }
            if (session.menuOptions && session.menuOptions.length > 0) {
                showMenuOptions(session.menuOptions);
            } else {
                menuNavigation.style.display = 'none';
            }
            return;
        }

        currentSession = null;
        sessionStatus.textContent = 'No Active Session';
        sessionStatus.className = 'badge bg-info';
        endSessionBtn.style.display = 'none';
        menuNavigation.style.display = 'none';
    }

    function checkSession() {
        fetch(buildUssdApiUrl('/api/ussd/session'), { signal: newSignal('session') })
            .then(response => response.json())
            .then(data => {
                setSessionState(data.success ? data.data : null);
            })
            .catch((error) => {
                if (error.name !== 'AbortError') console.error(error);
            });
    }

    function endSession() {
        fetch(buildUssdApiUrl('/api/ussd/session/end'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(activeDevicePayload())
        })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    setSessionState(null);
                    showToast('Session ended', 'success');
                }
            })
            .catch(console.error);
    }

    function attachDeviceChangeHandler() {
        window.addEventListener('device:changed', function () {
            currentPage = 1;
            historyResponseMap = {};
            refreshUssdData(false);
        });
        window.addEventListener('device:sim-changed', function () {
            currentPage = 1;
            historyResponseMap = {};
            refreshUssdData(false);
        });
    }

    function refreshUssdData(showFeedback = true) {
        loadHistory(currentPage);
        loadRecentCodes();
        loadSettings();
        loadEnabledSettings();
        checkSession();
        if (showFeedback) {
            showToast('USSD data refreshed', 'success');
        }
    }

    function setMultilineTextContent(element, value) {
        if (!element) return;
        element.innerHTML = '';
        const normalized = String(value || '')
            .replace(/\\r\\n|\\n|\\r|\r\n|\n|\r/g, '\n')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '');
        normalized.split('\n').forEach((line, index, arr) => {
            element.appendChild(document.createTextNode(line));
            if (index < arr.length - 1) {
                element.appendChild(document.createElement('br'));
            }
        });
    }

    function renderLiveUssdResponse(container, response, code = '') {
        if (!container) return;
        container.innerHTML = `
            <div class="border-start border-primary border-4 ps-3">
                <small class="text-muted" id="ussdLiveResponseMeta">${escapeHtml(new Date().toLocaleString())}${code ? ` | ${escapeHtml(code)}` : ''}</small>
                <div class="mt-2" style="font-family: monospace;" id="ussdLiveResponseText"></div>
            </div>
        `;
        setMultilineTextContent(document.getElementById('ussdLiveResponseText'), response);
    }

    function parseUssdMenuOptions(response) {
        return String(response || '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .split('\n')
            .map(line => String(line || '').trim())
            .map(line => {
                const match = line.match(/^(\d{1,2})(?:\s*[\.\):-]|\s+)(.+)$/);
                return match ? { option: match[1].trim(), label: match[2].trim() } : null;
            })
            .filter((item, index, arr) => item && item.option && item.label &&
                arr.findIndex(candidate => candidate && candidate.option === item.option) === index);
    }

    function showMenuOptions(options) {
        const menuNavigation = document.getElementById('menuNavigation');
        const menuOptions = document.getElementById('menuOptions');
        const menuOptionInput = document.getElementById('menuOptionInput');
        if (!menuNavigation || !menuOptions) return;

        if (!Array.isArray(options) || options.length === 0) {
            menuOptions.innerHTML = '';
            menuNavigation.style.display = 'none';
            if (menuOptionInput) menuOptionInput.value = '';
            return;
        }

        menuOptions.innerHTML = options.map((item) => `
            <button
                type="button"
                class="btn btn-outline-primary btn-sm"
                data-option="${escapeHtml(item.option)}"
                onclick="sendUSSD(this.dataset.option)"
            >
                <span class="fw-semibold">${escapeHtml(item.option)}</span>
                <span class="ms-1">${escapeHtml(item.label)}</span>
            </button>
        `).join('');
        menuNavigation.style.display = 'block';
    }

    function submitMenuReply() {
        const input = document.getElementById('menuOptionInput');
        const reply = String(input?.value || '').trim();
        if (!reply) {
            showToast('Enter a menu option or reply', 'warning');
            return;
        }
        sendUSSD(reply);
    }

    // Helper functions
    function getIconClass(icon) {
        const icons = {
            'cash-stack': 'cash-stack',
            'wifi': 'wifi',
            'telephone': 'telephone',
            'chat-dots': 'chat-dots',
            'gift': 'gift',
            'box': 'box',
            'headset': 'headset',
            'phone': 'phone',
            'star': 'star',
            'arrow-left-right': 'arrow-left-right',
            'question': 'question-circle'
        };
        return icons[icon] || 'question-circle';
    }

    function attachEventListeners() {
        // Enter key in USSD input
        const ussdInput = document.getElementById('ussdCode');
        if (ussdInput) {
            ussdInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    sendUSSD();
                }
            });
        }

        const menuReplyInput = document.getElementById('menuOptionInput');
        if (menuReplyInput) {
            menuReplyInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    submitMenuReply();
                }
            });
        }

        // Tab change events
        const settingsTab = document.getElementById('settings-tab');
        if (settingsTab) {
            settingsTab.addEventListener('shown.bs.tab', () => {
                loadSettings();
            });
        }

        const quickTab = document.getElementById('quick-tab');
        if (quickTab) {
            quickTab.addEventListener('shown.bs.tab', () => {
                loadEnabledSettings();
            });
        }
    }

    function enableDragAndDrop() {
        const tbody = document.getElementById('servicesTable');
        if (!tbody) return;

        let draggingRow = null;

        tbody.querySelectorAll('tr').forEach(row => {
            row.setAttribute('draggable', 'true');

            row.addEventListener('dragstart', (e) => {
                draggingRow = row;
                e.dataTransfer.setData('text/plain', row.dataset.key);
                row.classList.add('bg-light', 'opacity-50');
                e.stopPropagation();
            });

            row.addEventListener('dragend', (e) => {
                if (draggingRow) {
                    draggingRow.classList.remove('bg-light', 'opacity-50');
                }
                draggingRow = null;
                e.stopPropagation();
            });

            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                row.classList.add('bg-info', 'bg-opacity-10');
            });

            row.addEventListener('dragleave', (e) => {
                row.classList.remove('bg-info', 'bg-opacity-10');
            });

            row.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                row.classList.remove('bg-info', 'bg-opacity-10');

                if (!draggingRow || draggingRow === row) return;

                const keys = Array.from(tbody.querySelectorAll('tr')).map(r => r.dataset.key);
                const draggedKey = draggingRow.dataset.key;
                const targetKey = row.dataset.key;

                const draggedIndex = keys.indexOf(draggedKey);
                const targetIndex = keys.indexOf(targetKey);

                // Reorder array
                keys.splice(draggedIndex, 1);
                keys.splice(targetIndex, 0, draggedKey);

                // Send new order to server
                const saveIndicator = document.getElementById('orderSaveIndicator');
                if (saveIndicator) saveIndicator.style.display = 'block';

                fetch('/api/ussd/settings/reorder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ order: keys })
                })
                    .then(response => {
                        if (!response.ok) {
                            throw new Error(`HTTP error ${response.status}`);
                        }
                        return response.json();
                    })
                    .then(data => {
                        if (data.success) {
                            showToast('Services reordered', 'success');
                            loadSettings();
                            loadEnabledSettings();
                        } else {
                            showToast(data.message || 'Failed to save order', 'danger');
                        }
                    })
                    .catch(error => {
                        console.error('Error saving order:', error);
                        showToast('Error saving order', 'danger');
                    })
                    .finally(() => {
                        if (saveIndicator) saveIndicator.style.display = 'none';
                    });
            });
        });
    }

    // Cleanup
    window.addEventListener('beforeunload', () => {
        if (updateInterval) clearInterval(updateInterval);
    });

    // ==================== EXPORT ALL FUNCTIONS TO WINDOW ====================

    window.loadHistory = loadHistory;
    window.deleteHistory = deleteHistory;
    window.clearHistory = clearHistory;
    window.sendUSSD = sendUSSD;
    window.endSession = endSession;
    window.setCode = setCode;
    window.quickService = quickService;
    window.viewResponse = viewResponse;
    window.copyResponse = copyResponse;
    window.submitMenuReply = submitMenuReply;
    window.toggleService = toggleService;
    window.showAddServiceModal = showAddServiceModal;
    window.editService = editService;
    window.saveService = saveService;
    window.deleteService = deleteService;
    window.refreshUssdData = refreshUssdData;

    console.log('All USSD functions exported to window');
})();
