const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { getDeviceCapabilities } = require('../utils/deviceCapabilities');
const { getDeviceModuleHealth, markModuleFailure, markModuleSuccess, upsertModuleHealth } = require('../utils/moduleHealth');
const { saveCapture, listCaptures, getCaptureSummary, deleteCapture } = require('../services/webcamCaptureService');

// Intercom state (per device)
let intercomState = new Map(); // deviceId -> state

// WebRTC signaling state
let pendingCalls = new Map(); // callId -> { deviceId, type, timestamp }

// Active call timeout timers (auto-cleanup if no end signal received)
const CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
let callTimeouts = new Map(); // deviceId -> TimeoutHandle

function setNoStoreHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
}

function getDb() {
    try { return require('../config/database').getDatabase(); } catch (e) { return null; }
}

async function loadIntercomStateFromDb() {
    try {
        const db = getDb();
        if (!db) return;
        const rows = db.prepare('SELECT * FROM intercom_sessions WHERE in_call = 1').all();
        rows.forEach(row => {
            intercomState.set(row.device_id, {
                inCall: !!row.in_call,
                callType: row.call_type,
                peerId: row.peer_id
            });
        });
    } catch (e) { /* ignore */ }
}
loadIntercomStateFromDb();

function persistIntercomState(deviceId, state) {
    try {
        const db = getDb();
        if (!db) return;
        db.prepare(`INSERT INTO intercom_sessions (device_id, in_call, call_type, peer_id, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(device_id) DO UPDATE SET in_call=excluded.in_call,
            call_type=excluded.call_type, peer_id=excluded.peer_id, updated_at=excluded.updated_at`)
            .run(deviceId, state.inCall ? 1 : 0, state.callType || null, state.peerId || null);
    } catch (e) { /* ignore */ }
}

function getDefaultIntercomSettings() {
    return {
        videoEnabled: false,
        audioEnabled: false,
        resolution: '640x480',
        fps: 15,
        quality: 80,
        audioBitrate: 64000,
        stunServer: 'stun.l.google.com:19302',
        turnServer: '',
        turnUsername: '',
        turnPassword: '',
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        micSensitivity: 50,
        speakerVolume: 80
    };
}

function normalizeIntercomSettings(row) {
    const defaults = getDefaultIntercomSettings();
    if (!row) return defaults;

    return {
        ...defaults,
        videoEnabled: row.video_enabled != null ? row.video_enabled !== 0 : defaults.videoEnabled,
        audioEnabled: row.audio_enabled != null ? row.audio_enabled !== 0 : defaults.audioEnabled,
        resolution: row.resolution || defaults.resolution,
        fps: row.fps ?? defaults.fps,
        quality: row.quality ?? defaults.quality,
        audioBitrate: row.audio_bitrate ?? defaults.audioBitrate,
        stunServer: row.stun_server || defaults.stunServer,
        turnServer: row.turn_server || defaults.turnServer,
        turnUsername: row.turn_username || defaults.turnUsername,
        turnPassword: row.turn_password || defaults.turnPassword,
        echoCancellation: row.echo_cancellation != null ? row.echo_cancellation !== 0 : defaults.echoCancellation,
        noiseSuppression: row.noise_suppression != null ? row.noise_suppression !== 0 : defaults.noiseSuppression,
        autoGainControl: row.auto_gain_control != null ? row.auto_gain_control !== 0 : defaults.autoGainControl,
        micSensitivity: row.mic_sensitivity ?? defaults.micSensitivity,
        speakerVolume: row.speaker_volume ?? defaults.speakerVolume
    };
}

function getDefaultWebcamSettings() {
    return {
        enabled: false,
        resolution: '640x480',
        fps: 15,
        quality: 80,
        motionDetection: false,
        faceDetection: false,
        recognitionEnabled: false,
        retentionDays: 30,
        privacyMode: 'events-only'
    };
}

function normalizeWebcamSettings(row) {
    const defaults = getDefaultWebcamSettings();
    if (!row) return defaults;

    return {
        ...defaults,
        enabled: row.enabled != null ? row.enabled !== 0 : defaults.enabled,
        resolution: row.resolution || defaults.resolution,
        fps: row.fps ?? defaults.fps,
        quality: row.quality ?? defaults.quality,
        motionDetection: row.motion_detection != null ? row.motion_detection !== 0 : defaults.motionDetection,
        faceDetection: row.face_detection != null ? row.face_detection !== 0 : defaults.faceDetection,
        recognitionEnabled: row.recognition_enabled != null ? row.recognition_enabled !== 0 : defaults.recognitionEnabled,
        retentionDays: row.retention_days ?? defaults.retentionDays,
        privacyMode: row.privacy_mode || defaults.privacyMode
    };
}

