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

async function notifySms(from, message) {
    await notify(
        'New SMS received',
        `From: ${from}\nMessage: ${message}`
    );
}

async function notifyMissedCall(number) {
    await notify(
        'Missed call',
        `You missed a call from ${number}`
    );
}

async function notifyLowBattery(level) {
    await notify(
        'Low battery warning',
        `Device battery is at ${level}%`
    );
}

module.exports = { notify, notifySms, notifyMissedCall, notifyLowBattery };
