(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SdStatus = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const fields = {
        detected: 'sd_detected', mounted: 'sd_mounted', capacityBytes: 'sd_capacity_bytes',
        totalBytes: 'sd_total_bytes', usedBytes: 'sd_used_bytes', freeBytes: 'sd_free_bytes', error: 'sd_error'
    };
    function normalize(source = {}) {
        if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
        const nested = source.sdCard || source.status?.sdCard;
        // Older firmware hardcoded sd_mounted=false. That alone is not a physical probe.
        if (!nested && !Object.values(fields).some(key => key !== 'sd_mounted' && source[key] !== undefined)) return null;
        const card = { ...(nested || {}) };
        for (const [name, key] of Object.entries(fields)) {
            if (source[key] !== undefined) card[name] = source[key];
        }
        for (const name of ['capacityBytes', 'totalBytes', 'usedBytes', 'freeBytes']) {
            if (card[name] !== undefined) {
                const value = card[name] === null || card[name] === '' ? NaN : Number(card[name]);
                card[name] = Number.isSafeInteger(value) && value >= 0 ? value : null;
            }
        }
        return card;
    }
    function formatBytes(value) {
        if (!Number.isFinite(value) || value < 0) return 'Not reported';
        if (value === 0) return '0 B';
        const exponent = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
        return `${Number((value / (1024 ** exponent)).toFixed(2))} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][exponent]}`;
    }
    function describe(card, online = true) {
        if (!online) return 'Offline — last reported: ' + describe(card, true);
        if (!card || card.error === 'not_probed') return 'Not checked by firmware';
        const capacity = card.capacityBytes > 0 ? `${formatBytes(card.capacityBytes)} card — ` : '';
        if (card.error === 'removed') return 'Card removed';
        if (card.error === 'not_detected') return 'Not detected — check card seating';
        if (card.detected === false) return 'No SD card detected';
        if (card.error === 'init_failed') return 'Card check failed — check seating and connections';
        if (card.error === 'unsupported_exfat') return `${capacity}exFAT is not supported; card data unchanged`;
        if (card.error === 'usage_failed') return `${capacity}mounted; free space could not be read`;
        if (card.error === 'mount_failed') return `${capacity}detected but could not be mounted; card data unchanged`;
        if (card.error) return `${capacity}card status unavailable`;
        if (card.mounted === true) {
            const total = Number(card.totalBytes);
            const free = card.freeBytes == null ? NaN : Number(card.freeBytes);
            if (Number.isSafeInteger(total) && total > 0) {
                const freeText = Number.isSafeInteger(free) && free >= 0 && free <= total
                    ? formatBytes(free) : 'Not reported';
                return `${freeText} free / ${formatBytes(total)}`;
            }
            return `${capacity}mounted; capacity not reported`;
        }
        if (card.detected === true) return `${capacity}detected but could not be mounted; card data unchanged`;
        return 'Card status unavailable';
    }
    function meter(card, online = true) {
        const normalized = normalize(card) || card;
        const error = String(normalized?.error || '').trim().toLowerCase();
        const mounted = normalized?.mounted === true && normalized?.detected !== false && (!error || error === 'usage_failed');
        const total = Number(normalized?.totalBytes || 0);
        const used = normalized?.usedBytes == null ? NaN : Number(normalized.usedBytes);
        const known = online && mounted && !error && Number.isSafeInteger(total) && total > 0
            && Number.isSafeInteger(used) && used >= 0 && used <= total;
        const percent = known
            ? Math.max(0, Math.min(100, (used / total) * 100))
            : 0;
        const fullText = describe(normalized, online);
        let text = fullText;
        if (!online) text = 'Offline';
        else if (mounted && total > 0) {
            const free = normalized.freeBytes == null ? NaN : Number(normalized.freeBytes);
            text = Number.isSafeInteger(free) && free >= 0 && free <= total ? `${formatBytes(free)} free` : 'Free space not reported';
        }
        const value = !online ? '-' : known ? (percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`) : mounted ? 'Ready' : 'N/A';
        const status = !online ? 'Offline'
            : mounted ? 'Mounted'
                : !normalized || normalized.error === 'not_probed' ? 'Not checked'
                    : normalized.detected === false || normalized.error === 'not_detected' || normalized.error === 'removed' ? 'Not detected'
                        : normalized.error === 'unsupported_exfat' ? 'Unsupported format'
                            : normalized.detected === true ? 'Not mounted' : 'Unavailable';
        return { percent, text, fullText, value, status, known };
    }
    function details(card, online = true) {
        const normalized = normalize(card) || card;
        const error = String(normalized?.error || '').trim().toLowerCase();
        const mounted = normalized?.mounted === true && normalized?.detected !== false && (!error || error === 'usage_failed');
        const detected = normalized?.detected === true;
        const missing = !mounted && (normalized?.detected === false || error === 'not_detected' || error === 'removed');
        const unchecked = !normalized || error === 'not_probed';
        const total = Number(normalized?.totalBytes || 0);
        const capacity = Number(normalized?.capacityBytes || 0);
        const used = normalized?.usedBytes == null ? NaN : Number(normalized.usedBytes);
        const free = normalized?.freeBytes == null ? NaN : Number(normalized.freeBytes);

        let state = 'unavailable';
        let stateLabel = 'Unavailable';
        let description = describe(normalized, online);
        if (!online) {
            state = 'offline';
            stateLabel = 'Offline';
            description = `Device offline. Last reported: ${describe(normalized, true)}`;
        } else if (mounted) {
            state = 'mounted';
            stateLabel = 'Mounted';
            description = error === 'usage_failed' ? describe(normalized, true) : 'SD card is mounted and ready for device files.';
        } else if (missing) {
            state = 'missing';
            stateLabel = 'Card missing';
            description = 'No SD card detected. Insert a supported FAT/FAT32 card; the device will retry automatically.';
        } else if (unchecked) {
            state = 'unchecked';
            stateLabel = 'Not checked';
            description = 'Waiting for firmware to check the physical SD card.';
        } else if (detected) {
            stateLabel = 'Not mounted';
        }

        return {
            state,
            stateLabel,
            description,
            capacityText: (mounted && total > 0) ? formatBytes(total) : (capacity > 0 ? formatBytes(capacity) : '—'),
            usedText: mounted && !error && Number.isSafeInteger(used) && used >= 0 && used <= total ? formatBytes(used) : '—',
            freeText: mounted && !error && Number.isSafeInteger(free) && free >= 0 && free <= total ? formatBytes(free) : '—',
            canOpenFiles: online && mounted
        };
    }
    return { normalize, describe, meter, details, formatBytes };
}));
