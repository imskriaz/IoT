'use strict';

function looksLikeUcs2Hex(value) {
    if (typeof value !== 'string') return false;
    const clean = value.trim();
    return clean.length >= 4 && clean.length % 4 === 0 && /^[0-9A-Fa-f]+$/.test(clean);
}

function decodeUcs2Hex(value) {
    if (!looksLikeUcs2Hex(value)) return value;

    try {
        const clean = value.trim();
        const buf = Buffer.from(clean, 'hex');
        const le = Buffer.alloc(buf.length);

        for (let i = 0; i < buf.length; i += 2) {
            le.writeUInt16LE(buf.readUInt16BE(i), i);
        }

        const decoded = le.toString('utf16le');
        if (!decoded.includes('\uFFFD') && /\S/.test(decoded)) {
            return decoded;
        }
    } catch (_) {
        return value;
    }

    return value;
}

function normalizeDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function isPhoneLike(value) {
    const text = String(value || '').trim();
    if (!text || !/^\+?[\d\s\-()]+$/.test(text)) return false;
    const digits = normalizeDigits(text);
    return digits.length >= 10;
}

function looksLikeShiftedNibbleString(value) {
    if (typeof value !== 'string') return false;
    const clean = value.trim();
    return clean.length >= 6 && clean.length % 2 === 0 && /^[0-9:;<=>?]+$/.test(clean);
}

function inferServiceSender(message) {
    const text = String(decodeUcs2Hex(message) || '').toLowerCase();
    if (text.includes('robi') || text.includes('\u09b0\u09ac\u09bf')) return 'Robi';
    if (text.includes('airtel') || text.includes('\u098f\u09df\u09be\u09b0\u099f\u09c7\u09b2') || text.includes('\u098f\u09af\u09bc\u09be\u09b0\u099f\u09c7\u09b2')) return 'Airtel';
    if (text.includes('grameenphone') || text.includes('grammenphone') || /\bgp\b/.test(text)) return 'Grameenphone';
    if (text.includes('banglalink') || text.includes('\u09ac\u09be\u0982\u09b2\u09be\u09b2\u09bf\u0982\u0995')) return 'Banglalink';
    if (text.includes('teletalk') || text.includes('\u099f\u09c7\u09b2\u09bf\u099f\u0995')) return 'Teletalk';
    if (text.includes('otp') || text.includes('verification')) return 'Verification Service';
    if (text.includes('bank') || text.includes('payment') || text.includes('transaction')) return 'Financial Service';
    if (text.includes('support') || text.includes('customer care')) return 'Support Service';
    if (text.includes('offer') || text.includes('package') || text.includes('balance')) return 'Network Service';
    return 'Service Sender';
}

function decodeSmsRecord(record) {
    if (!record || typeof record !== 'object') return record;
    const fromNumber = decodeUcs2Hex(record.from_number);
    const toNumber = decodeUcs2Hex(record.to_number);
    const message = decodeUcs2Hex(record.message);
    const senderIsPhone = isPhoneLike(fromNumber);
    const displayFrom = senderIsPhone || /[A-Za-z\u0980-\u09FF]/.test(String(fromNumber || ''))
        ? fromNumber
        : looksLikeShiftedNibbleString(fromNumber)
            ? inferServiceSender(message)
            : fromNumber;

    return {
        ...record,
        from_number: fromNumber,
        to_number: toNumber,
        message,
        display_from: displayFrom,
        sender_is_phone: senderIsPhone
    };
}

module.exports = {
    decodeUcs2Hex,
    decodeSmsRecord,
    inferServiceSender,
    isPhoneLike,
    looksLikeShiftedNibbleString,
    looksLikeUcs2Hex
};
