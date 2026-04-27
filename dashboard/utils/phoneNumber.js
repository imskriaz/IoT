'use strict';

function getDefaultCountryCode() {
    return String(process.env.PHONE_COUNTRY_CODE || '').replace(/\D/g, '');
}

function normalizePhoneDigits(raw) {
    if (raw == null) return '';
    return String(raw).replace(/\D/g, '');
}

function isShortCode(raw) {
    if (raw == null) return false;
    const compact = String(raw).replace(/\s+/g, '');
    return /^[*#\d]{2,8}$/.test(compact);
}

function getPhoneLookupKeys(raw) {
    const digits = normalizePhoneDigits(raw);
    return {
        digits,
        last10: digits ? digits.slice(-10) : '',
        formatted: typeof raw === 'string' ? formatPhoneNumber(raw) : null
    };
}

function sqlNormalizePhone(columnName) {
    return `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${columnName}, ''), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '')`;
}

function sqlPhoneLastDigits(columnName, count = 10) {
    return `SUBSTR('${'0'.repeat(Math.max(1, count))}' || ${sqlNormalizePhone(columnName)}, -${Math.max(1, count)})`;
}

function formatPhoneNumber(raw, options = {}) {
    if (typeof raw !== 'string') return null;

    const trimmed = raw.trim();
    if (!trimmed) return null;

    if (isShortCode(trimmed) && !trimmed.startsWith('+')) {
        return trimmed.replace(/\s+/g, '');
    }

    const digits = trimmed.replace(/\D/g, '');

    if (!digits.length) return null;

    const countryCode = normalizePhoneDigits(options.countryCode || getDefaultCountryCode());
    const shortCountryCode = countryCode.length > 1 ? countryCode.slice(0, -1) : '';

    // Bangladesh numbers are often entered as +88 / 88 plus the 10-digit
    // local mobile number, omitting the 0 that belongs after the country code.
    if (
        countryCode === '880' &&
        shortCountryCode &&
        digits.length === shortCountryCode.length + 10 &&
        digits.startsWith(shortCountryCode)
    ) {
        return '+' + countryCode + digits.slice(shortCountryCode.length);
    }

    if (trimmed.startsWith('+')) {
        return '+' + digits;
    }

    if (trimmed.startsWith('00') && digits.length > 2) {
        return '+' + digits.slice(2);
    }

    if (countryCode && digits.length > countryCode.length + 4 && digits.startsWith(countryCode)) {
        return '+' + digits;
    }

    if (countryCode && digits.length >= 6) {
        if (digits.startsWith('0')) {
            return '+' + countryCode + digits.substring(1);
        }
        return '+' + countryCode + digits;
    }

    return '+' + digits;
}

module.exports = {
    formatPhoneNumber,
    normalizePhoneDigits,
    isShortCode,
    getPhoneLookupKeys,
    sqlNormalizePhone,
    sqlPhoneLastDigits
};
