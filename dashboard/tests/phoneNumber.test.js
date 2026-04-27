'use strict';
const {
    formatPhoneNumber,
    normalizePhoneDigits,
    getPhoneLookupKeys,
    sqlNormalizePhone,
    sqlPhoneLastDigits
} = require('../utils/phoneNumber');

describe('formatPhoneNumber', () => {
    beforeAll(() => {
        // Force Bangladesh country code for deterministic tests
        process.env.PHONE_COUNTRY_CODE = '880';
    });

    test('returns null for falsy input', () => {
        expect(formatPhoneNumber(null)).toBeNull();
        expect(formatPhoneNumber('')).toBeNull();
        expect(formatPhoneNumber(undefined)).toBeNull();
    });

    test('returns null for non-string input', () => {
        expect(formatPhoneNumber(123)).toBeNull();
    });

    test('returns null for whitespace-only string', () => {
        expect(formatPhoneNumber('   ')).toBeNull();
    });

    test('passes through E.164 numbers unchanged (strips non-digits)', () => {
        expect(formatPhoneNumber('+8801712345678')).toBe('+8801712345678');
        expect(formatPhoneNumber('+88 017-1234-5678')).toBe('+8801712345678');
    });

    test('repairs Bangladesh numbers entered as +88 plus a 10-digit local mobile', () => {
        expect(formatPhoneNumber('+881628301525')).toBe('+8801628301525');
        expect(formatPhoneNumber('881628301525')).toBe('+8801628301525');
    });

    test('formats 10-digit local number (no leading 0)', () => {
        expect(formatPhoneNumber('1712345678')).toBe('+8801712345678');
    });

    test('formats 11-digit number with leading 0', () => {
        expect(formatPhoneNumber('01712345678')).toBe('+8801712345678');
    });

    test('formats 13-digit number already carrying country code', () => {
        expect(formatPhoneNumber('8801712345678')).toBe('+8801712345678');
    });

    test('preserves short service codes without forcing E.164', () => {
        expect(formatPhoneNumber('123')).toBe('123');
        expect(formatPhoneNumber('*121#')).toBe('*121#');
    });

    test('strips dashes and spaces from input', () => {
        expect(formatPhoneNumber('01712-345-678')).toBe('+8801712345678');
    });

    test('normalizes phone digits for lookup', () => {
        expect(normalizePhoneDigits('+88 (017) 123-45678')).toBe('8801712345678');
    });

    test('builds stable lookup keys', () => {
        expect(getPhoneLookupKeys('01712-345-678')).toEqual({
            digits: '01712345678',
            last10: '1712345678',
            formatted: '+8801712345678'
        });
        expect(getPhoneLookupKeys('+8801712345678')).toEqual({
            digits: '8801712345678',
            last10: '1712345678',
            formatted: '+8801712345678'
        });
    });

    test('exports SQL helpers for consistent matching', () => {
        expect(sqlNormalizePhone('c.phone_number')).toContain("COALESCE(c.phone_number, '')");
        expect(sqlPhoneLastDigits('c.phone_number')).toContain('SUBSTR');
    });
});
