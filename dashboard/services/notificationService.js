/**
 * notificationService.js
 *
 * Sends notifications via email (nodemailer) and Telegram (node-telegram-bot-api).
 * Configuration is read from the `settings` DB table at send time so changes
 * take effect without restarting the server.
 *
 * Exported API:
 *   notify(type, subject, body) — send to all enabled channels
 *   notifySms(from, message)    — "new SMS received" shortcut
 *   notifyMissedCall(number)    — "missed call" shortcut
 *   notifyLowBattery(level)     — "low battery" shortcut
 */

const nodemailer = require('nodemailer');
const TelegramBot = require('node-telegram-bot-api');
const logger = require('../utils/logger');

// Cache the Telegram bot instance to avoid re-creating it on every send
let _telegramBot = null;
let _telegramToken = null;

function getTelegramBot(token) {
    if (!token) return null;
    if (_telegramBot && _telegramToken === token) return _telegramBot;
    // Re-create if token changed
    if (_telegramBot) { try { _telegramBot.stopPolling(); } catch {} }
    _telegramBot = new TelegramBot(token, { polling: false });
    _telegramToken = token;
    return _telegramBot;
}

/**
 * Load notification settings from DB.
 * Returns { email: {...}, telegram: {...} } or null if DB unavailable.
 */
async function loadSettings() {
    try {
        const db = global.app && global.app.locals.db;
        if (!db) return null;

        const rows = await db.all("SELECT key, value FROM settings WHERE key IN ('notifications', 'email', 'telegram')");
        const map = {};
        rows.forEach(r => {
            try { map[r.key] = JSON.parse(r.value); } catch { map[r.key] = r.value; }
        });

        return map.notifications || {
            email: map.email || null,
            telegram: map.telegram || null
        };
    } catch (e) {
        logger.error('notificationService: failed to load settings', e);
        return null;
    }
}

// ==================== EMAIL ====================

async function sendEmail(emailCfg, subject, body) {
    if (!emailCfg || !emailCfg.enabled) return;
    if (!emailCfg.smtp || !emailCfg.to) {
        logger.warn('notificationService: email enabled but smtp/to not configured');
        return;
    }

    try {
        const transporter = nodemailer.createTransport({
            host: emailCfg.smtp,
            port: emailCfg.port || 587,
            secure: emailCfg.secure || false,
            auth: emailCfg.user && emailCfg.password
                ? { user: emailCfg.user, pass: emailCfg.password }
                : undefined
        });

        await transporter.sendMail({
            from: emailCfg.from || emailCfg.user || 'esp32-dashboard@noreply',
            to: emailCfg.to,
            subject: `[ESP32 Dashboard] ${subject}`,
            text: body
        });

        logger.info(`notificationService: email sent — ${subject}`);
    } catch (e) {
        logger.error('notificationService: email send failed', e.message);
    }
}

// ==================== TELEGRAM ====================

async function sendTelegram(tgCfg, message) {
    if (!tgCfg || !tgCfg.enabled) return;
    if (!tgCfg.botToken || !tgCfg.chatId) {
        logger.warn('notificationService: telegram enabled but botToken/chatId not configured');
        return;
    }

    try {
        const bot = getTelegramBot(tgCfg.botToken);
        if (!bot) return;
        await bot.sendMessage(tgCfg.chatId, `🔔 *ESP32 Dashboard*\n${message}`, { parse_mode: 'Markdown' });
        logger.info(`notificationService: telegram sent — ${message.substring(0, 60)}`);
    } catch (e) {
        logger.error('notificationService: telegram send failed', e.message);
    }
}

// ==================== PUBLIC API ====================

/**
 * Send a notification on all enabled channels.
 * @param {string} subject  Short title (used as email subject + first line of Telegram)
 * @param {string} body     Full message text
 */
async function notify(subject, body) {
    try {
        const settings = await loadSettings();
        if (!settings) return;

        const text = body || subject;
        await Promise.all([
            sendEmail(settings.email, subject, text),
            sendTelegram(settings.telegram, `*${subject}*\n${text}`)
        ]);
    } catch (e) {
        logger.error('notificationService: notify error', e);
    }
}

function normalizeSeverity(value) {
    const severity = String(value || '').trim().toLowerCase();
    if (['success', 'info', 'warning', 'danger', 'error'].includes(severity)) {
        return severity === 'error' ? 'danger' : severity;
    }
    return 'info';
}

function safeMetadata(value) {
    if (value === undefined || value === null) return null;
    try {
        return JSON.stringify(value);
    } catch (_) {
        return JSON.stringify({ value: String(value) });
    }
}

function firstText(...values) {
    for (const value of values) {
        const text = String(value ?? '').trim();
        if (text) return text;
    }
    return '';
}

