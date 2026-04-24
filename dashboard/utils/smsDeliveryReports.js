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

function normalizeSmsDeliveryReport(data = {}) {
    const rawStatus = String(data?.status || data?.delivery_status || '').trim().toLowerCase();
    const statusReportStatus = firstFiniteNumber(
        data?.status_report_status,
        data?.statusReportStatus,
        data?.st
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
        statusReportStatus
    };
}

module.exports = {
    normalizeSmsDeliveryReport
};
