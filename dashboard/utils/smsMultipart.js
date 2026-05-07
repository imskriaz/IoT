'use strict';

function cleanText(value) {
    return String(value || '').trim();
}

function parsePositiveInt(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number.parseInt(String(value).trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeInt(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number.parseInt(String(value).trim(), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function firstNonEmpty(values) {
    for (const value of values) {
        const text = cleanText(value);
        if (text) return text;
    }
    return '';
}

function normalizeMultipartMetadata(payload = {}, context = {}) {
    const multipartRef = firstNonEmpty([
        payload.multipart_ref,
        payload.multipartRef,
        payload.multipart_reference,
        payload.multipartReference,
        payload.concat_ref,
        payload.concatRef,
        payload.reference,
        payload.ref
    ]) || null;
    const multipartPartIndex = parsePositiveInt(
        payload.multipart_part_index
        ?? payload.multipartPartIndex
        ?? payload.part_index
        ?? payload.partIndex
        ?? payload.sequence
        ?? payload.seq
    );
    const multipartPartCount = parsePositiveInt(
        payload.multipart_part_count
        ?? payload.multipartPartCount
        ?? payload.part_count
        ?? payload.partCount
        ?? payload.total_parts
        ?? payload.totalParts
        ?? payload.parts
    );
    const explicitGroupKey = firstNonEmpty([
        payload.multipart_group_key,
        payload.multipartGroupKey,
        payload.concat_group_key,
        payload.concatGroupKey
    ]) || null;

    const normalized = {
        multipart_ref: multipartRef,
        multipart_part_index: multipartPartIndex,
        multipart_part_count: multipartPartCount,
        multipart_group_key: explicitGroupKey || null
    };

    if (!normalized.multipart_group_key && normalized.multipart_ref && normalized.multipart_part_count > 1) {
        normalized.multipart_group_key = buildMultipartGroupKey({
            deviceId: context.deviceId || payload.device_id || payload.deviceId,
            direction: context.direction || payload.direction || payload.type,
            fromNumber: context.fromNumber || payload.from || payload.from_number || payload.sender,
            toNumber: context.toNumber || payload.to || payload.to_number,
            simSlot: context.simSlot ?? payload.sim_slot ?? payload.simSlot,
            multipartRef: normalized.multipart_ref,
            multipartPartCount: normalized.multipart_part_count
        });
    }

    return normalized;
}

function normalizeMultipartTimestamp(timestamp, multipart = {}) {
    const partIndex = parsePositiveInt(
        multipart.multipart_part_index
        ?? multipart.multipartPartIndex
        ?? multipart.part_index
        ?? multipart.partIndex
    );
    const partCount = parsePositiveInt(
        multipart.multipart_part_count
        ?? multipart.multipartPartCount
        ?? multipart.part_count
        ?? multipart.partCount
    );
    const groupKey = cleanText(multipart.multipart_group_key ?? multipart.multipartGroupKey);

    if (!groupKey || !partIndex || !partCount || partCount <= 1) {
        return timestamp;
    }

    const parsed = Date.parse(timestamp || '');
    if (!Number.isFinite(parsed)) {
        return timestamp;
    }

    return new Date(parsed + Math.max(0, partIndex - 1)).toISOString();
}

function buildMultipartGroupKey({
    deviceId,
    direction,
    fromNumber,
    toNumber,
    simSlot,
    multipartRef,
    multipartPartCount
} = {}) {
    const ref = cleanText(multipartRef);
    const count = parsePositiveInt(multipartPartCount);
    if (!ref || !count || count <= 1) {
        return null;
    }

    const normalizedDirection = cleanText(direction).toLowerCase() === 'outgoing' ? 'outgoing' : 'incoming';
    const counterpart = cleanText(normalizedDirection === 'outgoing' ? toNumber : (fromNumber || toNumber)).toLowerCase();
    const normalizedDeviceId = cleanText(deviceId).toLowerCase();
    const slot = parseNonNegativeInt(simSlot);

    return [
        'multipart',
        normalizedDeviceId || 'device',
        normalizedDirection,
        counterpart || 'unknown',
        slot == null ? 'nosim' : String(slot),
        ref.toLowerCase(),
        String(count)
    ].join(':');
}

function mergeMultipartThreadMessages(messages = []) {
    const sorted = Array.isArray(messages) ? messages.slice() : [];
    if (!sorted.length) return [];

    const merged = [];
    let index = 0;

    while (index < sorted.length) {
        const start = sorted[index];
        const groupKey = cleanText(start.multipart_group_key);

        if (!groupKey) {
            merged.push(start);
            index += 1;
            continue;
        }

        const group = [start];
        let cursor = index + 1;
        while (cursor < sorted.length && cleanText(sorted[cursor].multipart_group_key) === groupKey) {
            group.push(sorted[cursor]);
            cursor += 1;
        }

        merged.push(group.length > 1 ? combineMultipartGroup(group) : start);
        index = cursor;
    }

    return merged;
}

function combineMultipartGroup(group) {
    const ordered = group.slice().sort((left, right) => {
        const leftIndex = parsePositiveInt(left.multipart_part_index) || 0;
        const rightIndex = parsePositiveInt(right.multipart_part_index) || 0;
        if (leftIndex && rightIndex && leftIndex !== rightIndex) {
            return leftIndex - rightIndex;
        }
        const timeDelta = Date.parse(left.timestamp || '') - Date.parse(right.timestamp || '');
        if (Number.isFinite(timeDelta) && timeDelta !== 0) {
            return timeDelta;
        }
        return Number(left.id || 0) - Number(right.id || 0);
    });

    const anchor = { ...ordered[0] };
    const body = ordered.map((entry) => String(entry.message || '')).join('');
    const mergedIds = ordered
        .map((entry) => Number(entry.id || 0))
        .filter((id) => Number.isInteger(id) && id > 0);
    const latest = ordered[ordered.length - 1];

    anchor.id = mergedIds[0] || anchor.id;
    anchor.message = body;
    anchor.timestamp = anchor.timestamp || latest.timestamp;
    anchor.read = ordered.every((entry) => Boolean(entry.read)) ? 1 : 0;
    anchor.status = latest.status || anchor.status;
    anchor.error = latest.error || null;
    anchor.external_id = latest.external_id || anchor.external_id || null;
    anchor.multipart_part_index = 1;
    anchor.multipart_part_count = ordered.length;
    anchor.merged_sms_ids = mergedIds;
    anchor.merged_sms_count = mergedIds.length;
    anchor.merged_multipart = true;
    return anchor;
}

module.exports = {
    buildMultipartGroupKey,
    mergeMultipartThreadMessages,
    normalizeMultipartMetadata,
    normalizeMultipartTimestamp
};
