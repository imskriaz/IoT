const express = require('express');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { resolveDeviceId } = require('../utils/deviceResolver');

const router = express.Router();

const MAX_TIMEOUT_MS = 120000;
const DEFAULT_TIMEOUT_MS = 30000;

const COMMAND_PRESETS = [
    {
        group: 'Status',
        command: 'get-status',
        label: 'Get Status',
        payload: {},
        waitForResponse: true,
        timeoutMs: 15000,
        note: 'Compact runtime status snapshot. Use before and after command tests.'
    },
    {
        group: 'Status',
        command: 'status-watch',
        label: 'Status Watch',
        payload: { active: true },
        waitForResponse: true,
        timeoutMs: 10000,
        note: 'Adjusts event-aware status watch behavior when supported by firmware.'
    },
    {
        group: 'Network',
        command: 'wifi-scan',
        label: 'Wi-Fi Scan',
        payload: {},
        waitForResponse: true,
        timeoutMs: 20000,
        note: 'Runs the firmware Wi-Fi scan lane over MQTT.'
    },
    {
        group: 'Network',
        command: 'wifi-reconnect',
        label: 'Wi-Fi Reconnect',
        payload: {},
        waitForResponse: true,
        timeoutMs: 45000,
        note: 'Requests Wi-Fi reconnect without using serial/debug transport.'
    },
    {
        group: 'Network',
        command: 'wifi-disconnect',
        label: 'Wi-Fi Disconnect',
        payload: {},
        waitForResponse: true,
        timeoutMs: 15000,
        note: 'Disconnects Wi-Fi when firmware allows it.'
    },
    {
        group: 'Network',
        command: 'mobile-toggle',
        label: 'Mobile Data On',
        payload: { enabled: true },
        waitForResponse: true,
        timeoutMs: 45000,
        note: 'Opens the modem data fallback lane.'
    },
    {
        group: 'Network',
        command: 'mobile-toggle',
        label: 'Mobile Data Off',
        payload: { enabled: false },
        waitForResponse: true,
        timeoutMs: 30000,
        note: 'Closes modem data when policy allows it.'
    },
    {
        group: 'Telephony',
        command: 'send-ussd',
        label: 'USSD',
        payload: { code: '*123#' },
        waitForResponse: true,
        timeoutMs: 60000,
        note: 'Vendor basis: AT+CUSD session; dashboard sends the runtime USSD action.'
    },
    {
        group: 'Telephony',
        command: 'cancel-ussd',
        label: 'Cancel USSD',
        payload: {},
        waitForResponse: true,
        timeoutMs: 15000,
        note: 'Vendor basis: AT+CUSD=2 cancellation.'
    },
    {
        group: 'Telephony',
        command: 'make-call',
        label: 'Dial Number',
        payload: { number: '' },
        waitForResponse: true,
        timeoutMs: 45000,
        note: 'Use only with a real target number. Active ESP32 support is dial/hangup.'
    },
    {
        group: 'Telephony',
        command: 'end-call',
        label: 'Hang Up',
        payload: {},
        waitForResponse: true,
        timeoutMs: 15000,
        note: 'Ends the active call lane when firmware reports support.'
    },
    {
        group: 'Storage',
        command: 'storage-info',
        label: 'Storage Info',
        payload: {},
        waitForResponse: true,
        timeoutMs: 10000,
        note: 'Reads card/mount health through the runtime storage lane.'
    },
    {
        group: 'GPIO',
        command: 'gpio-status',
        label: 'GPIO Status',
        payload: {},
        waitForResponse: true,
        timeoutMs: 10000,
        note: 'Reads GPIO state if the active firmware exposes it.'
    },
    {
        group: 'GPIO',
        command: 'gpio-write',
        label: 'GPIO Write',
        payload: { pin: 2, value: 1 },
        waitForResponse: true,
        timeoutMs: 10000,
        note: 'Writes a pin through the firmware GPIO lane. Check board pin docs first.'
    },
    {
        group: 'System',
        command: 'restart-modem',
        label: 'Restart Modem',
        payload: {},
        waitForResponse: false,
        timeoutMs: 10000,
        note: 'Disruptive. Use only when the modem lane needs recovery.'
    },
    {
        group: 'Experimental',
        command: 'modem-at',
        label: 'Raw AT Probe',
        payload: { line: 'AT+CSQ' },
        waitForResponse: true,
        timeoutMs: 10000,
        note: 'Requires explicit firmware support. Current main firmware may reject this.'
    }
];

