'use strict';

function firstFiniteNumber(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number)) {
            return number;
        }
    }
    return null;
}

function unquoteField(value) {
    const trimmed = String(value || '').trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/""/g, '"');
    }
    return trimmed;
}

function splitCsvFields(value) {
    const fields = [];
    let current = '';
    let quoted = false;
    const raw = String(value || '');

    for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i];
        if (ch === '"') {
            if (quoted && raw[i + 1] === '"') {
                current += '"';
                i += 1;
            } else {
                quoted = !quoted;
                current += ch;
            }
        } else if (ch === ',' && !quoted) {
            fields.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    fields.push(current.trim());
    return fields;
}

function parseRawSmsDeliveryReport(value) {
    const raw = String(value || '').trim();
    const marker = raw.indexOf('+CDS:');
    if (marker < 0) {
        return {};
    }

    const lineEnd = raw.indexOf('\n', marker);
    const line = raw.slice(marker, lineEnd >= 0 ? lineEnd : raw.length).trim();
    const colon = line.indexOf(':');
    if (colon < 0) {
        return {};
    }

    const fields = splitCsvFields(line.slice(colon + 1).trim());
    if (fields.length < 7) {
        return {};
    }

    const messageReference = firstFiniteNumber(fields[1]);
    const statusReportStatus = firstFiniteNumber(fields[fields.length - 1]);
    const to = unquoteField(fields[2]);

    return {
        to: to || null,
        messageReference,
        statusReportStatus
    };
}

function parseSmsMessageReference(...values) {
    for (const value of values) {
        if (value === null || value === undefined || value === '') {
            continue;
        }
        if (Number.isFinite(Number(value))) {
            return Number(value);
        }

        const text = typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
        const cmgsMatch = text.match(/\+CMGS:\s*(\d+)/i);
        if (cmgsMatch) {
            return Number(cmgsMatch[1]);
        }
        const detailMatch = text.match(/\bsms_(?:multipart_)?sent_mr_(\d+)\b/i);
        if (detailMatch) {
            return Number(detailMatch[1]);
        }
        const jsonLikeMatch = text.match(/["']?(?:message_reference|messageReference|mr)["']?\s*[:=]\s*["']?(\d+)/i);
        if (jsonLikeMatch) {
            return Number(jsonLikeMatch[1]);
        }
    }

    return null;
}

function normalizeSmsDeliveryReport(data = {}) {
    const rawFields = parseRawSmsDeliveryReport(
        data?.raw_report ||
        data?.rawReport ||
        data?.raw ||
        data?.report ||
        ''
    );
    const rawStatus = String(data?.status || data?.delivery_status || '').trim().toLowerCase();
    const statusReportStatus = firstFiniteNumber(
        data?.status_report_status,
        data?.statusReportStatus,
        data?.st,
        rawFields.statusReportStatus
    );
    const messageReference = firstFiniteNumber(
        data?.message_reference,
        data?.messageReference,
        data?.mr,
        rawFields.messageReference,
        parseSmsMessageReference(data?.detail, data?.message, data?.payload)
    );
    let status = 'pending';

    if (typeof data?.delivered === 'boolean') {
        status = data.delivered ? 'delivered' : 'pending';
    }

    if (statusReportStatus !== null) {
        if (statusReportStatus <= 31) {
            status = 'delivered';
        } else if (statusReportStatus < 64) {
            status = 'pending';
        } else {
            status = 'failed';
        }
    }

    if (['delivered', 'sent', 'success', 'completed'].includes(rawStatus)) {
        status = 'delivered';
    } else if (['failed', 'undelivered', 'rejected', 'timeout'].includes(rawStatus)) {
        status = 'failed';
    } else if (rawStatus === 'pending' || rawStatus === 'buffered') {
        status = 'pending';
    }

    return {
        status,
        delivered: status === 'delivered',
        failed: status === 'failed',
        pending: status === 'pending',
        statusReportStatus,
        messageReference,
        to: String(data?.to || data?.number || rawFields.to || '').trim() || null
    };
}

function normalizeSmsDeliveryPayload(data = {}) {
    const report = normalizeSmsDeliveryReport(data);
    const payload = {
        ...(data || {}),
        status: report.status
    };

    if (!payload.to && !payload.number && report.to) {
        payload.to = report.to;
    }
    if (payload.status_report_status === undefined && report.statusReportStatus !== null) {
        payload.status_report_status = report.statusReportStatus;
    }
    if (payload.message_reference === undefined && report.messageReference !== null) {
        payload.message_reference = report.messageReference;
    }

    return payload;
}

module.exports = {
    parseRawSmsDeliveryReport,
    parseSmsMessageReference,
    normalizeSmsDeliveryPayload,
    normalizeSmsDeliveryReport
};
