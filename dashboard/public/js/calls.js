// Calls page specific functionality
(function () {
    'use strict';

    // State
    let currentPage = 1;
    let totalPages = 1;
    let contacts = [];
    let requestControllers = new Map();
    let callsSelectMode = false;
    const DOM_WINDOW_CALLS = 100;
    let callsLoading = false;
    let callsExhausted = false;

    function newSignal(key = 'default') {
        const previous = requestControllers.get(key);
        if (previous) previous.abort();
        const controller = new AbortController();
        requestControllers.set(key, controller);
        return controller.signal;
    }

    function abortAllRequests() {
        requestControllers.forEach(controller => controller.abort());
        requestControllers.clear();
    }

    window.addEventListener('beforeunload', abortAllRequests);
    let filteredContacts = [];
    let isDeviceConnected = false;
    let callStatusInterval = null;
    let companies = [];
    let activeWorkspaceMode = 'contacts';

    // DOM Elements
    const elements = {
        totalCalls: document.getElementById('totalCalls'),
        outgoingCalls: document.getElementById('outgoingCalls'),
        incomingCalls: document.getElementById('incomingCalls'),
        missedCalls: document.getElementById('missedCalls'),
        callsTableBody: document.getElementById('callsTableBody'),
        callsMobileList: document.getElementById('callsMobileList'),
        callsPagination: document.getElementById('callsPagination'),
        searchCalls: document.getElementById('searchCalls'),
        filterCallType: document.getElementById('filterCallType'),
        sortCalls: document.getElementById('sortCalls'),
        contactsList: document.getElementById('contactsList'),
        modalContactsList: document.getElementById('modalContactsList'),
        contactSearch: document.getElementById('contactSearch'),
        modalContactSearch: document.getElementById('modalContactSearch'),
        modalContactCompany: document.getElementById('modalContactCompany'),
        contactCompanyFilters: document.getElementById('contactCompanyFilters'),
        speedDialGrid: document.getElementById('speedDialGrid'),
        favoritesList: document.getElementById('favoritesList'),
        quickContacts: document.getElementById('quickContacts'),
        contactCount: document.getElementById('contactCount'),
        totalContacts: document.getElementById('totalContacts'),
        favoriteContacts: document.getElementById('favoriteContacts'),
        dialerNumber: document.getElementById('dialerNumber'),
        numberHint: document.getElementById('numberHint'),
        dialerContactName: document.getElementById('dialerContactName'),
        contactFormName: document.getElementById('contactFormName'),
        clearNumber: document.getElementById('clearNumber'),
        makeCall: document.getElementById('makeCall'),
        syncCallsBtn: document.getElementById('syncCallsBtn'),
        callWorkspaceModal: document.getElementById('callWorkspaceModal'),
        activeCallBanner: document.getElementById('activeCallBanner'),
        activeCallStatus: document.getElementById('activeCallStatus'),
        activeCallNumber: document.getElementById('activeCallNumber'),
        activeCallDuration: document.getElementById('activeCallDuration'),
        deviceOfflineWarning: document.getElementById('deviceOfflineWarning'),
        dialerOfflineWarning: document.getElementById('dialerOfflineWarning'),
        callWorkspaceCard: document.getElementById('callWorkspaceCard'),
        callWorkspaceDialerColumn: document.getElementById('callWorkspaceDialerColumn'),
        callWorkspaceContactsColumn: document.getElementById('callWorkspaceContactsColumn'),
        callWorkspaceDialerSection: document.getElementById('callWorkspaceDialerSection'),
        callWorkspaceContactsSection: document.getElementById('callWorkspaceContactsSection'),
        callWorkspaceDialerTab: document.getElementById('callWorkspaceDialerTab'),
        callWorkspaceContactsTab: document.getElementById('callWorkspaceContactsTab')
    };

    function getCallsActiveDeviceId() {
        const activeDeviceId = window.getActiveDeviceId
            ? window.getActiveDeviceId()
            : (window.DEVICE_ID || localStorage.getItem('activeDeviceId') || '');
        return String(activeDeviceId || '').trim();
    }

    function getCallsActiveSimSlot() {
        return getCallsActiveSimContext().simSlot;
    }

    function getCallsActiveSimContext() {
        if (typeof window.getActiveDeviceSimContext === 'function') {
            return window.getActiveDeviceSimContext() || {
                deviceId: getCallsActiveDeviceId(),
                simSlot: null
            };
        }
        return {
            deviceId: getCallsActiveDeviceId(),
            simSlot: typeof window.getActiveDeviceSimSlot === 'function' ? window.getActiveDeviceSimSlot() : null
        };
    }

    function getCallsActiveCapabilities() {
        const activeDeviceId = getCallsActiveDeviceId();
        if (!activeDeviceId) return {};
        try {
            const raw = localStorage.getItem(`deviceCaps_${activeDeviceId}`);
            return raw ? (JSON.parse(raw) || {}) : {};
        } catch (_) {
            return {};
        }
    }

    function getCallsTransportMode() {
        const caps = getCallsActiveCapabilities();
        return String(caps.transport_mode || caps.transportMode || '').trim().toLowerCase() === 'http'
            ? 'http'
            : 'mqtt';
    }

    function syncCallsHttpRequiredUi() {
        const showHttpUi = getCallsTransportMode() === 'http'
            && typeof window.deviceHttpOnline === 'function'
            && Boolean(window.deviceHttpOnline());
        document.querySelectorAll('[data-calls-http-required="true"]').forEach(function (el) {
            el.classList.toggle('d-none', !showHttpUi);
        });
    }

    function matchesCallsScope(payload = {}) {
        const activeContext = getCallsActiveSimContext();
        const payloadDeviceId = String(payload?.deviceId || payload?.device_id || '').trim();
        if (activeContext.deviceId && payloadDeviceId && payloadDeviceId !== activeContext.deviceId) {
            return false;
        }

        const activeSimSlot = activeContext.simSlot;
        if (activeSimSlot === null || activeSimSlot === undefined) {
            return true;
        }

        const payloadSimSlot = payload?.simSlot ?? payload?.sim_slot ?? null;
        if (payloadSimSlot === null || payloadSimSlot === undefined || payloadSimSlot === '') {
            return true;
        }

        return Number(payloadSimSlot) === Number(activeSimSlot);
    }

    function buildCallsApiUrl(path, params = {}) {
        const url = new URL(path, window.location.origin);
        const simContext = getCallsActiveSimContext();
        if (simContext.deviceId && !url.searchParams.has('deviceId')) {
            url.searchParams.set('deviceId', simContext.deviceId);
        }
        if (simContext.simSlot !== null && simContext.simSlot !== undefined && !url.searchParams.has('simSlot')) {
            url.searchParams.set('simSlot', simContext.simSlot);
        }
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.set(key, value);
            }
        });
        return `${url.pathname}${url.search}`;
    }

    function activeDevicePayload(extra = {}) {
        const simContext = getCallsActiveSimContext();
        const payload = { ...extra, deviceId: simContext.deviceId };
        if (simContext.simSlot !== null && simContext.simSlot !== undefined) {
            payload.simSlot = simContext.simSlot;
        }
        return payload;
    }

    function setPhoneFieldValue(id, value) {
        if (window.PhoneInputs?.setValue) {
            window.PhoneInputs.setValue(id, value || '');
            return;
        }
        const el = document.getElementById(id);
        if (el) el.value = value || '';
    }

    function validatePhoneField(id, options = {}) {
        if (window.PhoneInputs?.validate) {
            return window.PhoneInputs.validate(id, options);
        }

        const el = document.getElementById(id);
        const value = String(el?.value || '').trim();
        if (!value) return { ok: options.required === false, value, message: 'Phone number is required' };
        return { ok: true, value, message: '' };
    }

    function focusDialerInput() {
        if (!elements.dialerNumber) return;
        elements.dialerNumber.focus();
        elements.dialerNumber.select?.();
    }

    function scrollWorkspaceIntoView() {
        elements.callWorkspaceCard?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function getCallWorkspaceModalInstance() {
        if (!elements.callWorkspaceModal || !window.bootstrap?.Modal) return null;
        return bootstrap.Modal.getOrCreateInstance(elements.callWorkspaceModal);
    }

    function showCallWorkspaceModal(mode = 'dialer', options = {}) {
        setCallWorkspaceMode(mode, { scroll: false });

        const modal = getCallWorkspaceModalInstance();
        if (!modal) {
            if (mode === 'dialer' && options.focusDialer !== false) focusDialerInput();
            return;
        }

        if (mode === 'dialer' && options.focusDialer !== false) {
            elements.callWorkspaceModal.addEventListener('shown.bs.modal', focusDialerInput, { once: true });
        } else if (mode === 'contacts') {
            elements.callWorkspaceModal.addEventListener('shown.bs.modal', function () {
                elements.modalContactSearch?.focus();
            }, { once: true });
        }

        modal.show();

        if (elements.callWorkspaceModal.classList.contains('show')) {
            if (mode === 'dialer' && options.focusDialer !== false) focusDialerInput();
            if (mode === 'contacts') elements.modalContactSearch?.focus();
        }
    }

    function hideCallWorkspaceModal() {
        const modal = getCallWorkspaceModalInstance();
        if (modal) modal.hide();
    }

    function mountActiveCallCard() {
        const notificationArea = document.getElementById('dashboardNotificationArea');
        if (!notificationArea || !elements.activeCallBanner) return;

        if (elements.activeCallBanner.parentElement !== notificationArea) {
            const incomingCallPanel = document.getElementById('incomingCallPanel');
            if (incomingCallPanel?.nextSibling) {
                notificationArea.insertBefore(elements.activeCallBanner, incomingCallPanel.nextSibling);
            } else {
                notificationArea.insertBefore(elements.activeCallBanner, notificationArea.firstChild);
            }
        }
        elements.activeCallBanner.classList.add('active-call-card');
    }

    function setCallWorkspaceMode(mode = 'dialer', options = {}) {
        activeWorkspaceMode = mode === 'contacts' ? 'contacts' : 'dialer';

        if (elements.callWorkspaceModal) {
            elements.callWorkspaceModal.classList.toggle('call-workspace-modal--dialer', activeWorkspaceMode === 'dialer');
            elements.callWorkspaceModal.classList.toggle('call-workspace-modal--contacts', activeWorkspaceMode === 'contacts');
        }
        if (elements.callWorkspaceDialerColumn) {
            elements.callWorkspaceDialerColumn.classList.toggle('d-none', activeWorkspaceMode !== 'dialer');
        }
        if (elements.callWorkspaceContactsColumn) {
            elements.callWorkspaceContactsColumn.classList.toggle('d-none', activeWorkspaceMode !== 'contacts');
        }
        if (elements.callWorkspaceDialerSection) {
            elements.callWorkspaceDialerSection.classList.toggle('d-none', activeWorkspaceMode !== 'dialer');
        }
        if (elements.callWorkspaceContactsSection) {
            elements.callWorkspaceContactsSection.classList.toggle('d-none', activeWorkspaceMode !== 'contacts');
        }
        if (elements.callWorkspaceDialerTab) {
            elements.callWorkspaceDialerTab.classList.toggle('active', activeWorkspaceMode === 'dialer');
        }
        if (elements.callWorkspaceContactsTab) {
            elements.callWorkspaceContactsTab.classList.toggle('active', activeWorkspaceMode === 'contacts');
        }

        if (activeWorkspaceMode === 'contacts') {
            displayModalContacts(contacts);
        }

        if (options.scroll !== false) {
            scrollWorkspaceIntoView();
        }

        if (options.focusDialer) {
            focusDialerInput();
        } else if (activeWorkspaceMode === 'contacts' && elements.modalContactSearch) {
            elements.modalContactSearch.focus();
        }
    }

    // Initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        mountActiveCallCard();

        // Check device connection
        checkDeviceConnection();

        // Load initial data
        loadCallLogs();
        loadCallStats();
        loadContacts();
        initCallsInfiniteScroll();
        
        // Start call status check
        startCallStatusCheck();
        attachSocketCallUpdates();

        // Attach event listeners
        attachDialerListeners();
        attachSearchAndFilter();
        attachModalListeners();
        attachQuickCallFilters();
        attachKeyboardShortcuts();
        initCallTabsWithUrls();
        attachDeviceChangeHandler();
        updateCallsExportHref();
        syncCallsHttpRequiredUi();
        setCallWorkspaceMode(activeWorkspaceMode, { scroll: false });
        prefillDialerFromQuery();
    }

    function attachDeviceChangeHandler() {
        window.addEventListener('device:changed', function () {
            currentPage = 1;
            totalPages = 1;
            callsLoading = false;
            callsExhausted = false;
            checkDeviceConnection();
            loadCallLogs(1);
            loadCallStats();
            updateCallsExportHref();
            checkCallStatus();
            syncCallsHttpRequiredUi();
        });
        window.addEventListener('device:sim-changed', function () {
            currentPage = 1;
            totalPages = 1;
            callsLoading = false;
            callsExhausted = false;
            checkDeviceConnection();
            loadCallLogs(1);
            loadCallStats();
            updateCallsExportHref();
            checkCallStatus();
            syncCallsHttpRequiredUi();
        });
    }

    function updateCallsExportHref() {
        const exportLink = document.getElementById('callsExportCsv');
        if (exportLink) exportLink.href = buildCallsApiUrl('/api/calls/export/csv');
    }

    // ==================== DEVICE CONNECTION ====================
    function applyDeviceConnectionState(connected) {
        const httpBridgeOnline = getCallsTransportMode() === 'http'
            && typeof window.deviceHttpOnline === 'function'
            && Boolean(window.deviceHttpOnline());
        isDeviceConnected = Boolean(connected || httpBridgeOnline);

        if (elements.deviceOfflineWarning) {
            elements.deviceOfflineWarning.classList.add('d-none');
            elements.deviceOfflineWarning.classList.remove('d-flex');
        }

        if (elements.dialerOfflineWarning) {
            elements.dialerOfflineWarning.classList.add('d-none');
        }

        if (elements.makeCall) {
            elements.makeCall.disabled = !isDeviceConnected;
        }

        syncCallsHttpRequiredUi();
    }

    function checkDeviceConnection() {
        fetch(buildCallsApiUrl('/api/status', { refresh: 1 }), {
            signal: newSignal('deviceConnection'),
            cache: 'no-store',
            credentials: 'same-origin',
            headers: {
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        })
            .then(response => response.json())
            .then(data => {
                applyDeviceConnectionState(Boolean(data?.success && data?.data?.online));
            })
            .catch(error => {
                if (error.name === 'AbortError') return;
                console.error('Error checking device connection:', error);
                applyDeviceConnectionState(false);
            });
    }

    // ==================== CALL LOGS ====================
    function loadCallLogs(page = 1) {
        currentPage = page;
        if (page === 1) {
            callsLoading = false;
            callsExhausted = false;
        }

        fetch(buildCallsApiUrl('/api/calls/logs', { page, limit: 10 }), { signal: newSignal('callLogs') })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    displayCallLogs(data.data);
                    updatePagination(data.pagination);
                } else {
                    displayCallLogs([]);
                }
            })
            .catch(error => {
                if (error.name === 'AbortError') return;
                console.error('Error loading call logs:', error);
                if (elements.callsTableBody) elements.callsTableBody.innerHTML = '<tr><td colspan="9" class="text-center py-4 text-danger">Failed to load call logs</td></tr>';
                if (elements.callsMobileList) elements.callsMobileList.innerHTML = '<div class="text-center py-4 text-danger">Failed to load call logs</div>';
            });
    }

    function displayCallLogs(calls) {
        if (!elements.callsTableBody || !elements.callsMobileList) return;

        if (!calls || calls.length === 0) {
            const emptyHtml = `
                <tr>
                    <td colspan="9" class="text-center py-5">
                        <i class="bi bi-telephone-x fs-1 text-muted d-block mb-3"></i>
                        <p class="text-muted mb-0">No call logs found</p>
                        <button class="btn btn-primary mt-3" onclick="openDialerModal()">
                            <i class="bi bi-telephone-plus me-2"></i>Make a Call
                        </button>
                    </td>
                </tr>
            `;
            elements.callsTableBody.innerHTML = emptyHtml;
            elements.callsMobileList.innerHTML = emptyHtml;
            return;
        }

        // Desktop table view
        let tableHtml = '';

        // Mobile cards view
        let mobileHtml = '';

        calls.forEach(call => {
            const formattedNumber = formatDisplayNumber(call.phone_number);
            const matchedContact = findContactByNumber(call.phone_number);
            const contactName = call.contact_name || matchedContact?.name || formattedNumber;
            const icon = getCallIcon(call.type, call.status);
            const statusClass = getStatusClass(call.status);
            const statusBadge = getStatusBadge(call.status);
            const statusText = getStatusText(call.status);

            // Table row
            tableHtml += `
                <tr data-call-id="${call.id}" data-call-type="${escapeHtml(call.type || '')}" data-call-status="${escapeHtml(call.status || '')}" data-call-start="${escapeHtml(call.start_time || '')}" data-call-duration="${Number(call.duration) || 0}" data-phone="${escapeHtml(call.phone_number || '')}">
                    <td class="calls-bulk-col d-none">
                        <input type="checkbox" class="form-check-input call-select-cb" value="${call.id}">
                    </td>
                    <td>
                        <div class="avatar-circle ${statusClass}">
                            <i class="bi ${icon}"></i>
                        </div>
                    </td>
                    <td>
                        <div class="fw-bold">${escapeHtml(contactName)}</div>
                        ${call.contact_company ? `<small class="text-muted">${escapeHtml(call.contact_company)}</small>` : ''}
                    </td>
                    <td>${formattedNumber}</td>
                    <td>${formatDate(call.start_time)}</td>
                    <td>${formatDuration(call.duration)}</td>
                    <td><span class="badge ${statusBadge}">${statusText}</span></td>
                    <td>${call.dialed_by ? `<span class="badge bg-secondary">${escapeHtml(call.dialed_by)}</span>` : '<span class="text-muted">—</span>'}</td>
                    <td>
                        <div class="btn-group btn-group-sm">
                            <button class="btn btn-outline-success" data-phone="${escapeHtml(call.phone_number || '')}" onclick="quickCall(this.dataset.phone)"
                                    ${!isDeviceConnected ? 'disabled' : ''}>
                                <i class="bi bi-telephone"></i>
                            </button>
                            <button class="btn btn-outline-info" data-phone="${escapeHtml(call.phone_number || '')}" onclick="quickSms(this.dataset.phone)">
                                <i class="bi bi-chat-dots"></i>
                            </button>
                            <button class="btn btn-outline-primary" data-phone="${escapeHtml(call.phone_number || '')}" onclick="editContactFromNumber(this.dataset.phone)">
                                <i class="bi bi-person-plus"></i>
                            </button>
                            <button class="btn btn-outline-danger" onclick="deleteCallLog(${call.id})">
                                <i class="bi bi-trash"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;

            // Mobile card
            mobileHtml += `
                <div class="card mb-2" data-call-id="${call.id}" data-call-type="${escapeHtml(call.type || '')}" data-call-status="${escapeHtml(call.status || '')}" data-call-start="${escapeHtml(call.start_time || '')}" data-call-duration="${Number(call.duration) || 0}" data-phone="${escapeHtml(call.phone_number || '')}">
                    <div class="card-body">
                        <div class="d-flex align-items-start gap-3">
                            <div class="flex-shrink-0">
                                <div class="avatar-circle ${statusClass}">
                                    <i class="bi ${icon}"></i>
                                </div>
                            </div>
                            <div class="flex-grow-1">
                                <div class="d-flex justify-content-between mb-1">
                                    <h6 class="mb-0">${escapeHtml(contactName)}</h6>
                                    <small class="text-muted">${formatDate(call.start_time)}</small>
                                </div>
                                <p class="mb-1 small">${formattedNumber}</p>
                                ${call.contact_company ? `<small class="text-muted d-block mb-1">${escapeHtml(call.contact_company)}</small>` : ''}
                                <div class="d-flex justify-content-between align-items-center mt-2">
                                    <div>
                                        <span class="badge ${statusBadge} me-2">${statusText}</span>
                                        <small class="text-muted">${formatDuration(call.duration)}</small>
                                    </div>
                                    <div class="btn-group btn-group-sm">
                                        <button class="btn btn-outline-success" data-phone="${escapeHtml(call.phone_number || '')}" onclick="quickCall(this.dataset.phone)"
                                                ${!isDeviceConnected ? 'disabled' : ''}>
                                            <i class="bi bi-telephone"></i>
                                        </button>
                                        <button class="btn btn-outline-danger" onclick="deleteCallLog(${call.id})">
                                            <i class="bi bi-trash"></i>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        });

        elements.callsTableBody.innerHTML = tableHtml;
        elements.callsMobileList.innerHTML = mobileHtml;

        // Re-wire checkboxes if select mode is active
        if (callsSelectMode) {
            document.querySelectorAll('.call-select-cb').forEach(cb => { cb.onchange = updateCallsSelectionCount; });
        }
    }

    // ==================== CALL STATS ====================
    function loadCallStats() {
        fetch(buildCallsApiUrl('/api/calls/stats'), { signal: newSignal('callStats') })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    if (elements.totalCalls) elements.totalCalls.textContent = data.data.total;
                    if (elements.outgoingCalls) elements.outgoingCalls.textContent = data.data.outgoing;
                    if (elements.incomingCalls) elements.incomingCalls.textContent = data.data.incoming;
                    if (elements.missedCalls) elements.missedCalls.textContent = data.data.missed;
                }
            })
            .catch(error => { if (error.name !== 'AbortError') console.error(error); });
    }

    // ==================== CONTACTS ====================
    function loadContacts() {
        fetch('/api/contacts?page=1&limit=500', { signal: newSignal('contacts') })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    contacts = data.data;
                    filteredContacts = contacts;
                    
                    // Extract unique companies
                    companies = [...new Set(contacts.filter(c => c.company).map(c => c.company))];
                    
                    displayContacts();
                    displaySpeedDial();
                    displayFavorites();
                    displayQuickContacts();
                    updateContactCount();
                    updateContactFilters();

                    const dialerValue = elements.dialerNumber?.value || '';
                    if (dialerValue) {
                        const contact = findContactByNumber(dialerValue);
                        if (elements.dialerContactName) {
                            if (contact) {
                                elements.dialerContactName.textContent = contact.name;
                                elements.dialerContactName.classList.add('text-success');
                            } else {
                                elements.dialerContactName.textContent = '';
                                elements.dialerContactName.classList.remove('text-success');
                            }
                        }
                    }
                }
            })
            .catch(error => { if (error.name !== 'AbortError') console.error('Error loading contacts:', error); });
    }

    function displayContacts() {
        if (!elements.contactsList) return;

        if (filteredContacts.length === 0) {
            elements.contactsList.innerHTML = `
                <div class="text-center py-5">
                    <i class="bi bi-person-lines-fill fs-1 text-muted d-block mb-3"></i>
                    <p class="text-muted mb-0">No contacts found</p>
                    <button class="btn btn-primary mt-3" onclick="showAddContactModal()">
                        <i class="bi bi-person-plus me-2"></i>Add Contact
                    </button>
                </div>
            `;
            return;
        }

        let html = '';
        filteredContacts.forEach(contact => {
            const favorite = contact.favorite ? '<i class="bi bi-star-fill text-warning ms-2"></i>' : '';
            html += `
                <div class="list-group-item list-group-item-action" data-contact-id="${contact.id}">
                    <div class="d-flex align-items-center">
                        <div class="flex-shrink-0 me-3">
                            <div class="avatar-circle bg-primary bg-opacity-10">
                                <i class="bi bi-person-circle fs-4 text-primary"></i>
                            </div>
                        </div>
                        <div class="flex-grow-1">
                            <div class="d-flex justify-content-between">
                                <h6 class="mb-1">${escapeHtml(contact.name)} ${favorite}</h6>
                                ${contact.company ? `<small class="text-muted">${escapeHtml(contact.company)}</small>` : ''}
                            </div>
                            <p class="mb-1 small">${escapeHtml(contact.phone_number)}</p>
                            ${contact.email ? `<small class="text-muted">${escapeHtml(contact.email)}</small>` : ''}
                        </div>
                        <div class="btn-group btn-group-sm ms-2">
                            <button class="btn btn-outline-success" data-phone="${escapeHtml(contact.phone_number)}" onclick="quickCall(this.dataset.phone)"
                                    ${!isDeviceConnected ? 'disabled' : ''}>
                                <i class="bi bi-telephone"></i>
                            </button>
                            <button class="btn btn-outline-primary" onclick="editContact(${contact.id})">
                                <i class="bi bi-pencil"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        });

        elements.contactsList.innerHTML = html;
    }

    function displayModalContacts(contactsList) {
        if (!elements.modalContactsList) return;

        if (contactsList.length === 0) {
            elements.modalContactsList.innerHTML = '<div class="text-center py-4">No contacts found</div>';
            return;
        }

        let html = '';
        contactsList.forEach(contact => {
            html += `
                <div class="list-group-item list-group-item-action" data-contact-id="${contact.id}"
                     data-phone="${escapeHtml(contact.phone_number)}" data-name="${escapeHtml(contact.name)}">
                    <div class="d-flex align-items-center">
                        <div class="flex-shrink-0 me-3">
                            <div class="avatar-circle bg-primary bg-opacity-10">
                                <i class="bi bi-person-circle fs-4 text-primary"></i>
                            </div>
                        </div>
                        <div class="flex-grow-1">
                            <h6 class="mb-1">${escapeHtml(contact.name)}</h6>
                            <p class="mb-0 small">${escapeHtml(contact.phone_number)}</p>
                        </div>
                        <div class="btn-group btn-group-sm ms-2">
                            <button class="btn btn-outline-success" data-phone="${escapeHtml(contact.phone_number)}" data-name="${escapeHtml(contact.name)}" onclick="selectContact(this.dataset.phone, this.dataset.name)">
                                <i class="bi bi-check-lg"></i> Select
                            </button>
                        </div>
                    </div>
                </div>
            `;
        });

        elements.modalContactsList.innerHTML = html;
    }

    function displaySpeedDial() {
        if (!elements.speedDialGrid) return;

        const topContacts = contacts.filter(c => c.favorite).slice(0, 8);

        if (topContacts.length === 0) {
            elements.speedDialGrid.innerHTML = `
                <div class="col-12 text-center py-4">
                    <p class="text-muted">No speed dial contacts. Add favorites first.</p>
                </div>
            `;
            return;
        }

        let html = '';
        topContacts.forEach(contact => {
            html += `
                <div class="col-6 col-md-3">
                    <div class="speed-dial-card" data-phone="${escapeHtml(contact.phone_number)}"
                         onclick="quickCall(this.dataset.phone)"
                         style="${!isDeviceConnected ? 'cursor: not-allowed; opacity: 0.5;' : ''}">
                        <i class="bi bi-person-circle text-primary"></i>
                        <div class="fw-bold text-truncate">${escapeHtml(contact.name)}</div>
                        <small class="text-muted text-truncate d-block">${escapeHtml(contact.phone_number)}</small>
                    </div>
                </div>
            `;
        });

        elements.speedDialGrid.innerHTML = html;
    }

    function displayFavorites() {
        if (!elements.favoritesList) return;

        const favorites = contacts.filter(c => c.favorite);

        if (favorites.length === 0) {
            elements.favoritesList.innerHTML = `
                <div class="list-group-item text-center py-4">
                    <p class="text-muted mb-0">No favorites yet</p>
                </div>
            `;
            return;
        }

        let html = '';
        favorites.slice(0, 5).forEach(contact => {
            html += `
                <div class="list-group-item list-group-item-action" data-phone="${escapeHtml(contact.phone_number)}" onclick="quickCall(this.dataset.phone)"
                     style="${!isDeviceConnected ? 'cursor: not-allowed; opacity: 0.5;' : ''}">
                    <div class="d-flex align-items-center">
                        <div class="flex-shrink-0 me-2">
                            <i class="bi bi-star-fill text-warning"></i>
                        </div>
                        <div class="flex-grow-1">
                            <div class="fw-bold">${escapeHtml(contact.name)}</div>
                            <small class="text-muted">${escapeHtml(contact.phone_number)}</small>
                        </div>
                        <i class="bi bi-telephone text-success"></i>
                    </div>
                </div>
            `;
        });

        elements.favoritesList.innerHTML = html;
    }

    function displayQuickContacts() {
        if (!elements.quickContacts) return;

        const quickList = contacts.slice(0, 5);

        if (quickList.length === 0) {
            elements.quickContacts.innerHTML = '<small class="text-muted">No contacts available</small>';
            return;
        }

        let html = '';
        quickList.forEach(contact => {
            html += `
                <span class="contact-chip" data-phone="${escapeHtml(contact.phone_number)}" data-name="${escapeHtml(contact.name)}" onclick="selectContact(this.dataset.phone, this.dataset.name)"
                      style="${!isDeviceConnected ? 'cursor: not-allowed; opacity: 0.5;' : ''}">
                    <i class="bi bi-person-circle"></i>
                    <span>${escapeHtml(contact.name)}</span>
                </span>
            `;
        });

        elements.quickContacts.innerHTML = html;
    }

    function updateContactCount() {
        if (elements.contactCount) {
            elements.contactCount.textContent = contacts.length;
        }
        if (elements.totalContacts) {
            elements.totalContacts.textContent = `Total: ${contacts.length}`;
        }
        if (elements.favoriteContacts) {
            elements.favoriteContacts.textContent = `Favorites: ${contacts.filter(c => c.favorite).length}`;
        }
    }

    function updateContactFilters() {
        if (!elements.contactCompanyFilters) return;

        let html = '<span class="badge bg-primary cursor-pointer" onclick="filterContactsByCompany(\'\')">All</span>';
        
        companies.forEach(company => {
            html += `<span class="badge bg-secondary cursor-pointer" data-company="${escapeHtml(company)}" onclick="filterContactsByCompany(this.dataset.company)">${escapeHtml(company)}</span>`;
        });

        elements.contactCompanyFilters.innerHTML = html;

        // Update modal company filter
        if (elements.modalContactCompany) {
            let options = '<option value="">All Companies</option>';
            companies.forEach(company => {
                options += `<option value="${escapeHtml(company)}">${escapeHtml(company)}</option>`;
            });
            elements.modalContactCompany.innerHTML = options;
        }
    }

    // ==================== CONTACT FILTERS ====================
    function filterContacts() {
        const searchTerm = elements.contactSearch?.value.toLowerCase() || '';

        filteredContacts = contacts.filter(c => {
            return c.name.toLowerCase().includes(searchTerm) ||
                c.phone_number.includes(searchTerm);
        });

        displayContacts();
    }

    function filterModalContacts() {
        const searchTerm = elements.modalContactSearch?.value.toLowerCase() || '';
        const company = elements.modalContactCompany?.value || '';

        const filtered = contacts.filter(c => {
            const matchesSearch = c.name.toLowerCase().includes(searchTerm) ||
                c.phone_number.includes(searchTerm);
            const matchesCompany = !company || c.company === company;
            return matchesSearch && matchesCompany;
        });

        displayModalContacts(filtered);
    }

    window.filterContactsByCompany = function (company) {
        if (!company) {
            filteredContacts = contacts;
        } else {
            filteredContacts = contacts.filter(c => c.company === company);
        }
        displayContacts();

        // Update active badge
        document.querySelectorAll('#contactCompanyFilters .badge').forEach(badge => {
            badge.classList.remove('bg-primary');
            badge.classList.add('bg-secondary');
        });

        if (company) {
            const activeBadge = Array.from(document.querySelectorAll('#contactCompanyFilters .badge'))
                .find(b => b.textContent === company);
            if (activeBadge) {
                activeBadge.classList.remove('bg-secondary');
                activeBadge.classList.add('bg-primary');
            }
        } else {
            const allBadge = document.querySelector('#contactCompanyFilters .badge:first-child');
            if (allBadge) {
                allBadge.classList.remove('bg-secondary');
                allBadge.classList.add('bg-primary');
            }
        }
    };

    // ==================== CONTACT LOOKUP ====================
    function findContactByNumber(number) {
        if (!number || !contacts || contacts.length === 0) return null;
        
        const cleanNumber = number.replace(/\D/g, '');
        if (!cleanNumber) return null;
        
        return contacts.find(c => {
            const cleanContact = c.phone_number.replace(/\D/g, '');
            if (!cleanContact) return false;
            
            return cleanContact === cleanNumber ||
                cleanContact.slice(-10) === cleanNumber.slice(-10) ||
                cleanContact.includes(cleanNumber) ||
                cleanNumber.includes(cleanContact);
        });
    }

    function getDisplayLabelForNumber(number) {
        const formatted = formatDisplayNumber(number);
        const contact = findContactByNumber(number);
        return contact ? `${contact.name} (${formatted})` : formatted;
    }

    function prefillDialerFromQuery() {
        const params = new URLSearchParams(window.location.search);
        const target = String(params.get('to') || '').trim();
        if (!target) return;

        setPhoneFieldValue('dialerNumber', target);

        const contact = findContactByNumber(target);
        if (elements.dialerContactName) {
            if (contact) {
                elements.dialerContactName.textContent = contact.name;
                elements.dialerContactName.classList.add('text-success');
            } else {
                elements.dialerContactName.textContent = '';
                elements.dialerContactName.classList.remove('text-success');
            }
        }

        updateNumberHint(target);

        showCallWorkspaceModal('dialer', { focusDialer: true });

        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('to');
        const nextSearch = cleanUrl.searchParams.toString();
        window.history.replaceState({}, document.title, `${cleanUrl.pathname}${nextSearch ? `?${nextSearch}` : ''}${cleanUrl.hash}`);
    }

    // ==================== DIALER ====================
    function attachDialerListeners() {
        if (elements.dialerNumber) {
            elements.dialerNumber.addEventListener('input', function () {
                const number = elements.dialerNumber.value || '';
                const contact = findContactByNumber(number);

                if (elements.dialerContactName) {
                    if (contact) {
                        elements.dialerContactName.textContent = contact.name;
                        elements.dialerContactName.classList.add('text-success');
                    } else {
                        elements.dialerContactName.textContent = '';
                        elements.dialerContactName.classList.remove('text-success');
                    }
                }

                updateNumberHint(number);
            });
        }

        // Dialer buttons
        document.querySelectorAll('.dialer-btn').forEach(btn => {
            btn.addEventListener('click', function () {
                const number = this.dataset.number;
                appendToDialer(number);
            });
        });

        // Clear button
        if (elements.clearNumber) {
            elements.clearNumber.addEventListener('click', function () {
                setPhoneFieldValue('dialerNumber', '');
                if (elements.dialerContactName) {
                    elements.dialerContactName.textContent = '';
                    elements.dialerContactName.classList.remove('text-success');
                }
                if (elements.numberHint) {
                    elements.numberHint.innerHTML = '<i class="bi bi-info-circle"></i> Choose a country or type a number';
                }
            });
        }

        // Make call button
        if (elements.makeCall) {
            elements.makeCall.addEventListener('click', function () {
                const number = elements.dialerNumber?.value;
                if (number) {
                    makeCall(number);
                } else {
                    showToast('Please enter a number', 'warning');
                }
            });
        }
    }

    function appendToDialer(digit) {
        if (!elements.dialerNumber) return;
        
        elements.dialerNumber.value += digit;
        window.PhoneInputs?.sync?.('dialerNumber');

        const number = elements.dialerNumber.value;
        const contact = findContactByNumber(number);

        if (elements.dialerContactName) {
            if (contact) {
                elements.dialerContactName.textContent = contact.name;
                elements.dialerContactName.classList.add('text-success');
            } else {
                elements.dialerContactName.textContent = '';
                elements.dialerContactName.classList.remove('text-success');
            }
        }

        updateNumberHint(number);
    }

    function updateNumberHint(number) {
        if (!elements.numberHint) return;

        const validation = validatePhoneField('dialerNumber', { required: false, allowShortCode: true });
        if (!number) {
            elements.numberHint.innerHTML = '<i class="bi bi-info-circle"></i> Choose a country or type a number';
        } else if (validation.ok && validation.serviceCode) {
            elements.numberHint.innerHTML = '<i class="bi bi-check-circle-fill text-success"></i> Service code ready';
        } else if (validation.ok) {
            elements.numberHint.innerHTML = '<i class="bi bi-check-circle-fill text-success"></i> Ready to dial';
        } else {
            elements.numberHint.innerHTML = '<i class="bi bi-exclamation-triangle-fill text-warning"></i> Enter a valid number';
        }
    }

    // ==================== CALL ACTIONS ====================
    function makeCall(number) {
        if (!isDeviceConnected) {
            showToast('Device is offline. Cannot make call.', 'warning');
            return;
        }

        if (number && elements.dialerNumber && elements.dialerNumber.value !== number) {
            setPhoneFieldValue('dialerNumber', number);
        }

        const validated = validatePhoneField('dialerNumber', { allowShortCode: true });
        if (!validated.ok) {
            showToast(validated.message, 'warning');
            return;
        }
        const formattedNumber = validated.value;

        const makeCallBtn = elements.makeCall;
        const origBtnHtml = makeCallBtn ? makeCallBtn.innerHTML : null;
        if (makeCallBtn) {
            makeCallBtn.disabled = true;
            makeCallBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Calling…';
        }
        const cancelFeedback = typeof mqttWaitFeedback === 'function' && makeCallBtn
            ? mqttWaitFeedback(makeCallBtn)
            : null;

        fetch(buildCallsApiUrl('/api/calls/dial'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(activeDevicePayload({ number: formattedNumber }))
        })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    showToast(data.message || 'Call initiated', 'success');

                    // Clear dialer
                    setPhoneFieldValue('dialerNumber', '');
                    if (elements.dialerContactName) {
                        elements.dialerContactName.textContent = '';
                        elements.dialerContactName.classList.remove('text-success');
                    }
                    updateNumberHint('');
                    hideCallWorkspaceModal();
                } else {
                    showToast(data.message || 'Failed to make call', 'danger');
                }
            })
            .catch(error => {
                console.error('Error making call:', error);
                showToast('Error making call', 'danger');
            })
            .finally(() => {
                if (cancelFeedback) cancelFeedback();
                if (makeCallBtn && origBtnHtml) {
                    makeCallBtn.innerHTML = origBtnHtml;
                    makeCallBtn.disabled = !isDeviceConnected;
                }
            });
    }

    function endCall() {
        if (!isDeviceConnected) {
            showToast('Device is offline.', 'warning');
            return;
        }

        fetch(buildCallsApiUrl('/api/calls/end'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(activeDevicePayload())
        })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    showToast(data.message || 'Call end requested', 'info');
                    hideActiveCallBanner();
                    loadCallLogs(currentPage);
                } else {
                    showToast(data.message || 'Failed to end call', 'danger');
                }
            })
            .catch(error => {
                console.error('Error ending call:', error);
                showToast('Error ending call', 'danger');
            });
    }

    window.muteCall = function () {
        if (!isDeviceConnected) return;

        const muteBtn = document.querySelector('button[onclick="muteCall()"]');
        const isMuted = muteBtn?.classList.contains('active') || false;

        fetch(buildCallsApiUrl('/api/calls/mute'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(activeDevicePayload({ mute: !isMuted }))
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                if (!isMuted) {
                    muteBtn?.classList.add('active', 'btn-success');
                    muteBtn?.classList.remove('btn-outline-success');
                    muteBtn.innerHTML = '<i class="bi bi-mic-mute"></i> Unmute';
                    showToast('Microphone muted', 'warning');
                } else {
                    muteBtn?.classList.remove('active', 'btn-success');
                    muteBtn?.classList.add('btn-outline-success');
                    muteBtn.innerHTML = '<i class="bi bi-mic-mute"></i> Mute';
                    showToast('Microphone unmuted', 'info');
                }
            } else {
                showToast(data.message || 'Failed to toggle mute', 'danger');
            }
        })
        .catch(error => {
            console.error('Error toggling mute:', error);
            showToast('Error toggling mute', 'danger');
        });
    };

    window.holdCall = function () {
        if (!isDeviceConnected) return;

        const holdBtn = document.querySelector('button[onclick="holdCall()"]');
        const isOnHold = holdBtn?.classList.contains('active') || false;

        fetch(buildCallsApiUrl('/api/calls/hold'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(activeDevicePayload({ hold: !isOnHold }))
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                if (!isOnHold) {
                    holdBtn?.classList.add('active', 'btn-warning');
                    holdBtn?.classList.remove('btn-outline-primary');
                    holdBtn.innerHTML = '<i class="bi bi-pause"></i> Resume';
                    showToast('Call on hold', 'info');
                } else {
                    holdBtn?.classList.remove('active', 'btn-warning');
                    holdBtn?.classList.add('btn-outline-primary');
                    holdBtn.innerHTML = '<i class="bi bi-pause"></i> Hold';
                    showToast('Call resumed', 'info');
                }
            } else {
                showToast(data.message || 'Failed to toggle hold', 'danger');
            }
        })
        .catch(error => {
            console.error('Error toggling hold:', error);
            showToast('Error toggling hold', 'danger');
        });
    };

    window.quickCall = function (number) {
        if (!number) return;
        
        if (!isDeviceConnected) {
            showToast('Device is offline. Cannot make call.', 'warning');
            return;
        }

        if (confirm(`Call ${formatDisplayNumber(number)} now?`)) {
            makeCall(number);
        }
    };

    window.quickSms = function (number) {
        if (!number) return;
        window.location.href = `/sms?to=${encodeURIComponent(number)}`;
    };

    // ==================== ACTIVE CALL BANNER ====================
    function showActiveCallBanner(number, status, duration = 0) {
        if (!elements.activeCallBanner) return;

        mountActiveCallCard();
        elements.activeCallBanner.className = `active-call-card alert ${getActiveBannerClass(status)} mb-0`;
        if (elements.activeCallNumber) elements.activeCallNumber.textContent = getDisplayLabelForNumber(number);
        if (elements.activeCallStatus) elements.activeCallStatus.textContent = getStatusText(status);
        if (elements.activeCallDuration) elements.activeCallDuration.textContent = formatDuration(duration);
    }

    function setHoldButtonState(onHold) {
        const holdBtn = document.querySelector('button[onclick="holdCall()"]');
        if (!holdBtn) return;

        if (onHold) {
            holdBtn.classList.add('active', 'btn-warning');
            holdBtn.classList.remove('btn-outline-primary');
            holdBtn.innerHTML = '<i class="bi bi-pause"></i> Resume';
        } else {
            holdBtn.classList.remove('active', 'btn-warning');
            holdBtn.classList.add('btn-outline-primary');
            holdBtn.innerHTML = '<i class="bi bi-pause"></i> Hold';
        }
    }

    function resetActiveCallControls() {
        setHoldButtonState(false);
    }

    function hideActiveCallBanner() {
        if (elements.activeCallBanner) {
            elements.activeCallBanner.classList.add('d-none');
        }
        resetActiveCallControls();
    }

    // ==================== CALL STATUS ====================
    function startCallStatusCheck() {
        if (callStatusInterval) {
            clearInterval(callStatusInterval);
        }
        callStatusInterval = setInterval(checkCallStatus, 5000);
    }

    function attachSocketCallUpdates() {
        if (!window.socket || typeof window.socket.on !== 'function') return;

        window.socket.on('call:incoming', function (data) {
            if (!data || !matchesCallsScope(data)) return;
            if (data.sync === true || String(data.sync || '').toLowerCase() === 'true') return;
            const number = data.number || '';
            showActiveCallBanner(number, 'ringing', 0);
            loadCallLogs(1);
            loadCallStats();
        });

        window.socket.on('call:status', function (data) {
            if (!data || !matchesCallsScope(data)) return;
            if (data.sync === true || String(data.sync || '').toLowerCase() === 'true') return;
            const status = String(data.status || '').toLowerCase();
            const number = data.number || '';
            const duration = Number(data.duration || 0);

            if (['ended', 'missed', 'rejected', 'busy', 'no_answer'].includes(status)) {
                hideActiveCallBanner();
                loadCallLogs(1);
                loadCallStats();
                return;
            }

            if (['dialing', 'ringing', 'answered', 'connected', 'ending'].includes(status)) {
                showActiveCallBanner(number, status, duration);
            }
        });

        window.socket.on('call:ended', function (data) {
            if (!data || !matchesCallsScope(data)) return;
            hideActiveCallBanner();
            loadCallLogs(1);
            loadCallStats();
        });

        window.socket.on('call:hold', function (data) {
            if (!data || !matchesCallsScope(data)) return;
            const onHold = data.onHold === true || data.on_hold === true;
            setHoldButtonState(onHold);
            if (elements.activeCallStatus && !elements.activeCallBanner?.classList.contains('d-none')) {
                elements.activeCallStatus.textContent = onHold ? 'On Hold' : 'Connected';
            }
        });

        window.socket.on('device:status', function (status) {
            const activeDeviceId = getCallsActiveDeviceId();
            if (status?.deviceId && activeDeviceId && String(status.deviceId) !== activeDeviceId) return;
            if (typeof status?.online !== 'undefined') {
                if (Boolean(status.online)) {
                    applyDeviceConnectionState(true);
                } else if (getCallsTransportMode() === 'http') {
                    checkDeviceConnection();
                } else {
                    applyDeviceConnectionState(false);
                }
            }
        });

        window.socket.on('device:capabilities', function (payload) {
            if (!payload || !matchesCallsScope(payload)) return;
            syncCallsHttpRequiredUi();
        });
    }

    function checkCallStatus() {
        if (!isDeviceConnected) {
            hideActiveCallBanner();
            return;
        }

        fetch(buildCallsApiUrl('/api/calls/status'), { signal: newSignal('callStatus') })
            .then(response => response.json())
            .then(data => {
                if (data.success && data.data.active) {
                    showActiveCallBanner(data.data.number, data.data.status, data.data.duration);
                } else {
                    hideActiveCallBanner();
                }
            })
            .catch(error => {
                if (error?.name !== 'AbortError') console.error(error);
            });
    }

    // ==================== CALL LOG MANAGEMENT ====================
    async function deleteCallLog(id) {
        let approved = false;
        if (typeof window.appConfirm === 'function') {
            approved = await window.appConfirm({
                title: 'Delete Call Record',
                message: 'Delete this call record?',
                confirmText: 'Delete',
                confirmClass: 'btn btn-danger'
            });
        } else {
            approved = confirm('Delete this call record?');
        }
        if (!approved) return;

        fetch(buildCallsApiUrl(`/api/calls/logs/${id}`), { method: 'DELETE' })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    showToast('Call log deleted', 'success');
                    loadCallLogs(currentPage);
                    loadCallStats();
                } else {
                    showToast(data.message || 'Failed to delete', 'danger');
                }
            })
            .catch(console.error);
    }

    async function clearAllCalls() {
        let approved = false;
        if (typeof window.appConfirm === 'function') {
            approved = await window.appConfirm({
                title: 'Clear All Call Logs',
                message: 'Delete all call logs? This cannot be undone.',
                confirmText: 'Delete All',
                confirmClass: 'btn btn-danger'
            });
        } else {
            approved = confirm('Delete all call logs? This cannot be undone.');
        }
        if (!approved) return;

        fetch(buildCallsApiUrl('/api/calls/clear'), {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(activeDevicePayload())
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.success) {
                    showToast(`Cleared ${data.deleted || 0} call logs`, 'success');
                    loadCallLogs(1);
                    loadCallStats();
                } else {
                    showToast(data.message || 'Failed to clear calls', 'danger');
                }
            })
            .catch(function () { showToast('Error clearing calls', 'danger'); });
    }

    function refreshCalls() {
        loadCallLogs(currentPage);
        loadCallStats();
        showToast('Call logs refreshed', 'success');
    }

    async function syncCallHistory() {
        const syncBtn = elements.syncCallsBtn;
        const originalHtml = syncBtn ? syncBtn.innerHTML : '';
        if (syncBtn) {
            syncBtn.disabled = true;
            syncBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span><span class="d-none d-md-inline">Syncing</span>';
        }

        try {
            const response = await fetch(buildCallsApiUrl('/api/calls/sync'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(activeDevicePayload())
            });
            const data = await response.json();
            if (!data.success) {
                showToast(data.message || 'Failed to request call history sync', 'danger');
                return;
            }

            showToast(data.message || 'Call history sync requested', data.queued ? 'info' : 'success');
            setTimeout(function () {
                loadCallLogs(1);
                loadCallStats();
            }, 2500);
        } catch (error) {
            console.error('Error syncing call history:', error);
            showToast('Failed to request call history sync', 'danger');
        } finally {
            if (syncBtn) {
                syncBtn.disabled = false;
                syncBtn.innerHTML = originalHtml;
            }
        }
    }

    // ==================== SEARCH AND FILTER ====================
    function attachSearchAndFilter() {
        if (elements.searchCalls) {
            elements.searchCalls.addEventListener('input', debounce(filterCalls, 300));
        }

        if (elements.filterCallType) {
            elements.filterCallType.addEventListener('change', filterCalls);
        }

        if (elements.sortCalls) {
            elements.sortCalls.addEventListener('change', sortCalls);
        }

        if (elements.contactSearch) {
            elements.contactSearch.addEventListener('input', debounce(filterContacts, 300));
        }

        if (elements.modalContactSearch) {
            elements.modalContactSearch.addEventListener('input', debounce(filterModalContacts, 300));
        }

        if (elements.modalContactCompany) {
            elements.modalContactCompany.addEventListener('change', filterModalContacts);
        }
    }

    function attachQuickCallFilters() {
        document.querySelectorAll('#callQuickFilters [data-call-filter]').forEach(btn => {
            btn.addEventListener('click', function () {
                document.querySelectorAll('#callQuickFilters [data-call-filter]').forEach(el => el.classList.remove('active'));
                this.classList.add('active');
                const filter = this.dataset.callFilter;
                if (elements.filterCallType) elements.filterCallType.value = filter;
                filterCalls();
            });
        });
    }

    function normalizeCallTab(tab) {
        const value = String(tab || '').replace(/^#/, '').trim().toLowerCase();
        if (value === 'contacts') return 'contacts';
        if (value === 'dialer' || value === 'speed-dial' || value === 'speed') return 'dialer';
        return 'recent';
    }

    function initCallTabsWithUrls() {
        const params = new URLSearchParams(window.location.search);
        const initialTab = normalizeCallTab(params.get('tab') || window.location.hash);
        const initialButton = document.getElementById(`${initialTab}-tab`);
        if (initialButton && window.bootstrap?.Tab) {
            bootstrap.Tab.getOrCreateInstance(initialButton).show();
        }

        document.querySelectorAll('#callTabs [data-bs-toggle="tab"]').forEach(button => {
            button.addEventListener('shown.bs.tab', function (event) {
                const target = String(event.target?.dataset?.bsTarget || '').replace('#', '') || 'recent';
                const nextUrl = new URL(window.location.href);
                nextUrl.searchParams.set('tab', normalizeCallTab(target));
                nextUrl.hash = '';
                window.history.replaceState({}, document.title, `${nextUrl.pathname}${nextUrl.search}`);
            });
        });
    }

    function attachKeyboardShortcuts() {
        document.addEventListener('keydown', function (e) {
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
            if (e.key === '/') {
                e.preventDefault();
                elements.searchCalls?.focus();
            } else if (e.key.toLowerCase() === 'n') {
                e.preventDefault();
                window.openDialerModal?.();
            } else if (e.key.toLowerCase() === 'r') {
                e.preventDefault();
                refreshCalls();
            } else if (e.key === '?') {
                e.preventDefault();
                const modal = new bootstrap.Modal(document.getElementById('callsShortcutsModal'));
                modal.show();
            }
        });
    }

    function filterCalls() {
        const searchTerm = elements.searchCalls?.value.toLowerCase() || '';
        const filterType = elements.filterCallType?.value || 'all';

        document.querySelectorAll('#callsTableBody tr, #callsMobileList .card').forEach(item => {
            const text = item.textContent.toLowerCase();
            const matchesSearch = text.includes(searchTerm);
            const type = String(item.dataset.callType || '').toLowerCase();
            const status = String(item.dataset.callStatus || '').toLowerCase();
            const matchesFilter = filterType === 'all' || type === filterType || status === filterType;

            item.style.display = (matchesSearch && matchesFilter) ? '' : 'none';
        });
    }

    function sortCalls() {
        const sortOrder = elements.sortCalls?.value || 'newest';
        const compare = (a, b) => {
            if (sortOrder === 'duration') {
                return (Number(b.dataset.callDuration) || 0) - (Number(a.dataset.callDuration) || 0);
            }
            const timeA = Date.parse(a.dataset.callStart || '') || 0;
            const timeB = Date.parse(b.dataset.callStart || '') || 0;
            return sortOrder === 'oldest' ? timeA - timeB : timeB - timeA;
        };

        if (elements.callsTableBody) {
            Array.from(elements.callsTableBody.querySelectorAll('tr[data-call-id]'))
                .sort(compare)
                .forEach(row => elements.callsTableBody.appendChild(row));
        }

        if (elements.callsMobileList) {
            Array.from(elements.callsMobileList.querySelectorAll('.card[data-call-id]'))
                .sort(compare)
                .forEach(card => elements.callsMobileList.appendChild(card));
        }

        filterCalls();
    }

    // ==================== MODAL HANDLING ====================
    function attachModalListeners() {
        // Save contact button
        const saveBtn = document.getElementById('saveContactBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', saveContact);
        }

        // Delete contact button
        const deleteBtn = document.getElementById('deleteContactBtn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', deleteContact);
        }

        // Add contact modal reset
        const addContactModal = document.getElementById('addContactModal');
        if (addContactModal) {
            addContactModal.addEventListener('hidden.bs.modal', function() {
                document.getElementById('contactForm')?.reset();
                document.getElementById('contactId').value = '';
                document.getElementById('deleteContactBtn')?.classList.add('d-none');
            });
        }

        displayModalContacts(contacts);
    }

    window.openContactsModal = function() {
        showCallWorkspaceModal('contacts');
    };

    window.openDialerModal = function() {
        showCallWorkspaceModal('dialer', { focusDialer: true });
    };

    window.selectContact = function(phone, name) {
        setPhoneFieldValue('dialerNumber', phone);
        if (elements.dialerContactName) {
            elements.dialerContactName.textContent = name;
            elements.dialerContactName.classList.add('text-success');
        }
        updateNumberHint(phone);
        showCallWorkspaceModal('dialer', { focusDialer: true });

        showToast(`Selected: ${name}`, 'success');
    };

    // ==================== CONTACT CRUD ====================
    window.showAddContactModal = function (phoneNumber = '') {
        document.getElementById('contactModalTitle').textContent = 'Add New Contact';
        document.getElementById('contactId').value = '';
        document.getElementById('contactForm').reset();
        document.getElementById('deleteContactBtn').classList.add('d-none');

        if (phoneNumber) {
            setPhoneFieldValue('contactPhone', phoneNumber);
        }

        const modal = new bootstrap.Modal(document.getElementById('addContactModal'));
        modal.show();
    };

    function editContact(id) {
        fetch(`/api/contacts/${id}`)
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    const contact = data.data;
                    document.getElementById('contactId').value = contact.id;
                    document.getElementById('contactFormName').value = contact.name;
                    setPhoneFieldValue('contactPhone', contact.phone_number);
                    document.getElementById('contactEmail').value = contact.email || '';
                    document.getElementById('contactCompany').value = contact.company || '';
                    document.getElementById('contactFavorite').checked = contact.favorite === 1;
                    document.getElementById('contactNotes').value = contact.notes || '';

                    document.getElementById('contactModalTitle').textContent = 'Edit Contact';
                    document.getElementById('deleteContactBtn').classList.remove('d-none');

                    const modal = new bootstrap.Modal(document.getElementById('addContactModal'));
                    modal.show();
                }
            })
            .catch(console.error);
    }

    function editContactFromNumber(number) {
        const contact = findContactByNumber(number);
        if (contact) {
            editContact(contact.id);
        } else {
            showAddContactModal(number);
        }
    }

    function saveContact() {
        const id = document.getElementById('contactId').value;
        const phoneValidation = validatePhoneField('contactPhone', { allowShortCode: true });
        const data = {
            name: document.getElementById('contactFormName').value,
            phone_number: phoneValidation.value,
            email: document.getElementById('contactEmail').value,
            company: document.getElementById('contactCompany').value,
            favorite: document.getElementById('contactFavorite').checked,
            notes: document.getElementById('contactNotes').value
        };

        if (!data.name) {
            showToast('Name is required', 'warning');
            return;
        }

        if (!phoneValidation.ok) {
            showToast(phoneValidation.message, 'warning');
            return;
        }

        const saveBtn = document.getElementById('saveContactBtn');
        const originalText = saveBtn.innerHTML;
        saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Saving...';
        saveBtn.disabled = true;

        const url = id ? `/api/contacts/${id}` : '/api/contacts';
        const method = id ? 'PUT' : 'POST';

        fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    showToast(id ? 'Contact updated' : 'Contact created', 'success');

                    const modal = bootstrap.Modal.getInstance(document.getElementById('addContactModal'));
                    if (modal) modal.hide();

                    loadContacts();
                } else {
                    showToast('Failed to save contact', 'danger');
                }
            })
            .catch(console.error)
            .finally(() => {
                saveBtn.innerHTML = originalText;
                saveBtn.disabled = false;
            });
    }

    function deleteContact() {
        const id = document.getElementById('contactId').value;
        if (!id || !confirm('Delete this contact?')) return;

        fetch(`/api/contacts/${id}`, { method: 'DELETE' })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    showToast('Contact deleted', 'success');

                    const modal = bootstrap.Modal.getInstance(document.getElementById('addContactModal'));
                    if (modal) modal.hide();

                    loadContacts();
                } else {
                    showToast(data.message || 'Failed to delete', 'danger');
                }
            })
            .catch(console.error);
    }

    // ==================== INFINITE SCROLL ====================
    function updatePagination(pagination) {
        // Keep currentPage / totalPages in sync for other code that reads them
        currentPage = pagination.page;
        totalPages  = pagination.pages;

        // Hide the footer pagination nav — we use infinite scroll instead
        if (elements.callsPagination) elements.callsPagination.innerHTML = '';

        if (currentPage >= totalPages) callsExhausted = true;
    }

    function initCallsInfiniteScroll() {
        if (typeof IntersectionObserver === 'undefined') return;

        // Create a sentinel row at the bottom of the table
        const sentinel = document.createElement('tr');
        sentinel.id = 'callsScrollSentinel';
        sentinel.innerHTML = `<td colspan="9" class="text-center py-2 d-none" id="callsLoadingRow">
            <div class="spinner-border spinner-border-sm text-secondary me-2" role="status"></div>
            <span class="text-muted small">Loading more calls…</span>
        </td>`;

        if (elements.callsTableBody) elements.callsTableBody.after(sentinel);

        const io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting && !callsLoading && !callsExhausted) {
                    loadMoreCalls();
                }
            });
        }, { rootMargin: '200px' });

        io.observe(sentinel);
    }

    function loadMoreCalls() {
        if (callsLoading || callsExhausted) return;
        callsLoading = true;

        const loadingRow = document.getElementById('callsLoadingRow');
        if (loadingRow) loadingRow.classList.remove('d-none');

        const nextPage = currentPage + 1;
        fetch(buildCallsApiUrl('/api/calls/logs', { page: nextPage, limit: 10 }), { signal: newSignal('callLogsMore') })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data.success || !data.data || data.data.length === 0) {
                    callsExhausted = true;
                    return;
                }

                // Build rows to append
                const existing = new Set(
                    Array.from(elements.callsTableBody.querySelectorAll('[data-call-id]'))
                        .map(function (r) { return r.dataset.callId; })
                );

                let mobileHtml = '';
                data.data.forEach(function (call) {
                    if (existing.has(String(call.id))) return;
                    const formattedNumber = formatDisplayNumber(call.phone_number);
                    const matchedContact = findContactByNumber(call.phone_number);
                    const contactName = call.contact_name || matchedContact?.name || formattedNumber;
                    const icon = getCallIcon(call.type, call.status);
                    const statusClass = getStatusClass(call.status);
                    const statusBadge = getStatusBadge(call.status);
                    const statusText = getStatusText(call.status);
                    const tr = document.createElement('tr');
                    tr.dataset.callId = call.id;
                    tr.dataset.callType = call.type || '';
                    tr.dataset.callStatus = call.status || '';
                    tr.dataset.callStart = call.start_time || '';
                    tr.dataset.callDuration = String(Number(call.duration) || 0);
                    tr.dataset.phone = call.phone_number || '';
                    tr.innerHTML = `
                        <td class="calls-bulk-col d-none">
                            <input type="checkbox" class="form-check-input call-select-cb" value="${call.id}">
                        </td>
                        <td><div class="avatar-circle ${statusClass}"><i class="bi ${icon}"></i></div></td>
                        <td>
                            <div class="fw-bold">${escapeHtml(contactName)}</div>
                            ${call.contact_company ? `<small class="text-muted">${escapeHtml(call.contact_company)}</small>` : ''}
                        </td>
                        <td>${formattedNumber}</td>
                        <td>${formatDate(call.start_time)}</td>
                        <td>${formatDuration(call.duration)}</td>
                        <td><span class="badge ${statusBadge}">${statusText}</span></td>
                        <td>${call.dialed_by ? `<span class="badge bg-secondary">${escapeHtml(call.dialed_by)}</span>` : '<span class="text-muted">â€”</span>'}</td>
                        <td>
                            <div class="btn-group btn-group-sm">
                                <button class="btn btn-outline-success" data-phone="${escapeHtml(call.phone_number || '')}" onclick="quickCall(this.dataset.phone)" ${!isDeviceConnected ? 'disabled' : ''}><i class="bi bi-telephone"></i></button>
                                <button class="btn btn-outline-info" data-phone="${escapeHtml(call.phone_number || '')}" onclick="quickSms(this.dataset.phone)"><i class="bi bi-chat-dots"></i></button>
                                <button class="btn btn-outline-primary" data-phone="${escapeHtml(call.phone_number || '')}" onclick="editContactFromNumber(this.dataset.phone)"><i class="bi bi-person-plus"></i></button>
                                <button class="btn btn-outline-danger" onclick="deleteCallLog(${call.id})"><i class="bi bi-trash"></i></button>
                            </div>
                        </td>`;
                    elements.callsTableBody.appendChild(tr);

                    mobileHtml += `<div class="card mb-2" data-call-id="${call.id}" data-call-type="${escapeHtml(call.type || '')}" data-call-status="${escapeHtml(call.status || '')}" data-call-start="${escapeHtml(call.start_time || '')}" data-call-duration="${Number(call.duration) || 0}" data-phone="${escapeHtml(call.phone_number || '')}">
                        <div class="card-body">
                            <div class="d-flex align-items-start gap-3">
                                <div class="flex-shrink-0">
                                    <div class="avatar-circle ${statusClass}"><i class="bi ${icon}"></i></div>
                                </div>
                                <div class="flex-grow-1">
                                    <div class="d-flex justify-content-between mb-1">
                                        <h6 class="mb-0">${escapeHtml(contactName)}</h6>
                                        <small class="text-muted">${formatDate(call.start_time)}</small>
                                    </div>
                                    <p class="mb-1 small">${formattedNumber}</p>
                                    ${call.contact_company ? `<small class="text-muted d-block mb-1">${escapeHtml(call.contact_company)}</small>` : ''}
                                    <div class="d-flex justify-content-between align-items-center mt-2">
                                        <div>
                                            <span class="badge ${statusBadge} me-2">${statusText}</span>
                                            <small class="text-muted">${formatDuration(call.duration)}</small>
                                        </div>
                                        <div class="btn-group btn-group-sm">
                                            <button class="btn btn-outline-success" data-phone="${escapeHtml(call.phone_number || '')}" onclick="quickCall(this.dataset.phone)" ${!isDeviceConnected ? 'disabled' : ''}><i class="bi bi-telephone"></i></button>
                                            <button class="btn btn-outline-danger" onclick="deleteCallLog(${call.id})"><i class="bi bi-trash"></i></button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>`;
                });

                if (elements.callsMobileList) {
                    elements.callsMobileList.insertAdjacentHTML('beforeend', mobileHtml);
                }

                // DOM windowing: prune oldest rows when over limit
                const rows = elements.callsTableBody.querySelectorAll('[data-call-id]');
                if (rows.length > DOM_WINDOW_CALLS) {
                    const excess = rows.length - DOM_WINDOW_CALLS;
                    for (let i = 0; i < excess; i++) rows[i].remove();
                }

                currentPage = nextPage;
                if (nextPage >= data.pagination.pages) callsExhausted = true;
                sortCalls();
            })
            .catch(function (err) {
                if (err && err.name === 'AbortError') return;
            })
            .finally(function () {
                callsLoading = false;
                const loadingRow = document.getElementById('callsLoadingRow');
                if (loadingRow) loadingRow.classList.add('d-none');
            });
    }

    // ==================== HELPER FUNCTIONS ====================
    function formatNumber(number) {
        const raw = String(number || '').trim();
        if (!raw) return '';
        if (window.PhoneInputs?.looksLikeShortCode?.(raw) && !raw.startsWith('+')) {
            return raw.replace(/\s+/g, '');
        }
        const digits = raw.replace(/\D/g, '');
        if (!digits) return raw;
        if (raw.startsWith('+')) return '+' + digits;
        if (raw.startsWith('00')) return '+' + digits.slice(2);
        return raw;
    }

    function formatDisplayNumber(number) {
        if (!number) return 'Unknown';
        return formatNumber(number) || String(number);
    }

    function getCallIcon(type, status) {
        if (status === 'online') status = 'connected';
        if (status === 'missed') return 'bi-telephone-x';
        if (type === 'incoming') return 'bi-telephone-inbound';
        if (type === 'outgoing') return 'bi-telephone-outbound';
        return 'bi-telephone';
    }

    function getStatusClass(status) {
        if (status === 'online') status = 'connected';
        switch (status) {
            case 'missed': return 'text-danger';
            case 'answered': return 'text-success';
            case 'connected': return 'text-success';
            case 'rejected': return 'text-warning';
            case 'busy': return 'text-warning';
            case 'no_answer': return 'text-secondary';
            default: return 'text-primary';
        }
    }

    function getStatusBadge(status) {
        if (status === 'online') status = 'connected';
        switch (status) {
            case 'missed': return 'bg-danger';
            case 'answered': return 'bg-success';
            case 'connected': return 'bg-success';
            case 'rejected': return 'bg-warning';
            case 'busy': return 'bg-warning';
            case 'no_answer': return 'bg-secondary';
            case 'dialing': return 'bg-primary';
            case 'ringing': return 'bg-info';
            case 'ending': return 'bg-dark';
            default: return 'bg-secondary';
        }
    }

    function getStatusText(status) {
        const map = {
            'dialing': 'Dialing',
            'ringing': 'Ringing',
            'answered': 'Answered',
            'connected': 'Connected',
            'online': 'Connected',
            'ending': 'Ending',
            'missed': 'Missed',
            'rejected': 'Rejected',
            'busy': 'Busy',
            'no_answer': 'No Answer',
            'ended': 'Ended'
        };
        return map[status] || status;
    }

    function getActiveBannerClass(status) {
        if (status === 'online') status = 'connected';
        switch (status) {
            case 'ringing': return 'alert-info';
            case 'answered': return 'alert-primary';
            case 'connected': return 'alert-success';
            case 'dialing': return 'alert-primary';
            case 'ending': return 'alert-secondary';
            default: return 'alert-success';
        }
    }

    function formatDate(dateString) {
        if (!dateString) return 'Unknown';
        const date = new Date(dateString);
        const now = new Date();
        const diff = now - date;

        if (diff < 24 * 60 * 60 * 1000 && date.getDate() === now.getDate()) {
            return `Today, ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
        }

        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (date.getDate() === yesterday.getDate() && date.getMonth() === yesterday.getMonth()) {
            return `Yesterday, ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
        }

        return `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getFullYear()}`;
    }

    // ==================== CLEANUP ====================
    window.addEventListener('beforeunload', function () {
        if (callStatusInterval) {
            clearInterval(callStatusInterval);
        }
    });

    // ==================== BULK SELECT ====================
    function toggleCallsSelectMode() {
        callsSelectMode = !callsSelectMode;
        const cols = document.querySelectorAll('.calls-bulk-col');
        const btn = document.getElementById('callsSelectToggle');
        const deleteBtn = document.getElementById('callsBulkDeleteBtn');
        const countEl = document.getElementById('callsSelectedCount');
        const selectAll = document.getElementById('callsSelectAll');

        cols.forEach(el => el.classList.toggle('d-none', !callsSelectMode));

        if (callsSelectMode) {
            btn.innerHTML = '<i class="bi bi-x-lg me-1"></i>Cancel';
            if (selectAll) {
                selectAll.onchange = function () {
                    document.querySelectorAll('.call-select-cb').forEach(cb => { cb.checked = selectAll.checked; });
                    updateCallsSelectionCount();
                };
            }
            document.querySelectorAll('.call-select-cb').forEach(cb => {
                cb.onchange = updateCallsSelectionCount;
            });
        } else {
            btn.innerHTML = '<i class="bi bi-check2-square me-1"></i>Select';
            document.querySelectorAll('.call-select-cb').forEach(cb => { cb.checked = false; });
            if (selectAll) selectAll.checked = false;
            if (deleteBtn) deleteBtn.classList.add('d-none');
            if (countEl) countEl.classList.add('d-none');
        }
    }

    function updateCallsSelectionCount() {
        const checked = document.querySelectorAll('.call-select-cb:checked');
        const deleteBtn = document.getElementById('callsBulkDeleteBtn');
        const countEl = document.getElementById('callsSelectedCount');
        const n = checked.length;
        if (n > 0) {
            if (deleteBtn) deleteBtn.classList.remove('d-none');
            if (countEl) { countEl.textContent = n + ' selected'; countEl.classList.remove('d-none'); }
        } else {
            if (deleteBtn) deleteBtn.classList.add('d-none');
            if (countEl) countEl.classList.add('d-none');
        }
    }

    function bulkDeleteCalls() {
        const checked = Array.from(document.querySelectorAll('.call-select-cb:checked'));
        if (checked.length === 0) return;
        const ids = checked.map(cb => Number(cb.value));

        if (!confirm('Delete ' + ids.length + ' call log' + (ids.length > 1 ? 's' : '') + '?')) return;

        const deleteBtn = document.getElementById('callsBulkDeleteBtn');
        if (deleteBtn) { deleteBtn.disabled = true; deleteBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Deleting…'; }

        fetch(buildCallsApiUrl('/api/calls/logs/bulk-delete'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(activeDevicePayload({ ids }))
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                // Remove rows from DOM
                ids.forEach(id => {
                    document.querySelectorAll(`[data-call-id="${id}"]`).forEach(el => el.remove());
                });
                toggleCallsSelectMode(); // exit select mode
                if (typeof showToast === 'function') showToast('Deleted ' + ids.length + ' call log' + (ids.length > 1 ? 's' : ''), 'success');
            } else {
                if (typeof showToast === 'function') showToast('Delete failed: ' + (data.message || 'unknown error'), 'danger');
                if (deleteBtn) { deleteBtn.disabled = false; deleteBtn.innerHTML = '<i class="bi bi-trash me-1"></i>Delete selected'; }
            }
        })
        .catch(() => {
            if (typeof showToast === 'function') showToast('Network error during delete', 'danger');
            if (deleteBtn) { deleteBtn.disabled = false; deleteBtn.innerHTML = '<i class="bi bi-trash me-1"></i>Delete selected'; }
        });
    }

    // ==================== EXPOSE GLOBALLY ====================
    window.loadCallLogs = loadCallLogs;
    window.refreshCalls = refreshCalls;
    window.syncCallHistory = syncCallHistory;
    window.endCall = endCall;
    window.deleteCallLog = deleteCallLog;
    window.clearAllCalls = clearAllCalls;
    window.editContact = editContact;
    window.editContactFromNumber = editContactFromNumber;
    window.showAddContactModal = showAddContactModal;
    window.formatNumber = formatNumber;
    window.formatDisplayNumber = formatDisplayNumber;
    window.toggleCallsSelectMode = toggleCallsSelectMode;
    window.bulkDeleteCalls = bulkDeleteCalls;

    // ---- IndexedDB: seed from server-rendered DOM ----
    // Keeps last 500 call records locally for offline display.
    (function seedIdb() {
        const db = window.localDb;
        if (!db) return;
        const rows = document.querySelectorAll('[data-call-id]');
        if (!rows.length) return;
        const records = Array.from(rows).map(function (el) {
            return {
                server_id: Number(el.dataset.callId),
                phone_number: el.dataset.phone || null,
                type: el.dataset.type || 'incoming',
                status: el.dataset.status || 'ended',
                duration: Number(el.dataset.duration) || 0,
                start_time: el.dataset.startTime || new Date().toISOString()
            };
        });
        db.calls.bulkAdd(records).catch(function () {});
        // Trim to 500
        db.calls.count().then(function (count) {
            if (count > 500) {
                db.calls.orderBy('start_time').limit(count - 500).primaryKeys()
                    .then(function (keys) { return db.calls.bulkDelete(keys); })
                    .catch(function () {});
            }
        }).catch(function () {});
    })();
})();