function buildWebcamCaptureMetadata(data = {}, overrides = {}) {
    return {
        ...data.metadata,
        motionDetected: data.motionDetected ?? data.motion_detected,
        faceDetected: data.faceDetected ?? data.face_detected,
        faceCount: data.faceCount ?? data.face_count ?? data.faces?.length,
        recognizedLabel: data.recognizedLabel ?? data.recognized_label ?? data.recognition?.name,
        recognitionConfidence: data.recognitionConfidence ?? data.recognition_confidence ?? data.recognition?.confidence,
        captureType: data.captureType || data.capture_type || 'manual_capture',
        source: data.source || 'dashboard',
        ...overrides
    };
}

function clearCallTimeout(deviceId) {
    const t = callTimeouts.get(deviceId);
    if (t) {
        clearTimeout(t);
        callTimeouts.delete(deviceId);
    }
}

function startCallTimeout(deviceId) {
    clearCallTimeout(deviceId);
    const timer = setTimeout(() => {
        callTimeouts.delete(deviceId);
        const state = intercomState.get(deviceId) || {};
        if (state.inCall) {
            state.inCall = false;
            state.callType = null;
            state.peerId = null;
            intercomState.set(deviceId, state);
            persistIntercomState(deviceId, state);
            logger.warn(`Intercom call timeout — auto-ended for device ${deviceId}`);
            if (global.io) {
                global.io.to('device:' + deviceId).emit('intercom:timeout', { deviceId });
                global.io.to('device:' + deviceId).emit('intercom:status', { deviceId, inCall: false, type: null });
            }
            if (global.mqttService && global.mqttService.connected) {
                global.mqttService.publishCommand(deviceId, 'intercom-call-end', {}).catch(() => {});
            }
        }
    }, CALL_TIMEOUT_MS);
    timer.unref?.();
    callTimeouts.set(deviceId, timer);
}

// ==================== INTERCOM STATUS ====================

/**
 * Get intercom status
 * GET /api/intercom/status?deviceId=1
 */
router.get('/status', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;
        const db = req.app.locals.db;

        // Get settings from database
        const settings = await db.get('SELECT * FROM intercom_settings WHERE device_id = ?', [deviceId]);
        const webcamSettings = await db.get(
            `SELECT * FROM webcam WHERE device_id = ? ORDER BY id DESC LIMIT 1`,
            [deviceId]
        );
        const { caps } = await getDeviceCapabilities(db, deviceId);
        
        // Get current state
        const state = intercomState.get(deviceId) || {
            videoEnabled: false,
            audioEnabled: false,
            streaming: false,
            inCall: false,
            callType: null,
            peerId: null,
            lastFrame: null
        };

        // Use the normalized dashboard device status as the source of truth so
        // intercom availability follows the same stale/offline rules as the
        // rest of the dashboard.
        const liveDeviceStatus = global.modemService?.getDeviceStatus?.(deviceId)
            || global.modemService?.getStatus?.(deviceId)
            || null;
        const isOnline = liveDeviceStatus?.online === true;
        const moduleHealth = await getDeviceModuleHealth(db, deviceId, caps, {
            mqttConnected: global.mqttService?.connected,
            live: {
                online: isOnline,
                lastSeen: liveDeviceStatus?.lastSeen || null
            }
        });

        res.json({
            success: true,
            data: {
                settings: normalizeIntercomSettings(settings),
                webcam: normalizeWebcamSettings(webcamSettings),
                state,
                online: isOnline,
                caps,
                moduleHealth,
                support: {
                    signaling: Boolean(global.mqttService?.connected),
                    camera: Boolean(caps.camera),
                    audio: Boolean(caps.audio),
                    intercom: Boolean(caps.camera || caps.audio)
                }
            }
        });
    } catch (error) {
        logger.error('API intercom status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get intercom status'
        });
    }
});

// ==================== WEBCAM SETTINGS ====================

router.get('/webcam/settings', async (req, res) => {
    try {
        const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;
        const db = req.app.locals.db;
        const row = await db.get(
            `SELECT * FROM webcam WHERE device_id = ? ORDER BY id DESC LIMIT 1`,
            [deviceId]
        );

        res.json({
            success: true,
            data: normalizeWebcamSettings(row)
        });
    } catch (error) {
        logger.error('API webcam settings error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load webcam settings'
        });
    }
});

