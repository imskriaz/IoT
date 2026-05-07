const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { resolveDeviceId } = require('../utils/deviceResolver');
const {
    MAX_EVENT_LOG_LINES,
    appendConsoleEvent,
    clearConsoleEvents,
    readConsoleEvents,
    sanitizeEvent
} = require('../services/consoleEventLog');
const vendorCommandCatalog = require('../config/vendor-console-commands.json');

const router = express.Router();

const MAX_TIMEOUT_MS = 120000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RAW_MODEM_LINE_LEN = 96;
const FIRMWARE_DOCS_DIR = path.join(__dirname, '..', '..', 'firmware', 'espidf', 'esp32-s3-a7670e', 'docs');
const VENDOR_COMMANDS = Array.isArray(vendorCommandCatalog?.commands)
    ? vendorCommandCatalog.commands.filter((command) => command && command.line && Array.isArray(command.transports))
    : [];

const COMMAND_PRESETS = [
    {
        group: 'Status',
        category: 'system',
        deviceTypes: ['esp32', 'android'],
        command: 'get-status',
        label: 'Get Status',
        payload: {},
        waitForResponse: true,
        timeoutMs: 15000,
        note: 'Compact runtime status snapshot. Use before and after command tests.'
    },
    {
        group: 'Status',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'status-watch',
        label: 'Status Watch',
        payload: { active: true },
        waitForResponse: true,
        timeoutMs: 10000,
        note: 'Adjusts event-aware status watch behavior when supported by firmware.'
    },
    {
        group: 'Network',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'wifi-scan',
        label: 'Wi-Fi Scan',
        payload: {},
        waitForResponse: true,
        timeoutMs: 20000,
        note: 'Runs the firmware Wi-Fi scan lane over MQTT.'
    },
    {
        group: 'Network',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'wifi-reconnect',
        label: 'Wi-Fi Reconnect',
        payload: {},
        waitForResponse: true,
        timeoutMs: 45000,
        note: 'Requests Wi-Fi reconnect without using serial/debug transport.'
    },
    {
        group: 'Network',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'wifi-disconnect',
        label: 'Wi-Fi Disconnect',
        payload: {},
        waitForResponse: true,
        timeoutMs: 15000,
        note: 'Disconnects Wi-Fi when firmware allows it.'
    },
    {
        group: 'Network',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'mobile-toggle',
        label: 'Mobile Data On',
        payload: { enabled: true },
        waitForResponse: true,
        timeoutMs: 45000,
        note: 'Opens the modem data fallback lane.'
    },
    {
        group: 'Network',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'mobile-toggle',
        label: 'Mobile Data Off',
        payload: { enabled: false },
        waitForResponse: true,
        timeoutMs: 30000,
        note: 'Closes modem data when policy allows it.'
    },
    {
        group: 'Telephony',
        category: 'system',
        deviceTypes: ['esp32', 'android'],
        command: 'send-ussd',
        label: 'USSD',
        payload: { code: '*123#' },
        waitForResponse: true,
        timeoutMs: 60000,
        note: 'Vendor basis: AT+CUSD session; dashboard sends the runtime USSD action.'
    },
    {
        group: 'Telephony',
        category: 'system',
        deviceTypes: ['esp32', 'android'],
        command: 'cancel-ussd',
        label: 'Cancel USSD',
        payload: {},
        waitForResponse: true,
        timeoutMs: 15000,
        note: 'Vendor basis: AT+CUSD=2 cancellation.'
    },
    {
        group: 'Telephony',
        category: 'system',
        deviceTypes: ['esp32', 'android'],
        command: 'make-call',
        label: 'Dial Number',
        payload: { number: '' },
        waitForResponse: true,
        timeoutMs: 45000,
        note: 'Use only with a real target number. Active ESP32 support is dial/hangup.'
    },
    {
        group: 'Telephony',
        category: 'system',
        deviceTypes: ['esp32', 'android'],
        command: 'end-call',
        label: 'Hang Up',
        payload: {},
        waitForResponse: true,
        timeoutMs: 15000,
        note: 'Ends the active call lane when firmware reports support.'
    },
    {
        group: 'Storage',
        category: 'system',
        deviceTypes: ['esp32', 'android'],
        command: 'storage-info',
        label: 'Storage Info',
        payload: {},
        waitForResponse: true,
        timeoutMs: 10000,
        note: 'Reads card/mount health through the runtime storage lane.'
    },
    {
        group: 'GPIO',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'gpio-status',
        label: 'GPIO Status',
        payload: {},
        waitForResponse: true,
        timeoutMs: 10000,
        note: 'Reads GPIO state if the active firmware exposes it.'
    },
    {
        group: 'GPIO',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'gpio-write',
        label: 'GPIO Write',
        payload: { pin: 2, value: 1 },
        waitForResponse: true,
        timeoutMs: 10000,
        note: 'Writes a pin through the firmware GPIO lane. Check board pin docs first.'
    },
    {
        group: 'System',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'restart-modem',
        label: 'Restart Modem',
        payload: {},
        waitForResponse: false,
        timeoutMs: 10000,
        note: 'Disruptive. Use only when the modem lane needs recovery.'
    },
    {
        group: 'Manual',
        category: 'manual',
        deviceTypes: ['esp32'],
        command: 'modem-at',
        label: 'Raw AT Probe',
        payload: { line: 'AT+CSQ' },
        waitForResponse: true,
        timeoutMs: 10000,
        note: 'Manual modem probe. Validate the same line in terminal/serial before turning it into firmware behavior.'
    }
];

