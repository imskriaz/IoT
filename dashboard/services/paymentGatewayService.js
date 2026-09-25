'use strict';

const logger = require('../utils/logger');

const PAYMENT_GATEWAYS_KEY = 'payment_gateways';

function parseJsonArray(value, fallback = []) {
    if (!value) return fallback;
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return Array.isArray(parsed) ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function cleanText(value, max = 255) {
    return String(value || '').trim().slice(0, max);
}

function normalizeGateway(raw = {}) {
    const code = cleanText(raw.code || raw.name, 64).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    const name = cleanText(raw.name || raw.code, 80);
    if (!code || !name) return null;

    return {
        code,
        name,
        enabled: Boolean(raw.enabled),
        account_number: cleanText(raw.account_number || raw.number, 120),
        account_type: cleanText(raw.account_type || raw.type, 80),
        instructions: cleanText(raw.instructions, 500)
    };
}

function normalizeGatewayList(rawGateways) {
    const normalized = (Array.isArray(rawGateways) ? rawGateways : [])
        .map(normalizeGateway)
        .filter(Boolean);

    const unique = [];
    const seen = new Set();
    normalized.forEach((gateway) => {
        if (seen.has(gateway.code)) return;
        seen.add(gateway.code);
        unique.push(gateway);
    });

    if (!unique.length) return [];

    return unique;
}

function serializeGateway(gateway = {}) {
    return {
        code: gateway.code,
        name: gateway.name,
        enabled: !!gateway.enabled,
        account_number: gateway.account_number || '',
        account_type: gateway.account_type || '',
        instructions: gateway.instructions || ''
    };
}

function listActiveGateways(gateways) {
    return (Array.isArray(gateways) ? gateways : [])
        .filter((gateway) => gateway.enabled)
        .map(serializeGateway);
}

async function loadPaymentGateways(db) {
    if (!db) {
        return [];
    }

    try {
        const row = await db.get(`SELECT value FROM settings WHERE key = ?`, [PAYMENT_GATEWAYS_KEY]);
        const configured = normalizeGatewayList(parseJsonArray(row?.value, []));
        return configured;
    } catch (error) {
        logger.warn(`Could not load payment gateways: ${error.message}`);
        return [];
    }
}

async function savePaymentGateways(db, gateways, userId = null) {
    const normalized = normalizeGatewayList(gateways);
    await db.run(
        `INSERT INTO settings (key, value, type, category, description, updated_at, updated_by)
         VALUES (?, ?, 'json', 'payments', ?, CURRENT_TIMESTAMP, ?)
         ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             type = excluded.type,
             category = excluded.category,
             description = excluded.description,
             updated_at = CURRENT_TIMESTAMP,
             updated_by = excluded.updated_by`,
        [
            PAYMENT_GATEWAYS_KEY,
            JSON.stringify(normalized),
            'Payment gateway choices used for package applications and landing page checkout instructions',
            userId || null
        ]
    );
    return normalized;
}

module.exports = {
    PAYMENT_GATEWAYS_KEY,
    normalizeGatewayList,
    serializeGateway,
    listActiveGateways,
    loadPaymentGateways,
    savePaymentGateways
};