router.post('/webcam/settings', [
    body('enabled').optional().isBoolean(),
    body('resolution').optional().isIn(['1600x1200', '1280x1024', '1024x768', '800x600', '640x480', '352x288', '320x240']),
    body('fps').optional().isInt({ min: 1, max: 60 }),
    body('quality').optional().isInt({ min: 10, max: 100 }),
    body('motionDetection').optional().isBoolean(),
    body('faceDetection').optional().isBoolean(),
    body('recognitionEnabled').optional().isBoolean(),
    body('retentionDays').optional().isInt({ min: 1, max: 365 }),
    body('privacyMode').optional().isIn(['events-only', 'faces-only', 'full-frame']),
    body('deviceId').optional()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || 'Validation failed',
                errors: errors.array()
            });
        }

        const db = req.app.locals.db;
        const deviceId = req.body.deviceId || DEFAULT_DEVICE_ID;
        const existing = await db.get(
            `SELECT * FROM webcam WHERE device_id = ? ORDER BY id DESC LIMIT 1`,
            [deviceId]
        );
        const current = normalizeWebcamSettings(existing);
        const updateData = {
            enabled: req.body.enabled !== undefined ? req.body.enabled : current.enabled,
            resolution: req.body.resolution || current.resolution,
            fps: req.body.fps ?? current.fps,
            quality: req.body.quality ?? current.quality,
            motionDetection: req.body.motionDetection !== undefined ? req.body.motionDetection : current.motionDetection,
            faceDetection: req.body.faceDetection !== undefined ? req.body.faceDetection : current.faceDetection,
            recognitionEnabled: req.body.recognitionEnabled !== undefined ? req.body.recognitionEnabled : current.recognitionEnabled,
            retentionDays: req.body.retentionDays ?? current.retentionDays,
            privacyMode: req.body.privacyMode || current.privacyMode
        };

        if (existing) {
            await db.run(
                `UPDATE webcam
                 SET enabled = ?, resolution = ?, fps = ?, quality = ?,
                     motion_detection = ?, face_detection = ?, recognition_enabled = ?,
                     retention_days = ?, privacy_mode = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [
                    updateData.enabled ? 1 : 0,
                    updateData.resolution,
                    updateData.fps,
                    updateData.quality,
                    updateData.motionDetection ? 1 : 0,
                    updateData.faceDetection ? 1 : 0,
                    updateData.recognitionEnabled ? 1 : 0,
                    updateData.retentionDays,
                    updateData.privacyMode,
                    existing.id
                ]
            );
        } else {
            await db.run(
                `INSERT INTO webcam
                    (device_id, name, enabled, resolution, fps, quality, motion_detection, face_detection, recognition_enabled, retention_days, privacy_mode, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [
                    deviceId,
                    'ESP32-CAM',
                    updateData.enabled ? 1 : 0,
                    updateData.resolution,
                    updateData.fps,
                    updateData.quality,
                    updateData.motionDetection ? 1 : 0,
                    updateData.faceDetection ? 1 : 0,
                    updateData.recognitionEnabled ? 1 : 0,
                    updateData.retentionDays,
                    updateData.privacyMode
                ]
            );
        }

        if (global.mqttService?.connected) {
            global.mqttService.publishCommand(deviceId, 'webcam-config', updateData, false).catch(() => {});
        }

        res.json({
            success: true,
            message: 'Webcam settings updated',
            data: updateData
        });
    } catch (error) {
        logger.error('API webcam settings update error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update webcam settings'
        });
    }
});

