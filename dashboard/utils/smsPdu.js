'use strict';

const GSM7_EXTENSION_ESCAPE = 0x1B;
const GSM7_DEFAULT_ALPHABET = new Map([
    ['@', 0x00], ['£', 0x01], ['$', 0x02], ['¥', 0x03], ['è', 0x04],
    ['é', 0x05], ['ù', 0x06], ['ì', 0x07], ['ò', 0x08], ['Ç', 0x09],
    ['\n', 0x0A], ['Ø', 0x0B], ['ø', 0x0C], ['\r', 0x0D], ['Å', 0x0E],
    ['å', 0x0F], ['Δ', 0x10], ['_', 0x11], ['Φ', 0x12], ['Γ', 0x13],
    ['Λ', 0x14], ['Ω', 0x15], ['Π', 0x16], ['Ψ', 0x17], ['Σ', 0x18],
    ['Θ', 0x19], ['Ξ', 0x1A], ['Æ', 0x1C], ['æ', 0x1D], ['ß', 0x1E],
    ['É', 0x1F], [' ', 0x20], ['!', 0x21], ['"', 0x22], ['#', 0x23],
    ['¤', 0x24], ['%', 0x25], ['&', 0x26], ["'", 0x27], ['(', 0x28],
    [')', 0x29], ['*', 0x2A], ['+', 0x2B], [',', 0x2C], ['-', 0x2D],
    ['.', 0x2E], ['/', 0x2F], ['0', 0x30], ['1', 0x31], ['2', 0x32],
    ['3', 0x33], ['4', 0x34], ['5', 0x35], ['6', 0x36], ['7', 0x37],
    ['8', 0x38], ['9', 0x39], [':', 0x3A], [';', 0x3B], ['<', 0x3C],
    ['=', 0x3D], ['>', 0x3E], ['?', 0x3F], ['¡', 0x40], ['A', 0x41],
    ['B', 0x42], ['C', 0x43], ['D', 0x44], ['E', 0x45], ['F', 0x46],
    ['G', 0x47], ['H', 0x48], ['I', 0x49], ['J', 0x4A], ['K', 0x4B],
    ['L', 0x4C], ['M', 0x4D], ['N', 0x4E], ['O', 0x4F], ['P', 0x50],
    ['Q', 0x51], ['R', 0x52], ['S', 0x53], ['T', 0x54], ['U', 0x55],
    ['V', 0x56], ['W', 0x57], ['X', 0x58], ['Y', 0x59], ['Z', 0x5A],
    ['Ä', 0x5B], ['Ö', 0x5C], ['Ñ', 0x5D], ['Ü', 0x5E], ['§', 0x5F],
    ['¿', 0x60], ['a', 0x61], ['b', 0x62], ['c', 0x63], ['d', 0x64],
    ['e', 0x65], ['f', 0x66], ['g', 0x67], ['h', 0x68], ['i', 0x69],
    ['j', 0x6A], ['k', 0x6B], ['l', 0x6C], ['m', 0x6D], ['n', 0x6E],
    ['o', 0x6F], ['p', 0x70], ['q', 0x71], ['r', 0x72], ['s', 0x73],
    ['t', 0x74], ['u', 0x75], ['v', 0x76], ['w', 0x77], ['x', 0x78],
    ['y', 0x79], ['z', 0x7A], ['ä', 0x7B], ['ö', 0x7C], ['ñ', 0x7D],
    ['ü', 0x7E], ['à', 0x7F]
]);

const GSM7_EXTENSION_ALPHABET = new Map([
    ['\f', 0x0A],
    ['^', 0x14],
    ['{', 0x28],
    ['}', 0x29],
    ['\\', 0x2F],
    ['[', 0x3C],
    ['~', 0x3D],
    [']', 0x3E],
    ['|', 0x40],
    ['€', 0x65]
]);

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

function analyzeGsm7Text(text) {
    const septets = [];
    const unsupportedCharacters = [];

    for (const char of String(text || '')) {
        if (GSM7_DEFAULT_ALPHABET.has(char)) {
            septets.push(GSM7_DEFAULT_ALPHABET.get(char));
            continue;
        }
        if (GSM7_EXTENSION_ALPHABET.has(char)) {
            septets.push(GSM7_EXTENSION_ESCAPE, GSM7_EXTENSION_ALPHABET.get(char));
            continue;
        }
        if (unsupportedCharacters.length < 5) {
            unsupportedCharacters.push(char);
        }
    }

    return {
        encodable: unsupportedCharacters.length === 0,
        septets,
        units: septets.length,
        unsupportedCharacters
    };
}