const KNOWN_CONSOLE_COMMANDS = new Set(COMMAND_PRESETS.map((preset) => preset.command));

function pushDoc(docs, title, absolutePath, group = 'Documents') {
    if (!absolutePath || !fs.existsSync(absolutePath)) return;
    docs.push({
        title,
        group,
        path: path.relative(path.join(__dirname, '..', '..'), absolutePath).replace(/\\/g, '/'),
        kind: path.extname(absolutePath).replace('.', '').toLowerCase() || 'file',
        bytes: fs.statSync(absolutePath).size
    });
}

function buildDocumentCatalog() {
    const docs = [];
    pushDoc(docs, 'Runtime Rulebook', path.join(FIRMWARE_DOCS_DIR, 'RULEBOOK.md'), 'Runtime');
    pushDoc(docs, 'Runtime Implementation Plan', path.join(FIRMWARE_DOCS_DIR, 'RUNTIME_IMPLEMENTATION_PLAN.md'), 'Runtime');
    pushDoc(docs, 'ESP32 Docs Index', path.join(FIRMWARE_DOCS_DIR, 'README.md'), 'Runtime');

    const vendorRoot = path.join(FIRMWARE_DOCS_DIR, 'vendor', 'esp32-s3-a7670e');
    const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name))
            .forEach((entry) => {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath);
                    return;
                }
                if (!/\.(md|pdf)$/i.test(entry.name)) return;
                const relative = path.relative(vendorRoot, fullPath).replace(/\\/g, '/');
                const group = relative.startsWith('hardware/')
                    ? 'Hardware'
                    : (relative.startsWith('demo/') ? 'Demo' : 'Vendor');
                const title = entry.name.replace(/\.(md|pdf)$/i, '').replace(/_/g, ' ');
                pushDoc(docs, title, fullPath, group);
            });
    };
    walk(vendorRoot);
    return docs;
}

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

function normalizeRawModemLine(value) {
    const line = String(value || '').trim();
    if (!line) {
        return '';
    }
    if (line.length > MAX_RAW_MODEM_LINE_LEN) {
        throw new Error(`Raw modem line must be ${MAX_RAW_MODEM_LINE_LEN} characters or less`);
    }
    if (/[\r\n\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(line)) {
        throw new Error('Raw modem line must be a single printable line');
    }
    return line;
}

function looksLikeRawModemLine(value) {
    const line = String(value || '').trim();
    if (!line) {
        return false;
    }
    const normalizedCommand = normalizeCommand(line);
    if (normalizedCommand && KNOWN_CONSOLE_COMMANDS.has(normalizedCommand)) {
        return false;
    }
    if (normalizedCommand === 'modem-at') {
        return false;
    }
    if (/^a(?:t)?(?:$|[+?=,])/i.test(line)) {
        return true;
    }
    return !normalizedCommand && /[+?=,"\s]/.test(line);
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
            vendorCommands: VENDOR_COMMANDS,
            vendorCatalog: {
                version: vendorCommandCatalog.version || 1,
                generatedFrom: vendorCommandCatalog.generatedFrom || []
            },
            documents: buildDocumentCatalog(),
            defaults: {
                waitForResponse: true,
                timeoutMs: DEFAULT_TIMEOUT_MS,
                liveOnly: true
            }
        }
    });
});