const VENDOR_NOTES = [
    {
        title: 'AT probe baseline',
        commands: ['AT', 'AT+CPIN?', 'AT+CSQ', 'AT+CREG?', 'AT+CGREG?', 'AT+COPS?'],
        note: 'Use these from terminal/serial first when adding new modem-backed firmware behavior.'
    },
    {
        title: 'USSD',
        commands: ['AT+CUSD=?', 'AT+CUSD?', 'AT+CUSD=1,"<code>",15', 'AT+CUSD=2'],
        note: 'USSD continuation uses the same AT+CUSD write command; cancel uses AT+CUSD=2.'
    },
    {
        title: 'Battery and SIM',
        commands: ['AT+CBC?', 'AT+CNUM', 'AT+CGSN'],
        note: 'Useful for compact device identity and power status checks.'
    },
    {
        title: 'Packet data',
        commands: ['AT+CGDCONT?', 'AT+CGACT?', 'AT+NETOPEN?', 'AT+IPADDR'],
        note: 'Use to validate modem data before changing Wi-Fi/modem fallback firmware.'
    },
    {
        title: 'Modem MQTT',
        commands: ['AT+CMQTTSTART', 'AT+CMQTTACCQ', 'AT+CMQTTCONNECT', 'AT+CMQTTSUB', 'AT+CMQTTPUB'],
        note: 'These are modem-side MQTT commands. Dashboard runtime actions still go through device/{id}/command/{command}.'
    }
];

function normalizeBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
}

function normalizeTimeout(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
    return Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.round(parsed)));
}

function normalizeCommand(value) {
    const command = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(command)) {
        return '';
    }
    return command;
}

function normalizePayload(value) {
    if (value === undefined || value === null || value === '') {
        return {};
    }
    if (typeof value === 'string') {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Payload must be a JSON object');
        }
        return parsed;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Payload must be a JSON object');
    }
    return value;
}

router.get('/commands', (req, res) => {
    res.json({
        success: true,
        data: {
            presets: COMMAND_PRESETS,
            vendorNotes: VENDOR_NOTES,
            defaults: {
                waitForResponse: true,
                timeoutMs: DEFAULT_TIMEOUT_MS,
                liveOnly: true
            }
        }
    });
});

router.post('/command', async (req, res) => {
    const startedAt = Date.now();

    try {
        const deviceId = String(resolveDeviceId(req, DEFAULT_DEVICE_ID) || '').trim();
        const command = normalizeCommand(req.body?.command);
        const payload = normalizePayload(req.body?.payload);
        const waitForResponse = normalizeBoolean(req.body?.waitForResponse, true);
        const timeoutMs = normalizeTimeout(req.body?.timeoutMs);
        const messageId = String(req.body?.messageId || '').trim()
            || `console_${crypto.randomBytes(6).toString('hex')}`;

        if (!deviceId) {
            return res.status(400).json({ success: false, message: 'No active device selected' });
        }

        if (!command) {
            return res.status(400).json({
                success: false,
                message: 'Command must use only letters, numbers, hyphen, and underscore'
            });
        }

        if (!global.mqttService || typeof global.mqttService.publishCommand !== 'function') {
            return res.status(503).json({ success: false, message: 'MQTT command service unavailable' });
        }

        const result = await global.mqttService.publishCommand(
            deviceId,
            command,
            payload,
            waitForResponse,
            timeoutMs,
            {
                source: 'dashboard-esp32-console',
                messageId,
                skipPersistentQueue: true,
                domain: command === 'get-status' ? 'status' : undefined,
                bypassCompatibility: true
            }
        );

        res.json({
            success: true,
            deviceId,
            command,
            payload,
            waitForResponse,
            timeoutMs,
            messageId,
            durationMs: Date.now() - startedAt,
            result
        });
    } catch (error) {
        logger.warn('ESP32 console command failed:', error.message);
        const message = String(error.message || '');
        const statusCode = /timeout/i.test(message)
            ? 504
            : (/payload must|command must|no active device/i.test(message)
                ? 400
                : (/mqtt not connected|mqtt command service unavailable/i.test(message) ? 503 : 500));
        res.status(statusCode).json({
            success: false,
            message: message || 'Command failed',
            durationMs: Date.now() - startedAt
        });
    }
});

module.exports = router;
