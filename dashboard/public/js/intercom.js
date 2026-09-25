// Intercom JavaScript - P2P WebRTC Client
(function () {
    'use strict';

    console.log('Intercom.js loaded - ' + new Date().toISOString());

    // State
    let peerConnection = null;
    let localStream = null;
    let remoteStream = null;
    let dataChannel = null;
    let iceServers = [];
    let currentCallId = null;
    let callActive = false;
    let callType = null; // 'video' or 'audio'
    let deviceId = window.getActiveDeviceId ? window.getActiveDeviceId() : '';
    let settings = {};
    let webcamSettings = {};
    let capabilities = {};
    let moduleHealth = [];
    let isDeviceOnline = false;
    let supportState = { signaling: false, camera: false, audio: false, intercom: false };
    let browserPermissions = { checked: false, audio: false, video: false };
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;

    // DOM Elements
    const elements = {
        // Video elements
        localVideo: document.getElementById('localVideo'),
        remoteVideo: document.getElementById('remoteVideo'),
        remoteAudio: document.getElementById('remoteAudio'),
        
        // Buttons
        startVideoCall: document.getElementById('startVideoCall'),
        startAudioCall: document.getElementById('startAudioCall'),
        endCall: document.getElementById('endCall'),
        muteMic: document.getElementById('muteMic'),
        muteSpeaker: document.getElementById('muteSpeaker'),
        snapshot: document.getElementById('snapshot'),
        fullscreen: document.getElementById('fullscreen'),
        
        // Settings
        videoEnabled: document.getElementById('videoEnabled'),
        videoResolution: document.getElementById('videoResolution'),
        videoFps: document.getElementById('videoFps'),
        videoQuality: document.getElementById('videoQuality'),
        audioEnabled: document.getElementById('audioEnabled'),
        audioBitrate: document.getElementById('audioBitrate'),
        echoCancellation: document.getElementById('echoCancellation'),
        noiseSuppression: document.getElementById('noiseSuppression'),
        autoGainControl: document.getElementById('autoGainControl'),
        micSensitivity: document.getElementById('micSensitivity'),
        speakerVolume: document.getElementById('speakerVolume'),
        stunServer: document.getElementById('stunServer'),
        turnServer: document.getElementById('turnServer'),
        turnUsername: document.getElementById('turnUsername'),
        turnPassword: document.getElementById('turnPassword'),
        motionDetection: document.getElementById('motionDetection'),
        faceDetection: document.getElementById('faceDetection'),
        recognitionEnabled: document.getElementById('recognitionEnabled'),
        retentionDays: document.getElementById('retentionDays'),
        privacyMode: document.getElementById('privacyMode'),
        
        // Status
        callStatus: document.getElementById('callStatus'),
        callTimer: document.getElementById('callTimer'),
        deviceStatus: document.getElementById('deviceStatus'),
        audioLevel: document.getElementById('audioLevel'),
        browserPermissionState: document.getElementById('browserPermissionState'),
        browserPermissionHint: document.getElementById('browserPermissionHint'),
        signalingState: document.getElementById('signalingState'),
        signalingHint: document.getElementById('signalingHint'),
        deviceCameraState: document.getElementById('deviceCameraState'),
        deviceCameraHint: document.getElementById('deviceCameraHint'),
        deviceAudioState: document.getElementById('deviceAudioState'),
        deviceAudioHint: document.getElementById('deviceAudioHint'),
        capabilityBanner: document.getElementById('intercomCapabilityBanner'),
        capabilityBannerText: document.getElementById('intercomCapabilityBannerText'),
        
        // Tabs
        videoTab: document.getElementById('video-tab'),
        audioTab: document.getElementById('audio-tab'),
        settingsTab: document.getElementById('settings-tab'),
        
        // History
        callHistory: document.getElementById('callHistory'),
        webcamCaptureGrid: document.getElementById('webcamCaptureGrid'),
        captureFaceFilter: document.getElementById('captureFaceFilter'),
        captureMotionFilter: document.getElementById('captureMotionFilter'),
        captureRecognitionFilter: document.getElementById('captureRecognitionFilter'),
        captureTotal: document.getElementById('captureTotal'),
        captureFaces: document.getElementById('captureFaces'),
        captureRecognized: document.getElementById('captureRecognized'),
        
        // Values display
        fpsValue: document.getElementById('fpsValue'),
        qualityValue: document.getElementById('qualityValue'),
        sensitivityValue: document.getElementById('sensitivityValue'),
        volumeValue: document.getElementById('volumeValue')
    };

    // Initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        console.log('Initializing Intercom page...');

        loadStatus();
        loadIceServers();
        loadCallHistory();
        loadWebcamCaptures();
        attachEventListeners();
        attachSocketListeners();
        requestMediaPermissions();
    }

    function appendFreshTimestamp(url) {
        const separator = url.includes('?') ? '&' : '?';
        return `${url}${separator}_ts=${Date.now()}`;
    }

    function fetchFreshJson(url, options) {
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

        return fetch(url, requestOptions).then((response) => response.json());
    }

    // ==================== DATA LOADING ====================

    function loadStatus() {
        fetchFreshJson(`/api/intercom/status?deviceId=${encodeURIComponent(deviceId)}`)
            .then(data => {
                if (data.success) {
                    settings = data.data.settings;
                    webcamSettings = data.data.webcam || {};
                    capabilities = data.data.caps || {};
                    moduleHealth = data.data.moduleHealth || [];
                    isDeviceOnline = data.data.online;
                    supportState = data.data.support || supportState;
                    
                    updateSettingsUI();
                    updateDeviceStatus();
                    updateSupportUI();
                    
                    if (data.data.state.inCall) {
                        callActive = true;
                        callType = data.data.state.callType;
                        updateCallStatus('In call', 'success');
                    }
                }
            })
            .catch(error => {
                console.error('Error loading status:', error);
                showToast('Failed to load intercom status', 'danger');
            });
    }

    function loadIceServers() {
        fetchFreshJson(`/api/intercom/ice-servers?deviceId=${encodeURIComponent(deviceId)}`)
            .then(data => {
                if (data.success) {
                    iceServers = data.data;
                }
            })
            .catch(console.error);
    }

    function loadCallHistory() {
        fetchFreshJson(`/api/intercom/history?deviceId=${encodeURIComponent(deviceId)}&limit=20`)
            .then(data => {
                if (data.success) {
                    displayCallHistory(data.data);
                }
            })
            .catch(console.error);
    }

    function buildCaptureQuery() {
        const params = new URLSearchParams({
            deviceId,
            limit: '100'
        });

        if (elements.captureFaceFilter?.value !== '') params.set('faceDetected', elements.captureFaceFilter.value);
        if (elements.captureMotionFilter?.value !== '') params.set('motionDetected', elements.captureMotionFilter.value);
        if (elements.captureRecognitionFilter?.value) params.set('recognized', elements.captureRecognitionFilter.value);

        return params.toString();
    }

    function loadWebcamCaptures() {
        if (!elements.webcamCaptureGrid) return;

        fetchFreshJson(`/api/intercom/captures?${buildCaptureQuery()}`)
            .then(data => {
                if (!data.success) {
                    throw new Error(data.message || 'Failed to load camera events');
                }
                renderCaptureSummary(data.summary || {});
                renderWebcamCaptures(data.data || []);
            })
            .catch(error => {
                console.error('Error loading webcam captures:', error);
                elements.webcamCaptureGrid.innerHTML = '<div class="col-12 text-center py-4 text-danger">Failed to load camera events</div>';
            });
    }

    function renderCaptureSummary(summary) {
        if (elements.captureTotal) elements.captureTotal.textContent = `${summary.total || 0} total`;
        if (elements.captureFaces) elements.captureFaces.textContent = `${summary.faceDetected || 0} faces`;
        if (elements.captureRecognized) elements.captureRecognized.textContent = `${summary.recognized || 0} recognized`;
    }

    function renderWebcamCaptures(captures) {
        if (!elements.webcamCaptureGrid) return;
        if (!captures.length) {
            elements.webcamCaptureGrid.innerHTML = '<div class="col-12 text-center py-4 text-muted">No camera events match the current filters.</div>';
            return;
        }

        elements.webcamCaptureGrid.innerHTML = captures.map(capture => {
            const ts = new Date(capture.timestamp).toLocaleString();
            const badges = [
                capture.motionDetected ? '<span class="badge bg-warning text-dark">motion</span>' : '',
                capture.faceDetected ? `<span class="badge bg-info text-dark">${capture.faceCount || 1} face</span>` : '',
                capture.recognizedLabel ? `<span class="badge bg-success">${escapeHtml(capture.recognizedLabel)}</span>` : ''
            ].filter(Boolean).join(' ');

            const deleteUrl = `/api/intercom/captures/${encodeURIComponent(capture.id)}?deviceId=${encodeURIComponent(deviceId)}`;
            return `
                <div class="col-6 col-md-4 col-lg-3">
                    <div class="card h-100">
                        <img src="${capture.url}" class="card-img-top" alt="Capture" style="height:150px;object-fit:cover;cursor:pointer;"
                             onclick="openCaptureModal('${escapeAttr(capture.url)}', '${escapeAttr(capture.filename)}', '${escapeAttr(ts)}', '${escapeAttr(deleteUrl)}')">
                        <div class="card-body p-2">
                            <div class="d-flex justify-content-between align-items-start gap-2">
                                <div>
                                    <div class="small fw-semibold text-truncate">${escapeHtml(capture.captureType || 'event')}</div>
                                    <div class="small text-muted">${escapeHtml(ts)}</div>
                                </div>
                                <button class="btn btn-sm btn-outline-danger" type="button" onclick="deleteCaptureEvent('${capture.id}')">
                                    <i class="bi bi-trash"></i>
                                </button>
                            </div>
                            <div class="mt-2 d-flex flex-wrap gap-1">${badges || '<span class="small text-muted">no event tags</span>'}</div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function updateSettingsUI() {
        // Video settings
        if (elements.videoEnabled) elements.videoEnabled.checked = settings.videoEnabled || false;
        if (elements.videoResolution) elements.videoResolution.value = settings.resolution || '640x480';
        if (elements.videoFps) {
            elements.videoFps.value = settings.fps || 15;
            if (elements.fpsValue) elements.fpsValue.textContent = settings.fps || 15;
        }
        if (elements.videoQuality) {
            elements.videoQuality.value = settings.quality || 80;
            if (elements.qualityValue) elements.qualityValue.textContent = (settings.quality || 80) + '%';
        }

        // Audio settings
        if (elements.audioEnabled) elements.audioEnabled.checked = settings.audioEnabled || false;
        if (elements.audioBitrate) elements.audioBitrate.value = settings.audioBitrate || 64000;
        if (elements.echoCancellation) elements.echoCancellation.checked = settings.echoCancellation !== false;
        if (elements.noiseSuppression) elements.noiseSuppression.checked = settings.noiseSuppression !== false;
        if (elements.autoGainControl) elements.autoGainControl.checked = settings.autoGainControl !== false;
        if (elements.micSensitivity) {
            elements.micSensitivity.value = settings.micSensitivity || 50;
            if (elements.sensitivityValue) elements.sensitivityValue.textContent = (settings.micSensitivity || 50) + '%';
        }
        if (elements.speakerVolume) {
            elements.speakerVolume.value = settings.speakerVolume || 80;
            if (elements.volumeValue) elements.volumeValue.textContent = (settings.speakerVolume || 80) + '%';
        }

        // STUN/TURN
        if (elements.stunServer) elements.stunServer.value = settings.stunServer || 'stun.l.google.com:19302';
        if (elements.turnServer) elements.turnServer.value = settings.turnServer || '';
        if (elements.turnUsername) elements.turnUsername.value = settings.turnUsername || '';
        if (elements.turnPassword) elements.turnPassword.value = settings.turnPassword || '';

        if (elements.motionDetection) elements.motionDetection.checked = webcamSettings.motionDetection || false;
        if (elements.faceDetection) elements.faceDetection.checked = webcamSettings.faceDetection || false;
        if (elements.recognitionEnabled) elements.recognitionEnabled.checked = webcamSettings.recognitionEnabled || false;
        if (elements.retentionDays) elements.retentionDays.value = webcamSettings.retentionDays || 30;
        if (elements.privacyMode) elements.privacyMode.value = webcamSettings.privacyMode || 'events-only';
    }

    function updateDeviceStatus() {
        if (elements.deviceStatus) {
            if (isDeviceOnline) {
                elements.deviceStatus.innerHTML = '<span class="badge bg-success"><i class="bi bi-check-circle"></i> Online</span>';
            } else {
                elements.deviceStatus.innerHTML = '<span class="badge bg-secondary"><i class="bi bi-power"></i> Offline</span>';
            }
        }
    }

    function setStateChip(labelEl, hintEl, label, tone, hint) {
        if (labelEl) {
            labelEl.className = `fw-semibold text-${tone}`;
            labelEl.textContent = label;
        }
        if (hintEl && hint) {
            hintEl.textContent = hint;
        }
    }

    function updateSupportUI() {
        const signalingReady = Boolean(window.socket?.connected) && Boolean(supportState.signaling);
        const cameraReady = Boolean(capabilities.camera);
        const audioReady = Boolean(capabilities.audio);

        if (!browserPermissions.checked) {
            setStateChip(elements.browserPermissionState, elements.browserPermissionHint, 'Checking...', 'secondary', 'Waiting for permission probe');
        } else if (browserPermissions.audio || browserPermissions.video) {
            const granted = [browserPermissions.video ? 'video' : null, browserPermissions.audio ? 'audio' : null].filter(Boolean).join(' + ');
            setStateChip(elements.browserPermissionState, elements.browserPermissionHint, 'Granted', 'success', granted ? `${granted} permission available` : 'Permission available');
        } else {
            setStateChip(elements.browserPermissionState, elements.browserPermissionHint, 'Blocked', 'danger', 'Browser denied camera and microphone access');
        }

        setStateChip(
            elements.signalingState,
            elements.signalingHint,
            signalingReady ? 'Ready' : 'Waiting',
            signalingReady ? 'success' : 'warning',
            signalingReady ? 'Socket.IO and MQTT bridge available' : 'Dashboard cannot signal the device yet'
        );
        setStateChip(
            elements.deviceCameraState,
            elements.deviceCameraHint,
            cameraReady ? 'Available' : 'Missing',
            cameraReady ? 'success' : 'warning',
            cameraReady ? 'Device firmware reports camera support' : 'Video path still missing on this device firmware'
        );
        setStateChip(
            elements.deviceAudioState,
            elements.deviceAudioHint,
            audioReady ? 'Available' : 'Missing',
            audioReady ? 'success' : 'warning',
            audioReady ? 'Device firmware reports audio support' : 'Audio path is not reported by active firmware'
        );

        if (elements.capabilityBanner && elements.capabilityBannerText) {
            const notes = [];
            if (!signalingReady) notes.push('dashboard signaling is not fully online');
            if (!cameraReady) notes.push('device camera support is pending');
            if (!audioReady) notes.push('device microphone support is pending');

            if (notes.length) {
                elements.capabilityBanner.classList.remove('d-none');
                elements.capabilityBannerText.textContent = `Intercom stays usable where possible, but ${notes.join(', ')}.`;
            } else {
                elements.capabilityBanner.classList.add('d-none');
            }
        }

        if (elements.startVideoCall) {
            elements.startVideoCall.disabled = !isDeviceOnline || !cameraReady;
        }
        if (elements.startAudioCall) {
            elements.startAudioCall.disabled = !isDeviceOnline || !audioReady;
        }
    }

    function displayCallHistory(history) {
        if (!elements.callHistory) return;

        if (!history || history.length === 0) {
            elements.callHistory.innerHTML = '<div class="text-center py-4 text-muted">No call history</div>';
            return;
        }

        let html = '';
        history.forEach(call => {
            const date = new Date(call.start_time).toLocaleString();
            const duration = formatDuration(call.duration);
            const type = call.type === 'video' ? '📹 Video' : '🎤 Audio';
            
            html += `
                <div class="list-group-item">
                    <div class="d-flex justify-content-between">
                        <span>${type}</span>
                        <small class="text-muted">${duration}</small>
                    </div>
                    <small class="text-muted">${date}</small>
                </div>
            `;
        });

        elements.callHistory.innerHTML = html;
    }

    // ==================== SNAPSHOT HISTORY ====================

    function loadSnapshots() {
        const grid = document.getElementById('snapshotGrid');
        const countBadge = document.getElementById('snapshotCount');
        if (!grid) return;

        fetchFreshJson(`/api/intercom/snapshots?deviceId=${encodeURIComponent(deviceId)}&limit=100`)
            .then(data => {
                if (!data.success) throw new Error(data.message);
                if (countBadge) countBadge.textContent = data.data.length;
                if (data.data.length === 0) {
                    grid.innerHTML = '<div class="col-12 text-center py-4 text-muted">No snapshots yet</div>';
                    return;
                }
                let html = '';
                data.data.forEach(snap => {
                    const ts = new Date(snap.timestamp).toLocaleString();
                    html += `
                        <div class="col-6 col-sm-4 col-md-3 col-lg-2">
                            <div class="card h-100 cursor-pointer" onclick="openCaptureModal('${escapeAttr(snap.url)}','${escapeAttr(snap.name)}','${escapeAttr(ts)}','/api/intercom/snapshots/${encodeURIComponent(snap.name)}?deviceId=${encodeURIComponent(deviceId)}')">
                                <img src="${snap.url}" class="card-img-top" style="height:90px;object-fit:cover;" alt="Snapshot" loading="lazy">
                                <div class="card-body p-1 text-center">
                                    <small class="text-muted d-block" style="font-size:0.65rem;">${ts}</small>
                                </div>
                            </div>
                        </div>`;
                });
                grid.innerHTML = html;
            })
            .catch(err => {
                console.error('Failed to load snapshots:', err);
                if (grid) grid.innerHTML = '<div class="col-12 text-center py-4 text-danger">Failed to load snapshots</div>';
            });
    }

    function escapeAttr(str) {
        return String(str).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
    }

    window.openCaptureModal = function (url, name, ts, deleteUrl) {
        const modal = document.getElementById('snapshotModal');
        if (!modal) return;
        document.getElementById('snapshotModalImg').src = url;
        document.getElementById('snapshotModalLabel').textContent = ts;
        const dlBtn = document.getElementById('snapshotModalDownload');
        dlBtn.href = url;
        dlBtn.download = name;
        const delBtn = document.getElementById('snapshotModalDelete');
        delBtn.onclick = function () {
            fetch(deleteUrl, { method: 'DELETE' })
                .then(r => r.json())
                .then(d => {
                    if (d.success) {
                        bootstrap.Modal.getInstance(modal)?.hide();
                        loadWebcamCaptures();
                        loadSnapshots();
                        if (typeof showToast === 'function') showToast('Snapshot deleted', 'success');
                    }
                })
                .catch(console.error);
        };
        new bootstrap.Modal(modal).show();
    };

    window.openSnapshot = function (url, name, ts) {
        window.openCaptureModal(url, name, ts, `/api/intercom/snapshots/${encodeURIComponent(name)}?deviceId=${encodeURIComponent(deviceId)}`);
    };

    window.deleteCaptureEvent = function (captureId) {
        fetch(`/api/intercom/captures/${encodeURIComponent(captureId)}?deviceId=${encodeURIComponent(deviceId)}`, {
            method: 'DELETE'
        })
            .then(r => r.json())
            .then(data => {
                if (!data.success) throw new Error(data.message || 'Delete failed');
                loadWebcamCaptures();
                if (typeof showToast === 'function') showToast('Camera event deleted', 'success');
            })
            .catch(error => {
                console.error('Delete capture failed:', error);
                if (typeof showToast === 'function') showToast('Failed to delete capture', 'danger');
            });
    };

    // ==================== MEDIA PERMISSIONS ====================

    async function requestMediaPermissions() {
        browserPermissions = { checked: true, audio: false, video: false };

        try {
            const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            audioStream.getTracks().forEach(track => track.stop());
            browserPermissions.audio = true;
        } catch (error) {
            console.warn('Audio permission denied:', error);
        }

        try {
            const videoStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
            videoStream.getTracks().forEach(track => track.stop());
            browserPermissions.video = true;
        } catch (error) {
            console.warn('Video permission denied:', error);
        }

        updateSupportUI();

        if (!browserPermissions.audio && !browserPermissions.video) {
            showToast('Please allow camera or microphone access for intercom use', 'warning');
        }
    }

    // ==================== WEBRTC ====================

    async function startCall(type) {
        if (!isDeviceOnline) {
            showToast('Device is offline', 'warning');
            return;
        }

        if (type === 'video' && !capabilities.camera) {
            showToast('This device does not currently report camera support', 'warning');
            return;
        }

        if (type === 'audio' && !capabilities.audio) {
            showToast('This device does not currently report audio support', 'warning');
            return;
        }

        if (type === 'video' && !browserPermissions.video) {
            showToast('Browser camera permission is required for video calls', 'warning');
            return;
        }

        if (!browserPermissions.audio) {
            showToast('Browser microphone permission is required for intercom calls', 'warning');
            return;
        }

        if (callActive) {
            showToast('Call already active', 'warning');
            return;
        }

        try {
            showToast(`Initiating ${type} call...`, 'info');

            // Get local media stream
            const constraints = {
                audio: {
                    echoCancellation: settings.echoCancellation,
                    noiseSuppression: settings.noiseSuppression,
                    autoGainControl: settings.autoGainControl
                },
                video: type === 'video' ? {
                    width: { ideal: parseInt(settings.resolution.split('x')[0]) },
                    height: { ideal: parseInt(settings.resolution.split('x')[1]) },
                    frameRate: { ideal: settings.fps }
                } : false
            };

            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            
            if (elements.localVideo && type === 'video') {
                elements.localVideo.srcObject = localStream;
                elements.localVideo.style.display = 'block';
            }

            // Create peer connection
            peerConnection = new RTCPeerConnection({ iceServers });

            // Add local tracks
            localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, localStream);
            });

            // Handle ICE candidates
            peerConnection.onicecandidate = event => {
                if (event.candidate) {
                    sendSignal('candidate', event.candidate);
                }
            };

            // Handle remote stream
            peerConnection.ontrack = event => {
                remoteStream = event.streams[0];
                if (elements.remoteVideo && type === 'video') {
                    elements.remoteVideo.srcObject = remoteStream;
                    elements.remoteVideo.style.display = 'block';
                }
                if (elements.remoteAudio) {
                    elements.remoteAudio.srcObject = remoteStream;
                }
            };

            // Create data channel for control messages
            dataChannel = peerConnection.createDataChannel('intercom');
            dataChannel.onmessage = event => {
                handleDataChannelMessage(JSON.parse(event.data));
            };

            // Create offer
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: type === 'video'
            });
            await peerConnection.setLocalDescription(offer);

            // Initiate call via API
            const response = await fetch('/api/intercom/call/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, deviceId })
            });

            const data = await response.json();
            if (data.success) {
                currentCallId = data.data.callId;
                callActive = true;
                callType = type;
                
                // Send offer to device
                sendSignal('offer', peerConnection.localDescription);
                
                updateCallStatus('Connecting...', 'info');
                startCallTimer();
            } else {
                throw new Error(data.message);
            }

        } catch (error) {
            console.error('Error starting call:', error);
            showToast('Failed to start call: ' + error.message, 'danger');
            endCall();
        }
    }

    async function sendSignal(type, data) {
        if (!currentCallId) return;

        try {
            await fetch('/api/intercom/signal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    callId: currentCallId,
                    type,
                    data,
                    deviceId
                })
            });
        } catch (error) {
            console.error('Error sending signal:', error);
        }
    }

    async function handleRemoteSignal(type, data) {
        if (!peerConnection) return;

        try {
            if (type === 'answer') {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
                updateCallStatus('Connected', 'success');
            } else if (type === 'candidate') {
                await peerConnection.addIceCandidate(new RTCIceCandidate(data));
            }
        } catch (error) {
            console.error('Error handling remote signal:', error);
        }
    }

    function handleDataChannelMessage(data) {
        console.log('Data channel message:', data);
        
        if (data.type === 'ping') {
            dataChannel.send(JSON.stringify({ type: 'pong' }));
        } else if (data.type === 'audio-level') {
            if (elements.audioLevel) {
                elements.audioLevel.style.width = data.level + '%';
            }
        }
    }

    async function endCall() {
        try {
            if (peerConnection) {
                peerConnection.close();
                peerConnection = null;
            }

            if (localStream) {
                localStream.getTracks().forEach(track => track.stop());
                localStream = null;
            }

            if (elements.localVideo) {
                elements.localVideo.srcObject = null;
                elements.localVideo.style.display = 'none';
            }

            if (elements.remoteVideo) {
                elements.remoteVideo.srcObject = null;
                elements.remoteVideo.style.display = 'none';
            }

            if (elements.remoteAudio) {
                elements.remoteAudio.srcObject = null;
            }

            if (currentCallId) {
                await fetch('/api/intercom/call/end', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ deviceId })
                });
            }

            callActive = false;
            currentCallId = null;
            
            updateCallStatus('No active call', 'secondary');
            stopCallTimer();
            
            showToast('Call ended', 'info');
            
            // Reload history
            loadCallHistory();

        } catch (error) {
            console.error('Error ending call:', error);
        }
    }

    // ==================== CALL TIMER ====================

    let timerInterval = null;
    let callStartTime = null;

    function startCallTimer() {
        callStartTime = Date.now();
        if (timerInterval) clearInterval(timerInterval);
        
        timerInterval = setInterval(() => {
            if (callActive && callStartTime) {
                const duration = Math.floor((Date.now() - callStartTime) / 1000);
                if (elements.callTimer) {
                    elements.callTimer.textContent = formatDuration(duration);
                }
                const audioCallTimer = document.getElementById('audioCallTimer');
                if (audioCallTimer) {
                    audioCallTimer.textContent = formatDuration(duration);
                }
            }
        }, 1000);
    }

    function stopCallTimer() {
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        if (elements.callTimer) {
            elements.callTimer.textContent = '00:00';
        }
        const audioCallTimer = document.getElementById('audioCallTimer');
        if (audioCallTimer) {
            audioCallTimer.textContent = '00:00';
        }
    }

    // ==================== AUDIO CONTROL ====================

    function toggleMuteMic() {
        if (localStream) {
            const audioTrack = localStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled;
                const isMuted = !audioTrack.enabled;
                
                if (elements.muteMic) {
                    elements.muteMic.innerHTML = isMuted ? 
                        '<i class="bi bi-mic-mute"></i> Unmute' : 
                        '<i class="bi bi-mic"></i> Mute';
                    elements.muteMic.classList.toggle('btn-danger', isMuted);
                    elements.muteMic.classList.toggle('btn-outline-danger', !isMuted);
                }
                
                showToast(isMuted ? 'Microphone muted' : 'Microphone unmuted', 'info');
            }
        }
    }

    function toggleMuteSpeaker() {
        if (elements.remoteAudio) {
            elements.remoteAudio.muted = !elements.remoteAudio.muted;
            const isMuted = elements.remoteAudio.muted;
            
            if (elements.muteSpeaker) {
                elements.muteSpeaker.innerHTML = isMuted ? 
                    '<i class="bi bi-volume-mute"></i> Unmute' : 
                    '<i class="bi bi-volume-up"></i> Mute';
                elements.muteSpeaker.classList.toggle('btn-warning', isMuted);
                elements.muteSpeaker.classList.toggle('btn-outline-warning', !isMuted);
            }
        }
    }

    function setSpeakerVolume(volume) {
        if (elements.remoteAudio) {
            elements.remoteAudio.volume = volume / 100;
        }
    }

    // ==================== SNAPSHOT ====================

    async function takeSnapshot() {
        if (!callActive || callType !== 'video') {
            showToast('No active video call', 'warning');
            return;
        }

        try {
            const response = await fetch(`/api/intercom/snapshot?deviceId=${deviceId}`, {
                method: 'POST'
            });

            const data = await response.json();
            if (data.success) {
                showToast('Snapshot captured', 'success');
                // Refresh snapshot grid if history tab is visible
                loadWebcamCaptures();
                loadSnapshots();
                // Open in new tab
                window.open(data.data.url, '_blank');
            } else {
                showToast(data.message, 'danger');
            }
        } catch (error) {
            console.error('Error taking snapshot:', error);
            showToast('Failed to take snapshot', 'danger');
        }
    }

    // ==================== FULLSCREEN ====================

    function toggleFullscreen() {
        if (!elements.remoteVideo) return;

        if (!document.fullscreenElement) {
            if (elements.remoteVideo.requestFullscreen) {
                elements.remoteVideo.requestFullscreen();
            }
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            }
        }
    }

    // ==================== SETTINGS SAVE ====================

    function saveVideoSettings() {
        const data = {
            enabled: elements.videoEnabled?.checked || false,
            resolution: elements.videoResolution?.value || '640x480',
            fps: parseInt(elements.videoFps?.value) || 15,
            quality: parseInt(elements.videoQuality?.value) || 80,
            deviceId
        };

        fetch('/api/intercom/video/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('Video settings saved', 'success');
                settings = { ...settings, ...data.data };
            } else {
                showToast(data.message, 'danger');
            }
        })
        .catch(console.error);
    }

    function saveAudioSettings() {
        const data = {
            enabled: elements.audioEnabled?.checked || false,
            bitrate: parseInt(elements.audioBitrate?.value) || 64000,
            echoCancellation: elements.echoCancellation?.checked || false,
            noiseSuppression: elements.noiseSuppression?.checked || false,
            autoGainControl: elements.autoGainControl?.checked || false,
            micSensitivity: parseInt(elements.micSensitivity?.value) || 50,
            speakerVolume: parseInt(elements.speakerVolume?.value) || 80,
            deviceId
        };

        fetch('/api/intercom/audio/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('Audio settings saved', 'success');
                settings = { ...settings, ...data.data };
                
                // Apply speaker volume
                setSpeakerVolume(data.data.speakerVolume);
            } else {
                showToast(data.message, 'danger');
            }
        })
        .catch(console.error);
    }

    function saveServerSettings() {
        const data = {
            stunServer: elements.stunServer?.value || 'stun.l.google.com:19302',
            turnServer: elements.turnServer?.value || '',
            turnUsername: elements.turnUsername?.value || '',
            turnPassword: elements.turnPassword?.value || '',
            deviceId
        };

        fetch('/api/intercom/servers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showToast('STUN/TURN servers saved', 'success');
                loadIceServers(); // Reload ICE servers
            } else {
                showToast(data.message, 'danger');
            }
        })
        .catch(console.error);
    }

    function saveWebcamSettings() {
        const data = {
            enabled: elements.videoEnabled?.checked || false,
            resolution: elements.videoResolution?.value || '640x480',
            fps: parseInt(elements.videoFps?.value, 10) || 15,
            quality: parseInt(elements.videoQuality?.value, 10) || 80,
            motionDetection: elements.motionDetection?.checked || false,
            faceDetection: elements.faceDetection?.checked || false,
            recognitionEnabled: elements.recognitionEnabled?.checked || false,
            retentionDays: parseInt(elements.retentionDays?.value, 10) || 30,
            privacyMode: elements.privacyMode?.value || 'events-only',
            deviceId
        };

        fetch('/api/intercom/webcam/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    webcamSettings = { ...webcamSettings, ...data.data };
                    showToast('Capture settings saved', 'success');
                } else {
                    showToast(data.message || 'Failed to save capture settings', 'danger');
                }
            })
            .catch(error => {
                console.error('Error saving webcam settings:', error);
                showToast('Failed to save capture settings', 'danger');
            });
    }

    // ==================== UI UPDATES ====================

    function updateCallStatus(message, type) {
        if (elements.callStatus) {
            elements.callStatus.innerHTML = `<span class="badge bg-${type}">${message}</span>`;
        }
        const audioCallStatus = document.getElementById('audioCallStatus');
        if (audioCallStatus) {
            audioCallStatus.innerHTML = `<span class="badge bg-${type}">${message}</span>`;
        }
        const audioCallTimer = document.getElementById('audioCallTimer');
        if (audioCallTimer && elements.callTimer) {
            audioCallTimer.textContent = elements.callTimer.textContent;
        }
        const inCall = message !== 'No active call';
        if (elements.endCall) elements.endCall.disabled = !inCall;
        const endAudioCall = document.getElementById('endAudioCall');
        if (endAudioCall) endAudioCall.disabled = !inCall;
        if (elements.muteMic) elements.muteMic.disabled = !inCall;
        const muteMicAudio = document.getElementById('muteMicAudio');
        if (muteMicAudio) muteMicAudio.disabled = !inCall;
        if (elements.muteSpeaker) elements.muteSpeaker.disabled = !inCall;
        if (elements.snapshot) elements.snapshot.disabled = !inCall || callType !== 'video';
        if (elements.fullscreen) elements.fullscreen.disabled = !inCall || callType !== 'video';
    }

    // ==================== EVENT LISTENERS ====================

    function attachEventListeners() {
        // Call buttons
        if (elements.startVideoCall) {
            elements.startVideoCall.addEventListener('click', () => startCall('video'));
        }
        if (elements.startAudioCall) {
            elements.startAudioCall.addEventListener('click', () => startCall('audio'));
        }
        if (elements.endCall) {
            elements.endCall.addEventListener('click', endCall);
        }

        // Audio controls
        if (elements.muteMic) {
            elements.muteMic.addEventListener('click', toggleMuteMic);
        }
        if (elements.muteSpeaker) {
            elements.muteSpeaker.addEventListener('click', toggleMuteSpeaker);
        }

        // Video controls
        if (elements.snapshot) {
            elements.snapshot.addEventListener('click', takeSnapshot);
        }
        if (elements.fullscreen) {
            elements.fullscreen.addEventListener('click', toggleFullscreen);
        }

        // Range inputs
        if (elements.videoFps) {
            elements.videoFps.addEventListener('input', (e) => {
                if (elements.fpsValue) elements.fpsValue.textContent = e.target.value;
            });
        }
        if (elements.videoQuality) {
            elements.videoQuality.addEventListener('input', (e) => {
                if (elements.qualityValue) elements.qualityValue.textContent = e.target.value + '%';
            });
        }
        if (elements.micSensitivity) {
            elements.micSensitivity.addEventListener('input', (e) => {
                if (elements.sensitivityValue) elements.sensitivityValue.textContent = e.target.value + '%';
            });
        }
        if (elements.speakerVolume) {
            elements.speakerVolume.addEventListener('input', (e) => {
                if (elements.volumeValue) elements.volumeValue.textContent = e.target.value + '%';
                setSpeakerVolume(e.target.value);
            });
        }

        // Save buttons
        document.getElementById('saveVideoSettings')?.addEventListener('click', saveVideoSettings);
        document.getElementById('saveAudioSettings')?.addEventListener('click', saveAudioSettings);
        document.getElementById('saveServerSettings')?.addEventListener('click', saveServerSettings);
        document.getElementById('saveWebcamSettings')?.addEventListener('click', saveWebcamSettings);
        document.getElementById('refreshCapturesBtn')?.addEventListener('click', loadWebcamCaptures);
        document.getElementById('exportCapturesBtn')?.addEventListener('click', () => {
            window.open(`/api/intercom/captures/export?deviceId=${encodeURIComponent(deviceId)}`, '_blank');
        });
        elements.captureFaceFilter?.addEventListener('change', loadWebcamCaptures);
        elements.captureMotionFilter?.addEventListener('change', loadWebcamCaptures);
        elements.captureRecognitionFilter?.addEventListener('change', loadWebcamCaptures);

        // History tab — load call history + snapshots when shown
        const historyTab = document.getElementById('history-tab');
        if (historyTab) {
            historyTab.addEventListener('shown.bs.tab', () => {
                loadCallHistory();
                loadWebcamCaptures();
                loadSnapshots();
            });
        }

        window.addEventListener('device:changed', (event) => {
            deviceId = event.detail?.deviceId || (window.getActiveDeviceId ? window.getActiveDeviceId() : '') || '';
            Promise.resolve(endCall()).catch(() => {});
            loadStatus();
            loadIceServers();
            loadCallHistory();
            loadWebcamCaptures();
            loadSnapshots();
        });
    }

    function attachSocketListeners() {
        if (typeof socket === 'undefined') return;

        socket.off('intercom:signal');
        socket.on('intercom:signal', (data) => {
            if (data.deviceId === deviceId && data.callId === currentCallId) {
                handleRemoteSignal(data.type, data.data);
            }
        });

        socket.off('intercom:status');
        socket.on('intercom:status', (data) => {
            if (data.deviceId === deviceId) {
                if (!data.inCall && callActive) {
                    // Call ended by device
                    endCall();
                }
            }
        });

        socket.off('device:status');
        socket.on('device:status', (data) => {
            if (!data.deviceId || data.deviceId === deviceId) {
                isDeviceOnline = data.online;
                updateDeviceStatus();
                updateSupportUI();
            }
        });

        socket.off('device:capabilities');
        socket.on('device:capabilities', (data) => {
            if (!data.deviceId || data.deviceId !== deviceId) return;
            capabilities = data.caps || capabilities;
            supportState = {
                ...supportState,
                camera: Boolean(capabilities.camera),
                audio: Boolean(capabilities.audio),
                intercom: Boolean(capabilities.camera || capabilities.audio)
            };
            updateSupportUI();
        });

        socket.off('webcam:capture');
        socket.on('webcam:capture', (data) => {
            if (!data.deviceId || data.deviceId !== deviceId) return;
            loadWebcamCaptures();
        });

        socket.off('mqtt:status');
        socket.on('mqtt:status', (data) => {
            supportState.signaling = Boolean(data?.connected || window.socket?.connected);
            updateSupportUI();
        });
    }

    // ==================== HELPER FUNCTIONS ====================

    function formatDuration(totalSeconds) {
        const value = Math.max(0, parseInt(totalSeconds, 10) || 0);
        const minutes = Math.floor(value / 60);
        const seconds = value % 60;
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    window.refreshWebcamData = function () {
        loadWebcamCaptures();
        loadSnapshots();
    };

    // Cleanup
    window.addEventListener('beforeunload', () => {
        if (callActive) {
            endCall();
        }
    });

    // Expose functions
    window.startCall = startCall;
    window.endCall = endCall;
    window.takeSnapshot = takeSnapshot;
    window.toggleFullscreen = toggleFullscreen;
    window.saveVideoSettings = saveVideoSettings;
    window.saveAudioSettings = saveAudioSettings;
    window.saveServerSettings = saveServerSettings;
    window.saveWebcamSettings = saveWebcamSettings;
    window.loadSnapshots = loadSnapshots;
    window.loadWebcamCaptures = loadWebcamCaptures;

    console.log('Intercom.js initialized');
})();