router.post('/webcam/capture', [
    body('deviceId').optional(),
    body('resolution').optional().isString(),
    body('quality').optional().isInt({ min: 10, max: 100 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || 'Validation failed',
                errors: errors.array()
            });
        }

        const deviceId = req.body.deviceId || DEFAULT_DEVICE_ID;
        const db = req.app.locals.db;
        const webcamRow = await db.get(
            `SELECT * FROM webcam WHERE device_id = ? ORDER BY id DESC LIMIT 1`,
            [deviceId]
        );
        const webcamSettings = normalizeWebcamSettings(webcamRow);

        if (!global.mqttService?.connected) {
            return res.status(503).json({
                success: false,
                message: 'Device not connected'
            });
        }

        const commandPayload = {
            resolution: req.body.resolution || webcamSettings.resolution,
            quality: req.body.quality ?? webcamSettings.quality,
            faceDetection: webcamSettings.faceDetection,
            recognitionEnabled: webcamSettings.recognitionEnabled,
            privacyMode: webcamSettings.privacyMode,
            motionDetection: webcamSettings.motionDetection,
            source: 'dashboard'
        };

        let response = null;
        try {
            response = await global.mqttService.publishCommand(deviceId, 'camera-capture', commandPayload, true, 15000);
        } catch (error) {
            logger.warn(`Manual webcam capture timed out for ${deviceId}: ${error.message}`);
        }

        if (response?.image) {
            const capture = await saveCapture({
                db,
                deviceId,
                imageBase64: response.image,
                format: response.format || response.mimeType || 'jpeg',
                mimeType: response.mimeType || response.contentType || '',
                webcamId: webcamRow?.id || null,
                relativeDir: 'uploads/webcam',
                filenamePrefix: `webcam_${deviceId}`,
                tags: response.tags || [],
                metadata: buildWebcamCaptureMetadata(response, {
                    captureType: 'manual_capture',
                    source: 'dashboard'
                })
            });

            await markModuleSuccess(db, deviceId, 'camera', 'Manual webcam capture saved', {
                captureId: capture.id,
                faceDetected: capture.faceDetected,
                faceCount: capture.faceCount,
                recognizedLabel: capture.recognizedLabel || null
            });

            global.io?.to('device:' + deviceId).emit('webcam:capture', {
                deviceId,
                ...capture
            });

            return res.json({
                success: true,
                message: 'Capture saved',
                data: capture
            });
        }

        await global.mqttService.publishCommand(deviceId, 'camera-capture', commandPayload, false).catch(() => {});

        res.status(202).json({
            success: true,
            queued: true,
            message: 'Capture requested. Waiting for device image publish.'
        });
    } catch (error) {
        logger.error('API webcam capture error:', error);
        markModuleFailure(req.app.locals.db, req.body.deviceId || DEFAULT_DEVICE_ID, 'camera', 'Manual webcam capture failed', {
            error: error.message
        }).catch(() => {});
        res.status(500).json({
            success: false,
            message: 'Failed to capture webcam image'
        });
    }
});

/**
 * Update video settings
 * POST /api/intercom/video/settings
 */
router.post('/video/settings', [
    body('enabled').optional().isBoolean(),
    body('resolution').optional().isIn(['1600x1200', '1280x1024', '1024x768', '800x600', '640x480', '352x288', '320x240']),
    body('fps').optional().isInt({ min: 1, max: 60 }),
    body('quality').optional().isInt({ min: 10, max: 100 }),
    body('deviceId').optional()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { enabled, resolution, fps, quality, deviceId = DEFAULT_DEVICE_ID } = req.body;
        const db = req.app.locals.db;

        if (!db) {
            throw new Error('Database not available');
        }

        // Get current settings
        const settings = normalizeIntercomSettings(
            await db.get('SELECT * FROM intercom_settings WHERE device_id = ?', [deviceId])
        );
        
        const updateData = {
            videoEnabled: enabled !== undefined ? enabled : settings.videoEnabled,
            resolution: resolution || settings.resolution,
            fps: fps ?? settings.fps,
            quality: quality ?? settings.quality
        };

        if (await db.get('SELECT 1 FROM intercom_settings WHERE device_id = ?', [deviceId])) {
            await db.run(`
                UPDATE intercom_settings 
                SET video_enabled = ?, resolution = ?, fps = ?, quality = ?, updated_at = CURRENT_TIMESTAMP
                WHERE device_id = ?
            `, [updateData.videoEnabled ? 1 : 0, updateData.resolution, updateData.fps, updateData.quality, deviceId]);
        } else {
            await db.run(`
                INSERT INTO intercom_settings 
                (device_id, video_enabled, resolution, fps, quality, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `, [deviceId, updateData.videoEnabled ? 1 : 0, updateData.resolution, updateData.fps, updateData.quality]);
        }

        // Send command to device via MQTT
        if (global.mqttService && global.mqttService.connected) {
            try {
                await global.mqttService.publishCommand(deviceId, 'intercom-video-config', updateData);
            } catch (mqttError) {
                logger.error('MQTT error sending video config:', mqttError);
            }
        }

        markModuleSuccess(db, deviceId, 'camera', 'Video settings updated', updateData).catch(() => {});

        logger.info(`Video settings updated for ${deviceId}`);

        res.json({
            success: true,
            message: 'Video settings updated',
            data: updateData
        });
    } catch (error) {
        logger.error('API video settings error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update video settings'
        });
    }
});

// ==================== AUDIO SETTINGS ====================

/**
 * Update audio settings
 * POST /api/intercom/audio/settings
 */
