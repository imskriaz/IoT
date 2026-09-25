'use strict';

const { mergeMultipartThreadMessages, MULTIPART_ASSEMBLY_WINDOW_MS } = require('../utils/smsMultipart');

const epoch = Date.parse('2026-09-13T04:00:00Z');
function part(index, overrides = {}) {
    return {
        id: index, device_id: 'device-a', type: 'incoming', from_number: '+10000000001',
        to_number: '+10000000002', sim_slot: 0, message: index === 1 ? 'বাংলা ' : 'পরীক্ষা',
        timestamp: new Date(epoch + index * 1000).toISOString(), read: 1,
        multipart_ref: 'pdu8_17', multipart_group_key: 'group-a',
        multipart_part_index: index, multipart_part_count: 2, ...overrides
    };
}

describe('explicit multipart thread assembly', () => {
    test('orders interleaved and out-of-order parts without disturbing unrelated rows', () => {
        const unrelated = { id: 20, message: 'unrelated', timestamp: new Date(epoch).toISOString() };
        const result = mergeMultipartThreadMessages([part(2), unrelated, part(1)]);
        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({ message: 'বাংলা পরীক্ষা', multipart_complete: true,
            multipart_part_count: 2, merged_sms_ids: [1, 2], merged_multipart: true });
        expect(result[1]).toBe(unrelated);
    });

    test('deduplicates identical sequence retransmissions but retains all row IDs and unread state', () => {
        const result = mergeMultipartThreadMessages([part(1), part(1, { id: 3, read: 0 }), part(2)]);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ message: 'বাংলা পরীক্ষা', multipart_part_count: 2,
            merged_sms_count: 3, merged_sms_ids: [1, 3, 2], read: 0, multipart_complete: true });
    });

    test('does not turn missing parts into a complete body or reset the expected count', () => {
        const result = mergeMultipartThreadMessages([part(3, { multipart_part_count: 3 }),
            part(1, { multipart_part_count: 3 }), part(1, { id: 4, multipart_part_count: 3 })]);
        expect(result).toHaveLength(2);
        expect(result.map((row) => row.multipart_part_index)).toEqual([1, 3]);
        for (const row of result) {
            expect(row.multipart_part_count).toBe(3);
            expect(row.multipart_complete).toBe(false);
            expect(row.merged_multipart).not.toBe(true);
        }
        expect(result[0].merged_sms_ids).toEqual([1, 4]);
    });

    test('keeps conflicting duplicate bodies unmerged and visible', () => {
        const result = mergeMultipartThreadMessages([part(1), part(1, { id: 3, message: 'different' }), part(2)]);
        expect(result).toHaveLength(3);
        expect(result.every((row) => row.multipart_conflict && !row.multipart_complete)).toBe(true);
        expect(result.some((row) => row.message === 'different')).toBe(true);
    });

    test('rejects inconsistent counts even when generated keys differ by count', () => {
        const result = mergeMultipartThreadMessages([part(1), part(2, { multipart_part_count: 3, multipart_group_key: 'group-a:3' })]);
        expect(result).toHaveLength(2);
        expect(result.every((row) => row.multipart_conflict)).toBe(true);
    });

    test.each([0, -1, 3, 256, '1junk', 1.2, null])('rejects invalid sequence %p', (sequence) => {
        const result = mergeMultipartThreadMessages([part(1, { multipart_part_index: sequence }), part(2)]);
        expect(result.every((row) => row.multipart_complete === false)).toBe(true);
        expect(result).toHaveLength(2);
    });

    test.each(['device_id', 'from_number', 'to_number', 'sim_slot', 'type', 'multipart_ref'])('isolates %s', (field) => {
        const value = field === 'sim_slot' ? 1 : field === 'type' ? 'outgoing' : 'different';
        const result = mergeMultipartThreadMessages([part(1), part(2, { [field]: value })]);
        expect(result).toHaveLength(2);
        expect(result.every((row) => row.multipart_complete === false)).toBe(true);
    });

    test('supports ref/index/count without a prebuilt key', () => {
        const result = mergeMultipartThreadMessages([part(2, { multipart_group_key: null, multipart_ref: 'pdu16_65535' }),
            part(1, { multipart_group_key: null, multipart_ref: 'pdu16_65535' })]);
        expect(result[0]).toMatchObject({ message: 'বাংলা পরীক্ষা', multipart_complete: true });
    });

    test('supports legacy explicit keys without reference fields', () => {
        const result = mergeMultipartThreadMessages([part(1, { multipart_ref: null }), part(2, { multipart_ref: null })]);
        expect(result[0].multipart_complete).toBe(true);
    });

    test('does not merge reference reuse beyond the fixed assembly window', () => {
        const later = MULTIPART_ASSEMBLY_WINDOW_MS + 5000;
        const result = mergeMultipartThreadMessages([part(1), part(2),
            part(1, { id: 3, timestamp: new Date(epoch + later).toISOString(), message: 'new ' }),
            part(2, { id: 4, timestamp: new Date(epoch + later + 1000).toISOString(), message: 'body' })]);
        expect(result.map((row) => row.message)).toEqual(['বাংলা পরীক্ষা', 'new body']);
    });

    test('uses earliest timestamp, not a sliding timeout extended by duplicate arrivals', () => {
        const result = mergeMultipartThreadMessages([part(1, { timestamp: new Date(epoch).toISOString() }),
            part(1, { id: 3, timestamp: new Date(epoch + MULTIPART_ASSEMBLY_WINDOW_MS - 1000).toISOString() }),
            part(2, { timestamp: new Date(epoch + MULTIPART_ASSEMBLY_WINDOW_MS + 1000).toISOString() })]);
        expect(result).toHaveLength(2);
        expect(result.every((row) => !row.multipart_complete)).toBe(true);
    });

    test('will not assemble timestamps of unknown age', () => {
        const result = mergeMultipartThreadMessages([part(1, { timestamp: null }), part(2, { timestamp: 'invalid' })]);
        expect(result).toHaveLength(2);
        expect(result.every((row) => !row.multipart_complete)).toBe(true);
    });

    test('treats SQLite timezone-less timestamps as UTC', () => {
        const result = mergeMultipartThreadMessages([part(1, { timestamp: '2026-09-13 04:00:01' }), part(2)]);
        expect(result[0].multipart_complete).toBe(true);
    });

    test('does not mutate input rows', () => {
        const input = [part(2), part(1)];
        const before = JSON.stringify(input);
        mergeMultipartThreadMessages(input);
        expect(JSON.stringify(input)).toBe(before);
    });

    test('retains existing untagged legacy fallback behavior', () => {
        const input = [part(1, { message: 'x'.repeat(150) }), part(2, { message: 'tail' })]
            .map(({ multipart_ref, multipart_group_key, multipart_part_index, multipart_part_count, ...row }) => row);
        expect(mergeMultipartThreadMessages(input)[0].message).toBe(`${'x'.repeat(150)}tail`);
    });

    test('removing assembled explicit parts does not make unrelated fallback rows adjacent', () => {
        const untagged = (id, message) => ({ id, message, type: 'incoming', timestamp: new Date(epoch + id * 1000).toISOString() });
        const result = mergeMultipartThreadMessages([part(1), untagged(3, 'x'.repeat(150)), part(2), untagged(4, 'tail')]);
        expect(result).toHaveLength(3);
        expect(result[2].message).toBe('tail');
    });
});
