'use strict';

const SMS_MAX_UTF8_BYTES = 1023;
const SMS_MAX_PARTS = 15;
const GSM_SINGLE_PART_LIMIT = 160;
const GSM_MULTI_PART_LIMIT = 153;
const UCS2_SINGLE_PART_LIMIT = 70;
const UCS2_MULTI_PART_LIMIT = 67;

const GSM_BASIC_CHAR_SET = new Set(
    (
        "@\u00A3$\u00A5\u00E8\u00E9\u00F9\u00EC\u00F2\u00C7\n\u00D8\u00F8\r\u00C5\u00E5\u0394_"
        + "\u03A6\u0393\u039B\u03A9\u03A0\u03A8\u03A3\u0398\u039E\u00C6\u00E6\u00DF\u00C9"
        + " !\"#\u00A4%&'()*+,-./0123456789:;<=>?\u00A1ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        + "\u00C4\u00D6\u00D1\u00DC\u00A7\u00BFabcdefghijklmnopqrstuvwxyz\u00E4\u00F6\u00F1\u00FC\u00E0"
    ).split('')
);
const GSM_EXTENSION_CHAR_SET = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '\u20AC']);

function getUtf8ByteLength(text) {
    return Buffer.byteLength(String(text || ''), 'utf8');
}

function countUnicodeCharacters(text) {
    let count = 0;
    for (const _char of String(text || '')) {
        count += 1;
    }
    return count;
}

function analyzeSmsText(value) {
    const text = String(value || '');
    let encoding = 'gsm7';
    let gsmUnits = 0;

    for (const char of text) {
        if (GSM_BASIC_CHAR_SET.has(char)) {
            gsmUnits += 1;
            continue;
        }
        if (GSM_EXTENSION_CHAR_SET.has(char)) {
            gsmUnits += 2;
            continue;
        }
        encoding = 'unicode';
        break;
    }

    const utf8Bytes = getUtf8ByteLength(text);
    const characters = countUnicodeCharacters(text);
    const singlePartLimit = encoding === 'gsm7' ? GSM_SINGLE_PART_LIMIT : UCS2_SINGLE_PART_LIMIT;
    const multiPartLimit = encoding === 'gsm7' ? GSM_MULTI_PART_LIMIT : UCS2_MULTI_PART_LIMIT;
    const units = encoding === 'gsm7' ? gsmUnits : characters;
    let parts = 1;

    if (units > singlePartLimit) {
        parts = Math.ceil(units / multiPartLimit);
    }

    return {
        text,
        encoding,
        characters,
        utf8Bytes,
        units,
        parts,
        singlePartLimit,
        multiPartLimit,
        maxUtf8Bytes: SMS_MAX_UTF8_BYTES,
        maxParts: SMS_MAX_PARTS,
        overByteLimit: utf8Bytes > SMS_MAX_UTF8_BYTES,
        overPartLimit: parts > SMS_MAX_PARTS
    };
}

function formatSmsLimitError(analysis = analyzeSmsText('')) {
    const reasons = [];
    if (analysis.overByteLimit) {
        reasons.push(`max ${SMS_MAX_UTF8_BYTES} UTF-8 bytes`);
    }
    if (analysis.overPartLimit) {
        reasons.push(`max ${SMS_MAX_PARTS} parts`);
    }
    if (!reasons.length) {
        reasons.push(`max ${SMS_MAX_UTF8_BYTES} UTF-8 bytes / ${SMS_MAX_PARTS} parts`);
    }
    return `Message exceeds device SMS limit (${reasons.join(' / ')})`;
}

function validateSmsMessageSize(value) {
    const text = String(value || '');
    if (!text.trim()) {
        throw new Error('Message is required');
    }

    const analysis = analyzeSmsText(text);
    if (analysis.overByteLimit || analysis.overPartLimit) {
        throw new Error(formatSmsLimitError(analysis));
    }

    return true;
}

function resolveSmsCommand(value) {
    const analysis = analyzeSmsText(value);
    return {
        analysis,
        command: analysis.parts > 1 ? 'send-sms-multipart' : 'send-sms',
        multipart: analysis.parts > 1
    };
}

module.exports = {
    SMS_MAX_UTF8_BYTES,
    SMS_MAX_PARTS,
    GSM_SINGLE_PART_LIMIT,
    GSM_MULTI_PART_LIMIT,
    UCS2_SINGLE_PART_LIMIT,
    UCS2_MULTI_PART_LIMIT,
    analyzeSmsText,
    formatSmsLimitError,
    validateSmsMessageSize,
    resolveSmsCommand
};
