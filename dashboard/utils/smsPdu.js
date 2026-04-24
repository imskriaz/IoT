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

function segmentUcs2Text(text, segmentSize) {
    const chars = Array.from(String(text || ''));
    const segments = [];

    for (let index = 0; index < chars.length; index += segmentSize) {
        segments.push(chars.slice(index, index + segmentSize).join(''));
    }

    return segments;
}

function buildSmsSubmitPduSegment(number, text, options = {}) {
    const destination = normalizeDestinationNumber(number);
    const userData = encodeUcs2UserData(text);
    const requestStatusReport = options.requestStatusReport !== false;
    const multipart = options.multipart === true;
    const firstOctet = (requestStatusReport ? 0x21 : 0x01) | (multipart ? 0x40 : 0x00);
    let userDataHex = userData.hex;
    let userDataOctets = userData.octets;

    if (userData.units < 1 || (!multipart && userData.units > 70) || (multipart && userData.units > 67)) {
        throw new Error('SMS PDU builder currently supports single-part UCS-2 messages up to 70 characters');
    }

    if (multipart) {
        const reference = Number(options.concatReference);
        const total = Number(options.totalParts);
        const sequence = Number(options.partNumber);
        if (!Number.isInteger(reference) || reference < 0 || reference > 0xFF ||
            !Number.isInteger(total) || total < 2 || total > 0xFF ||
            !Number.isInteger(sequence) || sequence < 1 || sequence > total) {
            throw new Error('SMS multipart PDU options are invalid');
        }

        const udh = [
            '05',
            '00',
            '03',
            toHexByte(reference),
            toHexByte(total),
            toHexByte(sequence)
        ].join('');
        userDataHex = `${udh}${userData.hex}`;
        userDataOctets += 6;
    }

    const tpdu = [
        toHexByte(firstOctet),
        '00',
        toHexByte(destination.digits.length),
        destination.toa,
        encodeSemiOctets(destination.digits),
        '00',
        '08',
        toHexByte(userDataOctets),
        userDataHex
    ].join('');
    const pdu = `00${tpdu}`;

    return {
        pdu,
        length: tpdu.length / 2,
        encoding: 'ucs2',
        statusReportRequested: requestStatusReport
    };
}

function buildSmsSubmitPdu(number, text, options = {}) {
    return buildSmsSubmitPduSegment(number, text, options);
}

function buildSmsSubmitPdus(number, text, options = {}) {
    const userData = encodeUcs2UserData(text);
    if (userData.units <= 70) {
        return [buildSmsSubmitPdu(number, text, options)];
    }

    const requestedSegmentSize = Number(options.segmentSize);
    const segmentSize = Number.isInteger(requestedSegmentSize) &&
        requestedSegmentSize > 0 &&
        requestedSegmentSize <= 67
        ? requestedSegmentSize
        : 50;
    const segments = segmentUcs2Text(text, segmentSize);
    const reference = Number.isInteger(options.concatReference)
        ? options.concatReference
        : Math.floor(Math.random() * 256);

    return segments.map((segment, index) => buildSmsSubmitPduSegment(number, segment, {
        ...options,
        multipart: true,
        concatReference: reference,
        totalParts: segments.length,
        partNumber: index + 1
    }));
}

module.exports = {
    buildSmsSubmitPdu,
    buildSmsSubmitPdus,
    encodeSemiOctets,
    encodeUcs2UserData,
    segmentUcs2Text
};
