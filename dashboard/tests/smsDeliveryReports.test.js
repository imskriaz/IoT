'use strict';

const {
    normalizeSmsDeliveryPayload,
    normalizeSmsDeliveryReport,
    parseSmsMessageReference,
    parseRawSmsDeliveryReport
} = require('../utils/smsDeliveryReports');

describe('smsDeliveryReports', () => {
    test('parses SIMCom text-mode CDS reports', () => {
        const raw = '+CDS: 49,47,"+8801887300993",145,"26/04/24,12:00:00+24","26/04/24,12:00:03+24",0';

        expect(parseRawSmsDeliveryReport(raw)).toEqual({
            to: '+8801887300993',
            messageReference: 47,
            statusReportStatus: 0
        });
        expect(normalizeSmsDeliveryReport({ raw_report: raw })).toEqual(expect.objectContaining({
            status: 'delivered',
            delivered: true,
            pending: false,
            messageReference: 47,
            statusReportStatus: 0,
            to: '+8801887300993'
        }));
        expect(normalizeSmsDeliveryPayload({ raw_report: raw })).toEqual(expect.objectContaining({
            to: '+8801887300993',
            message_reference: 47,
            status_report_status: 0,
            status: 'delivered'
        }));
    });

    test('classifies failed CDS status values', () => {
        const raw = '+CDS: 49,48,"+8801887300993",145,"26/04/24,12:00:00+24","26/04/24,12:00:03+24",64';

        expect(normalizeSmsDeliveryReport({ raw_report: raw })).toEqual(expect.objectContaining({
            status: 'failed',
            failed: true,
            messageReference: 48,
            statusReportStatus: 64
        }));
    });

    test('extracts modem message references from send responses', () => {
        expect(parseSmsMessageReference('+CMGS: 132')).toBe(132);
        expect(parseSmsMessageReference('sms_sent_mr_133')).toBe(133);
        expect(parseSmsMessageReference({ message_reference: 134 })).toBe(134);
        expect(normalizeSmsDeliveryReport({
            detail: 'sms_sent_mr_135',
            status_report_status: 0
        })).toEqual(expect.objectContaining({
            status: 'delivered',
            messageReference: 135
        }));
    });
});
