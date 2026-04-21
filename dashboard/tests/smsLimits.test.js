'use strict';

const {
    analyzeSmsText,
    formatSmsLimitError,
    validateSmsMessageSize
} = require('../utils/smsLimits');

describe('smsLimits', () => {
    test('accepts large GSM multipart messages up to the transport byte cap', () => {
        const analysis = analyzeSmsText('x'.repeat(1023));

        expect(analysis.encoding).toBe('gsm7');
        expect(analysis.utf8Bytes).toBe(1023);
        expect(analysis.parts).toBe(Math.ceil(1023 / 153));
        expect(analysis.overByteLimit).toBe(false);
        expect(analysis.overPartLimit).toBe(false);
        expect(() => validateSmsMessageSize('x'.repeat(1023))).not.toThrow();
    });

    test('rejects messages that exceed the transport byte cap', () => {
        const analysis = analyzeSmsText('x'.repeat(1024));

        expect(analysis.overByteLimit).toBe(true);
        expect(formatSmsLimitError(analysis)).toBe('Message exceeds device SMS limit (max 1023 UTF-8 bytes)');
        expect(() => validateSmsMessageSize('x'.repeat(1024))).toThrow('Message exceeds device SMS limit (max 1023 UTF-8 bytes)');
    });

    test('rejects messages that exceed the 15-part Unicode ceiling even if bytes still fit', () => {
        const text = '`'.repeat(1006);
        const analysis = analyzeSmsText(text);

        expect(analysis.encoding).toBe('unicode');
        expect(analysis.utf8Bytes).toBe(1006);
        expect(analysis.parts).toBe(16);
        expect(analysis.overByteLimit).toBe(false);
        expect(analysis.overPartLimit).toBe(true);
        expect(formatSmsLimitError(analysis)).toBe('Message exceeds device SMS limit (max 15 parts)');
    });
});
