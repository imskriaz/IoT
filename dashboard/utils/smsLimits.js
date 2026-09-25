'use strict';

const { analyzeGsm7Text, buildSmsSubmitPdus } = require('./smsPdu');

const SMS_MAX_UTF8_BYTES = 1023;
const SMS_MAX_PARTS = 15;
const GSM_SINGLE_PART_LIMIT = 160;
const GSM_MULTI_PART_LIMIT = 153;
const UCS2_SINGLE_PART_LIMIT = 70;
const UCS2_MULTI_PART_LIMIT = 67;
const SMS_PDU_BUNDLE_MAX_CHARS = 1800;

const UCS2_BMP_MAX_CODEPOINT = 0xFFFF;
const FORCE_SINGLE_GSM_TEXT_MODE_UCS2 = false;

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
    const gsm7 = analyzeGsm7Text(text);
    let encoding = gsm7.encodable ? 'gsm7' : 'unicode';
    let gsmUnits = gsm7.units;
    let unsupportedUnicode = false;
    const unsupportedCharacters = [];

    for (const char of text) {
        const codepoint = char.codePointAt(0);
        if (codepoint > UCS2_BMP_MAX_CODEPOINT) {
            unsupportedUnicode = true;
            if (unsupportedCharacters.length < 5) {
                unsupportedCharacters.push(char);
            }
            encoding = 'unicode';
            continue;
        }
    }

    const utf8Bytes = getUtf8ByteLength(text);
    const characters = countUnicodeCharacters(text);
    const transportEncoding = encoding === 'unicode' ||
        (FORCE_SINGLE_GSM_TEXT_MODE_UCS2 && gsmUnits <= GSM_SINGLE_PART_LIMIT)
        ? 'ucs2'
        : 'ira';
    const singlePartLimit = transportEncoding === 'ira' ? GSM_SINGLE_PART_LIMIT : UCS2_SINGLE_PART_LIMIT;
    const multiPartLimit = transportEncoding === 'ira' ? GSM_MULTI_PART_LIMIT : UCS2_MULTI_PART_LIMIT;
    const units = transportEncoding === 'ira' ? gsmUnits : characters;
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
        overPartLimit: parts > SMS_MAX_PARTS,
        unsupportedUnicode,
        unsupportedCharacters,
        transportEncoding
    };
}

function formatSmsLimitError(analysis = analyzeSmsText('')) {
    if (analysis.unsupportedUnicode) {
        return 'Message contains characters this device cannot send over SMS (outside UCS-2 BMP)';
    }

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
    if (analysis.unsupportedUnicode) {
        throw new Error('Message contains characters this device cannot send over SMS (outside UCS-2 BMP)');
    }
    if (analysis.overByteLimit || analysis.overPartLimit) {
        throw new Error(formatSmsLimitError(analysis));
    }

    return true;
}

function resolveSmsTimeoutMs(valueOrAnalysis) {
    const analysis = typeof valueOrAnalysis === 'object' && valueOrAnalysis
        ? valueOrAnalysis
        : analyzeSmsText(valueOrAnalysis);

    if (analysis.parts > 1) {
        return Math.min(120000, Math.max(60000, 45000 + (Number(analysis.parts || 1) * 5000)));
    }

    return 45000;
}

function buildSmsTransportMetadata(valueOrAnalysis) {
    const analysis = typeof valueOrAnalysis === 'object' && valueOrAnalysis
        ? valueOrAnalysis
        : analyzeSmsText(valueOrAnalysis);

    return {
        sms_encoding: analysis.encoding,
        sms_transport_encoding: analysis.transportEncoding || (analysis.encoding === 'unicode' ? 'ucs2' : 'ira'),
        sms_parts: analysis.parts,
        sms_units: analysis.units,
        sms_utf8_bytes: analysis.utf8Bytes,
        sms_characters: analysis.characters,
        sms_multipart: analysis.parts > 1
    };
}

function buildSmsTransportMetadataForRecipient(number, valueOrAnalysis) {
    const analysis = typeof valueOrAnalysis === 'object' && valueOrAnalysis
        ? valueOrAnalysis
        : analyzeSmsText(valueOrAnalysis);
    const metadata = buildSmsTransportMetadata(analysis);

    const pdus = buildSmsSubmitPdus(number, analysis.text, {
        requestStatusReport: true,
        encoding: metadata.sms_transport_encoding === 'ucs2' ? 'ucs2' : 'gsm7'
    });
    const pduBundle = pdus.map((pdu) => pdu.pdu).join(';');

    if (pduBundle.length <= SMS_PDU_BUNDLE_MAX_CHARS) {
        metadata.sms_pdu = pduBundle;
        metadata.sms_pdu_encoding = pdus[0]?.encoding || metadata.sms_transport_encoding;
        metadata.sms_pdu_count = pdus.length;
        metadata.sms_status_report_requested = pdus.every((pdu) => pdu.statusReportRequested);

        if (pdus.length === 1) {
            metadata.sms_pdu_length = pdus[0].length;
        }
    }

    return metadata;
}

function resolveSmsCommand(value) {
    const analysis = analyzeSmsText(value);
    if (analysis.unsupportedUnicode || analysis.overByteLimit || analysis.overPartLimit) {
        throw new Error(formatSmsLimitError(analysis));
    }

    return {
        analysis,
        command: analysis.parts > 1 ? 'send-sms-multipart' : 'send-sms',
        multipart: analysis.parts > 1,
        timeoutMs: resolveSmsTimeoutMs(analysis),
        metadata: buildSmsTransportMetadata(analysis)
    };
}

function resolveSmsCommandForRecipient(number, value) {
    const resolved = resolveSmsCommand(value);

    return {
        ...resolved,
        metadata: buildSmsTransportMetadataForRecipient(number, resolved.analysis)
    };
}

module.exports = {
    SMS_MAX_UTF8_BYTES,
    SMS_MAX_PARTS,
    GSM_SINGLE_PART_LIMIT,
    GSM_MULTI_PART_LIMIT,
    UCS2_SINGLE_PART_LIMIT,
    UCS2_MULTI_PART_LIMIT,
    SMS_PDU_BUNDLE_MAX_CHARS,
    analyzeSmsText,
    formatSmsLimitError,
    validateSmsMessageSize,
    resolveSmsTimeoutMs,
    buildSmsTransportMetadata,
    buildSmsTransportMetadataForRecipient,
    resolveSmsCommandForRecipient,
    resolveSmsCommand
};
