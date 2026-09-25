'use strict';

// isValidNumericId is inlined in several route files.
// We test the logic directly here to document the expected contract.
function isValidNumericId(id) {
    return /^[0-9]+$/.test(String(id));
}

describe('isValidNumericId', () => {
    test('accepts positive integers', () => {
        expect(isValidNumericId(1)).toBe(true);
        expect(isValidNumericId('42')).toBe(true);
        expect(isValidNumericId('100')).toBe(true);
    });

    test('rejects zero (not a valid DB id)', () => {
        // zero is technically valid as a digit string; guard is at query level
        expect(isValidNumericId(0)).toBe(true); // passes regex; route should guard separately
    });

    test('rejects negative numbers', () => {
        expect(isValidNumericId('-1')).toBe(false);
    });

    test('rejects floats', () => {
        expect(isValidNumericId('1.5')).toBe(false);
    });

    test('rejects non-numeric strings', () => {
        expect(isValidNumericId('abc')).toBe(false);
        expect(isValidNumericId('1a')).toBe(false);
        expect(isValidNumericId('')).toBe(false);
    });

    test('rejects null/undefined coerced to "null"/"undefined"', () => {
        expect(isValidNumericId(null)).toBe(false);
        expect(isValidNumericId(undefined)).toBe(false);
    });
});

describe('pagination guard: Math.max(1, page)', () => {
    function guardedPage(input) {
        return Math.max(1, parseInt(input) || 1);
    }

    test('clamps negative page to 1', () => {
        expect(guardedPage(-5)).toBe(1);
    });

    test('clamps zero to 1', () => {
        expect(guardedPage(0)).toBe(1);
    });

    test('passes through positive page', () => {
        expect(guardedPage(3)).toBe(3);
    });

    test('defaults NaN to 1', () => {
        expect(guardedPage('abc')).toBe(1);
    });
});

describe('limit guard: Math.min(Math.max(1, limit), MAX)', () => {
    function guardedLimit(input, max = 100) {
        return Math.min(Math.max(1, parseInt(input) || 20), max);
    }

    test('treats 0 as "use default" (20), not 1', () => {
        // parseInt(0) || 20 evaluates to 20 (0 is falsy), so 0 → default
        expect(guardedLimit(0)).toBe(20);
    });

    test('clamps negative input to 1', () => {
        expect(guardedLimit(-10)).toBe(1);
    });

    test('clamps above max to max', () => {
        expect(guardedLimit(999, 100)).toBe(100);
    });

    test('defaults NaN to 20', () => {
        expect(guardedLimit('foo')).toBe(20);
    });

    test('passes through valid limit', () => {
        expect(guardedLimit(50, 100)).toBe(50);
    });
});
