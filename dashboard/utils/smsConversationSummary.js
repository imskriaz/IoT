'use strict';

const { mergeMultipartThreadMessages } = require('./smsMultipart');
const { decodeSmsRecord } = require('./smsUnicode');

function timestampMs(value) {
    const text = String(value || '');
    const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
        ? `${text.replace(' ', 'T')}Z` : text);
    return Number.isFinite(parsed) ? parsed : 0;
}

function compareActivity(left, right) {
    return timestampMs(left.timestamp) - timestampMs(right.timestamp)
        || Number(left.id || 0) - Number(right.id || 0);
}

// Assemble before counting or selecting previews. Unlike the thread bubble's
// start timestamp, a conversation is ordered by the latest constituent's
// activity, including an out-of-order part completing an older message.
function conversationDisplayMessages(rows) {
    const sorted = (Array.isArray(rows) ? rows : []).map(decodeSmsRecord).sort(compareActivity);
    const byId = new Map(sorted.map((row) => [Number(row.id), row]));
    // The legacy no-UDH heuristic predates multi-SIM. Isolate hardware lanes
    // before calling it so even metadata-free messages cannot cross SIMs.
    const lanes = new Map();
    for (const row of sorted) {
        const rawSlot = row.sim_slot ?? row.simSlot;
        const slot = rawSlot == null || rawSlot === '' ? null : Number(rawSlot);
        const key = JSON.stringify([String(row.device_id || row.deviceId || '').toLowerCase(), slot]);
        if (!lanes.has(key)) lanes.set(key, []);
        lanes.get(key).push(row);
    }
    return [...lanes.values()].flatMap(mergeMultipartThreadMessages).map((row) => {
        const latest = (row.merged_sms_ids || []).map((id) => byId.get(Number(id)))
            .filter(Boolean).reduce((previous, part) => compareActivity(part, previous) > 0 ? part : previous, row);
        return { ...row, id: latest.id, timestamp: latest.timestamp };
    }).sort(compareActivity);
}

module.exports = { conversationDisplayMessages };
