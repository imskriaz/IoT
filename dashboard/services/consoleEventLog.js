'use strict';

const fs = require('fs');
const path = require('path');

const MAX_EVENT_LOG_LINES = 500;
const MAX_EVENT_BODY_LEN = 4096;
const CONSOLE_EVENT_LOG = path.join(__dirname, '..', 'logs', 'console-events.ndjson');

function ensureLogDir() {
    fs.mkdirSync(path.dirname(CONSOLE_EVENT_LOG), { recursive: true });
}

function sanitizeEvent(value) {
    const event = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const compact = {
        timestamp: String(event.timestamp || new Date().toISOString()).slice(0, 64),
        deviceId: String(event.deviceId || '').slice(0, 64),
        deviceType: String(event.deviceType || '').slice(0, 32),
        consoleTab: String(event.consoleTab || '').slice(0, 24),
        scope: String(event.scope || '').slice(0, 24),
        source: String(event.source || 'console').slice(0, 80),
        level: String(event.level || 'info').slice(0, 24),
        message: String(event.message || '').slice(0, 500),
        data: event.data == null ? null : event.data
    };
    let serialized = '';
    try {
        serialized = JSON.stringify(compact);
    } catch (_) {
        compact.data = { unserializable: true };
        serialized = JSON.stringify(compact);
    }
    return serialized.length > MAX_EVENT_BODY_LEN
        ? { ...compact, data: { truncated: true } }
        : compact;
}

function appendConsoleEvent(event) {
    ensureLogDir();
    const safeEvent = sanitizeEvent(event);
    fs.appendFileSync(CONSOLE_EVENT_LOG, `${JSON.stringify(safeEvent)}\n`, 'utf8');
    return safeEvent;
}

function readConsoleEvents(limit = 100, deviceId = '') {
    if (!fs.existsSync(CONSOLE_EVENT_LOG)) {
        return [];
    }
    const max = Math.max(1, Math.min(MAX_EVENT_LOG_LINES, Number(limit) || 100));
    const wantedDevice = String(deviceId || '').trim();
    const lines = fs.readFileSync(CONSOLE_EVENT_LOG, 'utf8').split(/\r?\n/).filter(Boolean).slice(-MAX_EVENT_LOG_LINES);
    const events = [];
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            if (wantedDevice && parsed.deviceId && parsed.deviceId !== wantedDevice) {
                continue;
            }
            events.push(parsed);
        } catch (_) {}
    }
    return events.slice(-max);
}

function clearConsoleEvents() {
    ensureLogDir();
    fs.writeFileSync(CONSOLE_EVENT_LOG, '', 'utf8');
}

module.exports = {
    MAX_EVENT_LOG_LINES,
    appendConsoleEvent,
    clearConsoleEvents,
    readConsoleEvents,
    sanitizeEvent
};