router.post('/audio/settings', [
    body('enabled').optional().isBoolean(),
    body('bitrate').optional().isInt({ min: 8000, max: 256000 }),
    body('echoCancellation').optional().isBoolean(),
    body('noiseSuppression').optional().isBoolean(),
    body('autoGainControl').optional().isBoolean(),
    body('micSensitivity').optional().isInt({ min: 0, max: 100 }),
    body('speakerVolume').optional().isInt({ min: 0, max: 100 }),
    body('deviceId').optional()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { 
            enabled, 
            bitrate, 
            echoCancellation, 
            noiseSuppression, 
            autoGainControl,
            micSensitivity,
            speakerVolume,
            deviceId = DEFAULT_DEVICE_ID
        } = req.body;

        const db = req.app.locals.db;

        if (!db) {
            throw new Error('Database not available');
        }

        // Get current settings
        const settings = normalizeIntercomSettings(
            await db.get('SELECT * FROM intercom_settings WHERE device_id = ?', [deviceId])
        );
        
        const updateData = {
            audioEnabled: enabled !== undefined ? enabled : settings.audioEnabled,
            audioBitrate: bitrate ?? settings.audioBitrate,
            echoCancellation: echoCancellation !== undefined ? echoCancellation : settings.echoCancellation,
            noiseSuppression: noiseSuppression !== undefined ? noiseSuppression : settings.noiseSuppression,
            autoGainControl: autoGainControl !== undefined ? autoGainControl : settings.autoGainControl,
            micSensitivity: micSensitivity ?? settings.micSensitivity,
            speakerVolume: speakerVolume ?? settings.speakerVolume
        };

        if (await db.get('SELECT 1 FROM intercom_settings WHERE device_id = ?', [deviceId])) {
            await db.run(`
                UPDATE intercom_settings 
                SET audio_enabled = ?, audio_bitrate = ?, echo_cancellation = ?, 
                    noise_suppression = ?, auto_gain_control = ?, mic_sensitivity = ?,
                    speaker_volume = ?, updated_at = CURRENT_TIMESTAMP
                WHERE device_id = ?
            `, [
                updateData.audioEnabled ? 1 : 0,
                updateData.audioBitrate,
                updateData.echoCancellation ? 1 : 0,
                updateData.noiseSuppression ? 1 : 0,
                updateData.autoGainControl ? 1 : 0,
                updateData.micSensitivity,
                updateData.speakerVolume,
                deviceId
            ]);
        } else {
            await db.run(`
                INSERT INTO intercom_settings 
                (device_id, audio_enabled, audio_bitrate, echo_cancellation, noise_suppression, 
                 auto_gain_control, mic_sensitivity, speaker_volume, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `, [
                deviceId,
                updateData.audioEnabled ? 1 : 0,
                updateData.audioBitrate,
                updateData.echoCancellation ? 1 : 0,
                updateData.noiseSuppression ? 1 : 0,
                updateData.autoGainControl ? 1 : 0,
                updateData.micSensitivity,
                updateData.speakerVolume
            ]);
        }

        // Send command to device via MQTT
        if (global.mqttService && global.mqttService.connected) {
            try {
                await global.mqttService.publishCommand(deviceId, 'intercom-audio-config', updateData);
            } catch (mqttError) {
                logger.error('MQTT error sending audio config:', mqttError);
            }
        }

        markModuleSuccess(db, deviceId, 'audio', 'Audio settings updated', updateData).catch(() => {});

        logger.info(`Audio settings updated for ${deviceId}`);

        res.json({
            success: true,
            message: 'Audio settings updated',
            data: updateData
        });
    } catch (error) {
        logger.error('API audio settings error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update audio settings'
        });
    }
});

// ==================== STUN/TURN SERVERS ====================

/**
 * Update STUN/TURN servers
 * POST /api/intercom/servers
 */
router.post('/servers', [
    body('stunServer').optional(),
    body('turnServer').optional(),
    body('turnUsername').optional(),
    body('turnPassword').optional(),
    body('deviceId').optional()
], async (req, res) => {
    try {
        const { stunServer, turnServer, turnUsername, turnPassword, deviceId = DEFAULT_DEVICE_ID } = req.body;
        const db = req.app.locals.db;

        const settings = normalizeIntercomSettings(
            await db.get('SELECT * FROM intercom_settings WHERE device_id = ?', [deviceId])
        );
        const updateData = {
            stunServer: stunServer || settings.stunServer,
            turnServer: turnServer || settings.turnServer,
            turnUsername: turnUsername || settings.turnUsername,
            turnPassword: turnPassword || settings.turnPassword
        };

        if (await db.get('SELECT 1 FROM intercom_settings WHERE device_id = ?', [deviceId])) {
            await db.run(`
                UPDATE intercom_settings 
                SET stun_server = ?, turn_server = ?, turn_username = ?, turn_password = ?, updated_at = CURRENT_TIMESTAMP
                WHERE device_id = ?
            `, [updateData.stunServer, updateData.turnServer, updateData.turnUsername, updateData.turnPassword, deviceId]);
        } else {
            await db.run(`
                INSERT INTO intercom_settings
                (device_id, stun_server, turn_server, turn_username, turn_password, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `, [deviceId, updateData.stunServer, updateData.turnServer, updateData.turnUsername, updateData.turnPassword]);
        }

        res.json({
            success: true,
            message: 'STUN/TURN servers updated',
            data: updateData
        });
    } catch (error) {
        logger.error('API servers error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update servers'
        });
    }
});

