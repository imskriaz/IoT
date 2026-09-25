'use strict';

const DEFAULT_USER_ADMIN_CONTROLS = Object.freeze({
    allow_dashboard_send: true,
    allow_api_send: true,
    shared_sms_day_limit: 0,
    shared_sms_month_limit: 0,
    notes: ''
});

function parseJsonObject(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function normalizeBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
    return fallback;
}

function normalizeNonNegativeInteger(value, fallback = 0) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseUserPreferences(value) {
    return parseJsonObject(value, {});
}

function buildUserAdminControls(preferences = {}) {
    const raw = parseJsonObject(preferences.admin_controls, {});
    return {
        allow_dashboard_send: normalizeBoolean(raw.allow_dashboard_send, DEFAULT_USER_ADMIN_CONTROLS.allow_dashboard_send),
        allow_api_send: normalizeBoolean(raw.allow_api_send, DEFAULT_USER_ADMIN_CONTROLS.allow_api_send),
        shared_sms_day_limit: normalizeNonNegativeInteger(raw.shared_sms_day_limit, DEFAULT_USER_ADMIN_CONTROLS.shared_sms_day_limit),
        shared_sms_month_limit: normalizeNonNegativeInteger(raw.shared_sms_month_limit, DEFAULT_USER_ADMIN_CONTROLS.shared_sms_month_limit),
        notes: String(raw.notes || '').trim().slice(0, 1000)
    };
}

function withUserAdminControls(preferences = {}, controls = {}) {
    const nextPreferences = {
        ...parseJsonObject(preferences, {})
    };
    nextPreferences.admin_controls = buildUserAdminControls({ admin_controls: controls });
    return nextPreferences;
}

function getUtcDateParts(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    return { year: String(year), month, day };
}

async function getUserSmsUsageSnapshot(db, userId, now = new Date()) {
    if (!db || !userId) {
        return { day: 0, month: 0 };
    }

    const { year, month, day } = getUtcDateParts(now);
    const dayPrefix = `${year}-${month}-${day}`;
    const monthPrefix = `${year}-${month}`;
    const [daily, monthly] = await Promise.all([
        db.get(
            `SELECT COUNT(*) AS count
             FROM sms
             WHERE user_id = ?
               AND type = 'outgoing'
               AND timestamp LIKE ?`,
            [userId, `${dayPrefix}%`]
        ),
        db.get(
            `SELECT COUNT(*) AS count
             FROM sms
             WHERE user_id = ?
               AND type = 'outgoing'
               AND timestamp LIKE ?`,
            [userId, `${monthPrefix}%`]
        )
    ]);

    return {
        day: Number(daily?.count || 0),
        month: Number(monthly?.count || 0)
    };
}

function classifySendSource(source) {
    const text = String(source || '').trim().toLowerCase();
    if (text.includes('api')) return 'api';
    return 'dashboard';
}

async function assertUserSmsWithinLimits(db, userId, source = 'dashboard', requestedCount = 1, now = new Date()) {
    if (!db || !userId) return null;

    const user = await db.get(`SELECT id, preferences, is_active FROM users WHERE id = ?`, [userId]);
    if (!user) return null;
    if (!user.is_active) {
        const error = new Error('User account is inactive.');
        error.code = 'USER_INACTIVE';
        throw error;
    }

    const preferences = parseUserPreferences(user.preferences);
    const controls = buildUserAdminControls(preferences);
    const channel = classifySendSource(source);

    if (channel === 'api' && !controls.allow_api_send) {
        const error = new Error('API SMS sending is disabled for this user.');
        error.code = 'USER_API_SMS_DISABLED';
        throw error;
    }

    if (channel === 'dashboard' && !controls.allow_dashboard_send) {
        const error = new Error('Dashboard SMS sending is disabled for this user.');
        error.code = 'USER_DASHBOARD_SMS_DISABLED';
        throw error;
    }

    const usage = await getUserSmsUsageSnapshot(db, userId, now);
    if (controls.shared_sms_day_limit && usage.day + requestedCount > controls.shared_sms_day_limit) {
        const error = new Error(`User daily SMS limit reached (${usage.day}/${controls.shared_sms_day_limit}).`);
        error.code = 'USER_SMS_DAILY_LIMIT';
        throw error;
    }

    if (controls.shared_sms_month_limit && usage.month + requestedCount > controls.shared_sms_month_limit) {
        const error = new Error(`User monthly SMS limit reached (${usage.month}/${controls.shared_sms_month_limit}).`);
        error.code = 'USER_SMS_MONTHLY_LIMIT';
        throw error;
    }

    return {
        controls,
        usage,
        channel
    };
}

module.exports = {
    DEFAULT_USER_ADMIN_CONTROLS,
    parseUserPreferences,
    buildUserAdminControls,
    withUserAdminControls,
    getUserSmsUsageSnapshot,
    assertUserSmsWithinLimits
};
