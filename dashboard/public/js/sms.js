// SMS page specific functionality with contacts integration
(function () {
    'use strict';

    // State
    let contacts = [];
    let pageCtrl = null;
    let liveSmsHandlers = {};
    let smsSyncStartedHandler = null;
    let smsSyncCompletedHandler = null;
    let smsSyncHideTimer = null;
    let refreshTimer = null;
    let threadRefreshTimer = null;
    let smsRefreshToken = 0;
    let smsThreadToken = 0;
    let shouldReopenComposeAfterContacts = false;
    let contactTargetFieldId = 'smsChatTo';
    const threadState = {
        number: '',
        conversationId: null,
        title: '',
        messages: []
    };
    let smsAttachment = null;

    function newSignal() {
        if (pageCtrl) pageCtrl.abort();
        pageCtrl = new AbortController();
        return pageCtrl.signal;
    }

    function getSmsActiveDeviceId() {
        const activeDeviceId = window.getActiveDeviceId
            ? window.getActiveDeviceId()
            : (window.SMS_INIT?.deviceId || '');
        return String(activeDeviceId || '').trim();
    }

    function getSmsActiveSimSlot() {
        return getSmsActiveSimContext().simSlot;
    }

    function getSmsActiveSimContext() {
        if (typeof window.getActiveDeviceSimContext === 'function') {
            return window.getActiveDeviceSimContext() || {
                deviceId: getSmsActiveDeviceId(),
                simSlot: null
            };
        }
        return {
            deviceId: getSmsActiveDeviceId(),
            simSlot: typeof window.getActiveDeviceSimSlot === 'function' ? window.getActiveDeviceSimSlot() : null
        };
    }

    function getSmsActiveCapabilities() {
        const activeDeviceId = getSmsActiveDeviceId();
        if (!activeDeviceId) return {};
        try {
            const raw = localStorage.getItem(`deviceCaps_${activeDeviceId}`);
            return raw ? (JSON.parse(raw) || {}) : {};
        } catch (_) {
            return {};
        }
    }

    function getSmsTransportMode() {
        const caps = getSmsActiveCapabilities();
        return String(caps.transport_mode || caps.transportMode || '').trim().toLowerCase() === 'http'
            ? 'http'
            : 'mqtt';
    }

    function isSmsHttpUiAvailable() {
        if (getSmsTransportMode() !== 'http') {
            return false;
        }
        return typeof window.deviceHttpOnline === 'function'
            ? Boolean(window.deviceHttpOnline())
            : false;
    }

    function syncSmsHttpRequiredUi() {
        const showHttpUi = isSmsHttpUiAvailable();
        document.querySelectorAll('[data-sms-http-required="true"]').forEach(function (el) {
            const restoreDisplay = String(el.dataset.smsHttpDisplay || '').trim();
            el.style.display = showHttpUi ? restoreDisplay : 'none';
        });

        if (!showHttpUi) {
            resetSmsAttachment();
        }
    }

    function isSmsDeviceSnapshotCurrent(deviceId) {
        return String(deviceId || '') === getSmsActiveDeviceId();
    }

    function matchesSmsScope(payload = {}) {
        const activeDeviceId = getSmsActiveDeviceId();
        const payloadDeviceId = String(payload?.deviceId || payload?.device_id || '').trim();
        if (activeDeviceId && payloadDeviceId && payloadDeviceId !== activeDeviceId) {
            return false;
        }

        const activeContext = getSmsActiveSimContext();
        const activeSimSlot = activeContext.simSlot;
        if (activeSimSlot === null) {
            return true;
        }
        const payloadSimSlot = payload?.simSlot ?? payload?.sim_slot ?? null;
        if (payloadSimSlot === null || payloadSimSlot === undefined || payloadSimSlot === '') {
            return true;
        }

        return Number(payloadSimSlot) === Number(activeSimSlot);
    }

    function setSmsSyncOverlay(visible, payload = {}) {
        const overlay = document.getElementById('smsSyncOverlay');
        if (!overlay) return;
        const text = document.getElementById('smsSyncOverlayText');
        if (smsSyncHideTimer) {
            clearTimeout(smsSyncHideTimer);
            smsSyncHideTimer = null;
        }
        if (visible) {
            const total = Number(payload.total || 0);
            overlay.classList.remove('d-none');
            if (text) {
                text.textContent = total > 0
                    ? `Syncing ${total} message${total === 1 ? '' : 's'} from the phone. Dashboard updates will resume after completion.`
                    : 'Please wait while messages are copied from the phone.';
            }
            return;
        }
        if (text) {
            const synced = Number(payload.synced || 0);
            text.textContent = synced > 0
                ? `Sync complete. ${synced} message${synced === 1 ? '' : 's'} copied.`
                : 'Sync complete. Refreshing dashboard.';
        }
        smsSyncHideTimer = setTimeout(function () {
            overlay.classList.add('d-none');
        }, 700);
    }

    async function pullDeviceMessages(button) {
        const deviceId = getSmsActiveDeviceId();
        if (!deviceId) {
            showToast('Select a device first.', 'warning');
            return;
        }
        const btn = button?.closest ? button.closest('button') : button;
        const originalHtml = btn?.innerHTML || '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Pulling';
        }
        setSmsSyncOverlay(true, { requested: true });
        try {
            const response = await fetchSmsJson(buildSmsRequestUrl('/api/sms/sync'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceId })
            });
            if (!response?.success) {
                throw new Error(response?.message || 'Failed to request message pull');
            }
            showToast(response.message || 'Message pull requested', 'success');
        } catch (error) {
            setSmsSyncOverlay(false, { synced: 0 });
            showToast(error.message || 'Failed to request message pull', 'danger');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = originalHtml;
            }
        }
    }

    function buildSmsRequestUrl(url, options = {}) {
        const requestUrl = new URL(url, window.location.origin);
        const includeDeviceId = options.includeDeviceId !== false;
        const fresh = Boolean(options.fresh);
        const activeContext = includeDeviceId ? getSmsActiveSimContext() : {
            deviceId: '',
            simSlot: null
        };

        if (activeContext.deviceId && requestUrl.pathname.startsWith('/api/sms') && !requestUrl.searchParams.has('deviceId')) {
            requestUrl.searchParams.set('deviceId', activeContext.deviceId);
        }
        if (activeContext.simSlot !== null && requestUrl.pathname.startsWith('/api/sms') && !requestUrl.searchParams.has('simSlot')) {
            requestUrl.searchParams.set('simSlot', String(activeContext.simSlot));
        }
        if (fresh && !requestUrl.searchParams.has('_ts')) {
            requestUrl.searchParams.set('_ts', String(Date.now()));
        }

        return `${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`;
    }

    function analyzeSmsComposeText(text) {
        if (window.smsComposeLimits?.analyze) {
            return window.smsComposeLimits.analyze(text);
        }

        const normalized = String(text || '');
        return {
            text: normalized,
            characters: normalized.length,
            utf8Bytes: normalized.length,
            parts: normalized.length > 160 ? Math.ceil(normalized.length / 153) : 1,
            encoding: 'gsm7',
            valid: normalized.length <= 1023,
            overByteLimit: normalized.length > 1023,
            overPartLimit: false
        };
    }

    function clampSmsComposeText(text) {
        if (window.smsComposeLimits?.clamp) {
            return window.smsComposeLimits.clamp(text);
        }
        return String(text || '').slice(0, 1023);
    }

    function updateSmsComposeCounter(fieldId, options = {}) {
        const field = typeof fieldId === 'string' ? document.getElementById(fieldId) : fieldId;
        const countEl = document.getElementById(options.countId);
        const byteEl = options.byteId ? document.getElementById(options.byteId) : null;
        const partsEl = options.partsId ? document.getElementById(options.partsId) : null;

        if (!field) {
            return analyzeSmsComposeText('');
        }

        const clamped = clampSmsComposeText(field.value);
        if (clamped !== field.value) {
            field.value = clamped;
        }

        const analysis = analyzeSmsComposeText(field.value);
        if (countEl) {
            countEl.textContent = String(analysis.characters);
            countEl.className = '';
            if (analysis.utf8Bytes >= 0.8 * (window.smsComposeLimits?.SMS_MAX_UTF8_BYTES || 1023)) {
                countEl.classList.add('text-warning');
            }
            if (analysis.parts > 1) {
                countEl.classList.remove('text-warning');
                countEl.classList.add('text-info');
            }
            if (!analysis.valid) {
                countEl.classList.remove('text-info');
                countEl.classList.add('text-danger');
            }
        }
        if (byteEl) {
            byteEl.textContent = String(analysis.utf8Bytes);
        }
        if (partsEl) {
            const contractLabel = analysis.parts > 1 ? 'multipart' : 'single';
            const singleLimit = analysis.singlePartLimit || (analysis.encoding === 'gsm7' ? 160 : 70);
            partsEl.textContent = `(${contractLabel}: ${analysis.parts} part${analysis.parts === 1 ? '' : 's'}, ${analysis.encoding === 'gsm7' ? 'GSM-7' : 'Unicode'}, limit ${singleLimit})`;
            partsEl.classList.toggle('text-info', analysis.parts > 1);
            partsEl.classList.toggle('text-muted', analysis.parts <= 1);
        }

        return analysis;
    }

    function bindSmsComposeCounter(fieldId, options = {}) {
        const field = document.getElementById(fieldId);
        if (!field) {
            return;
        }

        if (field.dataset.smsLimitBound !== '1') {
            field.dataset.smsLimitBound = '1';
            field.addEventListener('input', function () {
                updateSmsComposeCounter(field, options);
            });
        }

        updateSmsComposeCounter(field, options);
    }

    window.updateSmsComposeCounterById = updateSmsComposeCounter;

    function fetchSmsJson(url, options = {}) {
        const requestOptions = { ...options };
        const method = String(requestOptions.method || 'GET').toUpperCase();
        const headers = new Headers(requestOptions.headers || {});
        const isReadRequest = method === 'GET' || method === 'HEAD';
        const includeDeviceId = requestOptions.includeDeviceId !== false;
        const activeContext = includeDeviceId ? getSmsActiveSimContext() : {
            simSlot: null
        };

        delete requestOptions.includeDeviceId;

        if (!isReadRequest
            && activeContext.simSlot !== null
            && requestOptions.body
            && headers.get('Content-Type')?.includes('application/json')) {
            try {
                const parsedBody = JSON.parse(String(requestOptions.body || '{}'));
                if (parsedBody.simSlot === undefined && parsedBody.sim_slot === undefined) {
                    parsedBody.simSlot = activeContext.simSlot;
                }
                requestOptions.body = JSON.stringify(parsedBody);
            } catch (_) {}
        }

        if (isReadRequest) {
            headers.set('Cache-Control', 'no-cache');
            headers.set('Pragma', 'no-cache');
            requestOptions.cache = 'no-store';
        }

        requestOptions.credentials = requestOptions.credentials || 'same-origin';
        requestOptions.headers = headers;

        return fetch(buildSmsRequestUrl(url, {
            includeDeviceId,
            fresh: isReadRequest
        }), requestOptions).then(function (response) {
            return response.json();
        });
    }

    function setPhoneFieldValue(id, value) {
        if (id === 'smsChatTo' || id === 'modalTo') {
            const el = document.getElementById(id);
            if (el) {
                el.value = value || '';
                updateRecipientMeta(id);
            }
            return;
        }
        if (window.PhoneInputs?.setValue) {
            window.PhoneInputs.setValue(id, value || '');
            return;
        }
        const el = document.getElementById(id);
        if (el) el.value = value || '';
    }

    function splitRecipientEntries(value) {
        return String(value || '')
            .split(/[\n,;]+/)
            .map(function (entry) { return entry.trim(); })
            .filter(Boolean);
    }

    function getRecipientMetaId(fieldId) {
        if (fieldId === 'smsChatTo') return 'smsChatRecipientMeta';
        if (fieldId === 'schedTo') return 'schedRecipientMeta';
        return 'modalRecipientMeta';
    }

    function getRecipientPillsId(fieldId) {
        if (fieldId === 'smsChatTo') return 'smsChatRecipientPills';
        if (fieldId === 'schedTo') return 'schedRecipientPills';
        return 'modalRecipientPills';
    }

    function isChatRecipientField(fieldId) {
        return fieldId === 'smsChatTo';
    }

    function getUniqueRecipientEntries(value) {
        return Array.from(new Set(splitRecipientEntries(value)));
    }

    function setRecipientValues(fieldId, values) {
        const field = document.getElementById(fieldId);
        if (!field) return;
        field.value = getUniqueRecipientEntries(values).join(', ');
        updateRecipientMeta(fieldId);
    }

    function renderRecipientPills(fieldId) {
        const field = document.getElementById(fieldId);
        const container = document.getElementById(getRecipientPillsId(fieldId));
        if (!field || !container) return;

        const unique = getUniqueRecipientEntries(field.value);
        if (!unique.length) {
            if (isChatRecipientField(fieldId)) {
                container.classList.remove('d-none');
                container.innerHTML = '';
            } else {
                container.classList.add('d-none');
                container.innerHTML = '';
            }
            return;
        }

        container.classList.remove('d-none');
        container.innerHTML = unique.map(function (value) {
            return `
                <span class="sms-recipient-pill" data-recipient-value="${esc(value)}">
                    <span>${esc(value)}</span>
                    <button type="button" class="sms-recipient-pill-remove" data-field-id="${esc(fieldId)}" data-recipient-value="${esc(value)}" aria-label="Remove recipient ${esc(value)}">
                        <i class="bi bi-x-lg"></i>
                    </button>
                </span>
            `;
        }).join('');
    }

    function updateRecipientMeta(fieldId) {
        const field = document.getElementById(fieldId);
        const meta = document.getElementById(getRecipientMetaId(fieldId));
        if (!field) return;
        const unique = getUniqueRecipientEntries(field.value);
        renderRecipientPills(fieldId);
        if (!meta) return;
        if (!unique.length) {
            meta.textContent = isChatRecipientField(fieldId)
                ? ''
                : 'Single or multiple numbers: separate with comma, semicolon, or new line.';
            return;
        }
        meta.textContent = isChatRecipientField(fieldId)
            ? `${unique.length} recipient${unique.length === 1 ? '' : 's'} ready`
            : `${unique.length} recipient${unique.length === 1 ? '' : 's'} selected`;
    }

    function appendRecipientValue(fieldId, value) {
        const field = document.getElementById(fieldId);
        if (!field) return;
        setRecipientValues(fieldId, [
            ...splitRecipientEntries(field.value),
            ...splitRecipientEntries(value)
        ]);
    }

    function focusChatRecipientEditor() {
        const editor = document.getElementById('smsChatRecipientEditor');
        const input = document.getElementById('smsChatRecipientEntry');
        if (!editor || !input) return;
        window.PhoneInputs?.ensureInit?.();
        editor.classList.remove('d-none');
        requestAnimationFrame(function () {
            input.focus();
            input.select?.();
        });
    }

    function closeChatRecipientEditor(options = {}) {
        const editor = document.getElementById('smsChatRecipientEditor');
        const input = document.getElementById('smsChatRecipientEntry');
        if (editor) editor.classList.add('d-none');
        if (input && options.clear !== false) {
            if (window.PhoneInputs?.setValue) {
                window.PhoneInputs.setValue(input, '');
            } else {
                input.value = '';
            }
        }
    }

    function validateChatRecipientEntry() {
        const input = document.getElementById('smsChatRecipientEntry');
        if (!input) return { ok: false, value: '', message: 'Phone number is required' };
        const validation = window.PhoneInputs?.validate
            ? window.PhoneInputs.validate(input, { required: false })
            : { ok: Boolean(String(input.value || '').trim()), value: String(input.value || '').trim(), message: 'Phone number is required' };
        input.classList.toggle('is-invalid', Boolean(validation.value) && !validation.ok);
        return validation;
    }

    function commitChatRecipientEntry() {
        const input = document.getElementById('smsChatRecipientEntry');
        if (!input) return;
        const validation = validateChatRecipientEntry();
        if (!validation.value) {
            closeChatRecipientEditor();
            return;
        }
        if (!validation.ok) {
            if (typeof showToast === 'function') {
                showToast(validation.message || 'Enter a valid phone number', 'warning');
            }
            requestAnimationFrame(function () {
                input.focus();
                input.select?.();
            });
            return;
        }
        appendRecipientValue('smsChatTo', validation.value);
        closeChatRecipientEditor();
    }

    function validateChatScheduleInput(options = {}) {
        const input = document.getElementById('smsChatScheduleAt');
        if (!input) return { ok: true, value: '' };
        const raw = String(input.value || '').trim();
        if (!raw) {
            input.classList.toggle('is-invalid', Boolean(options.markInvalid));
            return { ok: false, value: raw, message: 'Choose a schedule time first.' };
        }
        const scheduledDate = new Date(raw);
        const ok = Number.isFinite(scheduledDate.getTime()) && scheduledDate > new Date();
        input.classList.toggle('is-invalid', !ok && options.markInvalid !== false);
        return {
            ok,
            value: raw,
            date: scheduledDate,
            message: ok ? '' : 'Choose a future time for scheduled SMS.'
        };
    }

    function validatePhoneField(id, options = {}) {
        if (id === 'smsChatTo' || id === 'modalTo') {
            const el = document.getElementById(id);
            const values = Array.from(new Set(splitRecipientEntries(el?.value || '')));
            if (!values.length) {
                return { ok: options.required === false, value: '', values, message: 'Phone number is required' };
            }
            return { ok: true, value: values[0], values, message: '' };
        }
        if (window.PhoneInputs?.validate) {
            return window.PhoneInputs.validate(id, options);
        }

        const el = document.getElementById(id);
        const value = String(el?.value || '').trim();
        if (!value) return { ok: options.required === false, value, message: 'Phone number is required' };
        return { ok: true, value, message: '' };
    }

    window.addEventListener('beforeunload', function () {
        if (pageCtrl) pageCtrl.abort();
        if (refreshTimer) clearTimeout(refreshTimer);
        if (threadRefreshTimer) clearTimeout(threadRefreshTimer);
    });

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        // Attach event listeners
        attachDeleteListeners();
        attachMarkReadListeners();
        attachModalListeners();
        attachCharCounter();
        attachQuickActions();
        attachThreadListeners();
        updateThreadActionButtons('');
        attachSearchAndFilter();
        attachTemplateButtons();
        attachQuickFilterChips();
        attachKeyboardShortcuts();
        attachLiveSmsUpdates();
        attachScheduledSmsUpdates();
        attachSmsAttachmentControls();
        attachRecipientInputHandlers();
        attachChatRecipientControls();
        attachChatSendModeControls();
        updateSmsExportLink();
        syncSmsHttpRequiredUi();
        prefillComposeFromQuery();
        attachDeviceChangeHandler();
        attachSmsHttpUiStateHandlers();
        updateThreadPermalink('');
        window.addEventListener('popstate', handleThreadPopState);

        // Load contacts for contact selection modal
        loadContacts();
        refreshSmsPageData();
        if (typeof window.loadScheduledSms === 'function') {
            window.loadScheduledSms();
        }
    }

    function handleSmsScopeChange(options = {}) {
        const resetThread = options.resetThread !== false;
        if (window.SMS_INIT) {
            window.SMS_INIT.deviceId = getSmsActiveDeviceId();
        }
        updateSmsExportLink();
        syncSmsHttpRequiredUi();
        if (resetThread) {
            clearThreadSelection({ historyMode: 'replace' });
        } else {
            updateThreadPermalink(threadState.number, threadState.conversationId, threadState.title);
        }
        scheduleSmsRefresh(150);
        if (typeof window.loadScheduledSms === 'function') {
            window.loadScheduledSms();
        }
        if (!resetThread && isThreadModalOpen() && threadState.number) {
            scheduleThreadRefresh(200);
        }
    }

    function attachDeviceChangeHandler() {
        window.addEventListener('device:changed', function () {
            handleSmsScopeChange({ resetThread: true });
        });
        window.addEventListener('device:sim-changed', function () {
            if (window.SMS_INIT) {
                window.SMS_INIT.deviceId = getSmsActiveDeviceId();
            }
            handleSmsScopeChange({ resetThread: true });
        });
    }

    function attachSmsHttpUiStateHandlers() {
        if (!window.socket?.on || window.__smsHttpUiStateBound === '1') {
            return;
        }
        window.__smsHttpUiStateBound = '1';

        window.socket.on('device:status', function (status) {
            if (!matchesSmsScope(status)) return;
            syncSmsHttpRequiredUi();
        });

        window.socket.on('device:capabilities', function (payload) {
            if (!matchesSmsScope(payload)) return;
            syncSmsHttpRequiredUi();
        });
    }

    function prefillComposeFromQuery() {
        const params = new URLSearchParams(window.location.search);
        const thread = params.get('thread');
        const conversationId = Math.max(0, Number(params.get('conversation')) || 0);
        const title = String(params.get('title') || '').trim();
        const to = params.get('to');
        if (thread || conversationId) {
            threadState.number = thread;
            threadState.conversationId = conversationId || null;
            threadState.title = title || thread;
            loadSmsThread(thread, {
                conversationId,
                title,
                showModal: false,
                silent: true,
                historyMode: 'replace'
            });
        }
        if (!to) return;
        setPhoneFieldValue('smsChatTo', to);
        setPhoneFieldValue('modalTo', to);
        const chatMessage = document.getElementById('smsChatMessage');
        if (chatMessage) {
            chatMessage.focus();
            return;
        }
        const modalEl = document.getElementById('composeSmsModal');
        if (modalEl) {
            const modal = new bootstrap.Modal(modalEl);
            modal.show();
        }
    }

    function handleThreadPopState() {
        const params = new URLSearchParams(window.location.search);
        const thread = String(params.get('thread') || '').trim();
        const conversationId = Math.max(0, Number(params.get('conversation')) || 0);
        const title = String(params.get('title') || '').trim();
        if (thread || conversationId) {
            loadSmsThread(thread, {
                conversationId,
                title,
                showModal: false,
                silent: true,
                historyMode: 'ignore'
            });
            return;
        }
        clearThreadSelection({ historyMode: 'ignore' });
    }

    function updateSmsExportLink() {
        const link = document.getElementById('smsExportCsvLink');
        if (!link) return;
        link.setAttribute('href', buildSmsRequestUrl('/api/sms/export/csv', { fresh: true }));
    }

    function attachLiveSmsUpdates() {
        if (!window.socket || typeof window.socket.on !== 'function') return;

        if (Object.keys(liveSmsHandlers).length && typeof window.socket.off === 'function') {
            Object.entries(liveSmsHandlers).forEach(function (entry) {
                window.socket.off(entry[0], entry[1]);
            });
        }
        if (smsSyncStartedHandler && typeof window.socket.off === 'function') {
            window.socket.off('sms:sync-started', smsSyncStartedHandler);
            window.socket.off('sms:sync-completed', smsSyncCompletedHandler);
        }

        function handleLiveSmsEvent(eventName, data) {
            if (!matchesSmsScope(data)) return;
            if (data?.sync) return;

            if (eventName === 'sms:read' || eventName === 'sms:deleted' || eventName === 'sms:bulk-read' || eventName === 'sms:bulk-deleted') {
                if (data?.unreadCount !== undefined && data?.unreadCount !== null) {
                    updateUnreadBadge(data.unreadCount);
                }
                scheduleSmsRefresh(80);
                scheduleThreadRefresh(80);
                return;
            }

            if (eventName === 'sms:sent' || eventName === 'sms:delivered' || eventName === 'sms:send-failed') {
                const updated = updateThreadMessageStatus(data, eventName);
                updateRenderedThreadMessageStatus(data, eventName);
                updateConversationItemStatus(data, eventName);
                scheduleSmsRefresh(updated ? 60 : 80);
                if (!updated) {
                    scheduleThreadRefresh(80);
                }
                return;
            }

            const liveMessage = buildLiveThreadMessage(data, eventName);
            const applied = liveMessage
                && isLiveSmsCurrentThread(data, eventName)
                && upsertThreadMessage(liveMessage);

            if (data?.unreadCount !== undefined && data?.unreadCount !== null) {
                updateUnreadBadge(data.unreadCount);
            }

            scheduleSmsRefresh(applied ? 60 : 80);
            if (!applied) {
                scheduleThreadRefresh(80);
            }
        }

        smsSyncStartedHandler = function (data) {
            if (!matchesSmsScope(data)) return;
            setSmsSyncOverlay(true, data);
        };
        smsSyncCompletedHandler = function (data) {
            if (!matchesSmsScope(data)) return;
            setSmsSyncOverlay(false, data);
            scheduleSmsRefresh(80);
            scheduleThreadRefresh(80);
        };
        liveSmsHandlers = {
            'sms:received': function (data) { handleLiveSmsEvent('sms:received', data); },
            'sms:queued': function (data) { handleLiveSmsEvent('sms:queued', data); },
            'sms:sent': function (data) { handleLiveSmsEvent('sms:sent', data); },
            'sms:delivered': function (data) { handleLiveSmsEvent('sms:delivered', data); },
            'sms:send-failed': function (data) { handleLiveSmsEvent('sms:send-failed', data); },
            'sms:read': function (data) { handleLiveSmsEvent('sms:read', data); },
            'sms:deleted': function (data) { handleLiveSmsEvent('sms:deleted', data); },
            'sms:bulk-read': function (data) { handleLiveSmsEvent('sms:bulk-read', data); },
            'sms:bulk-deleted': function (data) { handleLiveSmsEvent('sms:bulk-deleted', data); }
        };

        Object.entries(liveSmsHandlers).forEach(function (entry) {
            window.socket.on(entry[0], entry[1]);
        });
        window.socket.on('sms:sync-started', smsSyncStartedHandler);
        window.socket.on('sms:sync-completed', smsSyncCompletedHandler);
        window.addEventListener('beforeunload', function cleanupLiveSms() {
            if (refreshTimer) clearTimeout(refreshTimer);
            Object.entries(liveSmsHandlers).forEach(function (entry) {
                window.socket?.off?.(entry[0], entry[1]);
            });
            window.socket?.off?.('sms:sync-started', smsSyncStartedHandler);
            window.socket?.off?.('sms:sync-completed', smsSyncCompletedHandler);
            liveSmsHandlers = {};
            window.removeEventListener('beforeunload', cleanupLiveSms);
        });
    }

    function attachScheduledSmsUpdates() {
        if (window.__smsScheduledBound) return;
        window.__smsScheduledBound = true;
        window.addEventListener('sms:scheduled-updated', function () {
            scheduleSmsRefresh(120);
            if (threadState.number) {
                renderThreadMessages(threadState.messages, threadState.number, threadState.title);
            }
        });
    }

    function attachRecipientInputHandlers() {
        ['smsChatTo', 'modalTo'].forEach(function (fieldId) {
            const field = document.getElementById(fieldId);
            if (!field || field.dataset.recipientsBound === '1') return;
            field.dataset.recipientsBound = '1';
            field.addEventListener('input', function () {
                updateRecipientMeta(fieldId);
            });
            field.addEventListener('blur', function () {
                const values = splitRecipientEntries(field.value);
                field.value = values.join(', ');
                updateRecipientMeta(fieldId);
            });
        });
        if (document.body && document.body.dataset.smsRecipientPillsBound !== '1') {
            document.body.dataset.smsRecipientPillsBound = '1';
            document.body.addEventListener('click', function (event) {
                const button = event.target.closest('.sms-recipient-pill-remove[data-field-id][data-recipient-value]');
                if (!button) return;
                const fieldId = String(button.dataset.fieldId || '').trim();
                const value = String(button.dataset.recipientValue || '').trim();
                const field = document.getElementById(fieldId);
                if (!field || !value) return;
                setRecipientValues(fieldId, splitRecipientEntries(field.value).filter(function (entry) {
                    return entry !== value;
                }));
            });
        }
        updateRecipientMeta('smsChatTo');
        updateRecipientMeta('modalTo');
    }

    function getDefaultScheduleValue() {
        const value = new Date(Date.now() + 60 * 60 * 1000);
        return value.toISOString().slice(0, 16);
    }

    function getChatSendMode() {
        const hiddenValue = String(document.getElementById('smsChatSendMode')?.value || '').trim().toLowerCase();
        if (hiddenValue === 'scheduled' || hiddenValue === 'instant') {
            return hiddenValue;
        }
        return document.getElementById('smsChatSendModeScheduled')?.checked ? 'scheduled' : 'instant';
    }

    function setChatSendMode(mode, options = {}) {
        const field = document.getElementById('smsChatSendMode');
        const row = document.getElementById('smsChatModeRow');
        const normalized = String(mode || 'instant').trim().toLowerCase() === 'scheduled' ? 'scheduled' : 'instant';
        if (field) {
            field.value = normalized;
        }
        if (row) {
            row.dataset.popupOpen = normalized === 'scheduled' && options.openPopup !== false ? '1' : '0';
        }
        updateChatSendModeUi();
    }

    function updateChatComposeMeta(analysis = null) {
        const meta = document.getElementById('smsChatSendModeMeta');
        if (!meta) return;

        const resolvedAnalysis = analysis || analyzeSmsComposeText(document.getElementById('smsChatMessage')?.value || '');
        const scheduled = getChatSendMode() === 'scheduled';
        const row = document.getElementById('smsChatModeRow');
        const popupOpen = scheduled && (!row || row.dataset.popupOpen !== '0');
        const parts = [];

        if (scheduled) {
            parts.push(popupOpen ? 'Set time' : 'Scheduled');
        }

        parts.push(`${resolvedAnalysis.characters} chars`);
        parts.push(`${resolvedAnalysis.parts} part${resolvedAnalysis.parts === 1 ? '' : 's'}`);
        meta.textContent = parts.join(' | ');
    }

    function updateChatSendModeUi() {
        const row = document.getElementById('smsChatModeRow');
        const wrap = document.getElementById('smsChatScheduleWrap');
        const input = document.getElementById('smsChatScheduleAt');
        const badge = document.getElementById('smsChatSendModeBadge');
        const sendBtn = document.getElementById('smsChatSendBtn');
        const sendModeItems = document.querySelectorAll('[data-chat-send-mode]');
        const scheduled = getChatSendMode() === 'scheduled';
        const popupOpen = scheduled && (!row || row.dataset.popupOpen !== '0');

        if (row) row.classList.toggle('d-none', !popupOpen);
        if (wrap) wrap.classList.toggle('d-none', !scheduled);
        if (input && scheduled && !input.value) {
            input.value = getDefaultScheduleValue();
        }
        if (badge) {
            badge.innerHTML = scheduled
                ? '<i class="bi bi-clock-fill me-1"></i>Scheduled'
                : '<i class="bi bi-lightning-charge-fill me-1"></i>Instant';
        }
        updateChatComposeMeta();
        if (sendBtn) {
            sendBtn.setAttribute('title', scheduled ? 'Schedule SMS' : 'Send SMS');
            sendBtn.innerHTML = `
                <span class="spinner-border spinner-border-sm d-none" role="status"></span>
                <i class="bi ${scheduled ? 'bi-clock-fill' : 'bi-send-fill'}"></i>`;
        }
        sendModeItems.forEach(function (item) {
            item.classList.toggle('active', String(item.dataset.chatSendMode || '') === (scheduled ? 'scheduled' : 'instant'));
        });
    }

    function attachChatSendModeControls() {
        document.querySelectorAll('[data-chat-send-mode]').forEach(function (item) {
            if (!item || item.dataset.modeBound === '1') return;
            item.dataset.modeBound = '1';
            item.addEventListener('click', function () {
                setChatSendMode(this.dataset.chatSendMode || 'instant', {
                    openPopup: String(this.dataset.chatSendMode || '').trim().toLowerCase() === 'scheduled'
                });
            });
        });
        const confirmBtn = document.getElementById('smsChatScheduleConfirmBtn');
        if (confirmBtn && confirmBtn.dataset.modeBound !== '1') {
            confirmBtn.dataset.modeBound = '1';
            confirmBtn.addEventListener('click', function () {
                const scheduleValidation = validateChatScheduleInput({ markInvalid: true });
                if (!scheduleValidation.ok) {
                    if (typeof showToast === 'function') {
                        showToast(scheduleValidation.message || 'Choose a future time for scheduled SMS.', 'warning');
                    }
                    document.getElementById('smsChatScheduleAt')?.focus();
                    return;
                }
                const row = document.getElementById('smsChatModeRow');
                if (row) row.dataset.popupOpen = '0';
                updateChatSendModeUi();
            });
        }
        const cancelBtn = document.getElementById('smsChatScheduleCancelBtn');
        if (cancelBtn && cancelBtn.dataset.modeBound !== '1') {
            cancelBtn.dataset.modeBound = '1';
            cancelBtn.addEventListener('click', function () {
                setChatSendMode('instant', { openPopup: false });
            });
        }
        const row = document.getElementById('smsChatModeRow');
        if (row && !row.dataset.popupOpen) {
            row.dataset.popupOpen = getChatSendMode() === 'scheduled' ? '1' : '0';
        }
        const scheduleInput = document.getElementById('smsChatScheduleAt');
        if (scheduleInput && scheduleInput.dataset.modeBound !== '1') {
            scheduleInput.dataset.modeBound = '1';
            scheduleInput.addEventListener('input', function () {
                validateChatScheduleInput({ markInvalid: false });
            });
            scheduleInput.addEventListener('change', function () {
                validateChatScheduleInput({ markInvalid: false });
            });
        }
        updateChatSendModeUi();
    }

    function attachChatRecipientControls() {
        const addBtn = document.getElementById('smsChatAddRecipientBtn');
        const applyBtn = document.getElementById('smsChatRecipientApplyBtn');
        const cancelBtn = document.getElementById('smsChatRecipientCancelBtn');
        const input = document.getElementById('smsChatRecipientEntry');

        if (addBtn && addBtn.dataset.recipientEditorBound !== '1') {
            addBtn.dataset.recipientEditorBound = '1';
            addBtn.addEventListener('click', focusChatRecipientEditor);
        }
        if (applyBtn && applyBtn.dataset.recipientEditorBound !== '1') {
            applyBtn.dataset.recipientEditorBound = '1';
            applyBtn.addEventListener('click', commitChatRecipientEntry);
        }
        if (cancelBtn && cancelBtn.dataset.recipientEditorBound !== '1') {
            cancelBtn.dataset.recipientEditorBound = '1';
            cancelBtn.addEventListener('click', function () {
                closeChatRecipientEditor();
            });
        }
        if (input && input.dataset.recipientEditorBound !== '1') {
            input.dataset.recipientEditorBound = '1';
            input.addEventListener('input', function () {
                if (!String(this.value || '').trim()) {
                    this.classList.remove('is-invalid');
                    return;
                }
                validateChatRecipientEntry();
            });
            input.addEventListener('change', function () {
                validateChatRecipientEntry();
            });
            input.addEventListener('keydown', function (event) {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commitChatRecipientEntry();
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    closeChatRecipientEditor();
                }
            });
        }
    }

    function scheduleSmsRefresh(delayMs = 120) {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            refreshSmsPageData();
        }, delayMs);
    }

    function isThreadModalOpen() {
        if (document.getElementById('smsConversationWorkspace')) {
            return Boolean(threadState.number);
        }
        const modalEl = document.getElementById('smsThreadModal');
        return Boolean(modalEl && modalEl.classList.contains('show'));
    }

    function scheduleThreadRefresh(delayMs = 80) {
        if (!threadState.number || !isThreadModalOpen()) return;
        if (threadRefreshTimer) clearTimeout(threadRefreshTimer);
        threadRefreshTimer = setTimeout(() => {
            loadSmsThread(threadState.number, {
                conversationId: threadState.conversationId,
                title: threadState.title,
                showModal: false,
                silent: true
            });
        }, delayMs);
    }

    function getLiveSmsConversationId(data) {
        const conversationId = Math.max(0, Number(data?.conversationId ?? data?.conversation_id) || 0);
        return conversationId || null;
    }

    function getLiveSmsThreadNumber(data, eventName = '') {
        const normalizedEvent = String(eventName || '').trim().toLowerCase();
        const type = String(data?.type || '').trim().toLowerCase();
        const outgoing = normalizedEvent === 'sms:queued'
            || normalizedEvent === 'sms:sent'
            || normalizedEvent === 'sms:delivered'
            || normalizedEvent === 'sms:send-failed'
            || type === 'outgoing'
            || data?.outgoing === true;
        const primary = outgoing
            ? (data?.to || data?.to_number || data?.number || '')
            : (data?.from || data?.from_number || data?.number || data?.to || data?.to_number || '');
        return String(primary || '').trim();
    }

    function isLiveSmsCurrentThread(data, eventName = '') {
        const conversationId = getLiveSmsConversationId(data);
        if (conversationId && threadState.conversationId) {
            return conversationId === threadState.conversationId;
        }
        const number = getLiveSmsThreadNumber(data, eventName);
        return Boolean(number) && number === threadState.number;
    }

    function sortThreadMessages(messages) {
        return (Array.isArray(messages) ? messages : []).slice().sort(function (left, right) {
            const timeDelta = new Date(left?.timestamp || 0).getTime() - new Date(right?.timestamp || 0).getTime();
            if (timeDelta !== 0) return timeDelta;
            return Number(left?.id || 0) - Number(right?.id || 0);
        });
    }

    function upsertThreadMessage(message) {
        if (!message) return false;

        let updated = false;
        const nextMessages = [];
        const targetId = Number(message.id || 0) || null;
        const targetExternalId = String(message.external_id || '').trim();

        (Array.isArray(threadState.messages) ? threadState.messages : []).forEach(function (entry) {
            const entryId = Number(entry?.id || 0) || null;
            const entryExternalId = String(entry?.external_id || '').trim();
            const sameMessage = (targetId && entryId === targetId)
                || (targetExternalId && entryExternalId === targetExternalId);
            if (sameMessage) {
                nextMessages.push({ ...entry, ...message });
                updated = true;
                return;
            }
            nextMessages.push(entry);
        });

        if (!updated) {
            nextMessages.push(message);
        }

        threadState.messages = sortThreadMessages(nextMessages);
        renderThreadMessages(threadState.messages, threadState.number, threadState.title);
        return true;
    }

    function resolveLiveSmsStatus(data, eventName = '', fallbackStatus = '') {
        const explicitStatus = String(data?.status || '').trim().toLowerCase();
        if (explicitStatus) {
            return explicitStatus;
        }

        const normalizedEvent = String(eventName || '').trim().toLowerCase();
        if (normalizedEvent === 'sms:send-failed') {
            return 'failed';
        }
        if (normalizedEvent === 'sms:delivered') {
            return 'delivered';
        }
        if (normalizedEvent === 'sms:sent') {
            return 'sent';
        }
        if (normalizedEvent === 'sms:queued') {
            return 'queued';
        }

        return String(fallbackStatus || '').trim().toLowerCase();
    }

    function updateThreadMessageStatus(data, eventName = '') {
        if (!isLiveSmsCurrentThread(data, eventName)) {
            return false;
        }

        const targetId = Number(data?.id || 0) || null;
        const targetExternalId = String(data?.messageId || data?.external_id || '').trim();
        if (!targetId && !targetExternalId) {
            return false;
        }

        const resolvedStatus = resolveLiveSmsStatus(data, eventName);
        let changed = false;
        threadState.messages = (Array.isArray(threadState.messages) ? threadState.messages : []).map(function (entry) {
            const entryId = Number(entry?.id || 0) || null;
            const entryExternalId = String(entry?.external_id || '').trim();
            const sameMessage = (targetId && entryId === targetId)
                || (targetExternalId && entryExternalId === targetExternalId);
            if (!sameMessage) {
                return entry;
            }

            changed = true;
            return {
                ...entry,
                status: resolvedStatus || entry.status,
                error: data?.error || null,
                timestamp: entry.timestamp
            };
        });

        if (changed) {
            renderThreadMessages(threadState.messages, threadState.number, threadState.title);
        }

        return changed;
    }

    function updateConversationItemStatus(data, eventName = '') {
        const resolvedStatus = resolveLiveSmsStatus(data, eventName);
        if (!resolvedStatus) {
            return false;
        }

        const targetConversationId = getLiveSmsConversationId(data);
        const targetNumber = getLiveSmsThreadNumber(data, eventName);
        if (!targetConversationId && !targetNumber) {
            return false;
        }

        let changed = false;
        document.querySelectorAll('.conversation-item').forEach(function (item) {
            const itemConversationId = Math.max(0, Number(item.dataset.threadConversationId) || 0) || null;
            const itemNumber = String(item.dataset.threadNumber || '').trim();
            const sameConversation = targetConversationId && itemConversationId && targetConversationId === itemConversationId;
            const sameNumber = !targetConversationId && targetNumber && itemNumber === targetNumber;
            if (!sameConversation && !sameNumber) {
                return;
            }

            item.dataset.threadLastDirection = 'outgoing';
            item.dataset.threadLastStatus = resolvedStatus;

            const meta = smsStatusMeta(resolvedStatus);
            const badges = item.querySelector('.conversation-item-badges');
            if (!badges) {
                return;
            }

            let pill = badges.querySelector('[data-thread-status-pill="1"]');
            if (!pill) {
                pill = document.createElement('span');
                pill.dataset.threadStatusPill = '1';
                badges.prepend(pill);
            }
            pill.className = `badge mt-1 ${meta.className}`;
            pill.textContent = meta.label;
            changed = true;
        });

        return changed;
    }

    function updateRenderedThreadMessageStatus(data, eventName = '') {
        const resolvedStatus = resolveLiveSmsStatus(data, eventName);
        const targetId = Number(data?.id || 0) || null;
        if (!resolvedStatus || !targetId) {
            return false;
        }

        const bubble = document.querySelector(`.sms-bubble[data-thread-sms-id="${targetId}"]`);
        if (!bubble) {
            return false;
        }

        const meta = bubble.querySelector('.sms-bubble-meta');
        if (!meta) {
            return false;
        }

        const existingIcon = meta.querySelector('i');
        const wrapper = document.createElement('span');
        wrapper.innerHTML = renderSmsStatusIcon(resolvedStatus);
        const nextIcon = wrapper.firstElementChild;
        if (!nextIcon) {
            return false;
        }

        if (existingIcon) {
            existingIcon.replaceWith(nextIcon);
        } else {
            meta.appendChild(nextIcon);
        }
        return true;
    }

    function buildLiveThreadMessage(data, eventName = '') {
        const number = getLiveSmsThreadNumber(data, eventName);
        if (!number) {
            return null;
        }

        const normalizedEvent = String(eventName || '').trim().toLowerCase();
        const type = String(data?.type || '').trim().toLowerCase();
        const outgoing = normalizedEvent === 'sms:queued'
            || normalizedEvent === 'sms:sent'
            || normalizedEvent === 'sms:delivered'
            || normalizedEvent === 'sms:send-failed'
            || type === 'outgoing'
            || data?.outgoing === true;
        const status = resolveLiveSmsStatus(data, eventName, outgoing ? 'sent' : 'received');

        return {
            id: Number(data?.id || 0) || null,
            conversation_id: getLiveSmsConversationId(data),
            external_id: String(data?.messageId || data?.external_id || '').trim() || null,
            from_number: outgoing ? 'self' : String(data?.from || data?.from_number || '').trim(),
            to_number: outgoing ? number : String(data?.to || data?.to_number || '').trim() || null,
            message: String(data?.message || data?.text || '').trim(),
            timestamp: data?.timestamp || new Date().toISOString(),
            read: outgoing ? 1 : 0,
            type: outgoing ? 'outgoing' : 'incoming',
            status,
            error: data?.error || null
        };
    }

    function formatTs(ts) {
        try {
            const d = new Date(ts);
            if (!Number.isFinite(d.getTime())) return '';
            const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
            const dd = String(d.getDate()).padStart(2, '0');
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            return `${mo} ${dd}, ${d.getFullYear()} ${hh}:${mm}`;
        } catch (e) { return ts; }
    }

    function esc(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function getPhoneThreadKey(value) {
        const digits = String(value || '').replace(/\D/g, '');
        return String(digits ? digits.slice(-10) : String(value || '').trim()).toLowerCase();
    }

    function getScheduledSmsItems() {
        try {
            return typeof window.getScheduledSmsItems === 'function' ? window.getScheduledSmsItems() : [];
        } catch (_) {
            return [];
        }
    }

    function getScheduledItemsForNumber(number) {
        const threadKey = getPhoneThreadKey(number);
        return getScheduledSmsItems()
            .filter(function (item) {
                return getPhoneThreadKey(item?.to_number || '') === threadKey;
            })
            .sort(function (left, right) {
                return new Date(left?.send_at || 0) - new Date(right?.send_at || 0);
            });
    }

    function smsStatusMeta(status) {
        const normalized = String(status || 'queued').trim().toLowerCase();
        switch (normalized) {
            case 'delivered':
                return { label: 'Delivered', className: 'bg-success' };
            case 'sent':
                return { label: 'Sent', className: 'bg-success' };
            case 'sending':
                return { label: 'Sending', className: 'bg-primary' };
            case 'queued':
            case 'pending':
                return { label: 'Queued', className: 'bg-warning text-dark' };
            case 'ambiguous':
                return { label: 'Unconfirmed', className: 'bg-warning-subtle text-warning-emphasis border border-warning-subtle' };
            case 'failed':
            case 'timeout':
                return { label: 'Failed', className: 'bg-danger' };
            default:
                return { label: normalized || 'Queued', className: 'bg-secondary' };
        }
    }

    function renderSmsStatusBadge(status) {
        const meta = smsStatusMeta(status);
        return `<span class="badge ${meta.className}"><i class="bi bi-check-circle me-1"></i>${esc(meta.label)}</span>`;
    }

    function renderSmsStatusIcon(status) {
        const normalized = String(status || 'queued').trim().toLowerCase();
        if (normalized === 'delivered') return '<i class="bi bi-check2-all text-primary" title="Delivered"></i>';
        if (normalized === 'sent') return '<i class="bi bi-check2-all text-secondary" title="Sent"></i>';
        if (normalized === 'sending') return '<i class="bi bi-arrow-repeat text-primary" title="Sending"></i>';
        if (normalized === 'ambiguous') return '<i class="bi bi-question-circle text-warning" title="Send result unconfirmed"></i>';
        if (normalized === 'failed' || normalized === 'timeout') return '<i class="bi bi-exclamation-circle text-danger" title="Failed"></i>';
        return '<i class="bi bi-clock text-warning" title="Queued"></i>';
    }

    function getSmsSourceMeta(sms) {
        const source = String(sms?.source || '').trim().toLowerCase();
        if (String(sms?.type || '').trim().toLowerCase() !== 'outgoing') {
            return {
                label: 'Inbox',
                className: 'bg-success-subtle text-success-emphasis border border-success-subtle',
                description: 'Received by the device inbox'
            };
        }
        if (source === 'mqtt-api') {
            return {
                label: 'API',
                className: 'bg-info-subtle text-info-emphasis border border-info-subtle',
                description: 'Queued through the dashboard API and delivered via MQTT runtime'
            };
        }
        if (source === 'scheduled') {
            return {
                label: 'Scheduled',
                className: 'bg-warning-subtle text-warning-emphasis border border-warning-subtle',
                description: 'Scheduled in the dashboard and dispatched at runtime'
            };
        }
        if (source === 'dashboard') {
            return {
                label: 'User',
                className: 'bg-primary-subtle text-primary-emphasis border border-primary-subtle',
                description: 'Queued from the dashboard and delivered via MQTT runtime'
            };
        }
        return {
            label: 'Device',
            className: 'bg-secondary-subtle text-secondary-emphasis border border-secondary-subtle',
            description: 'Handled directly by the device'
        };
    }

    function formatSmsSimSlotLabel(value) {
        const slot = Number.parseInt(String(value ?? '').trim(), 10);
        if (!Number.isFinite(slot) || slot < 0) {
            return '';
        }
        return `SIM ${slot + 1} (slot ${slot})`;
    }

    function toSmsDetailKey(label) {
        return String(label || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'field';
    }

    function buildSmsDetailMarkup(rows) {
        const lines = rows.map(function (row) {
            return `  ${toSmsDetailKey(row[0])}: ${JSON.stringify(String(row[1] || ''))}`;
        });
        return `message_info {\n${lines.join(',\n')}\n}`;
    }

    function copySmsDetailText(text) {
        const value = String(text || '');
        if (!value) {
            showToast('No message info available to copy', 'warning');
            return;
        }

        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(value).then(function () {
                showToast('Message info copied', 'success');
            }).catch(function () {
                showToast('Failed to copy message info', 'danger');
            });
            return;
        }

        const input = document.createElement('textarea');
        input.value = value;
        input.setAttribute('readonly', 'readonly');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        try {
            document.execCommand('copy');
            showToast('Message info copied', 'success');
        } catch (_) {
            showToast('Failed to copy message info', 'danger');
        } finally {
            document.body.removeChild(input);
        }
    }

    function buildSmsDetailRows(sms) {
        const sourceMeta = getSmsSourceMeta(sms);
        const outgoing = String(sms?.type || '').trim().toLowerCase() === 'outgoing';
        const rows = [
            ['Direction', outgoing ? 'Outgoing' : 'Incoming'],
            ['Source', sourceMeta.label],
            ['Source Detail', sourceMeta.description],
            ['Status', String(sms?.status || 'unknown').trim() || 'unknown'],
            ['Time', formatTs(sms?.timestamp)],
            ['From', String(sms?.display_from || sms?.from_number || '').trim()],
            ['To', String(sms?.display_to || sms?.to_number || '').trim()],
            ['Device', getSmsActiveDeviceId()],
            ['SIM Slot', formatSmsSimSlotLabel(sms?.sim_slot ?? sms?.simSlot)],
            ['Dashboard User', String(sms?.sent_by || '').trim()],
            ['External ID', String(sms?.external_id || '').trim()],
            ['Read', outgoing ? '' : (sms?.read ? 'Yes' : 'No')]
        ];

        if (sms?.id !== undefined && sms?.id !== null && sms?.id !== '') {
            rows.push(['Message ID', String(sms.id)]);
        }
        if (sms?.error) {
            rows.push(['Error', String(sms.error)]);
        }

        return rows.filter(function (row) {
            return String(row[1] || '').trim() !== '';
        });
    }

    function openSmsMessageDetails(messageOrId) {
        const sms = typeof messageOrId === 'object' && messageOrId
            ? messageOrId
            : threadState.messages.find(function (item) {
                return Number(item?.id) === Number(messageOrId);
            });
        if (!sms) return;

        const titleEl = document.getElementById('smsMessageDetailsTitle');
        const metaEl = document.getElementById('smsMessageDetailsMeta');
        const bodyEl = document.getElementById('smsMessageDetailsBody');
        const modalEl = document.getElementById('smsMessageDetailsModal');
        if (!titleEl || !metaEl || !bodyEl || !modalEl) return;

        const sourceMeta = getSmsSourceMeta(sms);
        const preview = summarizeMessagePreview(sms?.message || '') || 'Message details';
        const rows = buildSmsDetailRows(sms);
        const detailMarkup = buildSmsDetailMarkup(rows);

        titleEl.innerHTML = `<i class="bi bi-info-circle me-2"></i>${esc(preview)}`;
        metaEl.textContent = `${sourceMeta.label} | ${formatTs(sms?.timestamp)}`;
        modalEl.dataset.smsMessageInfoCopy = detailMarkup;
        bodyEl.innerHTML = `
            <div class="d-flex flex-column gap-3">
                <div class="border rounded p-3">
                    <div class="small text-uppercase text-muted fw-semibold mb-2">Message</div>
                    ${renderMessageContent(sms)}
                </div>
                <div class="sms-detail-editor">
                    <button type="button"
                            class="btn btn-sm sms-detail-editor-copy"
                            data-sms-copy-message-info
                            title="Copy message info"
                            aria-label="Copy message info">
                        <i class="bi bi-clipboard"></i>
                    </button>
                    <pre class="sms-detail-editor-pre mb-0"><code>${esc(detailMarkup)}</code></pre>
                </div>
            </div>`;

        bootstrap.Modal.getOrCreateInstance(modalEl).show();
    }

    function parseJsonPayload(text) {
        const raw = String(text || '').trim();
        if (!raw || !/^[{[]/.test(raw)) return null;
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (_) {
            return null;
        }
    }

    function parseVcard(text) {
        const raw = String(text || '');
        if (!/BEGIN:VCARD/i.test(raw)) return null;
        const readLine = function (name) {
            const match = raw.match(new RegExp(`^${name}[^:]*:(.+)$`, 'im'));
            return match ? match[1].trim() : '';
        };
        return {
            name: readLine('FN') || readLine('N').replace(/;/g, ' ').trim() || 'Contact',
            phone: readLine('TEL'),
            email: readLine('EMAIL')
        };
    }

    function normalizeStructuredMessage(sms) {
        const text = String(sms?.message || '');
        const parsed = parseJsonPayload(text);
        if (!parsed) {
            const vcard = parseVcard(text);
            return vcard
                ? { text: '', contacts: [vcard], attachments: [] }
                : { text, contacts: [], attachments: [] };
        }

        const contacts = [];
        const attachments = [];
        if (parsed.contact) contacts.push(parsed.contact);
        if (Array.isArray(parsed.contacts)) contacts.push(...parsed.contacts);
        if (parsed.vcard) {
            const contact = parseVcard(parsed.vcard) || parsed.vcard;
            contacts.push(contact);
        }
        if (parsed.attachment) attachments.push(parsed.attachment);
        if (Array.isArray(parsed.attachments)) attachments.push(...parsed.attachments);

        return {
            text: String(parsed.text || parsed.message || ''),
            contacts,
            attachments
        };
    }

    function renderContactCard(contact) {
        const data = typeof contact === 'string' ? (parseVcard(contact) || { name: contact }) : (contact || {});
        const name = data.name || data.fullName || data.fn || 'Contact';
        const phone = data.phone || data.tel || data.mobile || '';
        const email = data.email || '';
        return `
            <div class="sms-contact-card mt-1">
                <div class="d-flex align-items-center gap-2 min-w-0">
                    <span class="sms-media-icon bg-success-subtle text-success">
                        <i class="bi bi-person-vcard"></i>
                    </span>
                    <div class="min-w-0 flex-grow-1">
                        <div class="fw-semibold text-truncate">${esc(name)}</div>
                        <div class="sms-media-meta text-muted text-truncate">
                            ${esc([phone, email].filter(Boolean).join(' | ') || 'Contact card')}
                        </div>
                    </div>
                </div>
            </div>`;
    }

    function renderAttachmentCard(attachment) {
        const item = attachment || {};
        const name = item.name || item.filename || 'Attachment';
        const type = String(item.type || item.mime || '').toLowerCase();
        const url = item.url || item.dataUrl || item.href || '';
        const isImage = type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
        const size = item.size ? `${Math.ceil(Number(item.size) / 1024)} KB` : '';
        return `
            <div class="sms-media-card mt-1">
                <div class="d-flex align-items-center gap-2 min-w-0">
                    ${isImage && url
                        ? `<img src="${esc(url)}" alt="${esc(name)}" class="sms-media-thumb">`
                        : `<span class="sms-media-icon bg-primary-subtle text-primary"><i class="bi ${isImage ? 'bi-image' : 'bi-paperclip'}"></i></span>`}
                    <div class="min-w-0 flex-grow-1">
                        <div class="fw-semibold text-truncate">${esc(name)}</div>
                        <div class="sms-media-meta text-muted text-truncate">${esc(type || 'file')}${size ? ` | ${esc(size)}` : ''}</div>
                    </div>
                </div>
            </div>`;
    }

    function renderMessageContent(sms) {
        const payload = normalizeStructuredMessage(sms);
        const parts = [];
        if (payload.text) {
            parts.push(`<div class="text-break">${esc(payload.text)}</div>`);
        }
        payload.contacts.forEach(function (contact) {
            parts.push(renderContactCard(contact));
        });
        payload.attachments.forEach(function (attachment) {
            parts.push(renderAttachmentCard(attachment));
        });
        return parts.join('') || '<span class="text-muted fst-italic">Empty message</span>';
    }

    function summarizeMessagePreview(message) {
        const payload = normalizeStructuredMessage({ message });
        let preview = '';
        if (payload.text) {
            preview = payload.text;
        } else if (payload.contacts.length) {
            preview = 'Contact card';
        } else if (payload.attachments.length) {
            preview = 'Attachment';
        } else {
            preview = message || '';
        }

        const normalizedPreview = String(preview || '').replace(/\s+/g, ' ').trim();
        if (normalizedPreview.length <= 120) {
            return normalizedPreview;
        }
        return `${normalizedPreview.slice(0, 117).trimEnd()}...`;
    }

    function getThreadActionNumber(number = threadState.number) {
        return String(number || '').trim();
    }

    function buildComposerFollowUpThread(number, options = {}) {
        const target = getThreadActionNumber(number);
        if (!target) {
            return {
                number: '',
                conversationId: null,
                title: ''
            };
        }

        const explicitConversationId = Math.max(0, Number(options.conversationId) || 0) || null;
        const sameThread = getPhoneThreadKey(target) === getPhoneThreadKey(threadState.number || '');
        return {
            number: target,
            conversationId: explicitConversationId || (sameThread ? threadState.conversationId : null),
            title: sameThread ? (threadState.title || target) : target
        };
    }

    function followUpComposerThread(target, delayMs = 0) {
        if (!target?.number) return;

        threadState.number = target.number;
        threadState.conversationId = target.conversationId || null;
        threadState.title = target.title || target.number;

        setTimeout(function () {
            loadSmsThread(target.number, {
                conversationId: target.conversationId,
                title: target.title,
                showModal: false,
                silent: true
            });
        }, Math.max(0, Number(delayMs) || 0));
    }

    function buildThreadPageUrl(number, conversationId = threadState.conversationId, title = threadState.title) {
        const target = String(number || '').trim();
        const url = new URL(window.location.href);
        if (target) {
            url.searchParams.set('thread', target);
        } else {
            url.searchParams.delete('thread');
        }
        if (conversationId) {
            url.searchParams.set('conversation', String(conversationId));
        } else {
            url.searchParams.delete('conversation');
        }
        if (title) {
            url.searchParams.set('title', title);
        } else {
            url.searchParams.delete('title');
        }

        const activeDeviceId = getSmsActiveDeviceId();
        if (activeDeviceId) {
            url.searchParams.set('device', activeDeviceId);
        }

        return `${url.pathname}${url.search}${url.hash}`;
    }

    function syncThreadUrl(number, mode = 'replace', conversationId = threadState.conversationId, title = threadState.title) {
        if (mode === 'ignore') return;
        const fn = mode === 'push' ? 'pushState' : 'replaceState';
        window.history[fn]({
            smsThread: String(number || '').trim(),
            smsConversationId: conversationId || null
        }, '', buildThreadPageUrl(number, conversationId, title));
        updateThreadPermalink(number, conversationId, title);
    }

    function updateThreadPermalink(number, conversationId = threadState.conversationId, title = threadState.title) {
        return buildThreadPageUrl(number, conversationId, title);
    }

    function syncConversationSelection(number, conversationId = threadState.conversationId) {
        const target = String(number || '').trim();
        const list = document.getElementById('smsConversationList');
        if (!list) return;

        list.querySelectorAll('.conversation-item').forEach(function (item) {
            const itemConversationId = Math.max(0, Number(item.dataset.threadConversationId) || 0);
            const matchesConversation = conversationId && itemConversationId === conversationId;
            const matchesNumber = !conversationId && String(item.dataset.threadNumber || '').trim() === target && target !== '';
            item.classList.toggle('active', !!(matchesConversation || matchesNumber));
        });
    }

    function clearThreadSelection(options = {}) {
        threadState.number = '';
        threadState.conversationId = null;
        threadState.title = '';
        threadState.messages = [];
        if (threadRefreshTimer) clearTimeout(threadRefreshTimer);
        updateThreadActionButtons('');
        renderThreadMessages([], '');
        updateThreadPermalink('', null, '');
        syncConversationSelection('', null);
        syncThreadUrl('', options.historyMode || 'replace', null, '');
    }

    function getThreadNumberFromSms(sms) {
        const isOut = String(sms?.type || '').toLowerCase() === 'outgoing';
        return String(isOut ? (sms?.to_number || sms?.from_number || '') : (sms?.from_number || sms?.to_number || '')).trim();
    }

    function buildConversationSummaries(messages) {
        const map = new Map();
        (Array.isArray(messages) ? messages : []).forEach(function (sms) {
            const number = getThreadNumberFromSms(sms);
            if (!number) return;
            const isOut = String(sms.type || '').toLowerCase() === 'outgoing';
            const existing = map.get(number) || {
                number,
                title: sms.display_from || number,
                lastMessage: '',
                lastTimestamp: '',
                unread: 0,
                total: 0,
                lastDirection: isOut ? 'outgoing' : 'incoming'
            };
            existing.total += 1;
            if (!isOut && !sms.read) existing.unread += 1;
            if (!existing.lastTimestamp || new Date(sms.timestamp) > new Date(existing.lastTimestamp)) {
                existing.title = isOut ? number : (sms.display_from || number);
                existing.lastMessage = summarizeMessagePreview(sms.message || '');
                existing.lastTimestamp = sms.timestamp || '';
                existing.lastDirection = isOut ? 'outgoing' : 'incoming';
            }
            map.set(number, existing);
        });
        return Array.from(map.values()).sort(function (a, b) {
            return new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0);
        });
    }

    function normalizeConversationRows(rows) {
        const list = Array.isArray(rows) ? rows : [];
        if (!list.some((row) => Object.prototype.hasOwnProperty.call(row || {}, 'thread_number'))) {
            return buildConversationSummaries(list);
        }

        return list.map(function (row) {
            const isOut = String(row?.type || '').toLowerCase() === 'outgoing';
            const number = String(row.thread_number || getThreadNumberFromSms(row) || '').trim();
            return {
                number,
                conversationId: Math.max(0, Number(row.conversation_id) || 0) || null,
                title: isOut ? number : (row.display_from || number),
                lastMessage: summarizeMessagePreview(row.message || ''),
                lastTimestamp: row.timestamp || '',
                unread: Number(row.unread_count || 0),
                total: Number(row.total_count || 0),
                lastDirection: row.last_direction || (isOut ? 'outgoing' : 'incoming'),
                lastStatus: row.status || ''
            };
        }).filter((thread) => thread.number);
    }

    function mergeScheduledConversations(conversations) {
        const merged = Array.isArray(conversations) ? conversations.map(function (thread) { return { ...thread }; }) : [];
        const byKey = new Map();
        merged.forEach(function (thread) {
            byKey.set(getPhoneThreadKey(thread.number), thread);
        });

        const scheduledMap = new Map();
        getScheduledSmsItems().forEach(function (item) {
            const number = String(item?.to_number || '').trim();
            const key = getPhoneThreadKey(number);
            if (!number || !key) return;
            const bucket = scheduledMap.get(key) || {
                number,
                items: []
            };
            bucket.items.push(item);
            scheduledMap.set(key, bucket);
        });

        scheduledMap.forEach(function (bucket, key) {
            bucket.items.sort(function (left, right) {
                return new Date(left?.send_at || 0) - new Date(right?.send_at || 0);
            });
            const nextItem = bucket.items[0];
            const statusLabel = String(nextItem?.status || 'pending').trim().toLowerCase();
            const existing = byKey.get(key);
            if (existing) {
                existing.scheduledCount = bucket.items.length;
                existing.scheduledStatus = statusLabel;
                existing.nextScheduledAt = nextItem?.send_at || existing.lastTimestamp;
                existing.hasScheduled = true;
                return;
            }

            merged.push({
                number: bucket.number,
                title: bucket.number,
                lastMessage: nextItem?.message || 'Scheduled SMS',
                lastTimestamp: nextItem?.send_at || '',
                unread: 0,
                total: 0,
                lastDirection: 'outgoing',
                lastStatus: statusLabel,
                scheduledCount: bucket.items.length,
                scheduledStatus: statusLabel,
                nextScheduledAt: nextItem?.send_at || '',
                hasScheduled: true,
                scheduledOnly: true
            });
        });

        return merged.sort(function (left, right) {
            return new Date((right.nextScheduledAt || right.lastTimestamp || 0)) - new Date((left.nextScheduledAt || left.lastTimestamp || 0));
        });
    }

    function renderConversationRailState(kind, message, options = {}) {
        const normalizedKind = String(kind || 'loading').trim().toLowerCase();
        const icon = normalizedKind === 'error'
            ? 'bi-exclamation-triangle'
            : normalizedKind === 'empty'
                ? 'bi-chat-left-dots'
                : 'bi-arrow-repeat';
        const stateClass = normalizedKind === 'error'
            ? 'sms-conversation-state-error'
            : normalizedKind === 'empty'
                ? 'sms-conversation-state-empty'
                : 'sms-conversation-state-loading';
        const actionMarkup = options.action === 'retry'
            ? '<button type="button" class="btn btn-sm btn-outline-primary mt-3" id="smsRetryConversationsBtn"><i class="bi bi-arrow-clockwise me-1"></i>Retry</button>'
            : options.action === 'compose'
                ? '<button type="button" class="btn btn-sm btn-primary mt-3" data-sms-open-compose="1"><i class="bi bi-plus-circle me-1"></i>New message</button>'
                : '';

        return `
            <div class="sms-conversation-state ${stateClass}">
                <div class="sms-conversation-state-icon">
                    <i class="bi ${icon}"></i>
                </div>
                <div class="sms-conversation-state-title">${esc(options.title || message || '')}</div>
                ${options.detail ? `<div class="sms-conversation-state-detail">${esc(options.detail)}</div>` : ''}
                ${actionMarkup}
            </div>`;
    }

    function openCallsForNumber(number) {
        const target = getThreadActionNumber(number);
        if (!target) return;
        window.location.href = `/calls?to=${encodeURIComponent(target)}`;
    }

    function openComposeForNumber(number) {
        const target = getThreadActionNumber(number);
        if (!target) return;

        setPhoneFieldValue('smsChatTo', target);
        const chatMessage = document.getElementById('smsChatMessage');
        if (chatMessage) {
            chatMessage.focus();
            return;
        }

        setPhoneFieldValue('modalTo', target);

        const threadModalEl = document.getElementById('smsThreadModal');
        const threadModal = threadModalEl ? bootstrap.Modal.getInstance(threadModalEl) : null;
        if (threadModal) {
            threadModal.hide();
            setTimeout(() => {
                const composeModal = new bootstrap.Modal(document.getElementById('composeSmsModal'));
                composeModal.show();
            }, 180);
            return;
        }

        const composeModal = new bootstrap.Modal(document.getElementById('composeSmsModal'));
        composeModal.show();
    }

    function renderThreadMessages(messages, number, title = threadState.title || number) {
        const container = document.getElementById('smsChatMessages') || document.getElementById('smsThreadMessages');
        const countEl = document.getElementById('smsChatCount') || document.getElementById('smsThreadCount');
        const numberEl = document.getElementById('smsChatNumber') || document.getElementById('smsThreadNumber');
        const metaEl = document.getElementById('smsChatMeta') || document.getElementById('smsThreadMeta');
        const scheduledItems = getScheduledItemsForNumber(number);

        if (numberEl) {
            numberEl.innerHTML = (title || number)
                ? `<i class="bi bi-person-circle me-2"></i>${esc(title || number)}`
                : '<i class="bi bi-chat-square-text me-2"></i>Select a conversation';
        }
        if (countEl) countEl.textContent = `${messages.length} message${messages.length === 1 ? '' : 's'}`;
        if (metaEl) {
            const deviceLabel = getSmsActiveDeviceId() || 'No device selected';
            metaEl.textContent = messages.length
                ? `Showing freshest conversation for ${deviceLabel}${scheduledItems.length ? ` | ${scheduledItems.length} scheduled` : ''}`
                : (scheduledItems.length
                    ? `${scheduledItems.length} scheduled SMS on ${deviceLabel}`
                    : `No conversation history on ${deviceLabel}`);
        }

        if (!container) return;
        const scheduledMarkup = scheduledItems.length ? `
            <div class="sms-scheduled-stack mb-2">
                ${scheduledItems.map(function (item) {
                    const status = String(item?.status || 'pending').trim().toLowerCase();
                    const badgeClass = status === 'pending'
                        ? 'bg-warning-subtle text-warning-emphasis border border-warning-subtle'
                        : status === 'queued'
                            ? 'bg-info-subtle text-info-emphasis border border-info-subtle'
                            : status === 'sent'
                                ? 'bg-success-subtle text-success-emphasis border border-success-subtle'
                                : 'bg-danger-subtle text-danger-emphasis border border-danger-subtle';
                    return `
                        <div class="sms-media-card">
                            <div class="d-flex justify-content-between align-items-start gap-2">
                                <div class="min-w-0">
                                    <div class="fw-semibold text-truncate">Scheduled SMS</div>
                                    <div class="small text-muted text-truncate">${esc(item?.message || '')}</div>
                                </div>
                                <div class="text-end d-flex flex-column align-items-end gap-2">
                                    <span class="badge ${badgeClass}">${esc(status || 'pending')} | ${esc(formatTs(item?.send_at))}</span>
                                    ${status === 'pending' ? `<button type="button" class="btn btn-sm btn-outline-danger" onclick="cancelScheduledSms(${Number(item.id)})"><i class="bi bi-x-lg"></i></button>` : ''}
                                </div>
                            </div>
                        </div>`;
                }).join('')}
            </div>` : '';

        if (!messages.length) {
            container.innerHTML = scheduledMarkup || '<div class="text-muted text-center py-4">No messages found for this conversation on the selected device.</div>';
            return;
        }

        const messageMarkup = messages.map(function (sms) {
            const outgoing = String(sms.type || '').toLowerCase() === 'outgoing';
            const speaker = outgoing ? 'You' : (sms.display_from || sms.from_number || number || 'Unknown');
            const meta = [formatTs(sms.timestamp)];
            if (!outgoing && !sms.read) meta.push('Unread');

            return `
                <div class="d-flex ${outgoing ? 'justify-content-end' : 'justify-content-start'}">
                    <div class="card shadow-sm sms-bubble ${outgoing ? 'sms-bubble-out' : 'sms-bubble-in'}" data-thread-sms-id="${Number(sms.id) || ''}">
                        <div class="card-body py-2 px-3">
                            <div class="sms-message-header mb-1">
                                <div class="small fw-semibold ${outgoing ? 'text-primary-emphasis' : 'text-secondary'}">${esc(speaker)}</div>
                                <div class="sms-message-header-meta">
                                    <button type="button" class="sms-message-info" data-thread-message-info="${Number(sms.id) || ''}" aria-label="Message details">
                                        <i class="bi bi-info-circle"></i>
                                    </button>
                                    <div class="dropdown">
                                        <button type="button"
                                                class="btn btn-sm btn-link p-0 text-decoration-none sms-message-menu-toggle"
                                                data-bs-toggle="dropdown"
                                                data-thread-message-menu="1"
                                                aria-expanded="false"
                                                aria-label="Message menu">
                                            <i class="bi bi-three-dots-vertical"></i>
                                        </button>
                                        <ul class="dropdown-menu dropdown-menu-end">
                                            ${!outgoing && !sms.read ? `<li><button type="button" class="dropdown-item" data-thread-message-action="mark-read" data-sms-id="${Number(sms.id) || ''}"><i class="bi bi-envelope-open me-2"></i>Mark Read</button></li>` : ''}
                                            <li><button type="button" class="dropdown-item text-danger" data-thread-message-action="delete-message" data-sms-id="${Number(sms.id) || ''}"><i class="bi bi-trash me-2"></i>Delete</button></li>
                                        </ul>
                                    </div>
                                </div>
                            </div>
                            ${renderMessageContent(sms)}
                            <div class="sms-bubble-meta text-muted mt-2 d-flex justify-content-end align-items-center gap-1">
                                <span>${esc(meta.join(' | '))}</span>
                                ${outgoing ? renderSmsStatusIcon(sms.status) : ''}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        container.innerHTML = `${scheduledMarkup}${messageMarkup}`;
        container.scrollTop = container.scrollHeight;
    }

    function setThreadLoading(number, title = threadState.title || number) {
        const container = document.getElementById('smsChatMessages') || document.getElementById('smsThreadMessages');
        const numberEl = document.getElementById('smsChatNumber') || document.getElementById('smsThreadNumber');
        const countEl = document.getElementById('smsChatCount') || document.getElementById('smsThreadCount');
        const metaEl = document.getElementById('smsChatMeta') || document.getElementById('smsThreadMeta');

        if (numberEl) {
            numberEl.innerHTML = (title || number)
                ? `<i class="bi bi-person-circle me-2"></i>${esc(title || number)}`
                : '<i class="bi bi-chat-square-text me-2"></i>Select a conversation';
        }
        if (countEl) countEl.textContent = 'Loading...';
        if (metaEl) metaEl.textContent = 'Fetching latest conversation from the selected device...';
        if (container) {
            container.innerHTML = '<div class="text-center py-4 text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Loading conversation...</div>';
        }
    }

    function updateThreadActionButtons(number) {
        const target = getThreadActionNumber(number);
        const callBtn = document.getElementById('smsChatCallBtn') || document.getElementById('smsThreadCallBtn');
        const replyBtn = document.getElementById('smsThreadReplyBtn');
        const menuButtons = ['smsChatThreadMenuBtn', 'smsThreadMenuBtn'];
        const chatTo = document.getElementById('smsChatTo');

        if (callBtn) {
            callBtn.disabled = !target;
            callBtn.dataset.number = target;
        }
        if (replyBtn) {
            replyBtn.disabled = !target;
            replyBtn.dataset.number = target;
        }
        menuButtons.forEach(function (id) {
            const button = document.getElementById(id);
            if (!button) return;
            button.disabled = !target;
            button.dataset.number = target;
            button.dataset.conversationId = threadState.conversationId || '';
        });
        if (chatTo && target) {
            setPhoneFieldValue('smsChatTo', target);
        }
    }

    function markThreadMessagesRead(messages) {
        const ids = (Array.isArray(messages) ? messages : [])
            .filter((sms) => String(sms?.type || '').toLowerCase() !== 'outgoing' && !sms?.read)
            .map((sms) => Number(sms.id))
            .filter((id) => Number.isInteger(id) && id > 0);
        if (!ids.length) return Promise.resolve();

        return fetchSmsJson('/api/sms/bulk-read', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ids, deviceId: getSmsActiveDeviceId() })
        })
            .then(function (data) {
                if (!data?.success) return;
                threadState.messages = threadState.messages.map(function (sms) {
                    return ids.includes(Number(sms.id)) ? { ...sms, read: 1 } : sms;
                });
                renderThreadMessages(threadState.messages, threadState.number, threadState.title);
                updateUnreadBadge(data.unreadCount);
                refreshSmsPageData();
            })
            .catch(function (error) {
                console.error('Error marking conversation as read:', error);
            });
    }

    function getThreadMessageIds(messages) {
        return (Array.isArray(messages) ? messages : [])
            .map(function (sms) { return Number(sms?.id); })
            .filter(function (id) { return Number.isInteger(id) && id > 0; });
    }

    function fetchThreadMessagesSnapshot(number, conversationId = null) {
        const target = getThreadActionNumber(number);
        const resolvedConversationId = Math.max(0, Number(conversationId) || 0) || null;
        if (!target && !resolvedConversationId) {
            return Promise.resolve([]);
        }
        const threadUrl = resolvedConversationId
            ? `/api/sms/thread?conversationId=${resolvedConversationId}&limit=500`
            : `/api/sms/thread?number=${encodeURIComponent(target)}&limit=500`;
        return fetchSmsJson(threadUrl).then(function (data) {
            if (!data?.success) {
                throw new Error(data?.message || 'Failed to load conversation');
            }
            return Array.isArray(data.data) ? data.data : [];
        });
    }

    async function deleteSmsIds(ids, options = {}) {
        const smsIds = Array.from(new Set((Array.isArray(ids) ? ids : [])
            .map(function (id) { return Number(id); })
            .filter(function (id) { return Number.isInteger(id) && id > 0; })));
        if (!smsIds.length) {
            showToast('No messages found to delete.', 'warning');
            return false;
        }

        let approved = false;
        const count = smsIds.length;
        const confirmMessage = count === 1
            ? 'Delete this message?'
            : `Delete ${count} messages from this thread?`;
        if (typeof window.appConfirm === 'function') {
            approved = await window.appConfirm({
                title: count === 1 ? 'Delete Message' : 'Delete Thread',
                message: confirmMessage,
                confirmText: count === 1 ? 'Delete' : 'Delete All',
                confirmClass: 'btn btn-danger'
            });
        } else {
            approved = confirm(confirmMessage);
        }
        if (!approved) return false;

        const endpoint = count === 1 ? `/api/sms/${smsIds[0]}` : '/api/sms/bulk-delete';
        const requestOptions = count === 1
            ? {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' }
            }
            : {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: smsIds, deviceId: getSmsActiveDeviceId() })
            };

        const data = await fetchSmsJson(endpoint, requestOptions);
        if (!data?.success) {
            showToast(data?.message || 'Failed to delete SMS', 'danger');
            return false;
        }

        if (count === 1) {
            threadState.messages = threadState.messages.filter(function (sms) {
                return Number(sms?.id) !== smsIds[0];
            });
            showToast('SMS deleted successfully', 'success');
        } else {
            threadState.messages = [];
            showToast(`Deleted ${count} messages`, 'success');
            clearThreadSelection({ historyMode: 'replace' });
        }

        updateUnreadBadge(data.unreadCount);
        refreshSmsPageData();
        return true;
    }

    async function runThreadAction(action, options = {}) {
        const number = getThreadActionNumber(options.number || threadState.number);
        const conversationId = Math.max(0, Number(options.conversationId || threadState.conversationId) || 0) || null;
        if (!number && !conversationId) {
            showToast('Open a thread first.', 'warning');
            return;
        }

        const messages = options.messages || (
            threadState.number === number && threadState.conversationId === conversationId
                ? threadState.messages
                : await fetchThreadMessagesSnapshot(number, conversationId)
        );

        if (action === 'mark-read') {
            await markThreadMessagesRead(messages);
            showToast('Thread marked as read', 'success');
            return;
        }

        if (action === 'delete-thread') {
            await deleteSmsIds(getThreadMessageIds(messages));
        }
    }

    function loadSmsThread(number, options = {}) {
        const target = getThreadActionNumber(number);
        const conversationId = Math.max(0, Number(options.conversationId) || 0) || null;
        const title = String(options.title || '').trim() || target;
        if (!target && !conversationId) return Promise.resolve();
        const requestDeviceId = getSmsActiveDeviceId();
        const requestToken = ++smsThreadToken;
        const historyMode = options.historyMode || 'replace';

        threadState.number = target;
        threadState.conversationId = conversationId;
        threadState.title = title;
        updateThreadActionButtons(target);
        updateThreadPermalink(target, conversationId, title);
        syncConversationSelection(target, conversationId);
        syncThreadUrl(target, historyMode, conversationId, title);

        if (options.silent !== true) {
            setThreadLoading(target, title);
        }

        if (options.showModal !== false && !document.getElementById('smsConversationWorkspace')) {
            const modalEl = document.getElementById('smsThreadModal');
            if (modalEl) {
                bootstrap.Modal.getOrCreateInstance(modalEl).show();
            }
        }

        const threadUrl = conversationId
            ? `/api/sms/thread?conversationId=${conversationId}&limit=100`
            : `/api/sms/thread?number=${encodeURIComponent(target)}&limit=100`;

        return fetchSmsJson(threadUrl)
            .then(function (data) {
                if (!data?.success) {
                    throw new Error(data?.message || 'Failed to load conversation');
                }
                if (
                    requestToken !== smsThreadToken
                    || !isSmsDeviceSnapshotCurrent(requestDeviceId)
                    || threadState.number !== target
                    || threadState.conversationId !== conversationId
                ) {
                    return;
                }
                const resolvedConversationId = Math.max(0, Number(data?.meta?.conversationId) || 0) || conversationId || null;
                threadState.messages = Array.isArray(data.data) ? data.data : [];
                threadState.conversationId = resolvedConversationId;
                threadState.title = title || String(data?.meta?.number || target || '').trim();
                renderThreadMessages(threadState.messages, target, threadState.title);
                syncConversationSelection(target, resolvedConversationId);
                syncThreadUrl(target, 'replace', resolvedConversationId, threadState.title);
                updateThreadPermalink(target, resolvedConversationId, threadState.title);
                markThreadMessagesRead(threadState.messages);
            })
            .catch(function (error) {
                if (
                    requestToken !== smsThreadToken
                    || !isSmsDeviceSnapshotCurrent(requestDeviceId)
                    || threadState.number !== target
                    || threadState.conversationId !== conversationId
                ) {
                    return;
                }
                threadState.messages = [];
                const container = document.getElementById('smsChatMessages') || document.getElementById('smsThreadMessages');
                const metaEl = document.getElementById('smsChatMeta') || document.getElementById('smsThreadMeta');
                if (metaEl) metaEl.textContent = error.message || 'Failed to load conversation';
                if (container) {
                    container.innerHTML = '<div class="text-danger text-center py-4">Failed to load conversation for this number.</div>';
                }
            });
    }

    function renderConversationList(messages) {
        const list = document.getElementById('smsConversationList');
        const meta = document.getElementById('smsConversationMeta');
        if (!list) return [];

        const conversations = mergeScheduledConversations(normalizeConversationRows(messages));
        if ((document.getElementById('sortOrder')?.value || 'newest') === 'oldest') {
            conversations.reverse();
        }
        const scheduledCount = conversations.filter(function (thread) { return thread.hasScheduled; }).length;
        if (meta) {
            meta.textContent = conversations.length
                ? `${conversations.length} thread${conversations.length === 1 ? '' : 's'} on this device${scheduledCount ? ` | ${scheduledCount} scheduled` : ''}`
                : 'No SMS conversations yet';
        }

        if (!conversations.length) {
            list.innerHTML = renderConversationRailState('empty', 'No conversations yet.', {
                title: 'No conversations yet.',
                detail: 'Start a new SMS from the composer below.',
                action: 'compose'
            });
            clearThreadSelection({ historyMode: 'replace' });
            return conversations;
        }

        list.innerHTML = conversations.map(function (thread) {
            const active = (thread.conversationId && threadState.conversationId && thread.conversationId === threadState.conversationId)
                || (!threadState.conversationId && thread.number === threadState.number);
            const direction = thread.lastDirection === 'outgoing' ? 'You: ' : '';
            const previewText = thread.scheduledOnly
                ? `Scheduled: ${thread.lastMessage || 'Pending SMS'}`
                : (direction + (thread.lastMessage || 'No message text'));
            const statusPill = thread.lastDirection === 'outgoing' && thread.lastStatus
                ? `<span class="badge ${smsStatusMeta(thread.lastStatus).className} mt-1" data-thread-status-pill="1">${esc(smsStatusMeta(thread.lastStatus).label)}</span>`
                : '';
            const scheduledPill = thread.hasScheduled
                ? `<span class="badge bg-warning-subtle text-warning-emphasis border border-warning-subtle mt-1">Scheduled ${thread.scheduledCount || 1}</span>`
                : '';
            return `
                <div role="button" tabindex="0" class="list-group-item list-group-item-action conversation-item ${active ? 'active' : ''}"
                        data-thread-number="${esc(thread.number)}"
                        data-thread-conversation-id="${thread.conversationId || ''}"
                        data-thread-last-direction="${esc(thread.lastDirection || '')}"
                        data-thread-last-status="${esc(thread.lastStatus || '')}"
                        data-thread-title="${esc(thread.title || thread.number)}">
                    <div class="d-flex justify-content-between align-items-start gap-2 conversation-item-top">
                        <div class="min-w-0">
                            <div class="fw-semibold text-truncate conversation-item-title">${esc(thread.title || thread.number)}</div>
                            <div class="small ${active ? 'text-white-50' : 'text-muted'} conversation-preview" title="${esc(previewText)}">
                                ${esc(previewText)}
                            </div>
                        </div>
                        <div class="d-flex align-items-start gap-2 flex-shrink-0">
                            <div class="text-end conversation-item-time ${active ? 'text-white-50' : 'text-muted'}">${esc(formatTs(thread.nextScheduledAt || thread.lastTimestamp))}</div>
                            <div class="dropdown">
                                <button type="button"
                                        class="btn btn-sm btn-link p-0 text-decoration-none sms-thread-menu-toggle ${active ? 'text-white-50' : 'text-muted'}"
                                        data-bs-toggle="dropdown"
                                        data-thread-menu-toggle="1"
                                        data-thread-number="${esc(thread.number)}"
                                        data-thread-conversation-id="${thread.conversationId || ''}"
                                        data-thread-title="${esc(thread.title || thread.number)}"
                                        aria-expanded="false"
                                        aria-label="Thread menu">
                                    <i class="bi bi-three-dots-vertical"></i>
                                </button>
                                <ul class="dropdown-menu dropdown-menu-end">
                                    <li><button type="button" class="dropdown-item" data-thread-item-action="mark-read" data-thread-number="${esc(thread.number)}" data-thread-conversation-id="${thread.conversationId || ''}" data-thread-title="${esc(thread.title || thread.number)}"><i class="bi bi-envelope-open me-2"></i>Mark Read</button></li>
                                    <li><button type="button" class="dropdown-item text-danger" data-thread-item-action="delete-thread" data-thread-number="${esc(thread.number)}" data-thread-conversation-id="${thread.conversationId || ''}" data-thread-title="${esc(thread.title || thread.number)}"><i class="bi bi-trash me-2"></i>Delete Thread</button></li>
                                </ul>
                            </div>
                        </div>
                    </div>
                    <div class="conversation-item-footer">
                        <div class="conversation-item-badges">
                            ${statusPill}
                            ${scheduledPill}
                            ${thread.unread ? `<span class="badge bg-danger mt-1">Unread ${thread.unread}</span>` : ''}
                        </div>
                        <div class="small ${active ? 'text-white-50' : 'text-muted'} conversation-item-total">${thread.total || 0} msg</div>
                    </div>
                </div>`;
        }).join('');

        const selectedThreadExists = conversations.some((thread) => {
            if (threadState.conversationId && thread.conversationId) {
                return thread.conversationId === threadState.conversationId;
            }
            return thread.number === threadState.number;
        });
        if ((!threadState.number && !threadState.conversationId) || !selectedThreadExists) {
            loadSmsThread(conversations[0].number, {
                conversationId: conversations[0].conversationId,
                title: conversations[0].title,
                showModal: false,
                silent: true
            });
        }
        return conversations;
    }

    function refreshConversationView(refreshToken, requestDeviceId) {
        const list = document.getElementById('smsConversationList');
        const meta = document.getElementById('smsConversationMeta');
        if (!list) return Promise.resolve();
        if (list.dataset.loaded !== '1') {
            list.innerHTML = renderConversationRailState('loading', 'Loading conversations...', {
                title: 'Loading conversations...',
                detail: 'Fetching the latest thread summaries for this device.'
            });
        }

        return fetchSmsJson('/api/sms/conversations?limit=200')
            .then(function (data) {
                if (refreshToken !== smsRefreshToken || !isSmsDeviceSnapshotCurrent(requestDeviceId)) return;
                if (!data?.success) {
                    throw new Error(data?.message || 'Failed to load SMS conversations');
                }
                renderConversationList(Array.isArray(data.data) ? data.data : []);
                list.dataset.loaded = '1';
                attachThreadListeners();
                attachQuickActions();
            })
            .catch(function (error) {
                if (refreshToken !== smsRefreshToken || !isSmsDeviceSnapshotCurrent(requestDeviceId)) return;
                if (meta) meta.textContent = error.message || 'Failed to load SMS conversations';
                list.innerHTML = renderConversationRailState('error', 'Failed to load SMS conversations.', {
                    title: 'Conversation sync failed.',
                    detail: error.message || 'Failed to load SMS conversations.',
                    action: 'retry'
                });
            });
    }

    function refreshSmsStats(refreshToken, requestDeviceId) {
        const totalEl = document.getElementById('smsTotalCount');
        const sentEl = document.getElementById('smsSentCount');
        const inboxEl = document.getElementById('smsInboxCount');
        const unreadEl = document.getElementById('smsUnreadCount');

        fetchSmsJson('/api/sms?limit=1')
            .then(function (data) {
                if (refreshToken !== smsRefreshToken || !isSmsDeviceSnapshotCurrent(requestDeviceId)) return;
                if (data?.success && totalEl) totalEl.textContent = data.pagination?.total || 0;
            })
            .catch(function () {});

        fetchSmsJson('/api/sms?limit=1&type=outgoing')
            .then(function (data) {
                if (refreshToken !== smsRefreshToken || !isSmsDeviceSnapshotCurrent(requestDeviceId)) return;
                if (data?.success && sentEl) sentEl.textContent = data.pagination?.total || 0;
            })
            .catch(function () {});

        fetchSmsJson('/api/sms?limit=1&type=incoming')
            .then(function (data) {
                if (refreshToken !== smsRefreshToken || !isSmsDeviceSnapshotCurrent(requestDeviceId)) return;
                if (data?.success && inboxEl) inboxEl.textContent = data.pagination?.total || 0;
            })
            .catch(function () {});

        fetchSmsJson('/api/sms/unread')
            .then(function (data) {
                if (refreshToken !== smsRefreshToken || !isSmsDeviceSnapshotCurrent(requestDeviceId)) return;
                if (!data) return;
                if (unreadEl) unreadEl.textContent = data.count || 0;
                updateUnreadBadge(data.count || 0);
            })
            .catch(function () {});
    }

    function refreshSmsPageData() {
        const requestDeviceId = getSmsActiveDeviceId();
        const refreshToken = ++smsRefreshToken;
        refreshSmsStats(refreshToken, requestDeviceId);
        return Promise.all([
            refreshConversationView(refreshToken, requestDeviceId)
        ]).finally(function () {
            if (refreshToken !== smsRefreshToken || !isSmsDeviceSnapshotCurrent(requestDeviceId)) return;
            attachDeleteListeners();
            attachMarkReadListeners();
            attachQuickActions();
        });
    }

    window.openContactsModal = function(targetFieldId = '') {
        const requestedField = String(targetFieldId || '').trim();
        const composeModalEl = document.getElementById('composeSmsModal');
        const composeVisible = composeModalEl?.classList.contains('show');
        const composeModal = composeVisible ? bootstrap.Modal.getOrCreateInstance(composeModalEl) : null;
        contactTargetFieldId = requestedField || (composeVisible ? 'modalTo' : 'smsChatTo');
        shouldReopenComposeAfterContacts = composeVisible && contactTargetFieldId === 'modalTo';

        if (composeModal && composeVisible) {
            composeModal.hide();
        }

        setTimeout(() => {
            const contactsModal = new bootstrap.Modal(document.getElementById('contactsModal'));
            contactsModal.show();
            loadFullContacts();
        }, composeVisible ? 300 : 0);
    };

    // Load contacts from API
    function loadContacts() {
        fetch('/api/contacts?limit=100', { signal: newSignal() })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    contacts = data.data;
                    updateContactStats(data);
                }
            })
            .catch(error => { if (error.name !== 'AbortError') console.error('Error loading contacts:', error); });
    }

    // Update contact stats
    function updateContactStats(data) {
        const total = document.getElementById('totalContacts');
        const favorites = document.getElementById('favoriteContacts');

        if (total) total.textContent = `Total: ${data.pagination.total}`;
        if (favorites) favorites.textContent = `Favorites: ${data.data.filter(c => c.favorite).length}`;
    }

    // Attach delete button listeners
    function attachDeleteListeners() {
        const deleteButtons = document.querySelectorAll('.delete-sms-btn');

        deleteButtons.forEach(button => {
            button.removeEventListener('click', handleDelete);
            button.addEventListener('click', handleDelete);
        });
    }

    // Handle delete button click
    async function handleDelete(e) {
        e.preventDefault();
        e.stopPropagation();

        const smsItem = this.closest('[data-sms-id]');
        if (!smsItem) {
            console.error('No SMS item found');
            return;
        }

        const smsId = smsItem.dataset.smsId;

        let approved = false;
        if (typeof window.appConfirm === 'function') {
            approved = await window.appConfirm({
                title: 'Delete Message',
                message: 'Are you sure you want to delete this message?',
                confirmText: 'Delete',
                confirmClass: 'btn btn-danger'
            });
        } else {
            approved = confirm('Are you sure you want to delete this message?');
        }

        if (approved) {
            deleteSms(smsId, smsItem);
        }
    }

    // Delete SMS function
    function deleteSms(smsId, element) {
        // Show loading state
        const originalContent = element.innerHTML;
        element.style.opacity = '0.5';
        element.innerHTML = '<div class="text-center p-3"><div class="spinner-border spinner-border-sm text-primary" role="status"></div> Deleting...</div>';

        fetchSmsJson('/api/sms/' + smsId, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            }
        })
            .then(data => {
                if (data.success) {
                    // Remove element with animation
                    element.style.transition = 'all 0.3s ease';
                    element.style.transform = 'translateX(100%)';
                    element.style.opacity = '0';

                    setTimeout(() => {
                        element.remove();
                        showToast('SMS deleted successfully', 'success');
                        updateUnreadBadge();
                        refreshSmsPageData();
                    }, 300);
                } else {
                    element.style.opacity = '1';
                    element.innerHTML = originalContent;
                    showToast('Failed to delete SMS', 'danger');
                    attachDeleteListeners(); // Reattach listeners
                }
            })
            .catch(error => {
                console.error('Error deleting SMS:', error);
                element.style.opacity = '1';
                element.innerHTML = originalContent;
                showToast('Error deleting SMS', 'danger');
                attachDeleteListeners(); // Reattach listeners
            });
    }

    // Attach mark as read listeners
    function attachMarkReadListeners() {
        const markReadButtons = document.querySelectorAll('.mark-read-btn');

        markReadButtons.forEach(button => {
            button.removeEventListener('click', handleMarkRead);
            button.addEventListener('click', handleMarkRead);
        });
    }

    // Handle mark as read click
    function handleMarkRead(e) {
        e.preventDefault();
        e.stopPropagation();

        const smsItem = this.closest('[data-sms-id]');
        if (!smsItem) {
            console.error('No SMS item found');
            return;
        }

        const smsId = smsItem.dataset.smsId;

        markAsRead(smsId, smsItem, this);
    }

    // Mark SMS as read
    function markAsRead(smsId, element, button) {
        fetchSmsJson('/api/sms/' + smsId + '/read', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            }
        })
            .then(data => {
                if (data.success) {
                    // Remove badge
                    const badge = element.querySelector('.badge.bg-danger');
                    if (badge) {
                        badge.remove();
                    }

                    // Remove button
                    button?.remove();

                    // Update unread class
                    element.classList.remove('unread');

                    // Update avatar
                    const avatar = element.querySelector('.avatar-circle');
                    if (avatar) {
                        avatar.classList.remove('bg-primary');
                        avatar.classList.add('bg-light');
                        const icon = avatar.querySelector('i');
                        if (icon) {
                            icon.classList.remove('text-white');
                            icon.classList.add('text-secondary');
                        }
                    }

                    showToast('Message marked as read', 'success');
                    updateUnreadBadge();
                    refreshSmsStats();
                }
            })
            .catch(error => {
                console.error('Error marking SMS as read:', error);
                showToast('Error marking SMS as read', 'danger');
            });
    }

    function handleQuickCallClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const number = this.dataset.number;
        if (number && confirm(`Call ${number}?`)) {
            openCallsForNumber(number);
        }
    }

    function handleQuickReplyClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const number = this.dataset.number;
        if (number) {
            openComposeForNumber(number);
        }
    }

    // Attach quick action buttons (call, reply)
    function attachQuickActions() {
        document.querySelectorAll('.quick-call-btn').forEach(btn => {
            if (btn.dataset.quickCallBound === '1') return;
            btn.dataset.quickCallBound = '1';
            btn.addEventListener('click', handleQuickCallClick);
        });

        document.querySelectorAll('.quick-sms-btn').forEach(btn => {
            if (btn.dataset.quickSmsBound === '1') return;
            btn.dataset.quickSmsBound = '1';
            btn.addEventListener('click', handleQuickReplyClick);
        });
    }

    function resetSmsAttachment() {
        smsAttachment = null;
        const input = document.getElementById('smsAttachmentInput');
        const preview = document.getElementById('smsAttachmentPreview');
        if (input) input.value = '';
        if (preview) {
            preview.classList.add('d-none');
            preview.innerHTML = '';
        }
    }

    function renderSmsAttachmentPreview() {
        const preview = document.getElementById('smsAttachmentPreview');
        if (!preview) return;
        if (!smsAttachment) {
            preview.classList.add('d-none');
            preview.innerHTML = '';
            return;
        }
        const content = smsAttachment.kind === 'contact'
            ? renderContactCard(smsAttachment.contact)
            : renderAttachmentCard(smsAttachment);
        preview.classList.remove('d-none');
        preview.innerHTML = `
            <div class="flex-grow-1 min-w-0">${content}</div>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="smsAttachmentRemoveBtn" title="Remove attachment">
                <i class="bi bi-x-lg"></i>
            </button>`;
        document.getElementById('smsAttachmentRemoveBtn')?.addEventListener('click', resetSmsAttachment, { once: true });
    }

    function attachSmsAttachmentControls() {
        const attachBtn = document.getElementById('smsAttachBtn');
        const input = document.getElementById('smsAttachmentInput');
        if (!attachBtn || !input || attachBtn.dataset.attachBound === '1') return;
        attachBtn.dataset.attachBound = '1';

        attachBtn.addEventListener('click', function () {
            input.click();
        });

        input.addEventListener('change', function () {
            const file = input.files?.[0];
            if (!file) {
                resetSmsAttachment();
                return;
            }
            if (file.size > 512 * 1024) {
                showToast('Attachment preview limit is 512 KB.', 'warning');
                resetSmsAttachment();
                return;
            }

            const lowerName = file.name.toLowerCase();
            const isContact = /(\.vcf|\.vcard)$/.test(lowerName) || /vcard/i.test(file.type);
            const reader = new FileReader();
            reader.onload = function () {
                if (isContact) {
                    smsAttachment = {
                        kind: 'contact',
                        name: file.name,
                        size: file.size,
                        type: file.type || 'text/vcard',
                        contact: parseVcard(String(reader.result || '')) || { name: file.name }
                    };
                } else {
                    smsAttachment = {
                        kind: 'attachment',
                        name: file.name,
                        size: file.size,
                        type: file.type || 'application/octet-stream',
                        dataUrl: String(reader.result || '')
                    };
                }
                renderSmsAttachmentPreview();
            };
            reader.onerror = function () {
                showToast('Could not read attachment preview.', 'danger');
                resetSmsAttachment();
            };

            if (isContact) reader.readAsText(file);
            else reader.readAsDataURL(file);
        });
    }

    function attachThreadListeners() {
        const conversationList = document.getElementById('smsConversationList');
        if (conversationList && conversationList.dataset.threadBound !== '1') {
            conversationList.dataset.threadBound = '1';
            conversationList.addEventListener('click', function (event) {
                const retryButton = event.target.closest('#smsRetryConversationsBtn');
                if (retryButton) {
                    refreshSmsPageData();
                    return;
                }

                const composeButton = event.target.closest('[data-sms-open-compose]');
                if (composeButton) {
                    document.getElementById('smsFocusComposerBtn')?.click();
                    return;
                }

                const threadAction = event.target.closest('[data-thread-item-action]');
                if (threadAction) {
                    event.preventDefault();
                    event.stopPropagation();
                    runThreadAction(String(threadAction.dataset.threadItemAction || '').trim(), {
                        number: String(threadAction.dataset.threadNumber || '').trim(),
                        conversationId: Math.max(0, Number(threadAction.dataset.threadConversationId) || 0) || null
                    });
                    return;
                }

                const threadMenuToggle = event.target.closest('[data-thread-menu-toggle]');
                if (threadMenuToggle) {
                    event.stopPropagation();
                    return;
                }

                const item = event.target.closest('.conversation-item[data-thread-number]');
                if (!item) return;
                const number = String(item.dataset.threadNumber || '').trim();
                const conversationId = Math.max(0, Number(item.dataset.threadConversationId) || 0) || null;
                const title = String(item.dataset.threadTitle || '').trim();
                if (!number && !conversationId) return;
                threadState.number = number;
                threadState.conversationId = conversationId;
                threadState.title = title || number;
                loadSmsThread(number, {
                    conversationId,
                    title,
                    showModal: false,
                    historyMode: 'push'
                });
            });
            conversationList.addEventListener('keydown', function (event) {
                const item = event.target.closest('.conversation-item[data-thread-number]');
                if (!item) return;
                if (event.key !== 'Enter' && event.key !== ' ') return;
                if (event.target.closest('[data-thread-menu-toggle], [data-thread-item-action]')) return;
                event.preventDefault();
                item.click();
            });
        }

        const callBtn = document.getElementById('smsChatCallBtn') || document.getElementById('smsThreadCallBtn');
        if (callBtn && callBtn.dataset.threadActionBound !== '1') {
            callBtn.dataset.threadActionBound = '1';
            callBtn.addEventListener('click', function () {
                const number = this.dataset.number;
                if (number && confirm(`Call ${number}?`)) {
                    openCallsForNumber(number);
                }
            });
        }

        const replyBtn = document.getElementById('smsThreadReplyBtn');
        if (replyBtn && replyBtn.dataset.threadActionBound !== '1') {
            replyBtn.dataset.threadActionBound = '1';
            replyBtn.addEventListener('click', function () {
                const number = this.dataset.number;
                if (number) {
                    openComposeForNumber(number);
                }
            });
        }

        document.querySelectorAll('[data-thread-menu-action]').forEach(function (button) {
            if (!button || button.dataset.threadActionBound === '1') return;
            button.dataset.threadActionBound = '1';
            button.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();
                runThreadAction(String(this.dataset.threadMenuAction || '').trim());
            });
        });

        const threadContainers = ['smsChatMessages', 'smsThreadMessages'];
        threadContainers.forEach(function (id) {
            const container = document.getElementById(id);
            if (!container || container.dataset.threadMenuBound === '1') return;
            container.dataset.threadMenuBound = '1';
            container.addEventListener('click', function (event) {
                const messageInfo = event.target.closest('[data-thread-message-info]');
                if (messageInfo) {
                    event.preventDefault();
                    event.stopPropagation();
                    openSmsMessageDetails(Number(messageInfo.dataset.threadMessageInfo || 0));
                    return;
                }

                const messageAction = event.target.closest('[data-thread-message-action]');
                if (messageAction) {
                    event.preventDefault();
                    event.stopPropagation();
                    const smsId = Number(messageAction.dataset.smsId || 0);
                    const message = threadState.messages.find(function (sms) { return Number(sms?.id) === smsId; });
                    if (!message) return;
                    if (String(messageAction.dataset.threadMessageAction || '').trim() === 'mark-read') {
                        markThreadMessagesRead([message]).then(function () {
                            showToast('Message marked as read', 'success');
                        });
                        return;
                    }
                    if (String(messageAction.dataset.threadMessageAction || '').trim() === 'delete-message') {
                        deleteSmsIds([smsId]).then(function (deleted) {
                            if (!deleted) return;
                            renderThreadMessages(threadState.messages, threadState.number, threadState.title);
                            if (!threadState.messages.length) {
                                clearThreadSelection({ historyMode: 'replace' });
                            }
                        });
                        return;
                    }
                }

                const messageToggle = event.target.closest('[data-thread-message-menu]');
                if (messageToggle) {
                    event.stopPropagation();
                }
            });
        });

        const modalEl = document.getElementById('smsThreadModal');
        if (modalEl && modalEl.dataset.threadModalBound !== '1') {
            modalEl.dataset.threadModalBound = '1';
            modalEl.addEventListener('hidden.bs.modal', function () {
                if (!document.getElementById('smsConversationWorkspace')) {
                    clearThreadSelection({ historyMode: 'replace' });
                }
            });
        }

        const messageDetailsModal = document.getElementById('smsMessageDetailsModal');
        if (messageDetailsModal && messageDetailsModal.dataset.copyBound !== '1') {
            messageDetailsModal.dataset.copyBound = '1';
            messageDetailsModal.addEventListener('click', function (event) {
                const copyBtn = event.target.closest('[data-sms-copy-message-info]');
                if (!copyBtn) return;
                event.preventDefault();
                copySmsDetailText(messageDetailsModal.dataset.smsMessageInfoCopy || '');
            });
        }

        const chatMessage = document.getElementById('smsChatMessage');
        const chatCount = document.getElementById('smsChatCharCount');
        if (chatMessage && chatCount && chatMessage.dataset.charBound !== '1') {
            chatMessage.dataset.charBound = '1';
            chatMessage.addEventListener('input', function () {
                const analysis = updateSmsComposeCounter(this, {
                    countId: 'smsChatCharCount',
                    byteId: 'smsChatByteCount',
                    partsId: 'smsChatParts'
                });
                updateChatComposeMeta(analysis);
                this.style.height = 'auto';
                this.style.height = `${Math.min(this.scrollHeight, 112)}px`;
            });
            const analysis = updateSmsComposeCounter(chatMessage, {
                countId: 'smsChatCharCount',
                byteId: 'smsChatByteCount',
                partsId: 'smsChatParts'
            });
            updateChatComposeMeta(analysis);
        }

        const chatForm = document.getElementById('smsChatForm');
        if (chatForm && chatForm.dataset.sendBound !== '1') {
            chatForm.dataset.sendBound = '1';
            chatForm.addEventListener('submit', handleChatSendSms);
        }

        const focusComposerBtn = document.getElementById('smsFocusComposerBtn');
        if (focusComposerBtn && focusComposerBtn.dataset.focusBound !== '1') {
            focusComposerBtn.dataset.focusBound = '1';
            focusComposerBtn.addEventListener('click', function () {
                const chatTo = document.getElementById('smsChatTo');
                const chatMessage = document.getElementById('smsChatMessage');
                if (chatTo && !chatTo.value) {
                    focusChatRecipientEditor();
                } else if (chatMessage) {
                    chatMessage.focus();
                }
            });
        }
    }

    // Attach search and filter
    function attachSearchAndFilter() {
        const searchInput = document.getElementById('searchSms');
        const filterSelect = document.getElementById('filterType');
        const sortSelect = document.getElementById('sortOrder');

        if (searchInput) {
            searchInput.addEventListener('input', debounce(filterMessages, 300));
        }

        if (filterSelect) {
            filterSelect.addEventListener('change', filterMessages);
        }

        if (sortSelect) {
            sortSelect.addEventListener('change', sortMessages);
        }
    }

    function attachQuickFilterChips() {
        document.querySelectorAll('#quickFilterChips [data-quick-filter]').forEach(btn => {
            btn.addEventListener('click', function () {
                document.querySelectorAll('#quickFilterChips [data-quick-filter]').forEach(el => el.classList.remove('active'));
                this.classList.add('active');
                const quick = this.dataset.quickFilter;
                const filterSelect = document.getElementById('filterType');
                const searchInput = document.getElementById('searchSms');

                if (quick === 'today') {
                    if (searchInput) searchInput.value = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    if (filterSelect) filterSelect.value = 'all';
                } else {
                    if (searchInput) searchInput.value = '';
                    if (filterSelect) filterSelect.value = quick === 'all' ? 'all' : quick;
                }
                filterMessages();
            });
        });
    }

    function attachKeyboardShortcuts() {
        document.addEventListener('keydown', function (e) {
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
            if (e.key === '/') {
                e.preventDefault();
                document.getElementById('searchSms')?.focus();
            } else if (e.key.toLowerCase() === 'c') {
                e.preventDefault();
                const chatTo = document.getElementById('smsChatTo');
                if (chatTo) {
                    if (chatTo.value) {
                        document.getElementById('smsChatMessage')?.focus();
                    } else {
                        focusChatRecipientEditor();
                    }
                } else {
                    const modal = new bootstrap.Modal(document.getElementById('composeSmsModal'));
                    modal.show();
                }
            } else if (e.key === '?') {
                e.preventDefault();
                const modal = new bootstrap.Modal(document.getElementById('smsShortcutsModal'));
                modal.show();
            } else if (e.shiftKey && e.key.toLowerCase() === 'r') {
                e.preventDefault();
                markAllAsRead();
            }
        });
    }

    // Filter messages
    function filterMessages() {
        const searchTerm = document.getElementById('searchSms')?.value.toLowerCase() || '';
        const filterType = document.getElementById('filterType')?.value || 'all';

        document.querySelectorAll('.conversation-item').forEach(item => {
            const text = item.textContent.toLowerCase();
            const isUnread = Boolean(item.querySelector('.badge.bg-danger'));
            const direction = item.querySelector('.conversation-preview')?.textContent.toLowerCase() || '';
            let matchesFilter = true;
            if (filterType === 'inbox') matchesFilter = !direction.startsWith('you:');
            else if (filterType === 'sent') matchesFilter = direction.startsWith('you:');
            else if (filterType === 'unread') matchesFilter = isUnread;
            item.style.display = text.includes(searchTerm) && matchesFilter ? '' : 'none';
        });

        document.querySelectorAll('.message-item').forEach(item => {
            const text = item.querySelector('.message-text')?.textContent.toLowerCase() || '';
            const sender = item.querySelector('.sender-name')?.textContent.toLowerCase() || '';
            const recipient = item.querySelector('.recipient-number')?.textContent.toLowerCase() || '';
            const type = item.dataset.smsType;
            const isUnread = item.classList.contains('unread');

            let matchesSearch = text.includes(searchTerm) ||
                sender.includes(searchTerm) ||
                recipient.includes(searchTerm);

            let matchesFilter = true;
            if (filterType === 'inbox') matchesFilter = type === 'inbox';
            else if (filterType === 'sent') matchesFilter = type === 'sent';
            else if (filterType === 'unread') matchesFilter = isUnread;

            if (matchesSearch && matchesFilter) {
                item.style.display = '';
            } else {
                item.style.display = 'none';
            }
        });
    }

    // Sort messages
    function sortMessages() {
        refreshSmsPageData();
    }

    function attachTemplateButtons() {
        document.querySelectorAll('.template-btn').forEach(btn => {
            // Remove old listeners to prevent duplicates
            btn.removeEventListener('click', handleTemplateClick);
            btn.addEventListener('click', handleTemplateClick);
        });
    }

    function handleTemplateClick(e) {
        e.preventDefault();
        const template = this.dataset.template;
        const messageInput = document.getElementById('smsChatMessage') || document.getElementById('modalMessage');
        const toFieldId = document.getElementById('smsChatTo') ? 'smsChatTo' : 'modalTo';
        const toInput = document.getElementById(toFieldId);

        const templates = {
            balance: {
                message: 'Check my account balance',
                to: ''
            },
            offer: {
                message: 'Please send me current offers and packages',
                to: ''
            },
            help: {
                message: 'I need assistance with my account. Please call me back.',
                to: ''
            },
            hello: {
                message: 'Hello, this is a test message from my ESP32 dashboard.',
                to: ''
            }
        };

        if (messageInput && templates[template]) {
            messageInput.value = templates[template].message;
            messageInput.dispatchEvent(new Event('input'));

            if (toInput && templates[template].to && !toInput.value) {
                setPhoneFieldValue(toFieldId, templates[template].to);
            }

            showToast('Template applied', 'success');
        }
    }

    // Attach modal listeners
    function attachModalListeners() {
        const sendBtn = document.getElementById('modalSendBtn');
        if (sendBtn) {
            sendBtn.removeEventListener('click', handleSendSms);
            sendBtn.addEventListener('click', handleSendSms);
        }

        // Reset compose modal on close
        const composeModal = document.getElementById('composeSmsModal');
        if (composeModal) {
            composeModal.addEventListener('hidden.bs.modal', function () {
                const form = document.getElementById('composeSmsForm');
                if (form) form.reset();
                updateRecipientMeta('modalTo');
                updateSmsComposeCounter('modalMessage', {
                    countId: 'modalCharCount',
                    byteId: 'modalByteCount',
                    partsId: 'smsParts'
                });
            });
        }

        // Contacts modal - load contacts when shown
        const contactsModal = document.getElementById('contactsModal');
        if (contactsModal) {
            contactsModal.addEventListener('show.bs.modal', function() {
                loadFullContacts();
            });
            
            // When contacts modal is hidden, show compose modal again
            contactsModal.addEventListener('hidden.bs.modal', function() {
                const reopenCompose = shouldReopenComposeAfterContacts;
                shouldReopenComposeAfterContacts = false;
                if (reopenCompose) {
                    const composeModal = new bootstrap.Modal(document.getElementById('composeSmsModal'));
                    composeModal.show();
                }
            });
        }

        // Add Contact modal listeners
        const saveBtn = document.getElementById('saveContactBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', saveContact);
        }
        
        const deleteBtn = document.getElementById('deleteContactBtn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', function() {
                const id = document.getElementById('contactId').value;
                if (id) deleteContact(id);
            });
        }
        
        // Reset add contact modal on hide
        const addContactModal = document.getElementById('addContactModal');
        if (addContactModal) {
            addContactModal.addEventListener('hidden.bs.modal', function() {
                document.getElementById('contactForm').reset();
                document.getElementById('contactId').value = '';
                document.getElementById('deleteContactBtn').classList.add('d-none');
            });
        }
    }

    // Load full contacts list for selection
    function loadFullContacts() {
        const container = document.getElementById('contactsList');
        if (!container) return;

        container.innerHTML = '<div class="text-center py-4"><div class="spinner-border text-primary" role="status"></div></div>';

        fetch('/api/contacts?limit=100', { signal: newSignal() })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    contacts = Array.isArray(data.data) ? data.data : [];
                    displayFullContacts(contacts);
                }
            })
            .catch(error => {
                if (error.name === 'AbortError') return;
                console.error('Error loading contacts:', error);
                container.innerHTML = '<div class="text-center py-4 text-danger">Error loading contacts</div>';
            });
    }

    // Display full contacts list for selection
    function displayFullContacts(contacts) {
        const container = document.getElementById('contactsList');
        if (!container) return;

        const list = Array.isArray(contacts) ? contacts : [];
        if (list.length === 0) {
            container.innerHTML = '<div class="text-center py-4">No contacts found. <button class="btn btn-link" onclick="showAddContactModal()">Add one now</button></div>';
            return;
        }

        // Get unique companies for filter
        const companies = [...new Set(list.filter(c => c.company).map(c => c.company))];
        const companyFilter = document.getElementById('contactCompanyFilter');
        if (companyFilter) {
            let options = '<option value="">All Companies</option>';
            companies.forEach(company => {
                options += `<option value="${escapeHtml(company)}">${escapeHtml(company)}</option>`;
            });
            companyFilter.innerHTML = options;
        }

        renderFilteredContacts(list);

        // Add search/filter/sort functionality
        const searchInput = document.getElementById('contactSearch');
        if (searchInput) {
            searchInput.oninput = debounce(filterContacts, 300);
        }

        const companyFilterEl = document.getElementById('contactCompanyFilter');
        if (companyFilterEl) {
            companyFilterEl.onchange = filterContacts;
        }

        const sortEl = document.getElementById('contactSort');
        if (sortEl) {
            sortEl.onchange = filterContacts;
        }
    }

    function renderFilteredContacts(contactRows) {
        const container = document.getElementById('contactsList');
        if (!container) return;

        let html = '';
        contactRows.forEach(contact => {
            const favorite = contact.favorite ? '<i class="bi bi-star-fill text-warning ms-2"></i>' : '';
            html += `
                <div class="list-group-item list-group-item-action" data-contact-id="${contact.id}" data-phone="${escapeHtml(contact.phone_number)}" data-name="${escapeHtml(contact.name)}" data-company="${escapeHtml(contact.company || '')}">
                    <div class="d-flex align-items-center">
                        <div class="flex-shrink-0 me-3">
                            <div class="bg-light rounded-circle p-2">
                                <i class="bi bi-person-circle fs-4"></i>
                            </div>
                        </div>
                        <div class="flex-grow-1">
                            <div class="d-flex justify-content-between">
                                <h6 class="mb-1">${escapeHtml(contact.name)} ${favorite}</h6>
                                ${contact.company ? `<small class="text-muted">${escapeHtml(contact.company)}</small>` : ''}
                            </div>
                            <p class="mb-0 small">${escapeHtml(contact.phone_number)}</p>
                            ${contact.email ? `<small class="text-muted">${escapeHtml(contact.email)}</small>` : ''}
                        </div>
                        <div class="btn-group btn-group-sm ms-2">
                            <button class="btn btn-outline-success" data-phone="${escapeHtml(contact.phone_number)}" data-name="${escapeHtml(contact.name)}" onclick="selectContact(this.dataset.phone, this.dataset.name)">
                                <i class="bi bi-plus-lg"></i> Add
                            </button>
                            <button class="btn btn-outline-secondary" type="button" onclick="editContact(${Number(contact.id)})" title="Edit contact">
                                <i class="bi bi-pencil"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
    }

    // Filter contacts in modal
    function filterContacts() {
        const searchTerm = document.getElementById('contactSearch')?.value.toLowerCase() || '';
        const company = document.getElementById('contactCompanyFilter')?.value || '';
        const sortMode = document.getElementById('contactSort')?.value || 'name';
        const filtered = (Array.isArray(contacts) ? contacts : []).filter((contact) => {
            const name = String(contact?.name || '').toLowerCase();
            const phone = String(contact?.phone_number || '').toLowerCase();
            const itemCompany = String(contact?.company || '');
            const matchesSearch = name.includes(searchTerm) || phone.includes(searchTerm);
            const matchesCompany = !company || itemCompany === company;
            return matchesSearch && matchesCompany;
        });

        filtered.sort((left, right) => {
            if (sortMode === 'recent') {
                return String(right?.created_at || '').localeCompare(String(left?.created_at || ''));
            }
            if (sortMode === 'frequent') {
                return Number(right?.use_count || 0) - Number(left?.use_count || 0);
            }
            return String(left?.name || '').localeCompare(String(right?.name || ''));
        });

        if (filtered.length === 0) {
            const container = document.getElementById('contactsList');
            if (container) {
                container.innerHTML = '<div class="text-center py-4 text-muted">No contacts match the current filters.</div>';
            }
            return;
        }

        renderFilteredContacts(filtered);
    }

    /* Legacy char counter path kept here temporarily after the scheduled composer refactor.
        bindSmsComposeCounter('modalMessage', {
            countId: 'modalCharCount',
            byteId: 'modalByteCount',
            partsId: 'smsParts'
        });
        bindSmsComposeCounter('schedSingleMessage', {
            countId: 'schedSingleCharCount',
            byteId: 'schedSingleByteCount',
            partsId: 'schedSingleParts'
        });
        return;

        const messageInput = document.getElementById('modalMessage');
        const charCount = document.getElementById('modalCharCount');
        const smsParts = document.getElementById('smsParts');
        const singleSmsLimit = 160;
        const multipartLimit = 1023;

        if (messageInput && charCount) {
            messageInput.addEventListener('input', function () {
                const count = this.value.length;
                charCount.textContent = count;

                // Check if message contains non-GSM characters
                const gsmChars = '@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
                let isGsm = true;
                for (let i = 0; i < this.value.length; i++) {
                    if (!gsmChars.includes(this.value[i])) {
                        isGsm = false;
                        break;
                    }
                }

                if (smsParts) {
                    const segmentSize = isGsm ? 153 : 67;
                    const parts = count === 0 ? 1 : Math.ceil(count / segmentSize);
                    const label = count <= singleSmsLimit
                        ? `1 part${isGsm ? '' : ' (Unicode)'}`
                        : `${parts} parts${isGsm ? '' : ' (Unicode)'}`;
                    smsParts.innerHTML = `<span class="badge bg-secondary">${label}</span>`;
                }

                // Visual feedback
                charCount.className = '';
                if (count > singleSmsLimit - 20) {
                    charCount.classList.add('text-warning');
                }
                if (count > singleSmsLimit) {
                    charCount.classList.remove('text-warning');
                    charCount.classList.add('text-info');
                }
                if (count >= multipartLimit) {
                    charCount.classList.remove('text-info');
                    charCount.classList.add('text-danger');
                }
            });
        }
    }

    */
    function attachCharCounter() {
        bindSmsComposeCounter('modalMessage', {
            countId: 'modalCharCount',
            byteId: 'modalByteCount',
            partsId: 'smsParts'
        });
        bindSmsComposeCounter('schedSingleMessage', {
            countId: 'schedSingleCharCount',
            byteId: 'schedSingleByteCount',
            partsId: 'schedSingleParts'
        });
    }

    function handleChatSendSms(e) {
        e.preventDefault();

        const phoneValidation = validatePhoneField('smsChatTo', { allowShortCode: true });
        const recipients = Array.isArray(phoneValidation.values) ? phoneValidation.values : [phoneValidation.value].filter(Boolean);
        const to = recipients[0] || '';
        const messageEl = document.getElementById('smsChatMessage');
        const message = String(messageEl?.value || '').trim();
        const messageAnalysis = analyzeSmsComposeText(message);
        const button = document.getElementById('smsChatSendBtn') || e.submitter;
        const activeDeviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';
        const sendMode = getChatSendMode();
        const scheduleAtInput = document.getElementById('smsChatScheduleAt');
        const scheduleAt = scheduleAtInput?.value || '';

        if (!message) {
            showToast('Please type a message first.', 'warning');
            return;
        }
        if (smsAttachment) {
            showToast('MMS attachment transport is not enabled on the device yet. Remove the attachment to send this as SMS.', 'warning');
            return;
        }
        if (!phoneValidation.ok) {
            showToast(phoneValidation.message, 'warning');
            return;
        }
        if (!activeDeviceId) {
            showToast('Select a device first.', 'warning');
            return;
        }
        if (!messageAnalysis.valid) {
            showToast(window.smsComposeLimits?.formatError?.(messageAnalysis) || 'SMS message exceeds the device limit.', 'warning');
            return;
        }

        if (sendMode === 'scheduled') {
            if (!scheduleAt) {
                if (scheduleAtInput) scheduleAtInput.value = getDefaultScheduleValue();
            }
            const scheduledDate = new Date(scheduleAtInput?.value || getDefaultScheduleValue());
            if (!Number.isFinite(scheduledDate.getTime()) || scheduledDate <= new Date()) {
                showToast('Choose a future time for scheduled SMS.', 'warning');
                return;
            }
        }

        const spinner = button?.querySelector?.('.spinner-border');
        if (spinner) spinner.classList.remove('d-none');
        if (button) button.disabled = true;
        const cancelFeedback = typeof mqttWaitFeedback === 'function' && button ? mqttWaitFeedback(button) : null;
        const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
        const headers = { 'Content-Type': 'application/json' };
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

        const requestUrl = sendMode === 'scheduled' ? '/api/sms/scheduled' : '/api/sms/send';
        const requestBody = sendMode === 'scheduled'
            ? { to, recipients, message, send_at: new Date(scheduleAtInput?.value || getDefaultScheduleValue()).toISOString(), deviceId: activeDeviceId }
            : { to, recipients, message, deviceId: activeDeviceId };

        fetch(buildSmsRequestUrl(requestUrl), {
            method: 'POST',
            headers,
            credentials: 'same-origin',
            body: JSON.stringify(requestBody)
        })
            .then(async function (response) {
                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(payload?.message || payload?.error || `Request failed with HTTP ${response.status}`);
                }
                return payload;
            })
            .then(function (data) {
                if (!data?.success) {
                    throw new Error(data?.message || 'Failed to send SMS');
                }
                const queuedCount = Number(data.count || recipients.length || 1);
                showToast(
                    sendMode === 'scheduled'
                        ? (queuedCount > 1 ? `${queuedCount} SMS scheduled.` : 'SMS scheduled.')
                        : (queuedCount > 1
                            ? `${queuedCount} SMS queued for delivery.`
                            : (data.queued ? 'SMS queued for delivery.' : 'SMS sent successfully.')),
                    'success'
                );
                if (messageEl) {
                    messageEl.value = '';
                    messageEl.dispatchEvent(new Event('input'));
                }
                resetSmsAttachment();
                if (sendMode === 'scheduled' && scheduleAtInput) {
                    scheduleAtInput.value = getDefaultScheduleValue();
                }
                scheduleSmsRefresh(80);
                const followUpThread = queuedCount === 1
                    ? buildComposerFollowUpThread(to, { conversationId: data?.conversationId })
                    : null;
                if (sendMode === 'scheduled') {
                    Promise.resolve(
                        typeof window.loadScheduledSms === 'function' ? window.loadScheduledSms() : null
                    )
                        .catch(function () {})
                        .finally(function () {
                            if (followUpThread?.number) {
                                followUpComposerThread(followUpThread, 40);
                            }
                        });
                    return;
                }
                if (followUpThread?.number) {
                    followUpComposerThread(followUpThread, data.queued ? 40 : 80);
                }
            })
            .catch(function (error) {
                showToast(`Error sending SMS: ${error.message || 'Please try again.'}`, 'danger');
            })
            .finally(function () {
                if (cancelFeedback) cancelFeedback();
                if (spinner) spinner.classList.add('d-none');
                if (button) button.disabled = false;
            });
    }

    // Handle send SMS
    function handleSendSms(e) {
        e.preventDefault();

        const phoneValidation = validatePhoneField('modalTo', { allowShortCode: true });
        const recipients = Array.isArray(phoneValidation.values) ? phoneValidation.values : [phoneValidation.value].filter(Boolean);
        const to = recipients[0] || '';
        const message = document.getElementById('modalMessage')?.value.trim();
        const messageAnalysis = analyzeSmsComposeText(message);
        const button = this;
        const activeDeviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';

        // Validate
        if (!message) {
            showToast('Please fill in all fields', 'warning');
            return;
        }

        if (!phoneValidation.ok) {
            showToast(phoneValidation.message, 'warning');
            return;
        }

        if (!activeDeviceId) {
            showToast('Select a device first.', 'warning');
            return;
        }
        if (!messageAnalysis.valid) {
            showToast(window.smsComposeLimits?.formatError?.(messageAnalysis) || 'SMS message exceeds the device limit.', 'warning');
            return;
        }

        const spinner = button.querySelector('.spinner-border');
        if (spinner) spinner.classList.remove('d-none');
        button.disabled = true;
        const cancelFeedback = typeof mqttWaitFeedback === 'function' ? mqttWaitFeedback(button) : null;

        // Send request
        const request = (window.__rawFetch || window.fetch).bind(window);
        const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
        const headers = {
            'Content-Type': 'application/json'
        };
        if (csrfToken) {
            headers['X-CSRF-Token'] = csrfToken;
        }

        request(buildSmsRequestUrl('/api/sms/send'), {
            method: 'POST',
            headers,
            body: JSON.stringify({ to, recipients, message, deviceId: activeDeviceId })
        })
            .then(async response => {
                let payload = null;
                const contentType = response.headers.get('content-type') || '';

                if (contentType.includes('application/json')) {
                    payload = await response.json();
                } else {
                    const text = await response.text();
                    payload = text ? { message: text } : null;
                }

                if (!response.ok) {
                    const error = new Error(
                        payload?.message
                        || payload?.error
                        || `Request failed with HTTP ${response.status}`
                    );
                    error.status = response.status;
                    error.payload = payload;
                    throw error;
                }
                return payload || {};
            })
            .then(data => {
                if (data.success) {
                    // Close modal
                    const modal = bootstrap.Modal.getInstance(document.getElementById('composeSmsModal'));
                    if (modal) modal.hide();

                    showToast(
                        Number(data.count || recipients.length || 1) > 1
                            ? `${Number(data.count || recipients.length || 1)} SMS queued for delivery.`
                            : (data.queued ? 'SMS queued for delivery.' : 'SMS sent successfully.'),
                        'success'
                    );

                    const queuedCount = Number(data.count || recipients.length || 1);
                    const followUpThread = queuedCount === 1
                        ? buildComposerFollowUpThread(to, { conversationId: data?.conversationId })
                        : null;
                    setTimeout(() => {
                        refreshSmsPageData();
                        if (followUpThread?.number) {
                            setPhoneFieldValue('smsChatTo', to);
                            followUpComposerThread(followUpThread, data.queued ? 20 : 60);
                        } else {
                            setPhoneFieldValue('smsChatTo', '');
                        }
                    }, data.queued ? 80 : 120);
                } else {
                    showToast('Failed to send SMS: ' + (data.message || 'Unknown error'), 'danger');
                }
            })
            .catch(error => {
                console.error('Error sending SMS:', error);
                showToast(`Error sending SMS: ${error.message || 'Please try again.'}`, 'danger');
            })
            .finally(() => {
                if (cancelFeedback) cancelFeedback();
                if (spinner) spinner.classList.add('d-none');
                button.disabled = false;
            });
    }

    // Mark all as read
    async function markAllAsRead() {
        let approved = false;
        if (typeof window.appConfirm === 'function') {
            approved = await window.appConfirm({
                title: 'Mark All as Read',
                message: 'Mark all unread inbox messages as read?',
                confirmText: 'Mark Read',
                confirmClass: 'btn btn-primary'
            });
        } else {
            approved = confirm('Mark all unread inbox messages as read?');
        }
        if (!approved) return;

        fetchSmsJson('/api/sms/mark-all-read', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        })
            .then(data => {
                if (data.success) {
                    showToast(
                        data.marked > 0
                            ? `Marked ${data.marked} messages as read`
                            : 'No unread messages',
                        data.marked > 0 ? 'success' : 'info'
                    );
                    refreshSmsPageData();
                }
            })
            .catch(error => {
                console.error(error);
                showToast('Failed to mark messages as read', 'danger');
            });
    }

    // Select contact and close contacts modal
    function selectContact(phone, name) {
        const targetFieldId = document.getElementById(contactTargetFieldId) ? contactTargetFieldId : 'smsChatTo';
        const composeTarget = targetFieldId === 'modalTo';
        appendRecipientValue(targetFieldId, phone);
        const messageEl = document.getElementById('smsChatMessage');
        if (messageEl && !composeTarget && splitRecipientEntries(document.getElementById('smsChatTo')?.value || '').length === 1) {
            threadState.number = phone;
            threadState.conversationId = null;
            threadState.title = phone;
            updateThreadActionButtons(phone);
            loadSmsThread(phone, { showModal: false, silent: true });
            setTimeout(() => messageEl.focus(), 180);
        }

        // Close contacts modal
        const contactsModal = bootstrap.Modal.getInstance(document.getElementById('contactsModal'));
        if (contactsModal) contactsModal.hide();

        showToast(`Added: ${name}`, 'success');
    }

    // Show add contact modal
    function showAddContactModal() {
        // Close contacts modal if open
        const contactsModal = bootstrap.Modal.getInstance(document.getElementById('contactsModal'));
        if (contactsModal) contactsModal.hide();

        document.getElementById('contactModalTitle').textContent = 'Add New Contact';
        document.getElementById('contactForm').reset();
        document.getElementById('contactId').value = '';
        document.getElementById('deleteContactBtn').classList.add('d-none');
        
        const modal = new bootstrap.Modal(document.getElementById('addContactModal'));
        modal.show();
    }

    // Save contact
    function saveContact() {
        const id = document.getElementById('contactId').value;
        const name = document.getElementById('contactName').value.trim();
        const phoneValidation = validatePhoneField('contactPhone', { allowShortCode: true });
        const phone = phoneValidation.value;
        const email = document.getElementById('contactEmail').value.trim();
        const company = document.getElementById('contactCompany').value.trim();
        const favorite = document.getElementById('contactFavorite').checked;
        const notes = document.getElementById('contactNotes').value.trim();
        
        // Validate required fields
        if (!name) {
            showToast('Name is required', 'warning');
            document.getElementById('contactName').classList.add('is-invalid');
            return;
        }
        
        if (!phone) {
            showToast(phoneValidation.message || 'Phone number is required', 'warning');
            document.getElementById('contactPhone').classList.add('is-invalid');
            return;
        }
        
        // Remove invalid class
        document.getElementById('contactName').classList.remove('is-invalid');
        document.getElementById('contactPhone').classList.remove('is-invalid');
        
        const data = {
            name: name,
            phone_number: phone,
            email: email || null,
            company: company || null,
            favorite: favorite,
            notes: notes || null
        };
        
        const saveBtn = document.getElementById('saveContactBtn');
        const originalText = saveBtn.innerHTML;
        saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status"></span> Saving...';
        saveBtn.disabled = true;
        
        const url = id ? `/api/contacts/${id}` : '/api/contacts';
        const method = id ? 'PUT' : 'POST';
        
        fetch(url, {
            method: method,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        })
        .then(async response => {
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.message || 'Server error');
            }
            return data;
        })
        .then(data => {
            if (data.success) {
                // Close modal
                const modal = bootstrap.Modal.getInstance(document.getElementById('addContactModal'));
                if (modal) modal.hide();
                
                showToast(id ? 'Contact updated successfully!' : 'Contact created successfully!', 'success');
                
                // Reload contacts for the contacts modal
                loadContacts();
            } else {
                showToast(data.message || 'Failed to save contact', 'danger');
            }
        })
        .catch(error => {
            console.error('Error saving contact:', error);
            showToast('Error saving contact: ' + error.message, 'danger');
        })
        .finally(() => {
            saveBtn.innerHTML = originalText;
            saveBtn.disabled = false;
        });
    }

    // Delete contact
    async function deleteContact(id) {
        if (!id) {
            id = document.getElementById('contactId').value;
        }
        
        if (!id) return;
        
        let approved = false;
        if (typeof window.appConfirm === 'function') {
            approved = await window.appConfirm({
                title: 'Delete Contact',
                message: 'Are you sure you want to delete this contact?',
                confirmText: 'Delete',
                confirmClass: 'btn btn-danger'
            });
        } else {
            approved = confirm('Are you sure you want to delete this contact?');
        }
        if (!approved) return;
        
        fetch(`/api/contacts/${id}`, {
            method: 'DELETE'
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                // Close modal
                const modal = bootstrap.Modal.getInstance(document.getElementById('addContactModal'));
                if (modal) modal.hide();
                
                showToast('Contact deleted successfully', 'success');
                
                // Reload contacts
                loadContacts();
            } else {
                showToast(data.message || 'Failed to delete contact', 'danger');
            }
        })
        .catch(error => {
            console.error('Error deleting contact:', error);
            showToast('Error deleting contact', 'danger');
        });
    }

    // Edit contact (called from contacts modal)
    function editContact(id) {
        fetch('/api/contacts/' + id)
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    const contact = data.data;
                    
                    // Close contacts modal
                    const contactsModal = bootstrap.Modal.getInstance(document.getElementById('contactsModal'));
                    if (contactsModal) contactsModal.hide();
                    
                    // Populate form
                    document.getElementById('contactId').value = contact.id;
                    document.getElementById('contactName').value = contact.name;
                    setPhoneFieldValue('contactPhone', contact.phone_number);
                    document.getElementById('contactEmail').value = contact.email || '';
                    document.getElementById('contactCompany').value = contact.company || '';
                    document.getElementById('contactFavorite').checked = contact.favorite === 1;
                    document.getElementById('contactNotes').value = contact.notes || '';

                    document.getElementById('contactModalTitle').textContent = 'Edit Contact';
                    document.getElementById('deleteContactBtn').classList.remove('d-none');

                    // Show add/edit modal
                    const modal = new bootstrap.Modal(document.getElementById('addContactModal'));
                    modal.show();
                }
            })
            .catch(console.error);
    }

    // Show toast notification
    function showToast(message, type = 'info') {
        if (typeof window.showToast === 'function') {
            window.showToast(message, type);
        } else {
            // Fallback toast
            const toast = document.getElementById('liveToast');
            if (toast) {
                const toastInstance = new bootstrap.Toast(toast);
                document.getElementById('toastMessage').textContent = message;

                // Set icon based on type
                const icon = toast.querySelector('.toast-header i');
                if (icon) {
                    icon.className = type === 'success' ? 'bi-check-circle-fill text-success' :
                        type === 'danger' ? 'bi-exclamation-circle-fill text-danger' :
                            type === 'warning' ? 'bi-exclamation-triangle-fill text-warning' :
                                'bi-info-circle-fill text-info';
                }

                toastInstance.show();
            } else {
                alert(message);
            }
        }
    }

    function renderLocalUnreadBadge(count) {
        const badge = document.getElementById('unreadSmsBadge');
        const inboxBadge = document.getElementById('inboxUnreadBadge');

        if (count > 0) {
            if (badge) {
                badge.textContent = count;
                badge.style.display = 'inline';
            }
            if (inboxBadge) {
                inboxBadge.textContent = count;
                inboxBadge.classList.remove('d-none');
            }
        } else {
            if (badge) badge.style.display = 'none';
            if (inboxBadge) inboxBadge.classList.add('d-none');
        }
    }

    // Update unread badge
    function updateUnreadBadge(unreadCount) {
        if (typeof window.updateUnreadBadge === 'function' && window.updateUnreadBadge !== updateUnreadBadge) {
            window.updateUnreadBadge(unreadCount);
        } else if (unreadCount !== undefined && unreadCount !== null) {
            renderLocalUnreadBadge(Number(unreadCount) || 0);
        } else {
            fetchSmsJson('/api/sms/unread')
                .then(data => {
                    renderLocalUnreadBadge(Number(data?.count) || 0);
                })
                .catch(console.error);
        }
    }

    // Expose functions globally
    window.deleteSms = deleteSms;
    window.markAsRead = markAsRead;
    window.markAllAsRead = markAllAsRead;
    window.selectContact = selectContact;
    window.showAddContactModal = showAddContactModal;
    window.editContact = editContact;
    window.saveContact = saveContact;
    window.deleteContact = deleteContact;
    window.openContactsModal = openContactsModal; // Make sure this is exposed
    window.pullDeviceMessages = pullDeviceMessages;

    // ---- IndexedDB: seed from server-rendered DOM ----
    // Runs once after the page renders. Picks up all visible SMS rows and stores
    // them in IDB so the next visit can do a delta sync.
    (function seedIdb() {
        const db = window.localDb;
        if (!db) return;
        const rows = document.querySelectorAll('[data-sms-id]');
        if (!rows.length) return;
        const activeDeviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';
        const records = Array.from(rows).map(function (el) {
            return {
                server_id: Number(el.dataset.smsId),
                device_id: activeDeviceId || null,
                from_number: el.dataset.from || null,
                to_number: el.dataset.to || null,
                message: el.dataset.message || null,
                type: el.dataset.type || 'incoming',
                read: el.dataset.read === '1' ? 1 : 0,
                timestamp: el.dataset.timestamp || new Date().toISOString()
            };
        });
        // bulkAdd with ignoreErrors skips rows that already exist (by auto-id key collision
        // is unlikely, but we guard on server_id separately in common.js socket handler)
        db.sms.bulkAdd(records).catch(function () {});
    })();
    // ---- IndexedDB: intercept offline SMS send → queue in outbox ----
    // Patch the existing send form submission to use the outbox when offline.
    (function patchOfflineSend() {
        const form = document.getElementById('composeSmsForm') || document.querySelector('form[id*="sms"]');
        if (!form) return;
        form.addEventListener('submit', function (e) {
            if (navigator.onLine) return; // normal path handles it
            e.preventDefault();
            const to = (document.getElementById('smsChatTo') || document.getElementById('modalTo') || {}).value || '';
            const message = (document.getElementById('smsChatMessage') || document.getElementById('modalMessage') || {}).value || '';
            if (!to || !message) return;
            if (typeof window.queueOutboxSms === 'function') {
                window.queueOutboxSms({
                    to,
                    message,
                    deviceId: window.getActiveDeviceId ? window.getActiveDeviceId() : ''
                }).then(function () {
                    if (typeof window.showToast === 'function') {
                        window.showToast('No connection — SMS queued. Will send on reconnect.', 'warning');
                    }
                });
            }
        }, true); // capture phase so it fires before the existing submit handler
    })();
    /*
    // ── Infinite scroll (virtual windowing) ──────────────────────────────────
    // Loads additional pages from /api/sms as the user scrolls to the bottom.
    // Keeps at most DOM_WINDOW rows per tab to avoid unbounded DOM growth.
        function loadMore(tab) {
            const s = state[tab.containerId];
            if (s.loading || s.exhausted) return;
            s.loading = true;

            const sentinel = document.getElementById(tab.sentinelId);
            if (sentinel) sentinel.classList.remove('d-none');

            const nextPage = s.page + 1;
            const url = `/api/sms?page=${nextPage}&limit=${PAGE_SIZE}${tab.type ? '&type=' + tab.type : ''}`;

            fetchSmsJson(url)
                .then(function (data) {
                    if (!data.success || !data.data || data.data.length === 0) {
                        s.exhausted = true;
                        if (sentinel) sentinel.classList.add('d-none');
                        return;
                    }

                    const container = document.getElementById(tab.containerId);
                    if (!container) return;

                    // Remove empty-state placeholder if present
                    const emptyEl = container.querySelector('.text-center.py-5');
                    if (emptyEl) emptyEl.remove();

                    // Build and insert rows
                    const existing = new Set(
                        Array.from(container.querySelectorAll('[data-sms-id]')).map(function (el) { return el.dataset.smsId; })
                    );
                    const frag = document.createDocumentFragment();
                    const tmp = document.createElement('div');
                    data.data.forEach(function (sms) {
                        if (existing.has(String(sms.id))) return;
                        tmp.innerHTML = tab.type === 'incoming' ? renderInboxRow(sms)
                                      : tab.type === 'outgoing' ? renderSentRow(sms)
                                      : renderAllRow(sms);
                        frag.appendChild(tmp.firstElementChild);
                    });
                    container.appendChild(frag);

                    // DOM windowing: prune oldest rows when over limit
                    const rows = container.querySelectorAll('.message-item');
                    if (rows.length > DOM_WINDOW) {
                        const excess = rows.length - DOM_WINDOW;
                        for (let i = 0; i < excess; i++) rows[i].remove();
                    }

                    s.page = nextPage;
                    if (nextPage >= data.pagination.pages) s.exhausted = true;
                    if (sentinel) sentinel.classList.add('d-none');
                })
                .catch(function () {
                    if (sentinel) sentinel.classList.add('d-none');
                })
                .finally(function () {
                    s.loading = false;
                });
        }

        // One IntersectionObserver per sentinel — fires when sentinel enters viewport
        if (typeof IntersectionObserver === 'undefined') return;

        tabs.forEach(function (tab) {
            // Skip if all items already loaded on first page render
            if (initTotal <= PAGE_SIZE) {
                state[tab.containerId].exhausted = true;
                return;
            }

            const sentinel = document.getElementById(tab.sentinelId);
            if (!sentinel) return;

            // Move sentinel inside the tab pane so it is in the scrollable area
            const pane = document.getElementById(
                tab.containerId === 'inboxMessages' ? 'inbox' :
                tab.containerId === 'sentMessages'  ? 'sent'  : 'all'
            );
            if (pane) pane.appendChild(sentinel);

            const io = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (entry.isIntersecting) loadMore(tab);
                });
            }, { rootMargin: '200px' });

            io.observe(sentinel);
        });

        // Also wire event delegation for dynamically added rows (delete / mark-read / quick actions)
        ['inboxMessages', 'sentMessages', 'allMessages'].forEach(function (cid) {
            const container = document.getElementById(cid);
            if (!container) return;
            container.addEventListener('click', function (e) {
                const del = e.target.closest('.delete-sms-btn');
                if (del) {
                    const item = del.closest('[data-sms-id]');
                    if (item) handleDeleteDelegated(item);
                }
                const markRead = e.target.closest('.mark-read-btn');
                if (markRead) {
                    const item = markRead.closest('[data-sms-id]');
                    if (item) markAsRead(item.dataset.smsId, item, markRead);
                }
            });
        });

        async function handleDeleteDelegated(smsItem) {
            let approved = false;
            if (typeof window.appConfirm === 'function') {
                approved = await window.appConfirm({ title: 'Delete Message', message: 'Delete this message?', confirmText: 'Delete', confirmClass: 'btn btn-danger' });
            } else {
                approved = confirm('Delete this message?');
            }
            if (approved) deleteSms(smsItem.dataset.smsId, smsItem);
        }
    })();
    */
})();
