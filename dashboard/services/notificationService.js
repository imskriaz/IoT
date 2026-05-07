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
                options.actionUrl || options.action_url || null,
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
        actionUrl: options.actionUrl || '/sms',
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
        actionUrl: options.actionUrl || '/calls',
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

module.exports = { notify, capture, notifySms, notifyMissedCall, notifyLowBattery };
