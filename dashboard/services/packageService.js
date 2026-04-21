'use strict';

const logger = require('../utils/logger');

const PACKAGE_SETTINGS_KEY = 'device_package_offers';
const DEFAULT_PACKAGE_PAYMENT = Object.freeze({
    method: 'bKash',
    number: '01628301525'
});

const DEFAULT_PACKAGE_OFFERS = Object.freeze([
    {
        code: 'starter',
        name: 'Starter',
        priceBdt: 499,
        limits: {
            sms_per_day: 250,
            sms_per_month: 5000,
            api_requests_per_minute: 30,
            assigned_users: 2
        }
    },
    {
        code: 'growth',
        name: 'Growth',
        priceBdt: 999,
        limits: {
            sms_per_day: 1000,
            sms_per_month: 25000,
            api_requests_per_minute: 90,
            assigned_users: 5
        }
    },
    {
        code: 'business',
        name: 'Business',
        priceBdt: 1999,
        limits: {
            sms_per_day: 5000,
            sms_per_month: 100000,
            api_requests_per_minute: 240,
            assigned_users: 20
        }
    }
]);

function parseJsonObject(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function normalizePositiveInteger(value, fallback = 0) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeOffer(raw = {}) {
    const code = String(raw.code || '').trim().toLowerCase();
    const name = String(raw.name || '').trim();
    if (!code || !name) return null;

    return {
        code,
        name,
        priceBdt: normalizePositiveInteger(raw.priceBdt ?? raw.price_bdt, 0),
        limits: {
            sms_per_day: normalizePositiveInteger(raw.limits?.sms_per_day, 0),
            sms_per_month: normalizePositiveInteger(raw.limits?.sms_per_month, 0),
            api_requests_per_minute: normalizePositiveInteger(raw.limits?.api_requests_per_minute, 0),
            assigned_users: normalizePositiveInteger(raw.limits?.assigned_users, 0)
        }
    };
}

function normalizeOfferList(rawOffers) {
    if (!Array.isArray(rawOffers)) return [];
    const normalized = rawOffers
        .map(normalizeOffer)
        .filter(Boolean);
    const uniqueByCode = new Map();
    normalized.forEach((offer) => {
        if (!uniqueByCode.has(offer.code)) {
            uniqueByCode.set(offer.code, offer);
        }
    });
    return Array.from(uniqueByCode.values());
}

function serializeOffer(offer) {
    return {
        code: offer.code,
        name: offer.name,
        price_bdt: Number(offer.priceBdt || 0),
        limits: { ...(offer.limits || {}) }
    };
}

async function loadPackageOffers(db) {
    if (!db) {
        return DEFAULT_PACKAGE_OFFERS.map((offer) => ({ ...offer, limits: { ...offer.limits } }));
    }

    try {
        const row = await db.get(`SELECT value FROM settings WHERE key = ?`, [PACKAGE_SETTINGS_KEY]);
        const configured = normalizeOfferList(parseJsonObject(row?.value, []));
        if (configured.length) return configured;
    } catch (error) {
        logger.warn(`Could not load package offers: ${error.message}`);
    }

    return DEFAULT_PACKAGE_OFFERS.map((offer) => ({ ...offer, limits: { ...offer.limits } }));
}

async function savePackageOffers(db, offers, userId = null) {
    const normalized = normalizeOfferList(offers);
    if (!normalized.length) {
        throw new Error('At least one package plan is required');
    }

    await db.run(
        `INSERT INTO settings (key, value, type, category, description, updated_at, updated_by)
         VALUES (?, ?, 'json', 'packages', ?, CURRENT_TIMESTAMP, ?)
         ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             type = excluded.type,
             category = excluded.category,
             description = excluded.description,
             updated_at = CURRENT_TIMESTAMP,
             updated_by = excluded.updated_by`,
        [
            PACKAGE_SETTINGS_KEY,
            JSON.stringify(normalized),
            'Commercial package plans for per-device allocation and limits',
            userId || null
        ]
    );

    return normalized;
}

function getPackageOffer(offers, packageCode) {
    const normalized = String(packageCode || '').trim().toLowerCase();
    return (Array.isArray(offers) ? offers : []).find((offer) => offer.code === normalized) || null;
}

function buildPaymentInstructions() {
    return {
        method: DEFAULT_PACKAGE_PAYMENT.method,
        number: DEFAULT_PACKAGE_PAYMENT.number,
        message: `Send the package price to ${DEFAULT_PACKAGE_PAYMENT.number} via bKash, then wait for admin approval.`
    };
}

function buildCurrentPackage(row) {
    const code = String(row?.current_package_code || '').trim();
    if (!code) return null;

    return {
        code,
        name: String(row?.current_package_name || '').trim() || code,
        price_bdt: Number(row?.current_package_price || 0),
        status: String(row?.current_package_status || 'approved').trim() || 'approved',
        approved_at: row?.current_package_approved_at || null,
        limits: parseJsonObject(row?.current_package_limits, {})
    };
}

function buildPackageRequest(row) {
    return {
        id: Number(row.id),
        device_id: row.device_id,
        user_id: Number(row.user_id),
        username: row.username || '',
        reviewer_name: row.reviewer_name || '',
        package_code: row.package_code,
        package_name: row.package_name,
        price_bdt: Number(row.price_bdt || 0),
        payment_method: row.payment_method || DEFAULT_PACKAGE_PAYMENT.method,
        payment_number: row.payment_number || DEFAULT_PACKAGE_PAYMENT.number,
        payment_reference: row.payment_reference || '',
        notes: row.notes || '',
        status: row.status || 'pending',
        requested_at: row.requested_at || null,
        reviewed_at: row.reviewed_at || null,
        review_notes: row.review_notes || '',
        limits: parseJsonObject(row.limits_json, {})
    };
}

async function loadDevicePackageSnapshot(db, deviceId) {
    const profile = await db.get(
        `SELECT current_package_code, current_package_name, current_package_price,
                current_package_limits, current_package_status, current_package_approved_at
         FROM device_profiles
         WHERE device_id = ?`,
        [deviceId]
    );
    const requests = await db.all(
        `SELECT r.*,
                u.username,
                reviewer.username AS reviewer_name
         FROM device_package_requests r
         LEFT JOIN users u ON u.id = r.user_id
         LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
         WHERE r.device_id = ?
         ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.requested_at DESC, r.id DESC`,
        [deviceId]
    );

    return {
        currentPackage: buildCurrentPackage(profile),
        requests: (requests || []).map(buildPackageRequest)
    };
}

async function approveDevicePackageRequest(db, requestRow, reviewerId, reviewNotes) {
    const limitsJson = requestRow.limits_json || '{}';

    await db.run(
        `UPDATE device_package_requests
         SET status = 'approved',
             reviewed_at = CURRENT_TIMESTAMP,
             reviewed_by = ?,
             review_notes = ?
         WHERE id = ?`,
        [reviewerId || null, reviewNotes || null, requestRow.id]
    );

    await db.run(
        `UPDATE device_package_requests
         SET status = 'superseded',
             reviewed_at = CURRENT_TIMESTAMP,
             reviewed_by = ?,
             review_notes = COALESCE(review_notes, 'Superseded by a newer approved package')
         WHERE device_id = ?
           AND id != ?
           AND status = 'approved'`,
        [reviewerId || null, requestRow.device_id, requestRow.id]
    );

    await db.run(
        `INSERT INTO device_profiles
            (device_id, current_package_code, current_package_name, current_package_price,
             current_package_limits, current_package_status, current_package_approved_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'approved', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(device_id) DO UPDATE SET
             current_package_code = excluded.current_package_code,
             current_package_name = excluded.current_package_name,
             current_package_price = excluded.current_package_price,
             current_package_limits = excluded.current_package_limits,
             current_package_status = 'approved',
             current_package_approved_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP`,
        [
            requestRow.device_id,
            requestRow.package_code,
            requestRow.package_name,
            Number(requestRow.price_bdt || 0),
            limitsJson
        ]
    );
}

function getUtcDateParts(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    return { year: String(year), month, day };
}

async function getSmsUsageSnapshot(db, deviceId, now = new Date()) {
    const { year, month, day } = getUtcDateParts(now);
    const dayPrefix = `${year}-${month}-${day}`;
    const monthPrefix = `${year}-${month}`;
    const [daily, monthly] = await Promise.all([
        db.get(
            `SELECT COUNT(*) AS count
             FROM sms
             WHERE device_id = ?
               AND type = 'outgoing'
               AND timestamp LIKE ?`,
            [deviceId, `${dayPrefix}%`]
        ),
        db.get(
            `SELECT COUNT(*) AS count
             FROM sms
             WHERE device_id = ?
               AND type = 'outgoing'
               AND timestamp LIKE ?`,
            [deviceId, `${monthPrefix}%`]
        )
    ]);

    return {
        day: Number(daily?.count || 0),
        month: Number(monthly?.count || 0)
    };
}

async function getDeviceQuotaState(db, deviceId, now = new Date()) {
    const profile = await db.get(
        `SELECT current_package_code, current_package_name, current_package_limits, current_package_status
         FROM device_profiles
         WHERE device_id = ?`,
        [deviceId]
    );

    const currentPackage = buildCurrentPackage(profile);
    const limits = parseJsonObject(profile?.current_package_limits, {});
    const usage = await getSmsUsageSnapshot(db, deviceId, now);

    return {
        currentPackage,
        limits,
        usage
    };
}

async function assertSmsWithinPackageLimit(db, deviceId, requestedCount = 1, now = new Date()) {
    if (!db || !deviceId) return null;

    const quota = await getDeviceQuotaState(db, deviceId, now);
    const dayLimit = normalizePositiveInteger(quota.limits?.sms_per_day, 0);
    const monthLimit = normalizePositiveInteger(quota.limits?.sms_per_month, 0);

    if (dayLimit && quota.usage.day + requestedCount > dayLimit) {
        const error = new Error(`Daily SMS package limit reached for this device (${quota.usage.day}/${dayLimit}).`);
        error.code = 'PACKAGE_SMS_DAILY_LIMIT';
        throw error;
    }

    if (monthLimit && quota.usage.month + requestedCount > monthLimit) {
        const error = new Error(`Monthly SMS package limit reached for this device (${quota.usage.month}/${monthLimit}).`);
        error.code = 'PACKAGE_SMS_MONTHLY_LIMIT';
        throw error;
    }

    return quota;
}

module.exports = {
    PACKAGE_SETTINGS_KEY,
    DEFAULT_PACKAGE_PAYMENT,
    DEFAULT_PACKAGE_OFFERS,
    parseJsonObject,
    normalizeOfferList,
    normalizeOffer,
    serializeOffer,
    loadPackageOffers,
    savePackageOffers,
    getPackageOffer,
    buildPaymentInstructions,
    buildCurrentPackage,
    buildPackageRequest,
    loadDevicePackageSnapshot,
    approveDevicePackageRequest,
    getDeviceQuotaState,
    assertSmsWithinPackageLimit
};