// ==================== WEBRTC SIGNALING ====================

/**
 * Initiate call
 * POST /api/intercom/call/start
 */
router.post('/call/start', [
    body('type').isIn(['video', 'audio']),
    body('deviceId').optional()
], async (req, res) => {
    try {
        const { type, deviceId = DEFAULT_DEVICE_ID } = req.body;
        const db = req.app.locals.db;

        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'Device not connected'
            });
        }

        const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

        // Store pending call
        pendingCalls.set(callId, {
            deviceId,
            type,
            timestamp: Date.now(),
            status: 'initiating'
        });

        // Send signal to device via MQTT
        await global.mqttService.publishCommand(deviceId, 'intercom-call-start', {
            callId,
            type
        });

        // Persist the active-call state immediately so a restart after a
        // successful call initiation still restores the session.
        const state = intercomState.get(deviceId) || {};
        state.inCall = true;
        state.callType = type;
        state.peerId = state.peerId || null;
        intercomState.set(deviceId, state);
        persistIntercomState(deviceId, state);

        markModuleSuccess(db, deviceId, type === 'video' ? 'camera' : 'audio', `${type} call requested`, {
            callId
        }).catch(() => {});

        // Clean up old pending calls after 30s if no response
        const pendingCleanupTimer = setTimeout(() => {
            if (pendingCalls.has(callId)) {
                pendingCalls.delete(callId);
            }
        }, 30000);
        pendingCleanupTimer.unref?.();

        // Start 5-minute call watchdog — auto-ends call if no end signal arrives
        startCallTimeout(deviceId);

        res.json({
            success: true,
            message: `${type} call initiated`,
            data: { callId, type }
        });
    } catch (error) {
        logger.error('API call start error:', error);
        req.app.locals.db && markModuleFailure(req.app.locals.db, req.body.deviceId || DEFAULT_DEVICE_ID, req.body.type === 'video' ? 'camera' : 'audio', 'Failed to start intercom call', {
            error: error.message
        }).catch(() => {});
        res.status(500).json({
            success: false,
            message: 'Failed to start call'
        });
    }
});

/**
 * End call
 * POST /api/intercom/call/end
 */
router.post('/call/end', [
    body('deviceId').optional()
], async (req, res) => {
    try {
        const { deviceId = DEFAULT_DEVICE_ID } = req.body;

        // Update state
        const state = intercomState.get(deviceId) || {};
        state.inCall = false;
        state.callType = null;
        state.peerId = null;
        intercomState.set(deviceId, state);
        persistIntercomState(deviceId, state);

        // Cancel watchdog — call ended normally
        clearCallTimeout(deviceId);

        // Send signal to device via MQTT
        if (global.mqttService && global.mqttService.connected) {
            await global.mqttService.publishCommand(deviceId, 'intercom-call-end', {});
        }

        if (req.app.locals.db) {
            Promise.all([
                upsertModuleHealth(req.app.locals.db, {
                    deviceId,
                    moduleKey: 'audio',
                    supported: true,
                    state: 'ok',
                    message: 'Call ended'
                }).catch(() => {}),
                upsertModuleHealth(req.app.locals.db, {
                    deviceId,
                    moduleKey: 'camera',
                    supported: true,
                    state: 'ok',
                    message: 'Call ended'
                }).catch(() => {})
            ]).catch(() => {});
        }

        res.json({
            success: true,
            message: 'Call ended'
        });
    } catch (error) {
        logger.error('API call end error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to end call'
        });
    }
});

/**
 * WebRTC signaling (offer/answer/candidate)
 * POST /api/intercom/signal
 */