router.get('/events', (req, res) => {
    const limit = Math.max(1, Math.min(MAX_EVENT_LOG_LINES, Number(req.query?.limit) || 100));
    const deviceId = String(resolveDeviceId(req, '') || '').trim();
    res.json({
        success: true,
        data: readConsoleEvents(limit, deviceId)
    });
});

router.get('/documents', (req, res) => {
    try {
        const repoRoot = path.join(__dirname, '..', '..');
        const requested = String(req.query?.path || '').trim();
        const absolutePath = path.resolve(repoRoot, requested);
        const docsRoot = path.resolve(FIRMWARE_DOCS_DIR);

        if (!requested || !absolutePath.startsWith(docsRoot + path.sep) || !fs.existsSync(absolutePath)) {
            return res.status(404).json({
                success: false,
                message: 'Document not found'
            });
        }

        return res.sendFile(absolutePath);
    } catch (error) {
        logger.warn('Console document read failed:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to read document'
        });
    }
});

router.post('/events', (req, res) => {
    try {
        const event = sanitizeEvent({
            ...(req.body || {}),
            deviceId: String(req.body?.deviceId || resolveDeviceId(req, DEFAULT_DEVICE_ID) || '').trim()
        });
        appendConsoleEvent(event);
        res.json({
            success: true,
            data: event
        });
    } catch (error) {
        logger.warn('Console event log append failed:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to append console event'
        });
    }
});

router.delete('/events', (req, res) => {
    try {
        clearConsoleEvents();
        res.json({ success: true });
    } catch (error) {
        logger.warn('Console event log clear failed:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to clear console event log'
        });
    }
});

router.post('/command', async (req, res) => {
    const startedAt = Date.now();

    try {
        const deviceId = String(resolveDeviceId(req, DEFAULT_DEVICE_ID) || '').trim();
        const commandInput = String(req.body?.command || '').trim();
        let command = normalizeCommand(commandInput);
        let payload = normalizePayload(req.body?.payload);
        let rawLine = '';
        const waitForResponse = normalizeBoolean(req.body?.waitForResponse, true);
        const timeoutMs = normalizeTimeout(req.body?.timeoutMs);
        const messageId = String(req.body?.messageId || '').trim()
            || `console_${crypto.randomBytes(6).toString('hex')}`;
        const explicitRaw = normalizeBoolean(req.body?.raw, false);

        if (explicitRaw || looksLikeRawModemLine(commandInput)) {
            rawLine = normalizeRawModemLine(commandInput);
            command = 'modem-at';
            payload = {
                ...payload,
                line: rawLine,
                raw_line: rawLine
            };
        } else if (command === 'modem-at') {
            rawLine = normalizeRawModemLine(payload.line || payload.raw_line || payload.rawLine);
            if (rawLine) {
                payload = {
                    ...payload,
                    line: rawLine,
                    raw_line: rawLine
                };
            }
        }

        if (!deviceId) {
            return res.status(400).json({ success: false, message: 'No active device selected' });
        }

        if (!command) {
            return res.status(400).json({
                success: false,
                message: 'Command must use only letters, numbers, hyphen, and underscore, or enter a single raw modem line'
            });
        }

        if (command === 'modem-at' && !rawLine) {
            return res.status(400).json({
                success: false,
                message: 'Raw modem command requires a line, for example AT or AT+CSQ'
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
            rawLine: rawLine || undefined,
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
