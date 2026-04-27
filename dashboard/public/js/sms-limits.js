(function () {
    'use strict';

    const SMS_MAX_UTF8_BYTES = 1023;
    const SMS_MAX_PARTS = 15;
    const GSM_SINGLE_PART_LIMIT = 160;
    const GSM_MULTI_PART_LIMIT = 153;
    const UCS2_SINGLE_PART_LIMIT = 70;
    const UCS2_MULTI_PART_LIMIT = 67;

    const gsmExtensionCharSet = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '\u20AC']);
    const UCS2_BMP_MAX_CODEPOINT = 0xFFFF;
    const FORCE_SINGLE_GSM_TEXT_MODE_UCS2 = false;
    const utf8Encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

    function getUtf8ByteLength(text) {
        const normalized = String(text || '');
        if (utf8Encoder) {
            return utf8Encoder.encode(normalized).length;
        }
        return unescape(encodeURIComponent(normalized)).length;
    }

    function countUnicodeCharacters(text) {
        let count = 0;
        for (const _char of String(text || '')) {
            count += 1;
        }
        return count;
    }

    function analyze(text) {
        const normalized = String(text || '');
        let encoding = 'gsm7';
        let gsmUnits = 0;
        let unsupportedUnicode = false;
        const unsupportedCharacters = [];

        for (const char of normalized) {
            const codepoint = char.codePointAt(0);
            if (codepoint > UCS2_BMP_MAX_CODEPOINT) {
                unsupportedUnicode = true;
                if (unsupportedCharacters.length < 5) unsupportedCharacters.push(char);
                encoding = 'unicode';
                continue;
            }
            if (codepoint > 0x7F) {
                encoding = 'unicode';
                continue;
            }
            gsmUnits += gsmExtensionCharSet.has(char) ? 2 : 1;
        }

        const utf8Bytes = getUtf8ByteLength(normalized);
        const characters = countUnicodeCharacters(normalized);
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
            text: normalized,
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
            transportEncoding,
            valid: !unsupportedUnicode && utf8Bytes <= SMS_MAX_UTF8_BYTES && parts <= SMS_MAX_PARTS
        };
    }

    function formatError(analysis) {
        const sms = analysis || analyze('');
        const reasons = [];
        if (sms.unsupportedUnicode) return 'Message contains characters this device cannot send over SMS (outside UCS-2 BMP)';
        if (sms.overByteLimit) reasons.push(`max ${SMS_MAX_UTF8_BYTES} UTF-8 bytes`);
        if (sms.overPartLimit) reasons.push(`max ${SMS_MAX_PARTS} parts`);
        if (!reasons.length) reasons.push(`max ${SMS_MAX_UTF8_BYTES} UTF-8 bytes / ${SMS_MAX_PARTS} parts`);
        return `Message exceeds device SMS limit (${reasons.join(' / ')})`;
    }

    function resolveCommand(text) {
        const analysis = analyze(text);
        return {
            analysis,
            command: analysis.parts > 1 ? 'send-sms-multipart' : 'send-sms',
            multipart: analysis.parts > 1
        };
    }

    function clamp(text) {
        let result = '';
        for (const char of String(text || '')) {
            const next = result + char;
            if (!analyze(next).valid) {
                break;
            }
            result = next;
        }
        return result;
    }

    window.smsComposeLimits = {
        SMS_MAX_UTF8_BYTES,
        SMS_MAX_PARTS,
        GSM_SINGLE_PART_LIMIT,
        GSM_MULTI_PART_LIMIT,
        UCS2_SINGLE_PART_LIMIT,
        UCS2_MULTI_PART_LIMIT,
        analyze,
        resolveCommand,
        clamp,
        formatError
    };
})();
