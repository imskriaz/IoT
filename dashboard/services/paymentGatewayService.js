'use strict';

const logger = require('../utils/logger');

const PAYMENT_GATEWAYS_KEY = 'payment_gateways';
const DEFAULT_PAYMENT_GATEWAYS = Object.freeze([
    {
        code: 'bkash',
        name: 'bKash',
        enabled: true,
        primary: true,
        account_number: '01628301525',
        account_type: 'Personal',
        instructions: 'Send the package price to 01628301525 via bKash, then wait for admin approval.'
    },
    {
        code: 'nagad',
        name: 'Nagad',
        enabled: false,
        primary: false,
        account_number: '',
        account_type: 'Personal',
        instructions: ''
    },
    {
        code: 'rocket',
        name: 'Rocket',
        enabled: false,
        primary: false,
        account_number: '',
        account_type: 'Personal',
        instructions: ''
    }
]);

function cloneDefaultGateways() {
    return DEFAULT_PAYMENT_GATEWAYS.map((gateway) => ({ ...gateway }));
}

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
        primary: Boolean(raw.primary),
        account_number: cleanText(raw.account_number || raw.number, 120),
        account_type: cleanText(raw.account_type || raw.type || 'Personal', 80),
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

    if (!unique.length) {
        return cloneDefaultGateways();
    }

    let primaryAssigned = false;
    unique.forEach((gateway) => {
        if (gateway.enabled && gateway.primary && !primaryAssigned) {
            primaryAssigned = true;
            return;
        }
        gateway.primary = false;
    });

    if (!primaryAssigned) {
        const firstEnabled = unique.find((gateway) => gateway.enabled) || unique[0];
        firstEnabled.primary = true;
    }

    return unique;
}

function serializeGateway(gateway = {}) {
    return {
        code: gateway.code,
        name: gateway.name,
        enabled: !!gateway.enabled,
        primary: !!gateway.primary,
        account_number: gateway.account_number || '',
        account_type: gateway.account_type || '',
        instructions: gateway.instructions || ''
    };
}

async function loadPaymentGateways(db) {
    if (!db) {
        return cloneDefaultGateways();
    }

    try {
        const row = await db.get(`SELECT value FROM settings WHERE key = ?`, [PAYMENT_GATEWAYS_KEY]);
        const configured = normalizeGatewayList(parseJsonArray(row?.value, []));
        return configured.length ? configured : cloneDefaultGateways();
    } catch (error) {
        logger.warn(`Could not load payment gateways: ${error.message}`);
        return cloneDefaultGateways();
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

function getPrimaryGateway(gateways) {
    const list = Array.isArray(gateways) ? gateways : [];
    return list.find((gateway) => gateway.enabled && gateway.primary)
        || list.find((gateway) => gateway.enabled)
        || list[0]
        || cloneDefaultGateways()[0];
}

function buildPaymentInstructions(gateway) {
    const selected = gateway || cloneDefaultGateways()[0];
    const method = selected.name || 'Payment';
    const number = selected.account_number || '';
    const instructions = cleanText(selected.instructions, 500);
    return {
        code: selected.code || 'payment',
        method,
        number,
        account_type: selected.account_type || '',
        message: instructions || `Send the package price to ${number || 'the configured account'} via ${method}, then wait for admin approval.`
    };
}

async function loadPaymentInstructions(db) {
    const gateways = await loadPaymentGateways(db);
    return buildPaymentInstructions(getPrimaryGateway(gateways));
}

module.exports = {
    PAYMENT_GATEWAYS_KEY,
    DEFAULT_PAYMENT_GATEWAYS,
    normalizeGatewayList,
    serializeGateway,
    loadPaymentGateways,
    savePaymentGateways,
    getPrimaryGateway,
    buildPaymentInstructions,
    loadPaymentInstructions
};
