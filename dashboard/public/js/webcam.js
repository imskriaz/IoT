(function () {
    'use strict';

    const state = {
        deviceId: window.getActiveDeviceId ? window.getActiveDeviceId() : '',
        status: null,
        captures: [],
        summary: null,
        selectedCapture: null
    };

    const elements = {
        refreshBtn: document.getElementById('refreshCameraBtn'),
        requestCaptureBtn: document.getElementById('requestCaptureBtn'),
        exportCapturesBtn: document.getElementById('exportCapturesBtn'),
        supportNotice: document.getElementById('cameraSupportNotice'),
        deferredNotice: document.getElementById('cameraDeferredNotice'),
        summaryTotal: document.getElementById('summaryTotal'),
        summaryMotion: document.getElementById('summaryMotion'),
        summaryFaces: document.getElementById('summaryFaces'),
        summaryRecognized: document.getElementById('summaryRecognized'),
        summaryLastCapture: document.getElementById('summaryLastCapture'),
        summaryLastMeta: document.getElementById('summaryLastMeta'),
        deviceStatus: document.getElementById('cameraDeviceStatus'),
        moduleHealth: document.getElementById('cameraModuleHealth'),
        capabilityBadges: document.getElementById('cameraCapabilityBadges'),
        settingsForm: document.getElementById('cameraSettingsForm'),
        saveSettingsBtn: document.getElementById('saveCameraSettingsBtn'),
        resolution: document.getElementById('cameraResolution'),
        fps: document.getElementById('cameraFps'),
        quality: document.getElementById('cameraQuality'),
        retentionDays: document.getElementById('cameraRetentionDays'),
        privacyMode: document.getElementById('cameraPrivacyMode'),
        enabled: document.getElementById('cameraEnabled'),
        motionDetection: document.getElementById('cameraMotionDetection'),
        faceDetection: document.getElementById('cameraFaceDetection'),
        recognitionEnabled: document.getElementById('cameraRecognitionEnabled'),
        settingsHint: document.getElementById('cameraSettingsHint'),
        filterFaces: document.getElementById('filterFaces'),
        filterRecognized: document.getElementById('filterRecognized'),
        filterMotion: document.getElementById('filterMotion'),
        gallery: document.getElementById('cameraGallery'),
        modal: document.getElementById('cameraCaptureModal'),
        modalMeta: document.getElementById('cameraModalMeta'),
        modalImage: document.getElementById('cameraModalImage'),
        modalDetails: document.getElementById('cameraModalDetails'),
        modalDownload: document.getElementById('cameraModalDownload'),
        modalDelete: document.getElementById('cameraModalDelete')
    };

    const socket = window.socket || null;

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatDate(value) {
        if (!value) return 'Unknown time';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    function badgeClassForState(state) {
        switch (state) {
            case 'ok': return 'success';
            case 'warning': return 'warning';
            case 'error': return 'danger';
            case 'unsupported': return 'secondary';
            default: return 'secondary';
        }
    }

    function formatSupportNotice(status) {
        const caps = status?.caps || {};
        if (!caps.camera) {
            return 'This device has not reported integrated camera support yet. The page stays available for review and staged configuration.';
        }
        if (!status.online) {
            return 'Camera support is present, but the device is offline. Settings can still be saved for the next reconnect.';
        }
        return '';
    }

    function updateDeferredControls(status) {
        const integratedCamera = Boolean(status?.caps?.camera);
        const online = Boolean(status?.online);
        const liveReady = integratedCamera && online;

        if (elements.deferredNotice) {
            elements.deferredNotice.classList.toggle('d-none', integratedCamera);
        }

        if (elements.requestCaptureBtn) {
            elements.requestCaptureBtn.disabled = !liveReady;
            elements.requestCaptureBtn.title = liveReady
                ? ''
                : 'Live capture will be available after the integrated camera firmware path is enabled on the device.';
        }

        if (elements.saveSettingsBtn) {
            elements.saveSettingsBtn.disabled = !integratedCamera;
            elements.saveSettingsBtn.title = integratedCamera
                ? ''
                : 'Camera settings stay deferred until integrated camera support is reported by the active firmware.';
        }

        [
            elements.enabled,
            elements.motionDetection,
            elements.faceDetection,
            elements.recognitionEnabled,
            elements.resolution,
            elements.fps,
            elements.quality,
            elements.retentionDays,
            elements.privacyMode
        ].forEach((field) => {
            if (!field) return;
            field.disabled = !integratedCamera;
        });
    }

    function buildCaptureQuery() {
        const params = new URLSearchParams({ deviceId: state.deviceId, limit: '60' });
        if (elements.filterFaces?.checked) params.set('faceDetected', 'true');
        if (elements.filterRecognized?.checked) params.set('recognized', 'known');
        if (elements.filterMotion?.checked) params.set('motionDetected', 'true');
        return params.toString();
    }

    function appendFreshTimestamp(url) {
        const separator = url.includes('?') ? '&' : '?';
        return `${url}${separator}_ts=${Date.now()}`;
    }

    async function fetchJson(url, options) {
        const requestOptions = { ...(options || {}) };
        const method = String(requestOptions.method || 'GET').toUpperCase();
        const headers = new Headers(requestOptions.headers || {});

        if (method === 'GET' || method === 'HEAD') {
            headers.set('Cache-Control', 'no-cache');
            headers.set('Pragma', 'no-cache');
            requestOptions.cache = 'no-store';
            url = appendFreshTimestamp(url);
        }

        requestOptions.credentials = requestOptions.credentials || 'same-origin';
        requestOptions.headers = headers;

        const response = await fetch(url, requestOptions);
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.message || 'Request failed');
        }
        return data;
    }

    function renderCapabilityBadges(caps) {
        if (!elements.capabilityBadges) return;
        const entries = Object.entries(caps || {})
            .filter(([key, value]) => key !== 'specs' && key !== 'raw' && value === true)
            .sort(([a], [b]) => a.localeCompare(b));

        elements.capabilityBadges.innerHTML = entries.length
            ? entries.map(([key]) => `<span class="badge bg-primary-subtle text-primary-emphasis border">${escapeHtml(key)}</span>`).join(' ')
            : '<span class="text-muted small">No capability report yet.</span>';
    }

    function renderModuleHealth(entries) {
        if (!elements.moduleHealth) return;
        if (!Array.isArray(entries) || !entries.length) {
            elements.moduleHealth.innerHTML = '<span class="text-muted small">Waiting for module diagnostics...</span>';
            return;
        }

        const focus = entries.filter((entry) => ['camera', 'audio', 'mqtt', 'modem'].includes(entry.moduleKey));
        elements.moduleHealth.innerHTML = focus.map((entry) => `
            <span class="badge bg-${badgeClassForState(entry.state)}" title="${escapeHtml(entry.message || '')}">
                ${escapeHtml(entry.label || entry.moduleKey)}: ${escapeHtml(entry.state === 'unsupported' ? 'pending' : (entry.state || 'unknown'))}
            </span>
        `).join(' ');
    }

    function renderStatus(status) {
        state.status = status;

        if (elements.deviceStatus) {
            const online = Boolean(status?.online);
            elements.deviceStatus.className = `badge bg-${online ? 'success' : 'secondary'}`;
            elements.deviceStatus.textContent = online ? 'Online' : 'Offline';
        }

        renderModuleHealth(status?.moduleHealth || []);
        renderCapabilityBadges(status?.caps || {});

        const notice = formatSupportNotice(status);
        if (elements.supportNotice) {
            if (notice) {
                elements.supportNotice.classList.remove('d-none');
                elements.supportNotice.textContent = notice;
            } else {
                elements.supportNotice.classList.add('d-none');
                elements.supportNotice.textContent = '';
            }
        }

        const webcam = status?.webcam || {};
        if (elements.resolution) elements.resolution.value = webcam.resolution || '640x480';
        if (elements.fps) elements.fps.value = webcam.fps ?? 15;
        if (elements.quality) elements.quality.value = webcam.quality ?? 80;
        if (elements.retentionDays) elements.retentionDays.value = webcam.retentionDays ?? 30;
        if (elements.privacyMode) elements.privacyMode.value = webcam.privacyMode || 'events-only';
        if (elements.enabled) elements.enabled.checked = webcam.enabled !== false;
        if (elements.motionDetection) elements.motionDetection.checked = Boolean(webcam.motionDetection);
        if (elements.faceDetection) elements.faceDetection.checked = Boolean(webcam.faceDetection);
        if (elements.recognitionEnabled) elements.recognitionEnabled.checked = Boolean(webcam.recognitionEnabled);
        if (elements.settingsHint) {
            elements.settingsHint.textContent = status?.caps?.camera
                ? (webcam.recognitionEnabled
                    ? 'Face recognition is enabled in dashboard settings. Live recognition still depends on firmware support and model deployment on the device.'
                    : 'Recognition preferences are stored now; live recognition still depends on device-side firmware support.')
                : 'Integrated camera firmware is not active yet, so camera settings are shown in deferred mode.';
        }

        if (elements.exportCapturesBtn) {
            elements.exportCapturesBtn.href = `/api/intercom/captures/export?deviceId=${encodeURIComponent(state.deviceId)}`;
        }

        updateDeferredControls(status);
    }

    function renderSummary() {
        const summary = state.summary || { total: 0, motionDetected: 0, faceDetected: 0, recognized: 0 };
        const latest = state.captures[0] || null;

        if (elements.summaryTotal) elements.summaryTotal.textContent = String(summary.total || 0);
        if (elements.summaryMotion) elements.summaryMotion.textContent = String(summary.motionDetected || 0);
        if (elements.summaryFaces) elements.summaryFaces.textContent = String(summary.faceDetected || 0);
        if (elements.summaryRecognized) elements.summaryRecognized.textContent = String(summary.recognized || 0);
        if (elements.summaryLastCapture) elements.summaryLastCapture.textContent = latest ? formatDate(latest.timestamp) : 'No captures yet';
        if (elements.summaryLastMeta) {
            elements.summaryLastMeta.textContent = latest
                ? `${latest.captureType || 'event'} • ${latest.faceDetected ? `faces ${latest.faceCount || 0}` : 'no faces'}${latest.recognizedLabel ? ` • ${latest.recognizedLabel}` : ''}`
                : 'Waiting for first camera frame.';
        }
    }

    function renderGallery() {
        if (!elements.gallery) return;
        if (!state.captures.length) {
            elements.gallery.innerHTML = '<div class="col-12 text-center py-4 text-muted">No captures match the current filters.</div>';
            return;
        }

        elements.gallery.innerHTML = state.captures.map((capture) => `
            <div class="col-sm-6 col-xl-4">
                <div class="card camera-card h-100" onclick="openCameraCaptureModal(${capture.id})">
                    <img src="${escapeHtml(capture.url)}" alt="Capture ${capture.id}" class="camera-thumb rounded-top">
                    <div class="card-body">
                        <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
                            <div class="fw-semibold small">${escapeHtml(capture.captureType || 'event')}</div>
                            <span class="badge bg-${capture.faceDetected ? 'primary' : 'secondary'}">${capture.faceDetected ? `${capture.faceCount || 0} face` : 'no face'}</span>
                        </div>
                        <div class="camera-badge-row d-flex flex-wrap gap-1 mb-2">
                            ${capture.motionDetected ? '<span class="badge bg-warning text-dark">motion</span>' : ''}
                            ${capture.faceDetected ? '<span class="badge bg-info text-dark">face</span>' : ''}
                            ${capture.recognizedLabel ? `<span class="badge bg-success">${escapeHtml(capture.recognizedLabel)}</span>` : ''}
                            <span class="badge bg-light text-dark border">${escapeHtml(capture.source || 'mqtt')}</span>
                        </div>
                        <div class="small text-muted">${escapeHtml(formatDate(capture.timestamp))}</div>
                    </div>
                </div>
            </div>
        `).join('');
    }

    async function loadStatus() {
        const data = await fetchJson(`/api/intercom/status?deviceId=${encodeURIComponent(state.deviceId)}`);
        renderStatus(data.data || {});
    }

    async function loadCaptures() {
        if (elements.gallery) {
            elements.gallery.innerHTML = '<div class="col-12 text-center py-4 text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Loading camera captures...</div>';
        }

        const data = await fetchJson(`/api/intercom/captures?${buildCaptureQuery()}`);
        state.captures = Array.isArray(data.data) ? data.data : [];
        state.summary = data.summary || null;
        renderSummary();
        renderGallery();
    }

    async function refreshAll() {
        try {
            await Promise.all([loadStatus(), loadCaptures()]);
        } catch (error) {
            window.showToast?.(error.message || 'Failed to refresh camera page', 'danger');
        }
    }

    async function saveSettings(event) {
        event?.preventDefault();

        const payload = {
            deviceId: state.deviceId,
            enabled: Boolean(elements.enabled?.checked),
            resolution: elements.resolution?.value || '640x480',
            fps: Number(elements.fps?.value || 15),
            quality: Number(elements.quality?.value || 80),
            retentionDays: Number(elements.retentionDays?.value || 30),
            privacyMode: elements.privacyMode?.value || 'events-only',
            motionDetection: Boolean(elements.motionDetection?.checked),
            faceDetection: Boolean(elements.faceDetection?.checked),
            recognitionEnabled: Boolean(elements.recognitionEnabled?.checked)
        };

        try {
            const data = await fetchJson('/api/intercom/webcam/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            window.showToast?.(data.message || 'Camera settings saved', 'success');
            await loadStatus();
        } catch (error) {
            window.showToast?.(error.message || 'Failed to save camera settings', 'danger');
        }
    }

    async function requestCapture() {
        if (elements.requestCaptureBtn) {
            elements.requestCaptureBtn.disabled = true;
        }

        try {
            const data = await fetchJson('/api/intercom/webcam/capture', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceId: state.deviceId })
            });
            if (data.queued) {
                window.showToast?.(data.message || 'Capture requested', 'info');
            } else {
                window.showToast?.(data.message || 'Capture saved', 'success');
            }
            await loadCaptures();
        } catch (error) {
            window.showToast?.(error.message || 'Failed to request capture', 'danger');
        } finally {
            if (elements.requestCaptureBtn) {
                elements.requestCaptureBtn.disabled = !(state.status?.online && state.status?.caps?.camera);
            }
        }
    }

    function openModal(capture) {
        state.selectedCapture = capture;
        if (!capture || !elements.modal) return;

        if (elements.modalMeta) {
            elements.modalMeta.textContent = `${formatDate(capture.timestamp)} • ${capture.captureType || 'event'} • ${capture.source || 'mqtt'}`;
        }
        if (elements.modalImage) {
            elements.modalImage.src = capture.url;
            elements.modalImage.alt = capture.filename || `Capture ${capture.id}`;
        }
        if (elements.modalDetails) {
            elements.modalDetails.textContent = JSON.stringify(capture, null, 2);
        }
        if (elements.modalDownload) {
            elements.modalDownload.href = capture.url;
        }

        if (window.bootstrap) {
            window.bootstrap.Modal.getOrCreateInstance(elements.modal).show();
        }
    }

    async function deleteSelectedCapture() {
        const capture = state.selectedCapture;
        if (!capture) return;
        if (!window.confirm('Delete this capture?')) return;

        try {
            const data = await fetchJson(`/api/intercom/captures/${encodeURIComponent(capture.id)}?deviceId=${encodeURIComponent(state.deviceId)}`, {
                method: 'DELETE'
            });
            window.showToast?.(data.message || 'Capture deleted', 'success');
            if (window.bootstrap && elements.modal) {
                window.bootstrap.Modal.getOrCreateInstance(elements.modal).hide();
            }
            state.selectedCapture = null;
            await loadCaptures();
        } catch (error) {
            window.showToast?.(error.message || 'Failed to delete capture', 'danger');
        }
    }

    function attachEventListeners() {
        elements.refreshBtn?.addEventListener('click', refreshAll);
        elements.requestCaptureBtn?.addEventListener('click', requestCapture);
        elements.settingsForm?.addEventListener('submit', saveSettings);
        elements.filterFaces?.addEventListener('change', loadCaptures);
        elements.filterRecognized?.addEventListener('change', loadCaptures);
        elements.filterMotion?.addEventListener('change', loadCaptures);
        elements.modalDelete?.addEventListener('click', deleteSelectedCapture);
        window.addEventListener('device:changed', () => {
            state.deviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';
            refreshAll();
        });
    }

    function attachSocketListeners() {
        if (!socket) return;

        socket.off?.('webcam:capture');
        socket.on('webcam:capture', (payload) => {
            if (payload?.deviceId && payload.deviceId !== state.deviceId) return;
            loadCaptures().catch(() => {});
        });

        socket.off?.('device:capabilities');
        socket.on('device:capabilities', (payload) => {
            if (payload?.deviceId && payload.deviceId !== state.deviceId) return;
            loadStatus().catch(() => {});
        });

        socket.off?.('mqtt:status');
        socket.on('mqtt:status', () => {
            loadStatus().catch(() => {});
        });
    }

    window.openCameraCaptureModal = function (captureId) {
        const capture = state.captures.find((entry) => Number(entry.id) === Number(captureId));
        if (capture) openModal(capture);
    };

    window.refreshWebcamData = function () {
        return refreshAll();
    };

    attachEventListeners();
    attachSocketListeners();
    refreshAll();
})();
