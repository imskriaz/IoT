'use strict';

const {
    analyzeSmsText,
    formatSmsLimitError,
    validateSmsMessageSize,
    resolveSmsCommand,
    resolveSmsCommandForRecipient
} = require('../utils/smsLimits');

describe('smsLimits', () => {
    test('classifies Bangla text as Unicode and keeps single-part limits at 70 chars', () => {
        const text = 'বাংলা মেসেজ পরীক্ষা';
        const analysis = analyzeSmsText(text);

        expect(analysis.encoding).toBe('unicode');
        expect(analysis.characters).toBe(Array.from(text).length);
        expect(analysis.singlePartLimit).toBe(70);
        expect(analysis.parts).toBe(1);
        expect(analysis.overByteLimit).toBe(false);
        expect(analysis.overPartLimit).toBe(false);
    });

    test('counts Bangla multipart messages using Unicode segment sizes', () => {
        const text = 'বাংলা'.repeat(80);
        const analysis = analyzeSmsText(text);

        expect(analysis.encoding).toBe('unicode');
        expect(analysis.parts).toBeGreaterThan(1);
        expect(analysis.multiPartLimit).toBe(67);
        expect(analysis.overPartLimit).toBe(false);
    });

    test('accepts large GSM multipart messages up to the transport byte cap', () => {
        const analysis = analyzeSmsText('x'.repeat(1023));

        expect(analysis.encoding).toBe('gsm7');
        expect(analysis.transportEncoding).toBe('ira');
        expect(analysis.utf8Bytes).toBe(1023);
        expect(analysis.parts).toBe(Math.ceil(1023 / 153));
        expect(analysis.overByteLimit).toBe(false);
        expect(analysis.overPartLimit).toBe(false);
        expect(() => validateSmsMessageSize('x'.repeat(1023))).not.toThrow();
    });

    test('uses IRA transport for regular single-part text', () => {
        const resolved = resolveSmsCommandForRecipient('+8801887300993', 'regular sms test');

        expect(resolved.command).toBe('send-sms');
        expect(resolved.metadata).toEqual(expect.objectContaining({
            sms_encoding: 'gsm7',
            sms_transport_encoding: 'ira',
            sms_parts: 1,
            sms_multipart: false,
            sms_pdu_encoding: 'gsm7',
            sms_pdu_count: 1,
            sms_status_report_requested: true
        }));
        expect(resolved.metadata.sms_pdu).toMatch(/^00[0-9A-F]+$/);
        expect(resolved.timeoutMs).toBe(45000);
    });

    test('builds a dashboard-side UCS2 PDU for single-part Unicode SMS', () => {
        const resolved = resolveSmsCommandForRecipient('+8801887300993', '\u09AC\u09BE\u0982\u09B2\u09BE 123');

        expect(resolved.command).toBe('send-sms');
        expect(resolved.metadata).toEqual(expect.objectContaining({
            sms_encoding: 'unicode',
            sms_transport_encoding: 'ucs2',
            sms_parts: 1,
            sms_multipart: false,
            sms_pdu_encoding: 'ucs2',
            sms_pdu_length: 32,
            sms_status_report_requested: true
        }));
        expect(resolved.metadata.sms_pdu).toBe('0021000D91881088370099F300081209AC09BE098209B209BE0020003100320033');
    });

    test('rejects messages that exceed the transport byte cap', () => {
        const analysis = analyzeSmsText('x'.repeat(1024));

        expect(analysis.overByteLimit).toBe(true);
        expect(formatSmsLimitError(analysis)).toBe('Message exceeds device SMS limit (max 1023 UTF-8 bytes)');
        expect(() => validateSmsMessageSize('x'.repeat(1024))).toThrow('Message exceeds device SMS limit (max 1023 UTF-8 bytes)');
    });

    test('rejects messages that exceed the 15-part Unicode ceiling even if bytes still fit', () => {
        const text = '\u0985'.repeat(1006);
        const analysis = analyzeSmsText(text);

        expect(analysis.encoding).toBe('unicode');
        expect(analysis.utf8Bytes).toBe(3018);
        expect(analysis.parts).toBe(16);
        expect(analysis.overByteLimit).toBe(true);
        expect(analysis.overPartLimit).toBe(true);
        expect(formatSmsLimitError(analysis)).toBe('Message exceeds device SMS limit (max 1023 UTF-8 bytes / max 15 parts)');
    });

    test('uses UCS-2 PDU metadata for ASCII outside the GSM 7-bit alphabet', () => {
        const text = '`'.repeat(1000);
        const analysis = analyzeSmsText(text);

        expect(analysis.encoding).toBe('unicode');
        expect(analysis.transportEncoding).toBe('ucs2');
        expect(analysis.parts).toBe(15);
        expect(analysis.overByteLimit).toBe(false);
        expect(analysis.overPartLimit).toBe(false);
    });

    test('builds Unicode metadata for firmware SMS commands', () => {
        const resolved = resolveSmsCommandForRecipient('+8801887300993', '\u0985'.repeat(80));

        expect(resolved.command).toBe('send-sms-multipart');
        expect(resolved.metadata).toEqual(expect.objectContaining({
            sms_encoding: 'unicode',
            sms_transport_encoding: 'ucs2',
            sms_parts: 2,
            sms_multipart: true,
            sms_pdu_encoding: 'ucs2',
            sms_pdu_count: 2,
            sms_status_report_requested: true
        }));
        expect(resolved.metadata.sms_pdu).toContain(';');
        expect(resolved.metadata.sms_pdu_length).toBeUndefined();
        expect(resolved.timeoutMs).toBeGreaterThanOrEqual(60000);
    });

    test('rejects characters outside UCS-2 BMP before they reach firmware', () => {
        const analysis = analyzeSmsText('hello \u{1F600}');

        expect(analysis.unsupportedUnicode).toBe(true);
        expect(formatSmsLimitError(analysis)).toBe('Message contains characters this device cannot send over SMS (outside UCS-2 BMP)');
        expect(() => validateSmsMessageSize('hello \u{1F600}')).toThrow('outside UCS-2 BMP');
        expect(() => resolveSmsCommand('hello \u{1F600}')).toThrow('outside UCS-2 BMP');
    });
});