router.post('/signal', [
    body('callId').notEmpty(),
    body('type').isIn(['offer', 'answer', 'candidate']),
    body('data').notEmpty(),
    body('deviceId').optional()
], async (req, res) => {
    try {
        const { callId, type, data, deviceId = DEFAULT_DEVICE_ID } = req.body;

        const pendingCall = pendingCalls.get(callId);
        if (!pendingCall) {
            return res.status(404).json({
                success: false,
                message: 'Call not found or expired'
            });
        }

        // Forward signal to device via MQTT
        if (global.mqttService && global.mqttService.connected) {
            await global.mqttService.publishCommand(deviceId, 'intercom-signal', {
                callId,
                type,
                data
            });
        }

        // Relay signal to all browser peers in the device room via Socket.IO
        if (global.io) {
            global.io.to('device:' + deviceId).emit('intercom:signal', {
                deviceId,
                callId,
                type,
                data
            });
        }

        res.json({
            success: true,
            message: `Signal ${type} sent`
        });
    } catch (error) {
        logger.error('API signal error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send signal'
        });
    }
});

/**
 * Get ICE servers for WebRTC
 * GET /api/intercom/ice-servers
 */
router.get('/ice-servers', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;
        const db = req.app.locals.db;

        const settings = await db.get('SELECT stun_server, turn_server, turn_username, turn_password FROM intercom_settings WHERE device_id = ?', [deviceId]);

        const iceServers = [];

        // Add STUN server
        if (settings?.stun_server) {
            iceServers.push({
                urls: `stun:${settings.stun_server}`
            });
        } else {
            iceServers.push({
                urls: 'stun:stun.l.google.com:19302'
            });
        }

        // Add TURN server if configured
        if (settings?.turn_server) {
            const turnConfig = {
                urls: `turn:${settings.turn_server}`,
                username: settings.turn_username || '',
                credential: settings.turn_password || ''
            };
            iceServers.push(turnConfig);
        }

        res.json({
            success: true,
            data: iceServers
        });
    } catch (error) {
        logger.error('API ICE servers error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get ICE servers'
        });
    }
});

// ==================== SNAPSHOT (for video calls) ====================

/**
 * Capture snapshot during video call
 * POST /api/intercom/snapshot
 */
router.post('/snapshot', async (req, res) => {
    try {
        const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;
        const db = req.app.locals.db;

        // Request snapshot from device
        if (!global.mqttService || !global.mqttService.connected) {
            return res.status(503).json({
                success: false,
                message: 'Device not connected'
            });
        }

        const response = await global.mqttService.publishCommand(deviceId, 'intercom-snapshot', {}, true, 10000);

        if (response && response.success) {
            const capture = await saveCapture({
                db,
                deviceId,
                imageBase64: response.image,
                format: response.format || 'jpeg',
                relativeDir: 'uploads/intercom',
                filenamePrefix: 'snapshot',
                metadata: {
                    captureType: 'manual_snapshot',
                    source: 'dashboard',
                    faceDetected: response.faceDetected ?? response.face_detected,
                    faceCount: response.faceCount ?? response.face_count,
                    recognizedLabel: response.recognizedLabel ?? response.recognized_label
                }
            });

            markModuleSuccess(db, deviceId, 'camera', 'Manual snapshot captured', {
                captureId: capture.id
            }).catch(() => {});

            res.json({
                success: true,
                message: 'Snapshot captured',
                data: {
                    id: capture.id,
                    url: capture.url,
                    size: capture.size,
                    timestamp: capture.timestamp
                }
            });
        } else {
            markModuleFailure(db, deviceId, 'camera', response?.message || 'Snapshot capture failed', response || null).catch(() => {});
            res.status(500).json({
                success: false,
                message: response?.message || 'Failed to capture snapshot'
            });
        }
    } catch (error) {
        logger.error('API snapshot error:', error);
        const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;
        req.app.locals.db && markModuleFailure(req.app.locals.db, deviceId, 'camera', 'Snapshot route error', {
            error: error.message
        }).catch(() => {});
        res.status(500).json({
            success: false,
            message: 'Failed to capture snapshot'
        });
    }
});

// ==================== CALL HISTORY ====================

/**
 * Get call history
 * GET /api/intercom/history?deviceId=1&limit=50
 */
router.get('/history', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 50), 500);
        const db = req.app.locals.db;

        const history = await db.all(`
            SELECT * FROM intercom_calls 
            WHERE device_id = ? 
            ORDER BY start_time DESC 
            LIMIT ?
        `, [deviceId, limit]);

        res.json({
            success: true,
            data: history
        });
    } catch (error) {
        logger.error('API history error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get call history'
        });
    }
});

// ==================== SNAPSHOT HISTORY ====================

/**
 * List saved snapshots
 * GET /api/intercom/snapshots?deviceId=1&limit=50
 */
