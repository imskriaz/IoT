'use strict';

function normalizeDestinationNumber(value) {
    const raw = String(value || '').trim();
    const international = raw.startsWith('+');
    const digits = raw.replace(/\D/g, '');

    if (!digits) {
        throw new Error('SMS PDU destination number is required');
    }

    return {
        digits,
        toa: international ? '91' : '81'
    };
}

function encodeSemiOctets(digits) {
    const padded = digits.length % 2 === 0 ? digits : `${digits}F`;
    let encoded = '';

    for (let index = 0; index < padded.length; index += 2) {
        encoded += padded[index + 1] + padded[index];
    }

    return encoded;
}

function toHexByte(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xFF) {
        throw new Error('SMS PDU byte out of range');
    }

    return value.toString(16).toUpperCase().padStart(2, '0');
}

function encodeUcs2UserData(text) {
    const normalized = String(text || '');
    let encoded = '';
    let units = 0;

    for (const char of normalized) {
        const codepoint = char.codePointAt(0);
        if (codepoint > 0xFFFF) {
            throw new Error('Message contains characters this device cannot send over SMS (outside UCS-2 BMP)');
        }
        encoded += codepoint.toString(16).toUpperCase().padStart(4, '0');
        units += 1;
    }

    return {
        hex: encoded,
        octets: units * 2,
        units
    };
}

function buildSmsSubmitPdu(number, text, options = {}) {
    const destination = normalizeDestinationNumber(number);
    const userData = encodeUcs2UserData(text);
    const requestStatusReport = options.requestStatusReport !== false;
    const firstOctet = requestStatusReport ? '21' : '01';

    if (userData.units < 1 || userData.units > 70) {
        throw new Error('SMS PDU builder currently supports single-part UCS-2 messages up to 70 characters');
    }

    const tpdu = [
        firstOctet,
        '00',
        toHexByte(destination.digits.length),
        destination.toa,
        encodeSemiOctets(destination.digits),
        '00',
        '08',
        toHexByte(userData.octets),
        userData.hex
    ].join('');
    const pdu = `00${tpdu}`;

    return {
        pdu,
        length: tpdu.length / 2,
        encoding: 'ucs2',
        statusReportRequested: requestStatusReport
    };
}

module.exports = {
    buildSmsSubmitPdu,
    encodeSemiOctets,
    encodeUcs2UserData
};
