const mqtt = require('mqtt');
const logger = require('../utils/logger');
const EventEmitter = require('events');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const {
    resolveSmsCommandForRecipient,
    buildSmsTransportMetadataForRecipient,
    resolveSmsTimeoutMs
} = require('../utils/smsLimits');
const { buildDashboardDeviceStatus } = require('../utils/dashboardStatus');
const {
    normalizeSmsDeliveryPayload,
    normalizeSmsDeliveryReport,
    parseSmsMessageReference
} = require('../utils/smsDeliveryReports');

const FIRMWARE_ACTION_ID_MAX_LENGTH = 31;

function hasEnv(name) {
    return Object.prototype.hasOwnProperty.call(process.env, name);
}

function generateClientId() {
    return `dashboard_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`;
}

function resolveClientId(clientId) {
    const configured = String(clientId || '').trim();
    return configured || generateClientId();
}

function parsePort(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function firstDefinedBoolean(...values) {
    for (const value of values) {
        if (typeof value === 'boolean') {
            return value;
        }
    }
    return undefined;
}

function buildSimScopedPayload(payload = {}, options = {}) {
    const scopedPayload = normalizeMqttContractPayload(payload);
    const simSlot = Number.parseInt(
        String(options?.simSlot ?? options?.sim_slot ?? scopedPayload.sim_slot ?? '').trim(),
        10
    );

    if (Number.isInteger(simSlot) && simSlot >= 0) {
        scopedPayload.sim_slot = simSlot;
    }

    return scopedPayload;
}

function normalizeMqttContractPayload(payload = {}) {
    const normalized = { ...(payload || {}) };
    const simSlot = Number.parseInt(String(normalized.sim_slot ?? normalized.simSlot ?? '').trim(), 10);

    delete normalized.simSlot;

    if (Number.isInteger(simSlot) && simSlot >= 0) {
        normalized.sim_slot = simSlot;
    } else if (normalized.sim_slot === '' || normalized.sim_slot === null || normalized.sim_slot === undefined) {
        delete normalized.sim_slot;
    }

    return normalized;
}

function buildOptionsFromEnvironment(fallback = {}, overrides = {}) {
    const username = overrides.username ?? (hasEnv('MQTT_USER') ? process.env.MQTT_USER : fallback.username);
    const password = overrides.password ?? (hasEnv('MQTT_PASSWORD') ? process.env.MQTT_PASSWORD : fallback.password);
    const rejectUnauthorized = overrides.rejectUnauthorized ?? (
        hasEnv('MQTT_REJECT_UNAUTHORIZED')
            ? process.env.MQTT_REJECT_UNAUTHORIZED === 'true'
            : Boolean(fallback.rejectUnauthorized)
    );

    return {
        host: overrides.host ?? (process.env.MQTT_HOST || fallback.host || 'localhost'),
        port: parsePort(overrides.port ?? (hasEnv('MQTT_PORT') ? process.env.MQTT_PORT : fallback.port), fallback.port || 1883),
        protocol: overrides.protocol ?? (process.env.MQTT_PROTOCOL || fallback.protocol || 'mqtt'),
        username: username || undefined,
        password: password || undefined,
        clientId: resolveClientId(overrides.clientId ?? (hasEnv('MQTT_CLIENT_ID') ? process.env.MQTT_CLIENT_ID : fallback.clientId)),
        keepalive: overrides.keepalive ?? fallback.keepalive ?? 60,
        clean: overrides.clean ?? fallback.clean ?? true,
        reconnectPeriod: overrides.reconnectPeriod ?? fallback.reconnectPeriod ?? -1,
        connectTimeout: overrides.connectTimeout ?? fallback.connectTimeout ?? 30 * 1000,
        rejectUnauthorized
    };
}

function sanitizeMqttError(error) {
    const rawMessage = String(error?.message || error || '').trim();
    const code = String(error?.code || '').trim();
    const message = rawMessage || code || 'MQTT connection error';

    if (/not authorized|bad username|auth/i.test(message)) return 'MQTT auth failed';
    if (code === 'ECONNREFUSED' || /ECONNREFUSED|connection refused/i.test(message)) return 'Broker unreachable';
    if (code === 'ETIMEDOUT' || /timed?\s*out/i.test(message)) return 'Connection timed out';
    if (code === 'ENOTFOUND' || /ENOTFOUND|getaddrinfo/i.test(message)) return 'Broker host not found';

    return message
        .replace(/mqtt:\/\/[^@\s]+@/gi, 'mqtt://')
        .substring(0, 180);
}

function normalizeIncomingEventTimestamp(value, fallbackIso) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) {
            const parsed = new Date(trimmed);
            if (Number.isFinite(parsed.getTime()) && parsed.getFullYear() >= 2020) {
                return parsed.toISOString();
            }
        }
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        const parsed = new Date(value);
        if (Number.isFinite(parsed.getTime()) && parsed.getFullYear() >= 2020) {
            return parsed.toISOString();
        }
    }

    return fallbackIso;
}

const DURABLE_COMMANDS = new Set([
    'send-sms',
    'send-sms-multipart',
    'restart',
    'restart-modem',
    'ota-update',
    'storage-write',
    'storage-delete',
    'storage-mkdir',
    'storage-rename',
    'storage-move',
    'storage-copy',
    'storage-format',
    'storage-reinit',
    'gpio-write',
    'gpio-mode',
    'gpio-pwm',
    'led',
    'display-text',
    'display-clear',
    'display-flip',
    'display-invert',
    'display-on',
    'display-off',
    'display-brightness',
    'gps-set-enabled',
    'gps-configure'
]);

const ACK_REQUIRED_DURABLE_COMMANDS = new Set([
    'send-sms',
    'send-sms-multipart',
    'restart',
    'restart-modem',
    'ota-update',
    'storage-write',
    'storage-delete',
    'storage-mkdir',
    'storage-rename',
    'storage-move',
    'storage-copy',
    'storage-format',
    'storage-reinit',
    'gpio-write',
    'gpio-mode',
    'gpio-pwm',
    'led',
    'display-text',
    'display-clear',
    'display-flip',
    'display-invert',
    'display-on',
    'display-off',
    'display-brightness',
    'gps-set-enabled',
    'gps-configure'
]);

// ESP32 firmware has its own automation queue, so durable SMS rows can be
// pre-dispatched and settled by the later action/result. Android stays on the
// synchronous path because the phone bridge has its own OS-level SMS behavior.
const ESP32_ASYNC_RESULT_DURABLE_COMMANDS = new Set([
    'send-sms',
    'send-sms-multipart'
]);

const NON_REPLAY_SAFE_COMMANDS = new Set([
    'send-sms',
    'send-sms-multipart',
    'send-ussd',
    'cancel-ussd',
    'make-call',
    'call-dial',
    'answer-call',
    'reject-call',
    'end-call',
    'hold-call',
    'mute-call'
]);

const TELEPHONY_COMMANDS = new Set([
    'send-sms',
    'send-sms-multipart',
    'send-ussd',
    'cancel-ussd',
    'make-call',
    'call-dial',
    'answer-call',
    'reject-call',
    'end-call',
    'hold-call',
    'mute-call'
]);

const SYSTEM_COMMANDS = new Set([
    'restart',
    'restart-modem',
    'ota-update'
]);

const BACKGROUND_COMMAND_COALESCE_WINDOW_MS = 1500;
const COMMAND_CHANNEL_RETRY_DELAY_MS = 2000;

class MQTTService extends EventEmitter {
    constructor() {
        super();
        this.client = null;
        this.connected = false;
        this.connecting = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 20;
        this.reconnectDelay = 1000; // Start at 1s, doubles each attempt, capped at 60s
        this.reconnectTimer = null;
        this.maxReconnectNotified = false;
        this.connectionTimeout = null;
        this.manualDisconnect = false;
        this.lastError = null;
        this.lastErrorAt = null;
        
        // Load options from environment
        this.options = buildOptionsFromEnvironment();
        
        this.subscribedTopics = new Set();
        this.messageHandlers = new Map();
        this.pendingMessages = new Map();
        this.deviceStatus = new Map(); // Track device last seen
        this.seenMessages = new Set(); // Dedup cache keyed by topic+messageId
        this.deviceCommandQueues = new Map(); // Priority scheduler per device
        this.deviceOperationContext = new AsyncLocalStorage();
        this.deviceBusyUntil = new Map(); // Suppress automatic polling during long-running foreground commands
        this.activePersistentCommands = new Set();
        this._persistentQueueTickRunning = false;
        this._persistentQueueRecovered = false;
        this._persistentQueueWaiters = new Map();
        this._persistentQueueTimer = null;
        this._ensurePersistentQueueTimer();
        
        // Bind methods to maintain 'this' context
        this.handleConnect = this.handleConnect.bind(this);
        this.handleClose = this.handleClose.bind(this);
        this.handleError = this.handleError.bind(this);
        this.handleOffline = this.handleOffline.bind(this);
        this.handleMessage = this.handleMessage.bind(this);
        this.handleReconnect = this.handleReconnect.bind(this);
    }

    _ensurePersistentQueueTimer() {
        if (this._persistentQueueTimer) {
            return;
        }

        this._persistentQueueTimer = setInterval(() => {
            this.processPersistentQueue().catch((error) => {
                logger.error('Persistent command queue tick failed:', error);
            });
        }, 1000);
        this._persistentQueueTimer.unref?.();
    }

    connect() {
        this._ensurePersistentQueueTimer();
        this.manualDisconnect = false;
        // Clear any pending reconnect
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.connected || this.connecting) {
            logger.warn('MQTT already connecting or connected');
            return;
        }

        this.connecting = true;
        this.emit('connecting');

        // Build broker URL
        const brokerUrl = `${this.options.protocol}://${this.options.host}:${this.options.port}`;
        
        logger.info('Connecting to MQTT broker...', {
            url: brokerUrl,
            username: this.options.username,
            clientId: this.options.clientId
            // password intentionally not logged
        });