function encodeGsm7UserData(text) {
    const analysis = analyzeGsm7Text(text);
    if (!analysis.encodable) {
        throw new Error('Message contains characters outside the GSM 7-bit alphabet');
    }

    return {
        septets: analysis.septets,
        units: analysis.units,
        hex: packGsm7Septets(analysis.septets).toString('hex').toUpperCase(),
        octets: Math.ceil((analysis.units * 7) / 8)
    };
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

function packGsm7SeptetsInto(buffer, septets, bitOffset = 0) {
    septets.forEach((septet, index) => {
        const bitPosition = bitOffset + (index * 7);
        const byteIndex = Math.floor(bitPosition / 8);
        const shift = bitPosition % 8;

        buffer[byteIndex] |= (septet << shift) & 0xFF;
        if (shift > 1 && byteIndex + 1 < buffer.length) {
            buffer[byteIndex + 1] |= septet >> (8 - shift);
        }
    });
}

function packGsm7Septets(septets) {
    const values = Array.isArray(septets) ? septets : [];
    const buffer = Buffer.alloc(Math.ceil((values.length * 7) / 8));
    packGsm7SeptetsInto(buffer, values, 0);
    return buffer;
}

function segmentUcs2Text(text, segmentSize) {
    const chars = Array.from(String(text || ''));
    const segments = [];

    for (let index = 0; index < chars.length; index += segmentSize) {
        segments.push(chars.slice(index, index + segmentSize).join(''));
    }

    return segments;
}

function segmentGsm7Text(text, segmentSize) {
    const segments = [];
    let current = '';
    let currentUnits = 0;

    for (const char of String(text || '')) {
        const analysis = analyzeGsm7Text(char);
        if (!analysis.encodable || analysis.units > segmentSize) {
            throw new Error('Message contains characters outside the GSM 7-bit alphabet');
        }
        if (current && currentUnits + analysis.units > segmentSize) {
            segments.push(current);
            current = '';
            currentUnits = 0;
        }
        current += char;
        currentUnits += analysis.units;
    }

    if (current) {
        segments.push(current);
    }

    return segments;
}

function resolvePduEncoding(text, options = {}) {
    const requested = String(options.encoding || options.sms_pdu_encoding || '').trim().toLowerCase();
    if (requested === 'ucs2' || requested === 'unicode') {
        return 'ucs2';
    }
    if (requested === 'gsm7' || requested === 'ira') {
        return 'gsm7';
    }
    return analyzeGsm7Text(text).encodable ? 'gsm7' : 'ucs2';
}

function buildGsm7SubmitPduSegment(number, text, options = {}) {
    const destination = normalizeDestinationNumber(number);
    const userData = encodeGsm7UserData(text);
    const requestStatusReport = options.requestStatusReport !== false;
    const multipart = options.multipart === true;
    const firstOctet = (requestStatusReport ? 0x21 : 0x01) | (multipart ? 0x40 : 0x00);
    let userDataHex = userData.hex;
    let userDataLength = userData.units;

    if (userData.units < 1 || (!multipart && userData.units > 160) || (multipart && userData.units > 153)) {
        throw new Error('SMS GSM 7-bit PDU segment exceeds supported SMS size');
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

        const udh = Buffer.from([0x05, 0x00, 0x03, reference, total, sequence]);
        const fillBits = (7 - ((udh.length * 8) % 7)) % 7;
        const totalBits = (udh.length * 8) + fillBits + (userData.septets.length * 7);
        const packed = Buffer.alloc(Math.ceil(totalBits / 8));
        udh.copy(packed, 0);
        packGsm7SeptetsInto(packed, userData.septets, (udh.length * 8) + fillBits);
        userDataHex = packed.toString('hex').toUpperCase();
        userDataLength = userData.units + Math.ceil((udh.length * 8) / 7);
    }

    const tpdu = [
        toHexByte(firstOctet),
        '00',
        toHexByte(destination.digits.length),
        destination.toa,
        encodeSemiOctets(destination.digits),
        '00',
        '00',
        toHexByte(userDataLength),
        userDataHex
    ].join('');
    const pdu = `00${tpdu}`;

    return {
        pdu,
        length: tpdu.length / 2,
        encoding: 'gsm7',
        statusReportRequested: requestStatusReport
    };
}

function buildUcs2SubmitPduSegment(number, text, options = {}) {
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

function buildSmsSubmitPduSegment(number, text, options = {}) {
    return resolvePduEncoding(text, options) === 'gsm7'
        ? buildGsm7SubmitPduSegment(number, text, options)
        : buildUcs2SubmitPduSegment(number, text, options);
}

function buildSmsSubmitPdu(number, text, options = {}) {
    return buildSmsSubmitPduSegment(number, text, options);
}

function buildSmsSubmitPdus(number, text, options = {}) {
    const encoding = resolvePduEncoding(text, options);
    if (encoding === 'gsm7') {
        const userData = encodeGsm7UserData(text);
        const requestedSegmentSize = Number(options.segmentSize);
        const segmentSize = Number.isInteger(requestedSegmentSize) &&
            requestedSegmentSize > 0 &&
            requestedSegmentSize <= 153
            ? requestedSegmentSize
            : 153;
        if (userData.units <= 160 && !(options.forceSegmentSize === true && userData.units > segmentSize)) {
            return [buildSmsSubmitPdu(number, text, { ...options, encoding: 'gsm7' })];
        }
        const segments = segmentGsm7Text(text, segmentSize);
        const reference = Number.isInteger(options.concatReference)
            ? options.concatReference
            : Math.floor(Math.random() * 256);

        return segments.map((segment, index) => buildSmsSubmitPduSegment(number, segment, {
            ...options,
            encoding: 'gsm7',
            multipart: true,
            concatReference: reference,
            totalParts: segments.length,
            partNumber: index + 1
        }));
    }

    const userData = encodeUcs2UserData(text);
    const requestedSegmentSize = Number(options.segmentSize);
    const segmentSize = Number.isInteger(requestedSegmentSize) &&
        requestedSegmentSize > 0 &&
        requestedSegmentSize <= 67
        ? requestedSegmentSize
        : 50;
    if (userData.units <= 70 && !(options.forceSegmentSize === true && userData.units > segmentSize)) {
        return [buildSmsSubmitPdu(number, text, options)];
    }
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
    analyzeGsm7Text,
    buildSmsSubmitPdu,
    buildSmsSubmitPdus,
    encodeGsm7UserData,
    encodeSemiOctets,
    encodeUcs2UserData,
    packGsm7Septets,
    segmentGsm7Text,
    segmentUcs2Text
};
