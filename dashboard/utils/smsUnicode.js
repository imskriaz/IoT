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

function hasAny(text, values) {
    return values.some((value) => text.includes(value));
}

function inferServiceSender(message) {
    const text = String(decodeUcs2Hex(message) || '').toLowerCase();
    if (hasAny(text, ['robi', 'myrobi', ' রবি', 'রবি ', "রবি'"])) return 'Robi';
    if (hasAny(text, ['airtel', 'এয়ারটেল', 'এয়ারটেল'])) return 'Airtel';
    if (hasAny(text, ['banglalink', 'বাংলালিংক'])) return 'Banglalink';
    if (hasAny(text, ['grameenphone', 'গ্রামীণফোন'])) return 'Grameenphone';
    if (/\bgp\b/.test(text)) return 'Grameenphone';
    if (hasAny(text, ['teletalk', 'টেলিটক'])) return 'Teletalk';
    if (hasAny(text, ['bkash', 'বিকাশ'])) return 'bKash';
    if (hasAny(text, ['nagad', 'নগদ'])) return 'Nagad';
    if (hasAny(text, ['rocket', 'রকেট'])) return 'Rocket';
    if (text.includes('otp') || text.includes('verification')) return 'Verification Service';
    if (text.includes('bank') || text.includes('payment') || text.includes('transaction')) return 'Financial Service';
    if (text.includes('support') || text.includes('customer care')) return 'Support Service';
    if (text.includes('offer') || text.includes('package') || text.includes('balance')) return 'Network Service';
    return 'Service Sender';
}

function getSmsSenderDisplayName(sender, message = '') {
    const decodedSender = String(decodeUcs2Hex(sender) || '').trim();
    if (!decodedSender) return inferServiceSender(message);
    if (isPhoneLike(decodedSender)) return decodedSender;
    if (/[A-Za-z\u0980-\u09FF]/.test(decodedSender)) return decodedSender;
    if (looksLikeShiftedNibbleString(decodedSender)) return inferServiceSender(message);
    return decodedSender;
}

function isSmsSenderReplyable(sender) {
    return isPhoneLike(decodeUcs2Hex(sender));
}

function decodeSmsRecord(record) {
    if (!record || typeof record !== 'object') return record;
    const fromNumber = decodeUcs2Hex(record.from_number);
    const toNumber = decodeUcs2Hex(record.to_number);
    const message = decodeUcs2Hex(record.message);
    const senderIsPhone = isPhoneLike(fromNumber);
    const displayFrom = getSmsSenderDisplayName(fromNumber, message);

    return {
        ...record,
        from_number: fromNumber,
        to_number: toNumber,
        message,
        display_from: displayFrom,
        sender_is_phone: senderIsPhone,
        replyable: senderIsPhone
    };
}

module.exports = {
    decodeUcs2Hex,
    decodeSmsRecord,
    getSmsSenderDisplayName,
    inferServiceSender,
    isPhoneLike,
    isSmsSenderReplyable,
    looksLikeShiftedNibbleString,
    looksLikeUcs2Hex
};
