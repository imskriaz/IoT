'use strict';

const { conversationDisplayMessages } = require('../utils/smsConversationSummary');

const part = (index, overrides = {}) => ({
    id: index, device_id: 'test', from_number: '+8801000000000', to_number: '',
    source: 'esp32-mqtt', type: 'incoming', sim_slot: 0, read: 0,
    timestamp: `2026-09-13T10:00:0${index}.000Z`,
    multipart_ref: '9', multipart_part_count: 2, multipart_part_index: index,
    message: index === 1 ? 'বাংলা ' : 'পরীক্ষা', ...overrides
});

test('preview assembles reversed arrival order and uses latest activity', () => {
    const messages = conversationDisplayMessages([part(2), part(1)]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 2, message: 'বাংলা পরীক্ষা', timestamp: part(2).timestamp, read: 0, multipart_complete: true });
});

test('part completion after an interleaved message updates conversation preview', () => {
    const messages = conversationDisplayMessages([
        part(1), { ...part(1), id: 3, multipart_ref: null, multipart_part_count: null,
            timestamp: '2026-09-13T10:00:02.000Z', message: 'interleaved' },
        part(2, { timestamp: '2026-09-13T10:00:03.000Z' })
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[1].message).toBe('বাংলা পরীক্ষা');
});

test('incomplete or conflicting parts remain visibly incomplete and separate', () => {
    expect(conversationDisplayMessages([part(2)])[0]).toMatchObject({ message: 'পরীক্ষা', multipart_complete: false });
    const rows = conversationDisplayMessages([part(1), part(2), part(1, { id: 3, message: 'conflict' })]);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.multipart_conflict)).toBe(true);
});

test('exact duplicate fragments count once while unread status considers every row', () => {
    const rows = conversationDisplayMessages([part(1, { read: 1 }), part(2, { read: 1 }), part(2, { id: 3, read: 0 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ message: 'বাংলা পরীক্ষা', read: 0 });
});

test('SIM and device boundaries are never merged', () => {
    expect(conversationDisplayMessages([part(1), part(2, { sim_slot: 1 })])).toHaveLength(2);
    expect(conversationDisplayMessages([part(1), part(2, { device_id: 'other' })])).toHaveLength(2);
    const legacy = { multipart_ref: null, multipart_part_count: null, multipart_part_index: null };
    expect(conversationDisplayMessages([part(1, { ...legacy, message: 'x'.repeat(153) }),
        part(2, { ...legacy, sim_slot: 1 })])).toHaveLength(2);
});

test('firmware literal hexadecimal-looking body is not decoded a second time', () => {
    expect(conversationDisplayMessages([part(1, { message: '0041' }), part(2, { message: '0042' })])[0].message).toBe('00410042');
});