router.get('/snapshots', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 50), 500);
        const captures = await listCaptures({
            db: req.app.locals.db,
            deviceId,
            limit,
            captureType: 'manual_snapshot'
        });

        res.json({
            success: true,
            data: captures.map(capture => ({
                id: capture.id,
                name: capture.filename,
                url: capture.url,
                size: capture.size,
                timestamp: capture.timestamp
            }))
        });
    } catch (error) {
        logger.error('List snapshots error:', error);
        res.status(500).json({ success: false, message: 'Failed to list snapshots' });
    }
});

/**
 * Delete a snapshot
 * DELETE /api/intercom/snapshots/:filename
 */
router.delete('/snapshots/:filename', async (req, res) => {
    try {
        const deleted = await deleteCapture(req.app.locals.db, req.params.filename, req.query.deviceId || DEFAULT_DEVICE_ID);
        if (!deleted) {
            return res.status(404).json({ success: false, message: 'Snapshot not found' });
        }
        res.json({ success: true, message: 'Snapshot deleted' });
    } catch (error) {
        logger.error('Delete snapshot error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete snapshot' });
    }
});

router.get('/captures', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;
        const captures = await listCaptures({
            db: req.app.locals.db,
            deviceId,
            limit: req.query.limit,
            faceDetected: req.query.faceDetected === undefined ? undefined : req.query.faceDetected === 'true',
            motionDetected: req.query.motionDetected === undefined ? undefined : req.query.motionDetected === 'true',
            recognized: req.query.recognized || undefined,
            captureType: req.query.captureType || undefined,
            source: req.query.source || undefined
        });
        const summary = await getCaptureSummary(req.app.locals.db, deviceId);

        res.json({
            success: true,
            data: captures,
            summary
        });
    } catch (error) {
        logger.error('List captures error:', error);
        res.status(500).json({ success: false, message: 'Failed to list captures' });
    }
});

router.get('/captures/export', async (req, res) => {
    try {
        const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;
        const captures = await listCaptures({
            db: req.app.locals.db,
            deviceId,
            limit: 500
        });
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${deviceId}-camera-captures.json"`);
        res.send(JSON.stringify({
            deviceId,
            exportedAt: new Date().toISOString(),
            captures
        }, null, 2));
    } catch (error) {
        logger.error('Export captures error:', error);
        res.status(500).json({ success: false, message: 'Failed to export captures' });
    }
});

router.delete('/captures/:id', async (req, res) => {
    try {
        const deleted = await deleteCapture(req.app.locals.db, req.params.id, req.query.deviceId || DEFAULT_DEVICE_ID);
        if (!deleted) {
            return res.status(404).json({ success: false, message: 'Capture not found' });
        }
        res.json({ success: true, message: 'Capture deleted' });
    } catch (error) {
        logger.error('Delete capture error:', error);
        res.status(500).json({ success: false, message: 'Failed to delete capture' });
    }
});

// ==================== MQTT HANDLER ====================

// Handle incoming MQTT messages for intercom
function handleMqttMessage(deviceId, topic, data) {
    try {
        if (topic.includes('intercom-signal')) {
            // Forward WebRTC signal to browser
            if (global.io) {
                global.io.to('device:' + deviceId).emit('intercom:signal', {
                    deviceId,
                    callId: data.callId,
                    type: data.type,
                    data: data.data
                });
            }
        } else if (topic.includes('intercom-call-status')) {
            // Update call state
            const state = intercomState.get(deviceId) || {};
            state.inCall = data.inCall || false;
            state.callType = data.type || null;
            state.peerId = data.peerId || null;
            intercomState.set(deviceId, state);
            persistIntercomState(deviceId, state);

            // Manage watchdog timer
            if (data.inCall) {
                startCallTimeout(deviceId);
            } else {
                clearCallTimeout(deviceId);
            }

            // Save to history
            const db = global.app?.locals?.db;
            if (db && data.inCall === false && data.duration) {
                db.run(`
                    INSERT INTO intercom_calls (device_id, type, duration, start_time, end_time)
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                `, [deviceId, data.type || 'video', data.duration, data.startTime]);
            }

            // Emit status
            if (global.io) {
                global.io.to('device:' + deviceId).emit('intercom:status', {
                    deviceId,
                    inCall: data.inCall,
                    type: data.type
                });
            }
        }
    } catch (error) {
        logger.error('Error handling MQTT message:', error);
    }
}

// Export handler for mqttHandlers.js
module.exports = router;
module.exports.handleMqttMessage = handleMqttMessage;