function parseMetadataObject(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function withDevice(url, deviceId) {
    const normalizedUrl = String(url || '').trim() || '/dashboard';
    const normalizedDeviceId = String(deviceId || '').trim();
    if (!normalizedDeviceId) return normalizedUrl;
    try {
        const parsed = new URL(normalizedUrl, 'http://dashboard.local');
        if (!parsed.searchParams.has('device')) {
            parsed.searchParams.set('device', normalizedDeviceId);
        }
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch (_) {
        const separator = normalizedUrl.includes('?') ? '&' : '?';
        return `${normalizedUrl}${separator}device=${encodeURIComponent(normalizedDeviceId)}`;
    }
}

function buildNotificationActionUrl(options = {}) {
    const category = String(options.category || '').trim().toLowerCase();
    const metadata = parseMetadataObject(options.metadata);
    const deviceId = firstText(options.deviceId, options.device_id, metadata.deviceId, metadata.device_id);
    const existing = firstText(options.actionUrl, options.action_url);

    if (category === 'sms') {
        const base = existing && existing !== '/sms' ? existing : '/sms';
        const conversationId = firstText(metadata.conversationId, metadata.conversation_id);
        const thread = firstText(
            metadata.thread,
            metadata.thread_number,
            metadata.from,
            metadata.from_number,
            metadata.to,
            metadata.to_number,
            metadata.number,
            metadata.recipient
        );
        try {
            const parsed = new URL(base, 'http://dashboard.local');
            if (deviceId && !parsed.searchParams.has('device')) parsed.searchParams.set('device', deviceId);
            if (conversationId && !parsed.searchParams.has('conversation')) parsed.searchParams.set('conversation', conversationId);
            if (thread && !parsed.searchParams.has('thread') && !parsed.searchParams.has('to')) parsed.searchParams.set('thread', thread);
            return `${parsed.pathname}${parsed.search}${parsed.hash}`;
        } catch (_) {
            return withDevice('/sms', deviceId);
        }
    }

    if (category === 'call') {
        const base = existing && existing !== '/calls' ? existing : '/calls';
        const number = firstText(metadata.number, metadata.from, metadata.phone_number, metadata.phone);
        try {
            const parsed = new URL(base, 'http://dashboard.local');
            if (deviceId && !parsed.searchParams.has('device')) parsed.searchParams.set('device', deviceId);
            if (number && !parsed.searchParams.has('to')) parsed.searchParams.set('to', number);
            return `${parsed.pathname}${parsed.search}${parsed.hash}`;
        } catch (_) {
            return withDevice('/calls', deviceId);
        }
    }

    if (existing) return withDevice(existing, deviceId);

    if (category === 'automation') return '/automation';
    if (category === 'queue') return withDevice('/devices/queue', deviceId);
    if (category === 'device' || category === 'network' || category === 'security') return withDevice('/devices/about', deviceId);
    if (category === 'location') return withDevice('/location', deviceId);
    if (category === 'ussd') return withDevice('/ussd', deviceId);
    return '';
}

async function capture(options = {}) {
    try {
        const db = global.app && global.app.locals.db;
        if (!db) return null;

        const title = String(options.title || '').trim();
        if (!title) return null;

        const severity = normalizeSeverity(options.severity || options.type);
        const type = String(options.type || severity || 'info').trim().toLowerCase();
        const category = String(options.category || 'system').trim().toLowerCase();
        const source = String(options.source || 'dashboard').trim().toLowerCase();
        const deviceId = options.deviceId || options.device_id || null;
        const userId = Number.isInteger(options.userId) ? options.userId : null;
        const eventKey = options.eventKey ? String(options.eventKey).trim() : null;

        if (eventKey) {
            const existing = await db.get(
                `SELECT id FROM notifications
                 WHERE event_key = ?
                   AND datetime(created_at) >= datetime('now', '-10 minutes')
                 ORDER BY id DESC LIMIT 1`,
                [eventKey]
            );
            if (existing) return existing;
        }

        const result = await db.run(
            `INSERT INTO notifications (
                user_id, device_id, type, severity, category, source,
                title, message, action_url, action_text, metadata, event_key
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                userId,
                deviceId,
                type,
                severity,
                category,
                source,
                title,
                options.message == null ? null : String(options.message),
                buildNotificationActionUrl({ ...options, category, deviceId }) || null,
                options.actionText || options.action_text || null,
                safeMetadata(options.metadata),
                eventKey
            ]
        );

        const notification = await db.get(`SELECT * FROM notifications WHERE id = ?`, [result.lastID]);
        const io = global.io || global.app?.locals?.io;
        io?.emit?.('notification:created', notification);
        return notification;
    } catch (e) {
        logger.error('notificationService: capture error', e);
        return null;
    }
}

async function notifySms(from, message, options = {}) {
    await capture({
        deviceId: options.deviceId,
        type: 'info',
        severity: 'info',
        category: 'sms',
        source: 'device',
        title: 'New SMS received',
        message: `From: ${from}\nMessage: ${message}`,
        actionUrl: options.actionUrl || null,
        metadata: { from, message },
        eventKey: options.eventKey
    });
    await notify(
        'New SMS received',
        `From: ${from}\nMessage: ${message}`
    );
}

async function notifyMissedCall(number, options = {}) {
    await capture({
        deviceId: options.deviceId,
        type: 'warning',
        severity: 'warning',
        category: 'call',
        source: 'device',
        title: 'Missed call',
        message: `You missed a call from ${number || 'Unknown number'}`,
        actionUrl: options.actionUrl || null,
        metadata: { number },
        eventKey: options.eventKey
    });
    await notify(
        'Missed call',
        `You missed a call from ${number}`
    );
}

async function notifyLowBattery(level, options = {}) {
    await capture({
        deviceId: options.deviceId,
        type: 'warning',
        severity: 'warning',
        category: 'device',
        source: 'device',
        title: 'Low battery warning',
        message: `Device battery is at ${level}%`,
        actionUrl: options.actionUrl || '/devices/about',
        metadata: { level },
        eventKey: options.eventKey
    });
    await notify(
        'Low battery warning',
        `Device battery is at ${level}%`
    );
}

module.exports = { notify, capture, notifySms, notifyMissedCall, notifyLowBattery, buildNotificationActionUrl };