        try {
            // Set connection timeout
            this.connectionTimeout = setTimeout(() => {
                if (this.connecting && !this.connected) {
                    logger.error('MQTT connection timeout');
                    if (this.client) {
                        this.client.end(true);
                    }
                    this.connecting = false;
                    const timeoutError = new Error('Connection timeout');
                    this.lastError = sanitizeMqttError(timeoutError);
                    this.lastErrorAt = new Date().toISOString();
                    this.emit('error', timeoutError);
                    this.scheduleReconnect();
                }
            }, this.options.connectTimeout);
            this.connectionTimeout.unref();

            this.client = mqtt.connect(brokerUrl, {
                clientId: this.options.clientId,
                username: this.options.username,
                password: this.options.password,
                keepalive: this.options.keepalive,
                clean: this.options.clean,
                reconnectPeriod: this.options.reconnectPeriod,
                connectTimeout: this.options.connectTimeout,
                rejectUnauthorized: this.options.rejectUnauthorized
            });

            this.client.on('connect', this.handleConnect);
            this.client.on('close', this.handleClose);
            this.client.on('error', this.handleError);
            this.client.on('offline', this.handleOffline);
            this.client.on('message', this.handleMessage);
            this.client.on('reconnect', this.handleReconnect);

        } catch (error) {
            this.connecting = false;
            clearTimeout(this.connectionTimeout);
            this.lastError = sanitizeMqttError(error);
            this.lastErrorAt = new Date().toISOString();
            logger.error('MQTT connection error:', error);
            this.emit('error', error);
            this.scheduleReconnect();
        }
    }

    handleConnect() {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
        this.connected = true;
        this.connecting = false;
        this.reconnectAttempts = 0;
        this.maxReconnectNotified = false;
        this.lastError = null;
        this.lastErrorAt = null;
        
        // Subscribe to all device topics
        this.subscribeToDefaultTopics();
        
        this.emit('connect');
        
        // Emit via global IO if available
        if (global.io) {
            global.io.emit('mqtt:status', this.getStatus());
        }

        this.processPersistentQueue().catch((error) => {
            logger.error('Failed to process persistent command queue after MQTT connect:', error);
        });
    }

    subscribeToDefaultTopics() {
        const topics = [
            'device/+/status',
            'device/+/heartbeat',
            'device/+/sms/incoming',
            'device/+/sms/delivered',
            'device/+/call/incoming',
            'device/+/call/status',
            'device/+/call/events',
            'device/+/ussd/result',
            'device/+/webcam/image',
            'device/+/wifi/scan',
            'device/+/wifi/status-change',
            'device/+/hotspot/clients',
            'device/+/location',
            'device/+/nfc/read',
            'device/+/rfid/scan',
            'device/+/touch/event',
            'device/+/keyboard/key',
            'device/+/sensor/value',
            // Intercom/WebRTC signaling + call lifecycle
            'device/+/intercom-signal',
            'device/+/intercom-call-status',
            'device/+/command/response',
            'device/+/action/result',
            // Storage topics
            'device/+/storage/list',
            'device/+/storage/info',
            'device/+/storage/read',
            'device/+/storage/write',
            'device/+/storage/delete',
            'device/+/storage/rename',
            'device/+/storage/move',
            'device/+/storage/copy',
            'device/+/storage/mkdir',
            'device/+/device-log/info',
            'device/+/device-log/read',
            'device/+/device-log/clear',
            // GPS topics
            'device/+/gps/status',
            'device/+/gps/location',
            // GPIO topics
            'device/+/gpio/status',
            'device/+/gpio/read',
            'device/+/gpio/write',
            // OTA topics (device reports flash progress/status)
            'device/+/ota/progress',
            'device/+/ota/status',

            // Device self-test results
            'device/+/test/result',
            'device/+/test/progress',

            // Device capability profile (published on connect)
            'device/+/capabilities'
        ];

        this.subscribe(topics);
    }

    _firmwareCommandName(command) {
        switch (String(command || '').trim()) {
            case 'send-sms':
                return 'send_sms';
            case 'send-sms-multipart':
                return 'send_sms_multipart';
            case 'send-ussd':
                return 'send_ussd';
            case 'make-call':
            case 'call-dial':
                return 'dial_number';
            case 'reject-call':
            case 'end-call':
                return 'hangup_call';
            case 'restart':
                return 'reboot_device';
            case 'storage-list':
                return 'file_list';
            case 'storage-delete':
                return 'file_delete';
            default:
                return String(command || '').trim().replace(/-/g, '_');
        }
    }

    _buildFirmwareCompatibleMessage(command, payload = {}, messageId, source) {
        const normalizedCommand = String(command || '').trim();

        if (normalizedCommand === 'send-sms' || normalizedCommand === 'send-sms-multipart') {
            const text = String(payload.message || payload.text || '');
            const number = String(payload.to || payload.number || '').trim();
            const payloadSmsMetadata = Object.fromEntries(
                Object.entries(payload || {}).filter(([key]) => key.startsWith('sms_'))
            );
            const payloadProvidesPdu = typeof payloadSmsMetadata.sms_pdu === 'string' &&
                payloadSmsMetadata.sms_pdu.trim();
            const smsMetadata = {
                ...(payloadProvidesPdu ? {} : buildSmsTransportMetadataForRecipient(number, text)),
                ...payloadSmsMetadata
            };
            const metadataPduIsMultipart = Number(smsMetadata.sms_pdu_count) > 1 ||
                (typeof smsMetadata.sms_pdu === 'string' && smsMetadata.sms_pdu.includes(';'));
            const hasDashboardPdu = typeof smsMetadata.sms_pdu === 'string' &&
                smsMetadata.sms_pdu.trim() &&
                (payloadProvidesPdu || !metadataPduIsMultipart);
            const message = {
                action_id: messageId
            };
            if (hasDashboardPdu) {
                message.sms_pdu = smsMetadata.sms_pdu;
            } else {
                message.command = normalizedCommand === 'send-sms-multipart' ? 'send_sms_multipart' : 'send_sms';
                message.number = number;
                message.text = text;
                if (smsMetadata.sms_transport_encoding) {
                    message.sms_transport_encoding = smsMetadata.sms_transport_encoding;
                }
                if (Number.isFinite(Number(smsMetadata.sms_parts)) && Number(smsMetadata.sms_parts) > 0) {
                    message.sms_parts = Number(smsMetadata.sms_parts);
                }
            }
            if (!hasDashboardPdu && Number.isFinite(Number(payload.timeout)) && Number(payload.timeout) > 0) {
                message.timeout = Number(payload.timeout);
            }
            if (payload.sim_slot !== null && payload.sim_slot !== undefined && payload.sim_slot !== '') {
                message.sim_slot = Number(payload.sim_slot);
            }
            return message;
        }

        const message = {
            ...payload,
            messageId,
            action_id: messageId,
            command: this._firmwareCommandName(command),
            timestamp: Date.now(),
            source
        };

        switch (normalizedCommand) {
            case 'send-sms':
            case 'send-sms-multipart':
                if (!message.number && payload.to) message.number = String(payload.to).trim();
                if (!message.text && payload.message) message.text = String(payload.message);
                break;
            case 'send-ussd':
                if (!message.code && payload.ussd) message.code = String(payload.ussd).trim();
                break;
            case 'storage-list':
                if (message.path == null) message.path = '';
                if (message.max_entries == null && Number.isFinite(Number(payload.limit))) {
                    message.max_entries = Number(payload.limit);
                }
                break;
            case 'storage-delete':
                if (!message.path && Array.isArray(payload.items) && payload.items.length === 1) {
                    message.path = String(payload.items[0] || '').trim();
                }
                break;
            default:
                break;
        }

        return message;
    }

    _normalizeIncomingPayload(topicParts, data) {
        const normalized = (data && typeof data === 'object' && !Array.isArray(data)) ? { ...data } : data;

        if (!normalized || typeof normalized !== 'object') {
            return normalized;
        }

        if (topicParts[2] === 'sms' && topicParts[3] === 'incoming' && !normalized.message && normalized.text) {
            normalized.message = normalized.text;
        }

        if (topicParts[2] === 'call' && topicParts[3] === 'events') {
            normalized.status = normalized.status || normalized.state || '';
        }

        if (topicParts[2] === 'action' && topicParts[3] === 'result') {
            if (!normalized.messageId && normalized.action_id) {
                normalized.messageId = normalized.action_id;
            }
            if (normalized.success == null) {
                const result = String(normalized.result || '').toLowerCase();
                normalized.success = result === 'completed' || result === 'accepted';
            }
            if (!normalized.message && normalized.detail) {
                normalized.message = normalized.detail;
            }
            if (!normalized.error && normalized.success === false) {
                normalized.error = normalized.detail || 'Command failed';
            }
        }

        return normalized;
    }

    _resolvePendingMessage(data) {
        const correlationId = String(data?.messageId || data?.action_id || '').trim();
        if (!correlationId || !this.pendingMessages.has(correlationId)) {
            return false;
        }

        const pending = this.pendingMessages.get(correlationId);
        clearTimeout(pending.timeout);
        pending.resolve(data);
        this.pendingMessages.delete(correlationId);
        logger.debug(`Resolved pending message: ${correlationId}`);
        return true;
    }

    _emitCompatibilityEvents(topicParts, deviceId, data) {
        if (topicParts[2] === 'call' && topicParts[3] === 'events') {
            this.emit('call:status', deviceId, data);
            if (['incoming', 'ringing'].includes(String(data?.status || '').toLowerCase())) {
                this.emit('call:incoming', deviceId, data);
            }
            return;
        }

        if (topicParts[2] === 'action' && topicParts[3] === 'result') {
            this.emit('action:result', deviceId, data);
            this.emit('command:response', deviceId, data);

            let payload = data?.payload && typeof data.payload === 'object' ? data.payload : {};
            if (typeof data?.payload === 'string' && data.payload.trim()) {
                try {
                    const parsedPayload = JSON.parse(data.payload);
                    if (parsedPayload && typeof parsedPayload === 'object' && !Array.isArray(parsedPayload)) {
                        payload = parsedPayload;
                    }
                } catch (_) {
                    payload = {};
                }
            }
            switch (String(data?.command || '').toLowerCase()) {
                case 'wifi_scan':
                    if (data.success !== false || Array.isArray(payload.networks)) {
                        this.emit('wifi:scan', deviceId, {
                            networks: Array.isArray(payload.networks) ? payload.networks : [],
                            report: payload.report || null,
                            success: data.success,
                            messageId: data.messageId,
                            detail: data.detail
                        });
                    }
                    break;
                case 'file_list':
                    this.emit('storage:list', deviceId, {
                        ...payload,
                        success: data.success,
                        messageId: data.messageId,
                        detail: data.detail
                    });
                    break;
                case 'file_delete':
                    this.emit('storage:delete', deviceId, {
                        ...payload,
                        success: data.success,
                        messageId: data.messageId,
                        detail: data.detail
                    });
                    break;
                default:
                    break;
            }
        }
    }

    _buildCompatibilityStorageInfo(deviceId, messageId) {
        const snapshot = this.deviceStatus.get(deviceId)?.lastStatus;
        if (!snapshot || typeof snapshot !== 'object') {
            return null;
        }

        return {
            success: true,
            messageId,
            mounted: Boolean((snapshot.storage_media_mounted ?? snapshot.sd_mounted) && snapshot.storage_media_available),
            cardDetected: Boolean(snapshot.storage_media_available),
            bufferedOnly: Boolean(snapshot.storage_buffered_only),
            queueDepth: Number(snapshot.storage_queue_depth || 0),
            droppedCount: Number(snapshot.storage_dropped_count || 0),
            total: 0,
            used: 0,
            free: 0
        };
    }

    _emitCompatibilityCommandResponse(eventName, deviceId, payload) {
        setImmediate(() => {
            this.emit(eventName, deviceId, payload);
        });
    }

    _deviceCommandChannelState(deviceId) {
        const entry = this.deviceStatus.get(deviceId) || {};
        const snapshot = entry.lastStatus && typeof entry.lastStatus === 'object'
            ? entry.lastStatus
            : null;
        const liveStatus = global.modemService?.getDeviceStatus?.(deviceId) || null;
        const online = Boolean(
            liveStatus?.online === true ||
            entry.online === true ||
            snapshot?.online === true ||
            this.isDeviceOnline(deviceId) ||
            global.modemService?.isDeviceOnline?.(deviceId) === true
        );
        const normalized = snapshot && typeof snapshot === 'object'
            ? buildDashboardDeviceStatus(snapshot, online)
            : null;
        const connected = firstDefinedBoolean(
            liveStatus?.transport?.mqttCommandAccepting === true ? true : undefined,
            liveStatus?.mqtt?.connected,
            liveStatus?.status?.mqtt?.connected,
            normalized?.mqtt?.connected,
            snapshot?.status?.mqtt?.connected,
            snapshot?.mqtt?.connected,
            snapshot?.mqtt_connected
        );
        const subscribed = firstDefinedBoolean(
            liveStatus?.transport?.mqttCommandAccepting === true ? true : undefined,
            liveStatus?.mqtt?.subscribed,
            liveStatus?.status?.mqtt?.subscribed,
            normalized?.mqtt?.subscribed,
            snapshot?.status?.mqtt?.subscribed,
            snapshot?.mqtt?.subscribed,
            snapshot?.mqtt_subscribed
        );
        const acceptsCommands = firstDefinedBoolean(
            liveStatus?.transport?.mqttCommandAccepting,
            liveStatus?.status?.transport?.mqttCommandAccepting,
            normalized?.transport?.mqttCommandAccepting,
            snapshot?.status?.transport?.mqttCommandAccepting,
            snapshot?.transport?.mqttCommandAccepting,
            snapshot?.mqttCommandAccepting,
            snapshot?.mqtt_command_accepting
        );
        const hasEvidence = [connected, subscribed, acceptsCommands].some((value) => typeof value === 'boolean');

        return {
            online,
            connected: connected === true,
            subscribed: subscribed === true,
            acceptsCommands: hasEvidence
                ? (acceptsCommands === true || (connected === true && subscribed === true))
                : true,
            hasEvidence
        };
    }

    _deviceCommandChannelPendingReason(deviceId) {
        const state = this._deviceCommandChannelState(deviceId);
        if (!state.hasEvidence) {
            return null;
        }
        if (state.acceptsCommands) {
            return null;
        }
        if (!state.online) {
            return 'Device is offline';
        }
        if (state.connected && !state.subscribed) {
            return 'Device MQTT connected but command subscription is not ready';
        }
        if (state.connected && !state.acceptsCommands) {
            return 'Device MQTT connected but not accepting commands yet';
        }
        if (!state.connected) {
            return 'Device MQTT command channel is not connected';
        }
        return 'Device command channel is not ready';
    }

    _maybeHandleCompatibilityCommand(deviceId, command, messageId, options = {}) {
        if (options?.bypassCompatibility === true) {
            return null;
        }

        if (String(command || '').trim() === 'get-status') {
            const snapshot = this.deviceStatus.get(deviceId)?.lastStatus;
            if (!snapshot || typeof snapshot !== 'object') {
                return null;
            }

            const response = {
                ...snapshot,
                success: true,
                messageId
            };
            this._emitCompatibilityCommandResponse('status', deviceId, response);
            return Promise.resolve(response);
        }

        if (String(command || '').trim() === 'storage-info') {
            const response = this._buildCompatibilityStorageInfo(deviceId, messageId);
            if (!response) {
                return null;
            }

            this._emitCompatibilityCommandResponse('storage:info', deviceId, response);
            return Promise.resolve(response);
        }

        return null;
    }

    handleClose() {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
        this.connected = false;
        this.connecting = false;
        logger.warn('⚠️ MQTT connection closed');
        this.emit('close');
        
        // Reject all pending messages
        this.pendingMessages.forEach((pending, messageId) => {
            clearTimeout(pending.timeout);
            pending.reject(new Error('MQTT connection closed'));
        });
        this.pendingMessages.clear();
        
        // Emit via global IO if available
        if (global.io) {
            global.io.emit('mqtt:status', this.getStatus());
        }
        
        if (!this.manualDisconnect) {
            this.scheduleReconnect();
        }
    }

    handleError(error) {
        this.lastError = sanitizeMqttError(error);
        this.lastErrorAt = new Date().toISOString();
        logger.error(`❌ MQTT error: ${error.message}`);
        this.emit('error', error);
        
        // Don't schedule reconnect here, handleClose will be called
    }

    handleOffline() {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
        this.connected = false;
        this.connecting = false;
        logger.warn('⚠️ MQTT offline');
        this.emit('offline');
        
        // Emit via global IO if available
        if (global.io) {
            global.io.emit('mqtt:status', this.getStatus());
        }
        
        if (!this.manualDisconnect) {
            this.scheduleReconnect();
        }
    }

    handleReconnect() {
        logger.info('🔄 MQTT reconnecting...');
        this.emit('reconnect');
    }

    handleMessage(topic, message) {
        try {
            const messageStr = message.toString();
            
            // Parse message (try JSON first, fallback to raw)
            let data;
            try {
                data = JSON.parse(messageStr);
            } catch (e) {
                data = { 
                    raw: messageStr,
                    contentType: 'text/plain'
                };
            }

            const topicParts = topic.split('/');
            data = this._normalizeIncomingPayload(topicParts, data);

            logger.debug(`📨 MQTT message received on ${topic}:`,
                typeof data === 'object' ? JSON.stringify(data).substring(0, 200) : String(data).substring(0, 200));

            // Deduplicate exact broker repeats, but allow the same messageId to
            // appear on multiple topics for a single command flow.
            const correlationId = data?.messageId || data?.action_id;
            if (correlationId && typeof correlationId === 'string') {
                const dedupeKey = `${topic}|${correlationId}`;
                if (this.seenMessages.has(dedupeKey)) {
                    logger.debug(`Duplicate MQTT message ignored: ${dedupeKey}`);
                    return;
                }
                this.seenMessages.add(dedupeKey);
                if (this.seenMessages.size > 400) {
                    const iter = this.seenMessages.values();
                    for (let i = 0; i < 200; i++) this.seenMessages.delete(iter.next().value);
                }
            }

            // Extract device ID from topic (format: device/{deviceId}/{type}/{action})
            if (topicParts.length >= 2) {
                const deviceId = topicParts[1];
                const existingStatus = this.deviceStatus.get(deviceId) || {};
                const actionDerivedStatus = this._buildStatusFromActionResult(deviceId, data);
                const primaryStatusData = actionDerivedStatus || data;

                const receivedAt = new Date().toISOString();
                data.deviceId = deviceId;
                data.topic = topic;
                data.receivedAt = receivedAt;
                data.timestamp = normalizeIncomingEventTimestamp(data.timestamp, receivedAt);

                const isPrimaryStatus = (topicParts.length === 3 && topicParts[2] === 'status') ||
                    Boolean(actionDerivedStatus) ||
                    data.type === 'status' ||
                    data.type === 'device_status';

                // Update device last seen
                this.deviceStatus.set(deviceId, {
                    ...existingStatus,
                    lastSeen: receivedAt,
                    online: true,
                    lastStatus: isPrimaryStatus ? { ...primaryStatusData } : existingStatus.lastStatus
                });

                // Always emit a heartbeat for any message from device
                this.emit('heartbeat', deviceId, { timestamp: receivedAt });

                // Only treat device/{id}/status as the primary status snapshot.
                if (isPrimaryStatus) {
                    this.emit('status', deviceId, primaryStatusData);
                }

                this._resolvePendingMessage(data);
                if (topicParts[2] === 'action' && topicParts[3] === 'result') {
                    this._settlePersistentQueueFromResponse(deviceId, data).catch((error) => {
                        logger.error('Failed to settle persistent queue from action result:', error);
                    });
                } else if (topicParts[2] === 'sms' && (topicParts[3] === 'delivered' || topicParts[3] === 'delivery')) {
                    const deliveryData = topicParts[3] === 'delivered'
                        ? { ...data, status: data?.status || 'delivered', delivered: data?.delivered !== false }
                        : data;
                    this._settlePersistentQueueFromSmsDelivery(deviceId, deliveryData).catch((error) => {
                        logger.error('Failed to settle persistent queue from SMS delivery:', error);
                    });
                }

                // Emit event for specific message type
                if (topicParts.length >= 4) {
                    // Format: device/deviceId/type/action
                    const eventName = `${topicParts[2]}:${topicParts[3]}`;
                    this.emit(eventName, deviceId, data);
                    
                    // Also emit a generic event for the action
                    this.emit(topicParts[3], deviceId, data);
                } else if (topicParts.length >= 3) {
                    // Format: device/deviceId/type
                    const eventName = topicParts[2];
                    this.emit(eventName, deviceId, data);
                }

                this._emitCompatibilityEvents(topicParts, deviceId, data);
            }

            // Call registered handlers
            for (const [pattern, handler] of this.messageHandlers) {
                if (this.topicMatches(pattern, topic)) {
                    try {
                        handler(topic, data);
                    } catch (handlerError) {
                        logger.error('Error in message handler:', handlerError);
                    }
                }
            }

        } catch (error) {
            logger.error('Error handling MQTT message:', error);
        }
    }

    scheduleReconnect() {
        // Clear any existing reconnect timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            if (!this.maxReconnectNotified) {
                logger.error('❌ Max reconnection attempts reached');
                this.emit('max_reconnect');
                this.maxReconnectNotified = true;
            }

            const delay = 60000;
            logger.warn(`MQTT still disconnected after max retries; retrying again in ${Math.round(delay / 1000)}s`);
            this.reconnectTimer = setTimeout(() => {
                if (!this.connected && !this.connecting) {
                    logger.info('🔄 Attempting recovery reconnect after max retries...');
                    this.connect();
                }
                this.reconnectTimer = null;
            }, delay);
            this.reconnectTimer.unref();
            return;
        }

        this.reconnectAttempts++;
        
        // Exponential backoff: 1s → 2s → 4s → ... → 60s max
        const delay = Math.min(
            this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
            60000
        );
        
        logger.info(`⏳ Scheduling reconnect in ${Math.round(delay/1000)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        
        this.reconnectTimer = setTimeout(() => {
            if (!this.connected && !this.connecting) {
                logger.info('🔄 Attempting to reconnect...');
                this.connect();
            }
            this.reconnectTimer = null;
        }, delay);
        this.reconnectTimer.unref();
    }

    subscribe(topics) {
        if (!this.connected || !this.client) {
            logger.warn('Cannot subscribe: MQTT not connected');
            return false;
        }

        const topicArray = Array.isArray(topics) ? topics : [topics];
        let successCount = 0;
        
        topicArray.forEach(topic => {
            this.client.subscribe(topic, { qos: 1 }, (err) => {
                if (err) {
                    logger.error(`Failed to subscribe to ${topic}:`, err);
                } else {
                    this.subscribedTopics.add(topic);
                    successCount++;
                    logger.info(`📡 Subscribed to ${topic}`);
                }
            });
        });

        return successCount === topicArray.length;
    }

    resubscribe() {
        if (this.subscribedTopics.size > 0) {
            logger.info(`🔄 Resubscribing to ${this.subscribedTopics.size} topics`);
            this.subscribedTopics.forEach(topic => {
                this.client.subscribe(topic, { qos: 1 }, (err) => {
                    if (err) logger.error(`Failed to resubscribe to ${topic}:`, err);
                });
            });
        }
    }

    unsubscribe(topics) {
        if (!this.connected || !this.client) return false;

        const topicArray = Array.isArray(topics) ? topics : [topics];
        let successCount = 0;
        
        topicArray.forEach(topic => {
            this.client.unsubscribe(topic, (err) => {
                if (err) {
                    logger.error(`Failed to unsubscribe from ${topic}:`, err);
                } else {
                    this.subscribedTopics.delete(topic);
                    successCount++;
                    logger.info(`Unsubscribed from ${topic}`);
                }
            });
        });

        return successCount === topicArray.length;
    }

    publish(topic, message, options = { qos: 1, retain: false }) {
        if (!this.connected || !this.client) {
            logger.error('Cannot publish: MQTT not connected');
            return Promise.reject(new Error('MQTT not connected'));
        }

        return new Promise((resolve, reject) => {
            const messageId = options.messageId || `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const payload = typeof message === 'string' ? message : JSON.stringify(message);

            this.client.publish(topic, payload, options, (err) => {
                if (err) {
                    logger.error(`Failed to publish to ${topic}:`, err);
                    reject(err);
                } else {
                    logger.debug(`📤 Published to ${topic}:`, payload.substring(0, 200));
                    resolve({ topic, messageId });
                }
            });
        });
    }

    _normalizeDeviceId(deviceId) {
        return String(deviceId || '').trim();
    }

    _busyDurationMs(command) {
        switch (String(command || '').trim()) {
            case 'send-ussd':
            case 'cancel-ussd':
                return 90_000;
            case 'send-sms':
            case 'send-sms-multipart':
                return 90_000;
            case 'make-call':
            case 'call-dial':
            case 'answer-call':
                return 240_000;
            case 'reject-call':
            case 'end-call':
            case 'hold-call':
            case 'mute-call':
                return 30_000;
            default:
                return 0;
        }
    }

    markDeviceBusy(deviceId, command, durationMs = null) {
        const normalized = this._normalizeDeviceId(deviceId);
        if (!normalized) return;

        const wasBusy = this.isDeviceBusy(normalized);
        const busyMs = durationMs == null ? this._busyDurationMs(command) : durationMs;
        if (!Number.isFinite(busyMs) || busyMs <= 0) return;

        const nextUntil = Date.now() + busyMs;
        const previousUntil = this.deviceBusyUntil.get(normalized) || 0;
        if (nextUntil > previousUntil) {
            this.deviceBusyUntil.set(normalized, nextUntil);
        }
        if (!wasBusy && this.isDeviceBusy(normalized)) {
            this.emit('device:busy-change', normalized, true);
        }
    }

    isDeviceBusy(deviceId) {
        const normalized = this._normalizeDeviceId(deviceId);
        if (!normalized) return false;

        const busyUntil = this.deviceBusyUntil.get(normalized) || 0;
        if (!busyUntil) return false;
        if (busyUntil <= Date.now()) {
            this.deviceBusyUntil.delete(normalized);
            return false;
        }
        return true;
    }

    clearDeviceBusy(deviceId) {
        const normalized = this._normalizeDeviceId(deviceId);
        if (!normalized) return;
        const wasBusy = this.deviceBusyUntil.has(normalized) || this.isDeviceBusy(normalized);
        this.deviceBusyUntil.delete(normalized);
        if (wasBusy) {
            this.emit('device:busy-change', normalized, false);
        }
    }

    hasDeviceQueueActivity(deviceId) {
        const normalized = this._normalizeDeviceId(deviceId);
        if (!normalized) return false;
        const state = this.deviceCommandQueues.get(normalized);
        return Boolean(state && (state.active || state.draining || (state.pending?.length || 0) > 0));
    }

    _db() {
        return global.app?.locals?.db || null;
    }

    _hasDbMethods(db, methods = []) {
        return Boolean(db) && methods.every((method) => typeof db?.[method] === 'function');
    }

    _dbParams(params) {
        if (params === undefined || params === null) return [];
        return Array.isArray(params) ? params : [params];
    }

    _rawDb(db) {
        if (typeof db?.prepare === 'function') return db;
        if (typeof db?._raw?.prepare === 'function') return db._raw;
        return null;
    }

    _canDbRun(db) {
        return typeof db?.run === 'function' || Boolean(this._rawDb(db));
    }

    async _dbRun(db, sql, params = []) {
        if (typeof db?.run === 'function') {
            return db.run(sql, params);
        }

        const rawDb = this._rawDb(db);
        if (!rawDb) {
            throw new Error('DB run method not available');
        }

        const result = rawDb.prepare(sql).run(...this._dbParams(params));
        return {
            lastID: result?.lastInsertRowid ?? 0,
            changes: result?.changes ?? 0
        };
    }

    _generateCommandMessageId(command) {
        const rawCommand = String(command || '').trim().toLowerCase();
        const prefix = rawCommand === 'send-sms' || rawCommand === 'send-sms-multipart'
            ? 'sms'
            : (rawCommand.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 12) || 'cmd');
        const stamp = Date.now().toString(36);
        const nonce = Math.random().toString(36).slice(2, 6);
        return `${prefix}_${stamp}_${nonce}`;
    }

    _normalizeCommandMessageId(command, value) {
        const raw = String(value || '').trim() || this._generateCommandMessageId(command);
        if (raw.length <= FIRMWARE_ACTION_ID_MAX_LENGTH) {
            return raw;
        }

        const rawCommand = String(command || '').trim().toLowerCase();
        const prefix = rawCommand === 'send-sms' || rawCommand === 'send-sms-multipart'
            ? 'sms'
            : (rawCommand.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 10) || 'cmd');
        const digest = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
        return `${prefix}_${digest}`.slice(0, FIRMWARE_ACTION_ID_MAX_LENGTH);
    }

    _generatePersistentQueueId() {
        return `dcq_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }

    _sqlTimestamp(epochMs = Date.now()) {
        return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
    }

    _isDurableCommand(command, options = {}) {
        if (options?.skipPersistentQueue) return false;
        if (options?.persistent === true) return true;
        return DURABLE_COMMANDS.has(String(command || '').trim());
    }

    _isReplaySafeCommand(command, options = {}) {
        if (options?.replaySafe !== undefined) {
            return Boolean(options.replaySafe);
        }

        const normalized = String(command || '').trim().toLowerCase();
        if (NON_REPLAY_SAFE_COMMANDS.has(normalized)) {
            return false;
        }

        return this._isDurableCommand(command, options);
    }

    _requiresDurableAck(command, waitForResponse, options = {}) {
        if (options?.forceResponse === true) return true;
        if (waitForResponse) return true;
        return ACK_REQUIRED_DURABLE_COMMANDS.has(String(command || '').trim());
    }

    _usesAsyncDurableResult(command, options = {}) {
        if (options?.forceSyncResponse === true) return false;
        return ESP32_ASYNC_RESULT_DURABLE_COMMANDS.has(String(command || '').trim());
    }

    async _isAndroidDevice(deviceId) {
        const normalizedDeviceId = this._normalizeDeviceId(deviceId);
        const db = this._db();
        if (!normalizedDeviceId || !this._hasDbMethods(db, ['get'])) {
            return false;
        }

        try {
            const row = await db.get(
                `SELECT type
                 FROM devices
                 WHERE id = ?
                 LIMIT 1`,
                [normalizedDeviceId]
            );
            return String(row?.type || '').trim().toLowerCase().includes('android');
        } catch (_) {
            return false;
        }
    }

    async _usesAsyncDurableResultForRow(row) {
        if (!row || !this._usesAsyncDurableResult(row.command)) {
            return false;
        }

        return !await this._isAndroidDevice(row.device_id);
    }

    async _hasActivePersistentCommandInDomain(deviceId, command, excludeId = null) {
        const normalizedDeviceId = this._normalizeDeviceId(deviceId);
        const domain = this._commandDomain(command);
        const db = this._db();
        if (!normalizedDeviceId || domain !== 'telephony' || !this._hasDbMethods(db, ['all'])) {
            return false;
        }

        const rows = await db.all(
            `SELECT id, command
             FROM device_command_queue
             WHERE device_id = ?
               AND status IN ('dispatching', 'waiting_response')`,
            [normalizedDeviceId]
        );

        return (rows || []).some((row) => {
            if (excludeId && row.id === excludeId) {
                return false;
            }
            return this._commandDomain(row.command) === domain;
        });
    }

    _commandDomain(command, options = {}) {
        const override = String(options?.domain || '').trim().toLowerCase();
        if (override) {
            return override;
        }

        const normalized = String(command || '').trim().toLowerCase();
        if (!normalized) {
            return 'control';
        }
        if (normalized === 'get-status') {
            return 'status';
        }
        if (TELEPHONY_COMMANDS.has(normalized)) {
            return 'telephony';
        }
        if (SYSTEM_COMMANDS.has(normalized)) {
            return 'system';
        }
        if (normalized.startsWith('storage-')) {
            return 'storage';
        }
        if (
            normalized === 'gps-status' ||
            normalized === 'gps-location' ||
            normalized === 'gpio-status' ||
            normalized === 'gpio-read' ||
            normalized === 'sensor-read'
        ) {
            return 'status';
        }
        if (
            normalized.startsWith('wifi-') ||
            normalized.startsWith('hotspot-') ||
            normalized.startsWith('network-') ||
            normalized.startsWith('modem-')
        ) {
            return 'network';
        }
        return 'control';
    }

    _defaultPriority(command, options = {}) {
        const normalized = String(command || '').trim().toLowerCase();

        if (Number.isFinite(options?.priority)) {
            return options.priority;
        }

        switch (normalized) {
            case 'send-sms':
            case 'send-sms-multipart':
            case 'send-ussd':
            case 'cancel-ussd':
            case 'make-call':
            case 'call-dial':
            case 'answer-call':
            case 'reject-call':
            case 'end-call':
            case 'hold-call':
            case 'mute-call':
                return 40;
            case 'get-status':
            case 'gpio-status':
            case 'gpio-read':
            case 'gps-status':
            case 'gps-location':
            case 'sensor-read':
                return 60;
            default:
                break;
        }

        switch (this._commandDomain(command, options)) {
            case 'telephony':
                return 40;
            case 'network':
                return 80;
            case 'system':
                return 120;
            case 'storage':
                return 140;
            case 'status':
                return 220;
            case 'control':
            default:
                return 100;
        }
    }

    _isBackgroundCommand(command, options = {}) {
        if (options?.background === true) {
            return true;
        }

        const source = String(options?.source || '').trim().toLowerCase();
        if (source === 'startup-prime' || source === 'status-watch' || source === 'system:auto') {
            return true;
        }

        return false;
    }

    _queuePriority(command, options = {}) {
        let priority = this._defaultPriority(command, options);

        if (this._isBackgroundCommand(command, options)) {
            priority += 500;
        }
        if (options?.userPriority === true) {
            priority = Math.max(0, priority - 20);
        }

        return priority;
    }

    _coalescingCommandKey(command, options = {}) {
        const normalized = String(command || '').trim().toLowerCase();
        if (!normalized || !this._isBackgroundCommand(command, options)) {
            return '';
        }

        const domain = this._commandDomain(normalized, options);
        if (domain !== 'status') {
            return '';
        }

        return `${domain}:${normalized}`;
    }

    _backgroundCommandCoalesceWindowMs(command, options = {}) {
        if (Number.isFinite(options?.coalesceWindowMs) && options.coalesceWindowMs > 0) {
            return Number(options.coalesceWindowMs);
        }

        return BACKGROUND_COMMAND_COALESCE_WINDOW_MS;
    }

    _getOrCreateDeviceQueueState(deviceId) {
        const queueKey = this._normalizeDeviceId(deviceId);
        if (!queueKey) {
            return null;
        }

        let state = this.deviceCommandQueues.get(queueKey);
        if (!state) {
            state = {
                active: false,
                activeEntry: null,
                draining: false,
                sequence: 0,
                pending: [],
                recentBackground: new Map()
            };
            this.deviceCommandQueues.set(queueKey, state);
        }

        state.active = state.active === true;
        state.activeEntry = state.activeEntry || null;
        state.draining = state.draining === true;
        state.sequence = Number.isFinite(state.sequence) ? Number(state.sequence) : 0;
        state.pending = Array.isArray(state.pending) ? state.pending : [];
        if (!(state.recentBackground instanceof Map)) {
            state.recentBackground = new Map();
        }

        return state;
    }

    _pruneDeviceQueueCooldowns(state, now = Date.now()) {
        if (!state?.recentBackground) {
            return;
        }

        for (const [key, expiresAt] of state.recentBackground.entries()) {
            if (!Number.isFinite(expiresAt) || expiresAt <= now) {
                state.recentBackground.delete(key);
            }
        }
    }

    _cleanupDeviceQueueState(deviceId) {
        const queueKey = this._normalizeDeviceId(deviceId);
        const state = this.deviceCommandQueues.get(queueKey);

        if (!queueKey || !state) {
            return;
        }
        this._pruneDeviceQueueCooldowns(state);
        if (!state.active && !state.draining && state.pending.length === 0 && state.recentBackground.size === 0) {
            this.deviceCommandQueues.delete(queueKey);
        }
    }

    _insertPendingDeviceTask(state, entry) {
        let index = state.pending.findIndex((candidate) => (
            candidate.priority > entry.priority ||
            (candidate.priority === entry.priority && candidate.sequence > entry.sequence)
        ));

        if (index < 0) {
            index = state.pending.length;
        }
        state.pending.splice(index, 0, entry);
    }

    _dropSupersededBackgroundTasks(deviceId, state, incomingEntry) {
        if (!state || !incomingEntry || incomingEntry.background === true) {
            return;
        }

        const retained = [];
        const dropped = [];
        for (const entry of state.pending) {
            if (entry.background === true) {
                dropped.push(entry);
            } else {
                retained.push(entry);
            }
        }

        if (!dropped.length) {
            return;
        }

        state.pending = retained;
        for (const entry of dropped) {
            const error = new Error('Superseded by higher priority command');
            error.code = 'COMMAND_SUPERSEDED';
            entry.reject(error);
        }

        logger.debug(`Dropped ${dropped.length} background command(s) for ${deviceId} in favor of foreground work`);
    }

    _findCoalescedDeviceTask(state, coalesceKey) {
        if (!state || !coalesceKey) {
            return null;
        }

        if (state.activeEntry?.coalesceKey === coalesceKey) {
            return state.activeEntry;
        }

        return state.pending.find((entry) => entry.coalesceKey === coalesceKey) || null;
    }

    _deviceQueueSettlingDelayMs(entry) {
        const command = String(entry?.command || '').trim().toLowerCase();

        if (entry?.background === true) {
            return 200;
        }

        if (TELEPHONY_COMMANDS.has(command)) {
            return 40;
        }

        switch (command) {
            case 'get-status':
            case 'gpio-status':
            case 'gpio-read':
            case 'gps-status':
            case 'gps-location':
            case 'sensor-read':
                return 50;
            default:
                return 120;
        }
    }

    _drainDeviceQueue(deviceId) {
        const queueKey = this._normalizeDeviceId(deviceId);
        const state = this.deviceCommandQueues.get(queueKey);

        if (!queueKey || !state || state.active || state.draining) {
            return;
        }

        state.draining = true;
        setImmediate(async () => {
            const currentState = this.deviceCommandQueues.get(queueKey);
            if (!currentState) {
                return;
            }

            currentState.draining = false;
            if (currentState.active) {
                return;
            }

            const next = currentState.pending.shift();
            if (!next) {
                this._cleanupDeviceQueueState(queueKey);
                return;
            }

            currentState.active = true;
            currentState.activeEntry = next;
            try {
                const result = await this.deviceOperationContext.run({ deviceId: queueKey }, next.task);
                next.resolve(result);
            } catch (error) {
                next.reject(error);
            } finally {
                currentState.active = false;
                currentState.activeEntry = null;
                if (next.coalesceKey) {
                    currentState.recentBackground.set(
                        next.coalesceKey,
                        Date.now() + Math.max(200, Number(next.coalesceWindowMs || 0))
                    );
                }
                this._pruneDeviceQueueCooldowns(currentState);
                await new Promise(resolve => setTimeout(resolve, this._deviceQueueSettlingDelayMs(next)));
                this._cleanupDeviceQueueState(queueKey);
                this._drainDeviceQueue(queueKey);
            }
        });
    }

    async _publishCommandNow(deviceId, command, payload = {}, waitForResponse = false, timeout = 30000, options = {}) {
        if (!this.connected) {
            return Promise.reject(new Error('MQTT not connected'));
        }

        const normalizedPayload = normalizeMqttContractPayload(payload);
        const normalizedCommand = String(command || '').trim().toLowerCase();
        if ((normalizedCommand === 'send-sms' || normalizedCommand === 'send-sms-multipart') &&
            (!Number.isFinite(Number(normalizedPayload.timeout)) || Number(normalizedPayload.timeout) <= 0)) {
            normalizedPayload.timeout = Number(timeout || 30000);
        }
        const topic = `device/${deviceId}/command/${command}`;
        const messageId = this._normalizeCommandMessageId(command, options.messageId);
        const compatibilityResponse = this._maybeHandleCompatibilityCommand(deviceId, command, messageId, options);
        const message = this._buildFirmwareCompatibleMessage(command, normalizedPayload, messageId, options.source || 'dashboard');

        if (compatibilityResponse) {
            return compatibilityResponse;
        }

        this.markDeviceBusy(deviceId, command);

        if (waitForResponse) {
            return new Promise((resolve, reject) => {
                if (this.pendingMessages.size >= 100) {
                    return reject(new Error('Command queue full - device may be offline'));
                }

                const timeoutId = setTimeout(() => {
                    if (this.pendingMessages.has(messageId)) {
                        this.pendingMessages.delete(messageId);
                        logger.warn(`Command timed out after ${timeout}ms`, { command, messageId, deviceId });
                        reject(new Error(`Command timeout after ${timeout}ms`));
                    }
                }, timeout);
                timeoutId.unref?.();

                this.pendingMessages.set(messageId, {
                    command,
                    deviceId,
                    payload: normalizedPayload,
                    timestamp: Date.now(),
                    resolve,
                    reject,
                    timeout: timeoutId
                });

                this.publish(topic, message)
                    .catch(err => {
                        clearTimeout(timeoutId);
                        this.pendingMessages.delete(messageId);
                        reject(err);
                    });
            });
        }

        return this.publish(topic, message);
    }

    async _recoverPersistentQueue() {
        if (this._persistentQueueRecovered) return;
        const db = this._db();
        if (!this._canDbRun(db)) return;

        const canReadRows = this._hasDbMethods(db, ['all']);
        const replaySafeRows = canReadRows ? await db.all(
            `SELECT *
             FROM device_command_queue
             WHERE status IN ('dispatching', 'waiting_response')
               AND replay_safe = 1`
        ) : [];
        const nonReplaySafeRows = canReadRows ? await db.all(
            `SELECT *
             FROM device_command_queue
             WHERE status IN ('dispatching', 'waiting_response')
               AND replay_safe = 0`
        ) : [];

        await this._dbRun(db,
            `UPDATE device_command_queue
             SET status = 'pending',
                 last_error = COALESCE(last_error, 'dashboard restarted before command completion'),
                 updated_at = CURRENT_TIMESTAMP
             WHERE status IN ('dispatching', 'waiting_response')
               AND replay_safe = 1`
        );
        await this._dbRun(db,
            `UPDATE device_command_queue
             SET status = 'ambiguous',
                 last_error = COALESCE(last_error, 'dashboard restarted during non-replay-safe command'),
                 updated_at = CURRENT_TIMESTAMP,
                 completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
             WHERE status IN ('dispatching', 'waiting_response')
               AND replay_safe = 0`
        );

        for (const row of replaySafeRows) {
            await this._syncSmsStatusFromQueueRow({
                ...row,
                status: 'pending',
                last_error: row.last_error || 'dashboard restarted before command completion'
            }, 'queued', null);
        }
        for (const row of nonReplaySafeRows) {
            const detail = row.last_error || 'dashboard restarted during non-replay-safe command';
            await this._syncSmsStatusFromQueueRow({
                ...row,
                status: 'ambiguous',
                last_error: detail
            }, 'ambiguous', detail);
        }
        await this._reconcileSmsRowsFromQueueState();
        await this._markStaleSmsWithoutQueue();

        this._persistentQueueRecovered = true;
    }

    _mapSmsStatusFromQueueState(status) {
        switch (String(status || '').trim().toLowerCase()) {
            case 'dispatching':
            case 'waiting_response':
                return 'sending';
            case 'completed':
                return 'sent';
            case 'ambiguous':
                return 'ambiguous';
            case 'failed':
                return 'failed';
            case 'pending':
            default:
                return 'queued';
        }
    }

    _buildStatusFromActionResult(deviceId, data) {
        const command = String(data?.command || '').trim().toLowerCase();
        const payload = data?.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return null;
        }

        if (command === 'get_status') {
            return {
                ...payload,
                type: payload.type || 'device_status',
                deviceId,
                messageId: String(data?.messageId || data?.action_id || '').trim() || undefined,
                action_id: String(data?.action_id || data?.messageId || '').trim() || undefined,
                topic: `device/${deviceId}/status`,
                timestamp: new Date().toISOString()
            };
        }

        if (command === 'mobile_toggle') {
            const previous = this.deviceStatus.get(deviceId)?.lastStatus || {};
            const mobileEnabled = payload.enabled === true;
            const mobileConnected = payload.connected === true;

            return {
                ...previous,
                type: previous.type || 'device_status',
                data_mode_enabled: mobileEnabled,
                modem_ip_bearer_ready: mobileConnected,
                modem_ip_address: mobileConnected ? (payload.ip_address || '') : '',
                modem_data_ip: mobileConnected ? (payload.ip_address || '') : '',
                active_path: mobileConnected ? 'modem' : previous.active_path,
                deviceId,
                messageId: String(data?.messageId || data?.action_id || '').trim() || undefined,
                action_id: String(data?.action_id || data?.messageId || '').trim() || undefined,
                topic: `device/${deviceId}/status`,
                timestamp: new Date().toISOString()
            };
        }

        if (command === 'mobile_apn') {
            const previous = this.deviceStatus.get(deviceId)?.lastStatus || {};
            return {
                ...previous,
                type: previous.type || 'device_status',
                modem_apn: payload.apn ?? previous.modem_apn,
                deviceId,
                messageId: String(data?.messageId || data?.action_id || '').trim() || undefined,
                action_id: String(data?.action_id || data?.messageId || '').trim() || undefined,
                topic: `device/${deviceId}/status`,
                timestamp: new Date().toISOString()
            };
        }

        if (command !== 'wifi_disconnect' && command !== 'wifi_reconnect') {
            return null;
        }

        const previous = this.deviceStatus.get(deviceId)?.lastStatus || {};
        const nextWifiConnected = payload.connected === true;
        const nextSuppressed = command === 'wifi_disconnect'
            ? true
            : (payload.reconnect_suppressed === true ? true : false);

        return {
            ...previous,
            type: previous.type || 'device_status',
            wifi_configured: payload.configured ?? previous.wifi_configured,
            wifi_started: payload.started ?? previous.wifi_started,
            wifi_connected: nextWifiConnected,
            wifi_ip_assigned: nextWifiConnected ? (previous.wifi_ip_assigned ?? false) : false,
            wifi_reconnect_suppressed: nextSuppressed,
            wifi_ssid: payload.ssid ?? previous.wifi_ssid,
            active_path: previous.active_path,
            deviceId,
            messageId: String(data?.messageId || data?.action_id || '').trim() || undefined,
            action_id: String(data?.action_id || data?.messageId || '').trim() || undefined,
            topic: `device/${deviceId}/status`,
            timestamp: new Date().toISOString()
        };
    }

    _extractSmsTracking(row) {
        if (!['send-sms', 'send-sms-multipart'].includes(String(row?.command || '').trim())) {
            return null;
        }

        let payload = {};
        try {
            payload = row?.payload ? JSON.parse(row.payload) : {};
        } catch (_) {
            payload = {};
        }

        const smsId = Number(payload?.smsId || payload?.sms_id || 0);
        const messageId = String(row?.message_id || '').trim();
        const baseMessageId = String(payload?.sms_base_message_id || '').trim() ||
            (messageId ? messageId.replace(/_p\d+$/i, '') : '');
        const partIndex = Number(payload?.sms_part_index || payload?.sms_part || 0);
        const partCount = Number(payload?.sms_part_count || payload?.sms_parts_total || 0);

        if (!smsId && !messageId) {
            return null;
        }

        return {
            smsId: Number.isFinite(smsId) && smsId > 0 ? smsId : null,
            messageId: messageId || null,
            baseMessageId: baseMessageId || messageId || null,
            partIndex: Number.isFinite(partIndex) && partIndex > 0 ? partIndex : null,
            partCount: Number.isFinite(partCount) && partCount > 1 ? partCount : null
        };
    }

    async _resolveSmsStatusFromQueueTracking(row, tracking, requestedStatus) {
        if (requestedStatus !== 'sent' || !tracking?.partCount || !tracking.baseMessageId) {
            return requestedStatus;
        }

        const db = this._db();
        if (!this._hasDbMethods(db, ['all'])) {
            return 'sending';
        }

        const rows = await db.all(
            `SELECT message_id, status
             FROM device_command_queue
             WHERE device_id = ?
               AND command IN ('send-sms', 'send-sms-multipart')
               AND (message_id = ? OR message_id LIKE ?)`,
            [row.device_id, tracking.baseMessageId, `${tracking.baseMessageId}_p%`]
        );

        const completedParts = new Set();
        for (const candidate of rows || []) {
            const candidateStatus = String(candidate?.status || '').trim().toLowerCase();
            const candidateId = String(candidate?.message_id || '').trim();
            const match = candidateId.match(/_p(\d+)$/i);
            if (candidateStatus === 'completed' && match) {
                completedParts.add(Number(match[1]));
            }
        }

        for (let index = 1; index <= tracking.partCount; index++) {
            if (!completedParts.has(index)) {
                return 'sending';
            }
        }

        return 'sent';
    }

    async _syncSmsStatusFromQueueRow(row, explicitStatus = null, explicitError = null) {
        const db = this._db();
        const tracking = this._extractSmsTracking(row);
        if (!db || !tracking || !this._canDbRun(db)) return;

        const requestedStatus = explicitStatus || this._mapSmsStatusFromQueueState(row.status);
        const nextStatus = await this._resolveSmsStatusFromQueueTracking(row, tracking, requestedStatus);
        const nextError = nextStatus === 'failed' || nextStatus === 'ambiguous'
            ? (explicitError || row.last_error || `SMS ${nextStatus}`)
            : null;

        if (tracking.smsId) {
            await this._dbRun(db,
                `UPDATE sms
                 SET status = CASE WHEN status = 'delivered' THEN status ELSE ? END,
                     error = CASE WHEN status = 'delivered' THEN NULL ELSE ? END,
                     external_id = COALESCE(external_id, ?)
                 WHERE id = ?`,
                [nextStatus, nextError, tracking.baseMessageId || tracking.messageId, tracking.smsId]
            );
            return;
        }

        if (tracking.messageId) {
            await this._dbRun(db,
                `UPDATE sms
                 SET status = CASE WHEN status = 'delivered' THEN status ELSE ? END,
                     error = CASE WHEN status = 'delivered' THEN NULL ELSE ? END
                 WHERE external_id = ?`,
                [nextStatus, nextError, tracking.messageId]
            );
        }
    }

    async _reconcileSmsRowsFromQueueState(limit = 100) {
        const db = this._db();
        if (!this._hasDbMethods(db, ['all'])) return;

        const rows = await db.all(
            `SELECT *
             FROM device_command_queue
             WHERE command IN ('send-sms', 'send-sms-multipart')
               AND status IN ('pending', 'dispatching', 'waiting_response', 'failed', 'ambiguous')
             ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
             LIMIT ?`,
            [limit]
        );

        for (const row of rows) {
            await this._syncSmsStatusFromQueueRow(row);
        }
    }

    async _markStaleSmsWithoutQueue(maxAgeMs = 120000) {
        const db = this._db();
        if (!this._hasDbMethods(db, ['all']) || !this._canDbRun(db)) return;

        const cutoff = this._sqlTimestamp(Date.now() - maxAgeMs);
        const rows = await db.all(
            `SELECT id, device_id, external_id
             FROM sms s
             WHERE s.type = 'outgoing'
               AND s.status IN ('queued', 'sending')
               AND s.external_id LIKE 'send-sms%'
               AND datetime(REPLACE(substr(s.timestamp, 1, 19), 'T', ' ')) <= datetime(?)
               AND NOT EXISTS (
                   SELECT 1
                   FROM device_command_queue q
                   WHERE q.device_id = s.device_id
                     AND q.message_id = s.external_id
               )
             ORDER BY datetime(REPLACE(substr(s.timestamp, 1, 19), 'T', ' ')) ASC
             LIMIT 50`,
            [cutoff]
        );

        const touchedDevices = new Set();
        for (const row of rows) {
            await this._dbRun(db,
                `UPDATE sms
                 SET status = 'ambiguous',
                     error = COALESCE(error, 'SMS command status was not confirmed before queue tracking ended')
                 WHERE id = ?
                   AND status IN ('queued', 'sending')`,
                [row.id]
            );
            if (row.device_id) {
                touchedDevices.add(row.device_id);
            }
        }

        for (const deviceId of touchedDevices) {
            await this._emitDeviceQueueState(deviceId);
        }
    }

    async _updatePersistentQueueRow(id, fields) {
        const db = this._db();
        if (!db || !this._canDbRun(db) || !id || !fields || typeof fields !== 'object') return;

        const entries = Object.entries(fields);
        if (!entries.length) return;

        const assignments = entries.map(([key]) => `${key} = ?`);
        const values = entries.map(([, value]) => value);
        values.push(id);
        await this._dbRun(db,
            `UPDATE device_command_queue
             SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            values
        );
    }

    async _resolvePersistentQueueWaiter(row) {
        const waiter = this._persistentQueueWaiters.get(row.id);
        if (!waiter) return;

        clearTimeout(waiter.timeout);
        this._persistentQueueWaiters.delete(row.id);

        let payload = null;
        if (row.response_payload) {
            try { payload = JSON.parse(row.response_payload); } catch (_) { payload = { raw: row.response_payload }; }
        }

        if (row.status === 'completed') {
            waiter.resolve(payload || {
                success: true,
                queued: false,
                queueId: row.id,
                messageId: row.message_id
            });
        } else {
            waiter.reject(new Error(row.last_error || `Command ${row.command} ${row.status}`));
        }
    }

    async _emitDeviceQueueState(deviceId) {
        const normalized = this._normalizeDeviceId(deviceId);
        if (!normalized) return;

        const summary = await this.getDeviceQueueState(normalized);
        this.emit('device-queue', normalized, summary);
        if (global.io) {
            global.io.to(`device:${normalized}`).emit('device:queue', {
                deviceId: normalized,
                ...summary
            });
        }
    }

    async _settlePersistentQueueFromResponse(deviceId, data) {
        const db = this._db();
        const correlationId = String(data?.messageId || data?.action_id || '').trim();
        const normalizedDeviceId = this._normalizeDeviceId(deviceId);
        if (!this._hasDbMethods(db, ['get']) || !normalizedDeviceId || !correlationId) return false;

        const row = await db.get(
            `SELECT *
             FROM device_command_queue
             WHERE device_id = ?
               AND message_id = ?
               AND status IN ('pending', 'dispatching', 'waiting_response', 'failed', 'ambiguous')
             ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
             LIMIT 1`,
            [normalizedDeviceId, correlationId]
        );
        if (!row) return false;
        if (row.status === 'failed' && !this._usesAsyncDurableResult(row.command)) {
            return false;
        }

        const result = String(data?.result || '').toLowerCase();
        const success = data?.success !== false &&
            result !== 'failed' &&
            result !== 'rejected' &&
            result !== 'timeout';

        if (success) {
            const messageReference = parseSmsMessageReference(
                data?.message_reference,
                data?.messageReference,
                data?.mr,
                data?.detail,
                data?.message,
                data?.payload
            );
            const completedData = messageReference === null
                ? data
                : {
                    ...data,
                    message_reference: data?.message_reference ?? messageReference
                };
            await this._markPersistentQueueCompleted(row, completedData);
            return true;
        }

        await this._updatePersistentQueueRow(row.id, {
            status: 'failed',
            response_payload: JSON.stringify(data),
            completed_at: this._sqlTimestamp(),
            last_error: data?.error || data?.message || data?.detail || `Command ${row.command} failed`,
            next_attempt_at: null
        });
        await this._syncSmsStatusFromQueueRow({
            ...row,
            status: 'failed',
            last_error: data?.error || data?.message || data?.detail || `Command ${row.command} failed`
        }, 'failed', data?.error || data?.message || data?.detail || `Command ${row.command} failed`);
        const failed = this._hasDbMethods(db, ['get'])
            ? await db.get(`SELECT * FROM device_command_queue WHERE id = ?`, [row.id])
            : null;
        if (failed) {
            await this._resolvePersistentQueueWaiter(failed);
        }
        await this._emitDeviceQueueState(row.device_id);
        return true;
    }

    async _findPersistentSmsQueueRow(deviceId, data) {
        const db = this._db();
        const normalizedDeviceId = this._normalizeDeviceId(deviceId);
        if (!normalizedDeviceId || !this._hasDbMethods(db, ['get', 'all'])) return null;

        const correlationId = String(data?.messageId || data?.action_id || '').trim();
        if (correlationId) {
            const row = await db.get(
                `SELECT *
                 FROM device_command_queue
                 WHERE device_id = ?
                   AND command IN ('send-sms', 'send-sms-multipart')
                   AND message_id = ?
                   AND status IN ('pending', 'dispatching', 'waiting_response', 'failed', 'ambiguous')
                 ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
                 LIMIT 1`,
                [normalizedDeviceId, correlationId]
            );
            if (row) return row;
        }

        const deliveryReport = normalizeSmsDeliveryReport(data);
        if (deliveryReport.messageReference !== null) {
            const rows = await db.all(
                `SELECT *
                 FROM device_command_queue
                 WHERE device_id = ?
                   AND command IN ('send-sms', 'send-sms-multipart')
                   AND status IN ('pending', 'dispatching', 'waiting_response', 'failed', 'ambiguous', 'completed')
                 ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
                 LIMIT 50`,
                [normalizedDeviceId]
            );

            for (const row of rows || []) {
                const references = [];
                for (const field of ['response_payload', 'payload']) {
                    if (!row?.[field]) continue;
                    try {
                        references.push(parseSmsMessageReference(JSON.parse(row[field])));
                    } catch (_) {
                        references.push(parseSmsMessageReference(row[field]));
                    }
                }
                if (references.some((reference) => reference === deliveryReport.messageReference)) {
                    return row;
                }
            }
        }

        const deliveredTo = String(data?.to || data?.number || '').trim();
        if (!deliveredTo) return null;

        const candidates = await db.all(
            `SELECT *
             FROM device_command_queue
             WHERE device_id = ?
               AND command IN ('send-sms', 'send-sms-multipart')
               AND status IN ('pending', 'dispatching', 'waiting_response', 'failed', 'ambiguous')
             ORDER BY
                CASE
                    WHEN status = 'waiting_response' THEN 0
                    WHEN status = 'dispatching' THEN 1
                    WHEN status = 'pending' THEN 2
                    WHEN status = 'failed' THEN 3
                    WHEN status = 'ambiguous' THEN 4
                    ELSE 5
                END,
                datetime(updated_at) DESC,
                datetime(created_at) DESC
             LIMIT 10`,
            [normalizedDeviceId]
        );

        for (const row of candidates) {
            try {
                const payload = row?.payload ? JSON.parse(row.payload) : {};
                const rowNumber = String(payload?.to || payload?.number || '').trim();
                if (rowNumber && rowNumber === deliveredTo) {
                    return row;
                }
            } catch (_) {}
        }

        return null;
    }

    async _settlePersistentQueueFromSmsDelivery(deviceId, data) {
        const normalizedData = normalizeSmsDeliveryPayload(data);
        const deliveryReport = normalizeSmsDeliveryReport(normalizedData);
        const row = await this._findPersistentSmsQueueRow(deviceId, normalizedData);
        if (!row) return false;

        if (deliveryReport.pending) {
            return false;
        }

        if (deliveryReport.failed) {
            const detail = normalizedData?.error || normalizedData?.message || normalizedData?.detail || 'SMS delivery failed';
            await this._updatePersistentQueueRow(row.id, {
                status: 'failed',
                response_payload: JSON.stringify(normalizedData),
                completed_at: this._sqlTimestamp(),
                last_error: detail,
                next_attempt_at: null
            });
            await this._syncSmsStatusFromQueueRow({
                ...row,
                status: 'failed',
                last_error: detail
            }, 'failed', detail);
            const db = this._db();
            const failed = this._hasDbMethods(db, ['get'])
                ? await db.get(`SELECT * FROM device_command_queue WHERE id = ?`, [row.id])
                : null;
            if (failed) {
                await this._resolvePersistentQueueWaiter(failed);
            }
            await this._emitDeviceQueueState(row.device_id);
            return true;
        }

        await this._markPersistentQueueCompleted(row, {
            ...normalizedData,
            success: true,
            result: normalizedData?.result || 'completed',
            detail: normalizedData?.detail || 'sms_delivered'
        });
        return true;
    }

    async _markPersistentQueueCompleted(row, response) {
        const serialized = response == null
            ? null
            : (typeof response === 'string' ? response : JSON.stringify(response));
        await this._updatePersistentQueueRow(row.id, {
            status: 'completed',
            response_payload: serialized,
            published_at: row.published_at || this._sqlTimestamp(),
            completed_at: this._sqlTimestamp(),
            last_error: null,
            next_attempt_at: null
        });
        await this._syncSmsStatusFromQueueRow({
            ...row,
            status: 'completed',
            last_error: null
        }, 'sent', null);
        const db = this._db();
        const completed = this._hasDbMethods(db, ['get'])
            ? await db.get(`SELECT * FROM device_command_queue WHERE id = ?`, [row.id])
            : null;
        if (completed) {
            await this._resolvePersistentQueueWaiter(completed);
        }
        await this._emitDeviceQueueState(row.device_id);
    }

    async _markPersistentQueueRetry(row, error) {
        const db = this._db();
        const detail = error?.message || String(error);
        if (Number(row?.replay_safe || 0) === 0 && /Command timeout after \d+ms/i.test(detail)) {
            await this._markPersistentQueueAmbiguous(row, error);
            return;
        }
        const attempts = Number(row.attempt_count || 0) + 1;
        const nextAttempt = this._sqlTimestamp(Date.now() + Math.min(30000, Math.max(2000, attempts * 5000)));

        if (attempts >= (row.max_attempts || 6)) {
            await this._updatePersistentQueueRow(row.id, {
                status: 'failed',
                completed_at: this._sqlTimestamp(),
                last_error: detail
            });
            await this._syncSmsStatusFromQueueRow({
                ...row,
                status: 'failed',
                last_error: detail
            }, 'failed', detail);
            const failed = this._hasDbMethods(db, ['get'])
                ? await db.get(`SELECT * FROM device_command_queue WHERE id = ?`, [row.id])
                : null;
            if (failed) {
                await this._resolvePersistentQueueWaiter(failed);
            }
        } else {
            await this._updatePersistentQueueRow(row.id, {
                status: 'pending',
                next_attempt_at: nextAttempt,
                last_error: detail
            });
            await this._syncSmsStatusFromQueueRow({
                ...row,
                status: 'pending',
                last_error: detail
            }, 'queued', null);
        }
        await this._emitDeviceQueueState(row.device_id);
    }

    async _markPersistentQueueAmbiguous(row, error) {
        const db = this._db();
        const detail = error?.message || String(error || 'Command published but result was not confirmed');
        await this._updatePersistentQueueRow(row.id, {
            status: 'ambiguous',
            completed_at: this._sqlTimestamp(),
            last_error: detail,
            next_attempt_at: null
        });
        await this._syncSmsStatusFromQueueRow({
            ...row,
            status: 'ambiguous',
            last_error: detail
        }, 'ambiguous', detail);
        const ambiguous = this._hasDbMethods(db, ['get'])
            ? await db.get(`SELECT * FROM device_command_queue WHERE id = ?`, [row.id])
            : null;
        if (ambiguous) {
            await this._resolvePersistentQueueWaiter(ambiguous);
        }
        await this._emitDeviceQueueState(row.device_id);
    }

    async _processPersistentQueueRow(row) {
        const queueKey = this._normalizeDeviceId(row.device_id);
        if (!queueKey || this.activePersistentCommands.has(row.id)) return;
        this.activePersistentCommands.add(row.id);

        const run = async () => {
            const db = this._db();
            if (!db) return;
            try {
                if (!this.connected) throw new Error('MQTT not connected');
                const commandChannelReason = this._deviceCommandChannelPendingReason(row.device_id);
                if (commandChannelReason) {
                    const nextAttempt = this._sqlTimestamp(Date.now() + COMMAND_CHANNEL_RETRY_DELAY_MS);
                    await this._updatePersistentQueueRow(row.id, {
                        status: 'pending',
                        next_attempt_at: nextAttempt,
                        last_error: commandChannelReason
                    });
                    await this._syncSmsStatusFromQueueRow({
                        ...row,
                        status: 'pending',
                        last_error: commandChannelReason
                    }, 'queued', null);
                    await this._emitDeviceQueueState(row.device_id);
                    return;
                }

                const payload = row.payload ? JSON.parse(row.payload) : {};
                const usesAsyncResult = Boolean(row.requires_response) && await this._usesAsyncDurableResultForRow(row);
                const nextAttemptAt = usesAsyncResult
                    ? this._sqlTimestamp(Date.now() + Number(row.timeout_ms || 30000))
                    : null;
                await this._updatePersistentQueueRow(row.id, {
                    status: row.requires_response ? 'waiting_response' : 'dispatching',
                    attempt_count: Number(row.attempt_count || 0) + 1,
                    published_at: row.published_at || this._sqlTimestamp(),
                    next_attempt_at: nextAttemptAt,
                    last_error: null
                });
                await this._syncSmsStatusFromQueueRow({
                    ...row,
                    status: row.requires_response ? 'waiting_response' : 'dispatching',
                    last_error: null
                }, row.requires_response ? 'sending' : 'sending', null);
                await this._emitDeviceQueueState(row.device_id);

                const response = await this._publishCommandNow(
                    row.device_id,
                    row.command,
                    payload,
                    usesAsyncResult ? false : Boolean(row.requires_response),
                    Number(row.timeout_ms || 30000),
                    {
                        messageId: row.message_id,
                        source: row.source || 'dashboard-queue'
                    }
                );
                if (usesAsyncResult) {
                    return;
                }
                await this._markPersistentQueueCompleted(row, response);
            } catch (error) {
                await this._markPersistentQueueRetry(row, error);
            } finally {
                this.activePersistentCommands.delete(row.id);
            }
        };

        this.enqueueDeviceCommand(queueKey, run, {
            command: row.command,
            source: row.source || 'dashboard-queue',
            priority: Number(row.priority),
            background: false
        }).catch((error) => {
            logger.error('Persistent queue device task failed:', error);
        });
    }

    async processPersistentQueue() {
        if (this._persistentQueueTickRunning) return;
        const db = this._db();
        if (!this._hasDbMethods(db, ['all'])) return;

        this._persistentQueueTickRunning = true;
        try {
            await this._recoverPersistentQueue();

            const rows = await db.all(
                `SELECT *
                 FROM device_command_queue
                 WHERE status = 'pending'
                   AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
                 ORDER BY priority ASC, created_at ASC
                 LIMIT 24`
            );

            const scheduledDevices = new Set();
            for (const row of rows) {
                const queueKey = this._normalizeDeviceId(row.device_id);
                if (!queueKey || scheduledDevices.has(queueKey)) continue;
                if (!this.connected) continue;
                if (await this._hasActivePersistentCommandInDomain(queueKey, row.command, row.id)) continue;
                scheduledDevices.add(queueKey);
                this._processPersistentQueueRow(row);
            }

            const waitingRows = await db.all(
                `SELECT *
                 FROM device_command_queue
                 WHERE status = 'waiting_response'
                   AND next_attempt_at IS NOT NULL
                   AND next_attempt_at <= CURRENT_TIMESTAMP
                 ORDER BY priority ASC, updated_at ASC
                 LIMIT 24`
            );

            for (const row of waitingRows) {
                if (this.activePersistentCommands.has(row.id)) continue;
                const timeoutError = new Error(`Command timeout after ${Number(row.timeout_ms || 30000)}ms`);
                if (Number(row.replay_safe || 0) === 0) {
                    await this._markPersistentQueueAmbiguous(row, timeoutError);
                } else {
                    await this._markPersistentQueueRetry(row, timeoutError);
                }
            }
        } finally {
            this._persistentQueueTickRunning = false;
        }
    }

    async enqueuePersistentDeviceCommand(deviceId, command, payload = {}, waitForResponse = false, timeout = 30000, options = {}) {
        const db = this._db();
        if (!this._canDbRun(db)) {
            return this._publishCommandNow(deviceId, command, payload, waitForResponse, timeout, options);
        }

        const normalizedPayload = normalizeMqttContractPayload(payload);
        const queueId = this._generatePersistentQueueId();
        const messageId = this._normalizeCommandMessageId(command, options.messageId);
        const requiresResponse = this._requiresDurableAck(command, waitForResponse, options);
        const nowSql = this._sqlTimestamp();

        await this._dbRun(db,
            `INSERT INTO device_command_queue (
                id, device_id, command, payload, message_id, status,
                requires_response, replay_safe, attempt_count, max_attempts,
                timeout_ms, priority, next_attempt_at, source, user_id,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                queueId,
                this._normalizeDeviceId(deviceId),
                command,
                JSON.stringify(normalizedPayload),
                messageId,
                requiresResponse ? 1 : 0,
                this._isReplaySafeCommand(command, options) ? 1 : 0,
                Number.isFinite(options.maxAttempts) ? options.maxAttempts : 6,
                timeout,
                this._queuePriority(command, options),
                null,
                options.source || 'dashboard',
                options.userId || null,
                nowSql,
                nowSql
            ]
        );

        await this._emitDeviceQueueState(deviceId);
        this.processPersistentQueue().catch((error) => {
            logger.error('Failed to kick persistent command queue:', error);
        });

        if (!waitForResponse) {
            return {
                success: true,
                queued: true,
                queueId,
                messageId,
                status: 'pending'
            };
        }

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this._persistentQueueWaiters.delete(queueId);
                reject(new Error(`Command queued and still pending after ${timeout}ms`));
            }, timeout);
            timeoutId.unref?.();

            this._persistentQueueWaiters.set(queueId, { resolve, reject, timeout: timeoutId });
        });
    }

    async getDeviceQueueState(deviceId) {
        const normalized = this._normalizeDeviceId(deviceId);
        const db = this._db();
        if (!normalized || !this._hasDbMethods(db, ['all'])) {
            return {
                summary: { pending: 0, active: 0, failed: 0, ambiguous: 0, totalOpen: 0 },
                domains: {},
                runtime: { queued: false, busy: false },
                recent: []
            };
        }

        const counts = await db.all(
            `SELECT command, status, COUNT(*) AS count
             FROM device_command_queue
             WHERE device_id = ?
             GROUP BY command, status`,
            [normalized]
        );

        const summary = { pending: 0, active: 0, failed: 0, ambiguous: 0, totalOpen: 0 };
        const domains = {};
        for (const row of counts) {
            const count = Number(row.count || 0);
            if (row.status === 'pending') summary.pending += count;
            else if (row.status === 'dispatching' || row.status === 'waiting_response') summary.active += count;
            else if (row.status === 'failed') summary.failed += count;
            else if (row.status === 'ambiguous') summary.ambiguous += count;

            const domain = this._commandDomain(row.command);
            if (!domains[domain]) {
                domains[domain] = { pending: 0, active: 0, failed: 0, ambiguous: 0, totalOpen: 0 };
            }
            if (row.status === 'pending') domains[domain].pending += count;
            else if (row.status === 'dispatching' || row.status === 'waiting_response') domains[domain].active += count;
            else if (row.status === 'failed') domains[domain].failed += count;
            else if (row.status === 'ambiguous') domains[domain].ambiguous += count;
        }
        summary.totalOpen = summary.pending + summary.active + summary.failed + summary.ambiguous;
        for (const domain of Object.keys(domains)) {
            const entry = domains[domain];
            entry.totalOpen = entry.pending + entry.active + entry.failed + entry.ambiguous;
        }

        const recent = await db.all(
            `SELECT id, command, status,
                    message_id AS messageId,
                    attempt_count AS attemptCount,
                    max_attempts AS maxAttempts,
                    last_error AS lastError,
                    created_at AS createdAt,
                    updated_at AS updatedAt,
                    completed_at AS completedAt
             FROM device_command_queue
             WHERE device_id = ?
             ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
             LIMIT 12`,
            [normalized]
        );

        return {
            summary,
            domains,
            runtime: {
                queued: this.hasDeviceQueueActivity(normalized),
                busy: this.isDeviceBusy(normalized)
            },
            recent: recent.map((row) => ({
                ...row,
                domain: this._commandDomain(row.command)
            }))
        };
    }

    publishCommand(deviceId, command, payload = {}, waitForResponse = false, timeout = 30000, options = {}) {
        const normalizedDeviceId = String(deviceId || '').trim();
        const normalizedPayload = normalizeMqttContractPayload(payload);
        if (!normalizedDeviceId) {
            const error = new Error('No active device selected');
            error.code = 'DEVICE_ID_REQUIRED';
            return Promise.reject(error);
        }

        if (this._isDurableCommand(command, options)) {
            return this.enqueuePersistentDeviceCommand(normalizedDeviceId, command, normalizedPayload, waitForResponse, timeout, options);
        }

        if (!this.connected) {
            return Promise.reject(new Error('MQTT not connected'));
        }

        const topic = `device/${normalizedDeviceId}/command/${command}`;
        const messageId = this._normalizeCommandMessageId(command, options?.messageId);
        const compatibilityResponse = this._maybeHandleCompatibilityCommand(normalizedDeviceId, command, messageId, options);

        const executePublish = async () => {
            const message = this._buildFirmwareCompatibleMessage(
                command,
                { ...normalizedPayload, timeout },
                messageId,
                options?.source || 'dashboard'
            );

            this.markDeviceBusy(normalizedDeviceId, command);

            if (compatibilityResponse) {
                return compatibilityResponse;
            }

            if (waitForResponse) {
                return new Promise((resolve, reject) => {
                    // Cap the pending queue to prevent unbounded growth during long outages
                    if (this.pendingMessages.size >= 100) {
                        return reject(new Error('Command queue full — device may be offline'));
                    }

                    // Set timeout
                    const timeoutId = setTimeout(() => {
                        if (this.pendingMessages.has(messageId)) {
                            this.pendingMessages.delete(messageId);
                            logger.warn(`⏱ Command timed out after ${timeout}ms`, { command, messageId, deviceId: normalizedDeviceId });
                            reject(new Error(`Command timeout after ${timeout}ms`));
                        }
                    }, timeout);

                    // Store pending message
                    this.pendingMessages.set(messageId, {
                        command,
                        deviceId: normalizedDeviceId,
                        payload,
                        timestamp: Date.now(),
                        resolve,
                        reject,
                        timeout: timeoutId
                    });

                    // Publish message
                    this.publish(topic, message)
                        .catch(err => {
                            clearTimeout(timeoutId);
                            this.pendingMessages.delete(messageId);
                            reject(err);
                        });
                });
            }

            // Just publish without waiting for response
            return this.publish(topic, message);
        };

        logger.info(`📤 Publishing command to ${topic}:`, { command, messageId });
        const activeDeviceOperation = this.deviceOperationContext.getStore();
        const alreadyInDeviceQueue = activeDeviceOperation?.deviceId === normalizedDeviceId;
        if (options?.skipQueue || alreadyInDeviceQueue) {
            return executePublish();
        }

        return this.enqueueDeviceCommand(normalizedDeviceId, executePublish, {
            command,
            source: options?.source,
            domain: options?.domain,
            priority: this._queuePriority(command, options),
            background: this._isBackgroundCommand(command, options)
        });
    }

    runDeviceOperation(deviceId, task) {
        if (typeof task !== 'function') {
            return Promise.reject(new Error('task must be a function'));
        }
        return this.enqueueDeviceCommand(deviceId, task);
    }

    enqueueDeviceCommand(deviceId, task, metadata = {}) {
        const queueKey = this._normalizeDeviceId(deviceId);
        const state = this._getOrCreateDeviceQueueState(queueKey);
        const activeDeviceOperation = this.deviceOperationContext.getStore();
        const coalesceKey = this._coalescingCommandKey(metadata?.command, metadata || {});

        if (!queueKey || !state || typeof task !== 'function') {
            return Promise.reject(new Error('Invalid device queue task'));
        }
        if (activeDeviceOperation?.deviceId === queueKey) {
            return Promise.resolve().then(task);
        }

        this._pruneDeviceQueueCooldowns(state);

        if (coalesceKey) {
            const sharedEntry = this._findCoalescedDeviceTask(state, coalesceKey);
            if (sharedEntry?.promise) {
                return sharedEntry.promise;
            }

            const cooldownUntil = state.recentBackground.get(coalesceKey) || 0;
            if (cooldownUntil > Date.now()) {
                logger.debug(`Coalesced recent background command ${metadata?.command || 'unknown'} for ${queueKey}`);
                return Promise.resolve({
                    success: true,
                    queued: false,
                    skipped: true,
                    coalesced: true,
                    reason: 'background command recently satisfied'
                });
            }
        }

        let resolveEntry;
        let rejectEntry;
        const promise = new Promise((resolve, reject) => {
            resolveEntry = resolve;
            rejectEntry = reject;
        });
        const entry = {
            task,
            resolve: resolveEntry,
            reject: rejectEntry,
            promise,
            command: String(metadata?.command || '').trim(),
            priority: Number.isFinite(metadata?.priority)
                ? Number(metadata.priority)
                : this._queuePriority(metadata?.command, metadata || {}),
            background: metadata?.background === true,
            sequence: ++state.sequence,
            coalesceKey,
            coalesceWindowMs: coalesceKey ? this._backgroundCommandCoalesceWindowMs(metadata?.command, metadata || {}) : 0
        };

        this._dropSupersededBackgroundTasks(queueKey, state, entry);
        this._insertPendingDeviceTask(state, entry);
        this._drainDeviceQueue(queueKey);
        return promise;
    }

    publishRuntimeCommand(deviceId, command, payload = {}, waitForResponse = false, timeout = 30000, options = {}) {
        const runtimeOptions = {
            ...options,
            domain: options?.domain || this._commandDomain(command, options),
            skipPersistentQueue: true
        };

        return this.publishCommand(deviceId, command, payload, waitForResponse, timeout, runtimeOptions);
    }

    // ==================== CONVENIENCE METHODS ====================

    // SMS Commands
    sendSms(deviceId, to, message) {
        const resolved = resolveSmsCommandForRecipient(to, message);
        return this.publishCommand(
            deviceId,
            resolved.command,
            { to, message, timeout: resolved.timeoutMs, ...(resolved.metadata || {}) },
            true,
            resolved.timeoutMs || resolveSmsTimeoutMs(message)
        );
    }

    // Call Commands
    makeCall(deviceId, number, options = {}) {
        return this.publishRuntimeCommand(
            deviceId,
            'make-call',
            buildSimScopedPayload({ number }, options),
            false,
            60000,
            options
        );
    }

    answerCall(deviceId, options = {}) {
        return this.publishRuntimeCommand(deviceId, 'answer-call', {}, false, 10000, options);
    }

    rejectCall(deviceId, options = {}) {
        return this.publishRuntimeCommand(deviceId, 'reject-call', {}, false, 10000, options);
    }

    endCall(deviceId, options = {}) {
        return this.publishRuntimeCommand(deviceId, 'end-call', {}, false, 10000, options);
    }

    holdCall(deviceId, hold, options = {}) {
        return this.publishRuntimeCommand(deviceId, 'hold-call', { hold }, false, 10000, options);
    }

    // USSD Commands
    sendUssd(deviceId, code, options = {}) {
        return this.publishRuntimeCommand(
            deviceId,
            'send-ussd',
            buildSimScopedPayload({ code }, options),
            false,
            60000,
            options
        );
    }

    cancelUssd(deviceId, options = {}) {
        return this.publishRuntimeCommand(
            deviceId,
            'cancel-ussd',
            buildSimScopedPayload({}, options),
            false,
            15000,
            options
        );
    }

    // Device Commands
    requestStatus(deviceId, options = {}) {
        const force = options.force !== false;
        const timeout = Number.isFinite(options.timeout) ? options.timeout : 15000;

        if (!force && (this.isDeviceBusy(deviceId) || this.hasDeviceQueueActivity(deviceId))) {
            logger.debug(`Skipping automatic status request for busy device ${deviceId}`);
            return Promise.resolve({ skipped: true, reason: 'device busy' });
        }

        return this.publishCommand(deviceId, 'get-status', {}, true, timeout, {
            messageId: options?.messageId,
            source: options?.source,
            userId: options?.userId,
            domain: 'status',
            background: force === false,
            skipQueue: false,
            bypassCompatibility: options?.allowCompatibilitySnapshot === true ? false : true
        });
    }

    restartDevice(deviceId) {
        return this.publishCommand(deviceId, 'restart', {}, false);
    }

    restartModem(deviceId) {
        return this.publishCommand(deviceId, 'restart-modem', {}, false);
    }

    // ==================== STORAGE COMMANDS ====================

    /**
     * Get list of files in a directory
     */
    listFiles(deviceId, path = '/') {
        return this.publishCommand(deviceId, 'storage-list', { path }, true, 10000);
    }

    /**
     * Get SD card information (total, used, free space)
     */
    getStorageInfo(deviceId) {
        return this.publishCommand(deviceId, 'storage-info', {}, true, 10000);
    }

    /**
     * Read a file from SD card
     */
    readFile(deviceId, path) {
        return this.publishCommand(deviceId, 'storage-read', { path }, true, 30000);
    }

    /**
     * Write a file to SD card
     * @param {string} deviceId - Device ID
     * @param {string} path - Destination path
     * @param {string} filename - File name
     * @param {string} content - Base64 encoded file content
     * @param {boolean} append - Whether to append to existing file
     */
    writeFile(deviceId, path, filename, content, append = false) {
        return this.publishCommand(deviceId, 'storage-write', { 
            path, 
            filename, 
            content, 
            append 
        }, true, 60000);
    }

    /**
     * Delete files or directories
     */
    deleteFiles(deviceId, items) {
        return this.publishCommand(deviceId, 'storage-delete', { items }, true, 30000);
    }

    /**
     * Rename a file or directory
     */
    renameFile(deviceId, oldPath, newName) {
        return this.publishCommand(deviceId, 'storage-rename', { oldPath, newName }, true, 10000);
    }

    /**
     * Move files to another directory
     */
    moveFiles(deviceId, items, destination) {
        return this.publishCommand(deviceId, 'storage-move', { items, destination }, true, 30000);
    }

    /**
     * Copy files to another directory
     */
    copyFiles(deviceId, items, destination) {
        return this.publishCommand(deviceId, 'storage-copy', { items, destination }, true, 60000);
    }

    /**
     * Create a new directory
     */
    createDirectory(deviceId, path, name) {
        return this.publishCommand(deviceId, 'storage-mkdir', { path, name }, true, 10000);
    }

    // ==================== GPS COMMANDS ====================

    /**
     * Get GPS status
     */
    getGpsStatus(deviceId) {
        return this.publishCommand(deviceId, 'gps-status', {}, true, 10000);
    }

    /**
     * Get current GPS location
     */
    getGpsLocation(deviceId) {
        return this.publishCommand(deviceId, 'gps-location', {}, true, 10000);
    }

    /**
     * Enable/disable GPS
     */
    setGpsEnabled(deviceId, enabled) {
        return this.publishCommand(deviceId, 'gps-set-enabled', { enabled }, true, 10000);
    }

    // ==================== GPIO COMMANDS ====================

    /**
     * Get GPIO pin status
     */
    getGpioStatus(deviceId) {
        return this.publishCommand(deviceId, 'gpio-status', {}, true, 10000);
    }

    /**
     * Read GPIO pin
     */
    readGpioPin(deviceId, pin) {
        return this.publishCommand(deviceId, 'gpio-read', { pin }, true, 10000);
    }

    /**
     * Write GPIO pin
     */
    writeGpioPin(deviceId, pin, value) {
        return this.publishCommand(deviceId, 'gpio-write', { pin, value }, true, 10000);
    }

    /**
     * Set GPIO pin mode
     */
    setGpioMode(deviceId, pin, mode) {
        return this.publishCommand(deviceId, 'gpio-mode', { pin, mode }, true, 10000);
    }

    // ==================== UTILITY METHODS ====================

    // Topic matching helper
    topicMatches(pattern, topic) {
        const patternParts = pattern.split('/');
        const topicParts = topic.split('/');

        if (patternParts.length !== topicParts.length && !pattern.includes('#')) {
            return false;
        }

        for (let i = 0; i < patternParts.length; i++) {
            if (patternParts[i] === '+') continue;
            if (patternParts[i] === '#') return true;
            if (patternParts[i] !== topicParts[i]) return false;
        }

        return true;
    }

    // Register message handler
    onMessage(pattern, handler) {
        this.messageHandlers.set(pattern, handler);
    }

    // Remove message handler
    offMessage(pattern) {
        this.messageHandlers.delete(pattern);
    }

    // Get connection status
    getStatus() {
        const state = this.connected
            ? 'connected'
            : this.connecting
                ? 'connecting'
                : this.reconnectTimer
                    ? 'reconnecting'
                    : 'disconnected';

        return {
            connected: this.connected,
            connecting: this.connecting,
            reconnecting: state === 'reconnecting',
            state,
            host: this.options.host,
            port: this.options.port,
            protocol: this.options.protocol,
            clientId: this.options.clientId,
            username: this.options.username,
            lastError: this.lastError,
            lastErrorAt: this.lastErrorAt,
            subscribedTopics: Array.from(this.subscribedTopics),
            pendingMessages: this.pendingMessages.size,
            reconnectAttempts: this.reconnectAttempts,
            persistentQueueActive: this.activePersistentCommands.size,
            devices: Array.from(this.deviceStatus.entries()).map(([id, status]) => ({
                id,
                lastSeen: status.lastSeen,
                online: status.online
            }))
        };
    }

    // Get device online status
    isDeviceOnline(deviceId) {
        const device = this.deviceStatus.get(deviceId);
        if (!device) return false;
        
        const lastSeen = new Date(device.lastSeen);
        const now = new Date();
        const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);
        
        return lastSeen > twoMinutesAgo;
    }

    // Reconnect with new options
    reconnect(newOptions = null) {
        // Clear any pending reconnect
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (newOptions) {
            this.options = buildOptionsFromEnvironment(this.options, newOptions);
        } else {
            this.options = buildOptionsFromEnvironment(this.options);
        }

        if (this.client) {
            this.client.end(true, () => {
                this.connected = false;
                this.connecting = false;
                const reconnectTimer = setTimeout(() => this.connect(), 1000);
                reconnectTimer.unref();
            });
        } else {
            this.connect();
        }
    }

    // Disconnect
    disconnect() {
        this.manualDisconnect = true;
        this.maxReconnectNotified = false;
        // Clear any pending reconnect
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
        if (this._persistentQueueTimer) {
            clearInterval(this._persistentQueueTimer);
            this._persistentQueueTimer = null;
        }

        if (this.client) {
            this.client.end(true);
            this.connected = false;
            this.connecting = false;
            logger.info('MQTT disconnected');
            
            // Reject all pending messages
            this.pendingMessages.forEach((pending, messageId) => {
                clearTimeout(pending.timeout);
                pending.reject(new Error('MQTT disconnected'));
            });
            this.pendingMessages.clear();
        }
    }

    // Check if connected
    isConnected() {
        return this.connected;
    }

    // Get client ID
    getClientId() {
        return this.options.clientId;
    }

    // Get device last seen
    getDeviceLastSeen(deviceId) {
        const device = this.deviceStatus.get(deviceId);
        return device ? device.lastSeen : null;
    }

    // Clear device status
    clearDeviceStatus(deviceId) {
        this.deviceStatus.delete(deviceId);
        this.clearDeviceBusy(deviceId);
    }

    // Clear all device statuses
    clearAllDevices() {
        this.deviceStatus.clear();
        this.deviceBusyUntil.clear();
    }
}

module.exports = new MQTTService();
