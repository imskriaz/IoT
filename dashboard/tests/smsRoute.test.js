'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

function buildApp(router, db) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = { user: { id: 7 } };
        next();
    });
    app.locals.db = db;
    app.use('/api/sms', router);
    return app;
}

let roomEmit;

function expectDeviceEvent(deviceId, eventName, payload) {
    expect(global.io.to).toHaveBeenCalledWith(`device:${deviceId}`);
    expect(roomEmit).toHaveBeenCalledWith(eventName, payload);
}

describe('sms route queue-first delivery', () => {
    const originalPhoneCountryCode = process.env.PHONE_COUNTRY_CODE;

    beforeEach(() => {
        jest.resetModules();
        process.env.PHONE_COUNTRY_CODE = '880';
        roomEmit = jest.fn();
        global.io = {
            emit: jest.fn(),
            to: jest.fn(() => ({ emit: roomEmit }))
        };
        global.mqttService = {
            publishCommand: jest.fn().mockResolvedValue({
                success: true,
                queued: true,
                queueId: 'queue-1',
                messageId: 'send-sms_test123',
                status: 'pending'
            })
        };
    });

    afterEach(() => {
        if (originalPhoneCountryCode === undefined) delete process.env.PHONE_COUNTRY_CODE;
        else process.env.PHONE_COUNTRY_CODE = originalPhoneCountryCode;
        delete global.io;
        delete global.mqttService;
    });

    test('queues outgoing SMS instead of failing when broker is offline', async () => {
        const db = {
            run: jest.fn(async (sql) => {
                if (String(sql).includes('INSERT INTO sms')) {
                    return { lastID: 41, changes: 1 };
                }
                return { changes: 1 };
            }),
            get: jest.fn(async (sql) => {
                if (String(sql).includes('SELECT id FROM devices')) return { id: 'device-1' };
                return null;
            }),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app)
            .post('/api/sms/send')
            .send({
                to: '+8801555123456',
                message: 'queued hello',
                deviceId: 'device-1'
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual(expect.objectContaining({
            success: true,
            queued: true,
            id: 41,
            queueId: 'queue-1',
            status: 'queued'
        }));
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith(
            'device-1',
            'send-sms',
            expect.objectContaining({
                to: '+8801555123456',
                message: '',
                smsId: 41,
                sms_pdu: expect.stringMatching(/^00[0-9A-F]+$/),
                sms_pdu_encoding: 'gsm7',
                sms_status_report_requested: true
            }),
            false,
            45000,
            expect.objectContaining({
                source: 'dashboard-sms',
                userId: 7,
                priority: 50,
                messageId: expect.stringMatching(/^sms_/)
            })
        );
    });

    test('accepts multipart SMS under the device limit and queues dashboard-built PDU parts', async () => {
        const db = {
            run: jest.fn(async (sql) => {
                if (String(sql).includes('INSERT INTO sms')) {
                    return { lastID: 61, changes: 1 };
                }
                return { changes: 1 };
            }),
            get: jest.fn(async (sql) => {
                if (String(sql).includes('SELECT id FROM devices')) return { id: 'device-1' };
                return null;
            }),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);
        const multipartMessage = 'x'.repeat(900);

        const res = await request(app)
            .post('/api/sms/send')
            .send({
                to: '+8801555123456',
                message: multipartMessage,
                deviceId: 'device-1'
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual(expect.objectContaining({
            success: true,
            queued: true,
            id: 61
        }));
        expect(global.mqttService.publishCommand).toHaveBeenCalledTimes(6);
        expect(global.mqttService.publishCommand).toHaveBeenNthCalledWith(
            1,
            'device-1',
            'send-sms',
            expect.objectContaining({
                to: '+8801555123456',
                message: '',
                smsId: 61,
                sms_pdu: expect.stringMatching(/^00[0-9A-F]+$/),
                sms_pdu_encoding: 'gsm7',
                sms_status_report_requested: true
            }),
            false,
            75000,
            expect.objectContaining({
                messageId: expect.stringMatching(/^sms_.*_p1$/)
            })
        );
        expect(global.mqttService.publishCommand).toHaveBeenNthCalledWith(
            6,
            'device-1',
            'send-sms',
            expect.objectContaining({
                to: '+8801555123456',
                message: '',
                smsId: 61,
                sms_pdu: expect.stringMatching(/^00[0-9A-F]+$/),
                sms_pdu_encoding: 'gsm7',
                sms_status_report_requested: true
            }),
            false,
            75000,
            expect.objectContaining({
                messageId: expect.stringMatching(/^sms_.*_p6$/)
            })
        );
    });

    test('accepts Bangla SMS and keeps the single-part MQTT contract when it fits Unicode limits', async () => {
        const db = {
            run: jest.fn(async (sql) => {
                if (String(sql).includes('INSERT INTO sms')) {
                    return { lastID: 71, changes: 1 };
                }
                return { changes: 1 };
            }),
            get: jest.fn(async (sql) => {
                if (String(sql).includes('SELECT id FROM devices')) return { id: 'device-1' };
                return null;
            }),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);
        const banglaMessage = 'MRUNI0426053916 \u09AC\u09BE\u0982\u09B2\u09BE';

        const res = await request(app)
            .post('/api/sms/send')
            .send({
                to: '+8801555123456',
                message: banglaMessage,
                deviceId: 'device-1'
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual(expect.objectContaining({
            success: true,
            queued: true,
            id: 71
        }));
        expect(global.mqttService.publishCommand).toHaveBeenCalledWith(
            'device-1',
            'send-sms',
            expect.objectContaining({
                to: '+8801555123456',
                message: '',
                smsId: 71,
                sms_pdu: expect.stringMatching(/^00[0-9A-F]+$/),
                sms_pdu_encoding: 'ucs2',
                sms_status_report_requested: true
            }),
            false,
            45000,
            expect.objectContaining({
                messageId: expect.stringMatching(/^sms_/)
            })
        );
    });

    test('accepts Bangla multipart SMS and uses the multipart MQTT contract', async () => {
        const db = {
            run: jest.fn(async (sql) => {
                if (String(sql).includes('INSERT INTO sms')) {
                    return { lastID: 72, changes: 1 };
                }
                return { changes: 1 };
            }),
            get: jest.fn(async (sql) => {
                if (String(sql).includes('SELECT id FROM devices')) return { id: 'device-1' };
                return null;
            }),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);
        const banglaMultipartMessage = '\u0985'.repeat(80);

        const res = await request(app)
            .post('/api/sms/send')
            .send({
                to: '+8801555123456',
                message: banglaMultipartMessage,
                deviceId: 'device-1'
            });

        expect(res.status).toBe(200);
        expect(res.body).toEqual(expect.objectContaining({
            success: true,
            queued: true,
            id: 72
        }));
        expect(global.mqttService.publishCommand).toHaveBeenCalledTimes(2);
        expect(global.mqttService.publishCommand).toHaveBeenNthCalledWith(
            1,
            'device-1',
            'send-sms',
            expect.objectContaining({
                to: '+8801555123456',
                message: '',
                smsId: 72,
                sms_pdu: expect.stringMatching(/^00[0-9A-F]+$/),
                sms_pdu_encoding: 'ucs2'
            }),
            false,
            60000,
            expect.objectContaining({
                messageId: expect.stringMatching(/^sms_.*_p1$/)
            })
        );
        expect(global.mqttService.publishCommand).toHaveBeenNthCalledWith(
            2,
            'device-1',
            'send-sms',
            expect.objectContaining({
                to: '+8801555123456',
                message: '',
                smsId: 72,
                sms_pdu: expect.stringMatching(/^00[0-9A-F]+$/),
                sms_pdu_encoding: 'ucs2'
            }),
            false,
            60000,
            expect.objectContaining({
                messageId: expect.stringMatching(/^sms_.*_p2$/)
            })
        );
    });

    test('send SMS stays MQTT-only even when a serial bridge exists', async () => {
        const db = {
            run: jest.fn(async (sql) => {
                if (String(sql).includes('INSERT INTO sms')) {
                    return { lastID: 52, changes: 1 };
                }
                return { changes: 1 };
            }),
            get: jest.fn(async (sql) => {
                if (String(sql).includes('SELECT id FROM devices')) return { id: 'device-1' };
                return null;
            }),
            all: jest.fn()
        };

        global.mqttService = {
            publishCommand: jest.fn().mockRejectedValue(new Error('MQTT not connected'))
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);
        const serialBridge = {
            _port: { isOpen: true },
            sendSms: jest.fn()
        };
        app.locals.serialBridge = serialBridge;

        const res = await request(app)
            .post('/api/sms/send')
            .send({
                to: '+8801555123456',
                message: 'mqtt only',
                deviceId: 'device-1'
            });

        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({
            success: false,
            message: 'MQTT not connected'
        });
        expect(serialBridge.sendSms).not.toHaveBeenCalled();
    });

    test('queues one SMS per recipient when multiple numbers are provided', async () => {
        let insertId = 60;
        const db = {
            run: jest.fn(async (sql) => {
                if (String(sql).includes('INSERT INTO sms')) {
                    insertId += 1;
                    return { lastID: insertId, changes: 1 };
                }
                return { changes: 1 };
            }),
            get: jest.fn(async (sql) => {
                if (String(sql).includes('SELECT id FROM devices')) return { id: 'device-1' };
                return null;
            }),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app)
            .post('/api/sms/send')
            .send({
                to: '01700000001, 01700000002',
                message: 'fanout hello',
                deviceId: 'device-1'
            });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            multiRecipient: true,
            count: 2,
            recipients: ['+8801700000001', '+8801700000002']
        });
        expect(global.mqttService.publishCommand).toHaveBeenCalledTimes(2);
    });

    test('returns unread count scoped to the requested device', async () => {
        const db = {
            run: jest.fn(),
            get: jest.fn().mockResolvedValue({ count: 3 }),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app).get('/api/sms/unread?deviceId=device-2');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            deviceId: 'device-2',
            count: 3
        });
        expect(res.headers['cache-control']).toContain('no-store');
        expect(res.headers.pragma).toBe('no-cache');
        expect(res.headers.expires).toBe('0');
        expect(db.get).toHaveBeenCalledWith(
            expect.stringContaining('WHERE device_id = ? AND read = 0 AND type = \'incoming\''),
            ['device-2']
        );
    });

    test('returns unread count scoped to the requested sim slot', async () => {
        const db = {
            run: jest.fn(),
            get: jest.fn().mockResolvedValue({ count: 2 }),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app).get('/api/sms/unread?deviceId=device-2&simSlot=1');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            deviceId: 'device-2',
            count: 2
        });
        expect(db.get).toHaveBeenCalledWith(
            expect.stringContaining('sim_slot = ?'),
            ['device-2', 1]
        );
    });

    test('unread count stays slot-scoped in sim-scoped mode', async () => {
        const db = {
            run: jest.fn(),
            get: jest.fn().mockResolvedValue({ count: 2 }),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app).get('/api/sms/unread?deviceId=device-2&simSlot=1');

        expect(res.status).toBe(200);
        expect(db.get).toHaveBeenCalledWith(
            expect.stringContaining('sim_slot = ?'),
            ['device-2', 1]
        );
    });

    test('bulk import emits a live update for the active device', async () => {
        const db = {
            run: jest.fn(async (sql) => {
                if (sql === 'BEGIN' || sql === 'COMMIT') return { changes: 0 };
                if (String(sql).includes('INSERT OR IGNORE INTO sms')) return { changes: 1 };
                return { changes: 0 };
            }),
            get: jest.fn(),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app)
            .post('/api/sms/bulk-import')
            .send({
                deviceId: 'device-4',
                messages: [
                    {
                        from: '+8801628301525',
                        message: 'hello import',
                        type: 'incoming',
                        timestamp: '2026-04-12T10:00:00.000Z'
                    },
                    {
                        from: '+8801628301525',
                        message: '',
                        type: 'incoming'
                    }
                ]
            });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            success: true,
            imported: 1,
            skipped: 1
        });
        expectDeviceEvent('device-4', 'sms:bulk-imported', {
            deviceId: 'device-4',
            imported: 1,
            skipped: 1
        });
    });

    test('bulk import skips invalid timestamps instead of failing the whole batch', async () => {
        const db = {
            run: jest.fn(async (sql) => {
                if (sql === 'BEGIN' || sql === 'COMMIT') return { changes: 0 };
                if (String(sql).includes('INSERT OR IGNORE INTO sms')) return { changes: 1 };
                return { changes: 0 };
            }),
            get: jest.fn(),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app)
            .post('/api/sms/bulk-import')
            .send({
                deviceId: 'device-5',
                messages: [
                    {
                        from: '+8801628301525',
                        message: 'valid import',
                        type: 'incoming',
                        timestamp: '2026-04-12T10:00:00.000Z'
                    },
                    {
                        from: '+8801628301525',
                        message: 'bad import',
                        type: 'incoming',
                        timestamp: 'not-a-date'
                    }
                ]
            });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            success: true,
            imported: 1,
            skipped: 1
        });
        expect(db.run.mock.calls.length).toBeGreaterThanOrEqual(3);
        expectDeviceEvent('device-5', 'sms:bulk-imported', {
            deviceId: 'device-5',
            imported: 1,
            skipped: 1
        });
    });

    test('lists SMS with fresh-only headers and requested device scope', async () => {
        const db = {
            run: jest.fn(),
            get: jest.fn().mockResolvedValue({ count: 0 }),
            all: jest.fn().mockResolvedValue([])
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app).get('/api/sms?deviceId=device-9&limit=1');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            data: []
        });
        expect(res.headers['cache-control']).toContain('no-store');
        expect(res.headers.pragma).toBe('no-cache');
        expect(res.headers.expires).toBe('0');
        expect(db.all).toHaveBeenCalledWith(
            expect.stringContaining('WHERE device_id = ?'),
            ['device-9', 1, 0]
        );
        expect(db.get).toHaveBeenCalledWith(
            expect.stringContaining('SELECT COUNT(*) as count FROM sms'),
            ['device-9']
        );
    });

    test('returns a thread scoped to the selected device with fresh-only headers', async () => {
        const rows = [
            {
                id: 22,
                device_id: 'device-8',
                from_number: '+8801628301525',
                to_number: null,
                message: 'reply two',
                timestamp: '2026-04-12T10:05:00.000Z',
                read: 0,
                type: 'incoming',
                status: 'received',
                user_id: null,
                source: 'device',
                error: null,
                external_id: null,
                sent_by: null
            },
            {
                id: 21,
                device_id: 'device-8',
                from_number: 'self',
                to_number: '+8801628301525',
                message: 'reply one',
                timestamp: '2026-04-12T10:00:00.000Z',
                read: 1,
                type: 'outgoing',
                status: 'queued',
                user_id: 7,
                source: 'dashboard',
                error: null,
                external_id: 'send-sms_abc123',
                sent_by: 'admin'
            }
        ];

        const db = {
            run: jest.fn(),
            get: jest.fn(),
            all: jest.fn().mockResolvedValue(rows)
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app).get('/api/sms/thread?deviceId=device-8&number=01628301525&limit=20');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.meta).toMatchObject({
            deviceId: 'device-8',
            number: '01628301525',
            count: 2
        });
        expect(res.body.data.map((entry) => entry.id)).toEqual([21, 22]);
        expect(res.body.data[0]).toEqual(expect.objectContaining({
            source: 'dashboard',
            sent_by: 'admin',
            external_id: 'send-sms_abc123'
        }));
        expect(res.body.data[1]).toEqual(expect.objectContaining({
            source: 'device'
        }));
        expect(res.headers['cache-control']).toContain('no-store');
        expect(res.headers.pragma).toBe('no-cache');
        expect(res.headers.expires).toBe('0');
        expect(db.all).toHaveBeenCalledWith(
            expect.stringContaining('LEFT JOIN users u ON s.user_id = u.id'),
            ['device-8', '01628301525', '1628301525', '01628301525', 20]
        );
    });

    test('thread lookup excludes rows with unknown SIM metadata when a SIM scope is selected', async () => {
        const rows = [
            {
                id: 22,
                device_id: 'device-8',
                from_number: '+8801628301525',
                to_number: null,
                message: 'reply two',
                timestamp: '2026-04-12T10:05:00.000Z',
                read: 0,
                type: 'incoming',
                status: 'received',
                user_id: null,
                source: 'device',
                error: null,
                external_id: null,
                sent_by: null
            },
            {
                id: 21,
                device_id: 'device-8',
                from_number: 'self',
                to_number: '+8801628301525',
                message: 'reply one',
                timestamp: '2026-04-12T10:00:00.000Z',
                read: 1,
                type: 'outgoing',
                status: 'queued',
                user_id: 7,
                source: 'dashboard',
                error: null,
                external_id: 'send-sms_abc123',
                sent_by: 'admin'
            }
        ];

        const db = {
            run: jest.fn(),
            get: jest.fn(),
            all: jest.fn().mockResolvedValue(rows)
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app).get('/api/sms/thread?deviceId=device-8&number=01628301525&simSlot=0&limit=20');

        expect(res.status).toBe(200);
        expect(res.body.meta).toMatchObject({ count: 2, simSlot: 0 });
        expect(db.all).toHaveBeenCalledWith(
            expect.stringContaining('s.sim_slot = ?'),
            ['device-8', '01628301525', '1628301525', '01628301525', 0, 20]
        );
    });

    test('returns conversation summaries scoped to the selected device', async () => {
        const conversationRows = [
            {
                conversation_id: 33,
                device_id: 'device-10',
                thread_number: '+8801628301525',
                display_from: '+8801628301525',
                message: 'latest inbound',
                timestamp: '2026-04-12T10:05:00.000Z',
                status: 'received',
                unread_count: 2,
                total_count: 3,
                last_direction: 'incoming'
            },
            {
                conversation_id: 31,
                device_id: 'device-10',
                thread_number: '+8801888888888',
                display_from: '+8801888888888',
                message: 'queued outbound',
                timestamp: '2026-04-12T09:00:00.000Z',
                status: 'queued',
                unread_count: 0,
                total_count: 1,
                last_direction: 'outgoing'
            }
        ];

        const db = {
            run: jest.fn(),
            get: jest.fn().mockResolvedValue({ count: 2 }),
            all: jest.fn().mockResolvedValue(conversationRows)
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app).get('/api/sms/conversations?deviceId=device-10&limit=20');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.meta).toMatchObject({
            deviceId: 'device-10',
            total: 2,
            limit: 20
        });
        expect(res.body.data).toEqual([
            expect.objectContaining({
                conversation_id: 33,
                thread_number: '+8801628301525',
                total_count: 3,
                unread_count: 2,
                last_direction: 'incoming'
            }),
            expect.objectContaining({
                conversation_id: 31,
                thread_number: '+8801888888888',
                total_count: 1,
                unread_count: 0,
                last_direction: 'outgoing'
            })
        ]);
        expect(res.headers['cache-control']).toContain('no-store');
        expect(res.headers.pragma).toBe('no-cache');
        expect(res.headers.expires).toBe('0');
        expect(db.all).toHaveBeenCalledWith(
            expect.stringContaining('FROM sms_conversations'),
            ['device-10', 20]
        );
        expect(db.get).toHaveBeenCalledWith(
            'SELECT COUNT(*) AS count FROM sms_conversations WHERE device_id = ?',
            ['device-10']
        );
    });

    test('conversation fallback stays slot-scoped in SIM-scoped mode', async () => {
        const smsRows = [
            {
                id: 12,
                device_id: 'device-10',
                from_number: '+8801628301525',
                to_number: null,
                message: 'latest inbound',
                timestamp: '2026-04-12T10:05:00.000Z',
                read: 0,
                type: 'incoming',
                status: 'received',
                user_id: null,
                conversation_id: 33
            },
            {
                id: 11,
                device_id: 'device-10',
                from_number: 'self',
                to_number: '+8801628301525',
                message: 'queued outbound',
                timestamp: '2026-04-12T09:00:00.000Z',
                read: 1,
                type: 'outgoing',
                status: 'queued',
                user_id: 7,
                conversation_id: 33
            }
        ];

        const db = {
            run: jest.fn(),
            get: jest.fn().mockResolvedValue({ count: 0 }),
            all: jest.fn().mockResolvedValue(smsRows)
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app).get('/api/sms/conversations?deviceId=device-10&simSlot=1&limit=20');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toEqual([
            expect.objectContaining({
                thread_number: '+8801628301525',
                total_count: 2
            })
        ]);
        expect(db.all).toHaveBeenCalledWith(
            expect.stringContaining('sim_slot = ?'),
            ['device-10', 1, 250]
        );
    });

    test('exports CSV for the active device with no-store headers', async () => {
        const db = {
            run: jest.fn(),
            get: jest.fn(),
            all: jest.fn().mockResolvedValue([
                {
                    id: 5,
                    device_id: 'device-12',
                    from_number: '+8801000000000',
                    to_number: '+8801628301525',
                    message: 'csv hello',
                    type: 'outgoing',
                    status: 'sent',
                    timestamp: '2026-04-12T10:00:00.000Z',
                    sent_by: 'admin'
                }
            ])
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app).get('/api/sms/export/csv?deviceId=device-12');

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/csv');
        expect(res.headers['cache-control']).toContain('no-store');
        expect(res.headers.pragma).toBe('no-cache');
        expect(res.headers.expires).toBe('0');
        expect(res.headers['content-disposition']).toContain('sms-export-device-12-');
        expect(res.text).toContain('id,device_id,from_number,to_number,message,type,status,timestamp,sim_slot,sent_by');
        expect(res.text).toContain('5,device-12,+8801000000000,+8801628301525,"csv hello",outgoing,sent,2026-04-12T10:00:00.000Z,,admin');
        expect(db.all).toHaveBeenCalledWith(
            expect.stringContaining('WHERE s.device_id = ?'),
            ['device-12']
        );
    });

    test('clears only the selected device inbox messages', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ changes: 4 }),
            get: jest.fn().mockResolvedValue({ count: 0 }),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app)
            .delete('/api/sms/clear?deviceId=device-3')
            .send({ type: 'incoming' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            deviceId: 'device-3',
            deleted: 4
        });
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('DELETE FROM sms WHERE device_id = ? AND type != \'outgoing\''),
            ['device-3']
        );
        expect(db.get).toHaveBeenCalledWith(
            expect.stringContaining('WHERE device_id = ? AND read = 0 AND type = \'incoming\''),
            ['device-3']
        );
        expectDeviceEvent('device-3', 'sms:bulk-deleted', {
            deviceId: 'device-3',
            count: 4,
            unreadCount: 0
        });
    });

    test('deletes only a message owned by the active device', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn(),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app).delete('/api/sms/99?deviceId=device-4');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(db.run).toHaveBeenCalledWith(
            'DELETE FROM sms WHERE id = ? AND device_id = ?',
            ['99', 'device-4']
        );
    });

    test('bulk read is scoped to the active device and returns a fresh unread count', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ changes: 2 }),
            get: jest.fn().mockResolvedValue({ count: 1 }),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app)
            .post('/api/sms/bulk-read?deviceId=device-5')
            .send({ ids: [10, 11] });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            marked: 2,
            unreadCount: 1
        });
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('UPDATE sms SET read = 1 WHERE device_id = ? AND id IN (?,?) AND read = 0'),
            ['device-5', 10, 11]
        );
        expect(db.get).toHaveBeenCalledWith(
            expect.stringContaining('WHERE device_id = ? AND read = 0 AND type = \'incoming\''),
            ['device-5']
        );
    });

    test('mark all read updates the full unread inbox for the active device', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ changes: 5 }),
            get: jest.fn().mockResolvedValue({ count: 0 }),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app)
            .post('/api/sms/mark-all-read?deviceId=device-15')
            .send({});

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            marked: 5,
            unreadCount: 0
        });
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining("WHERE device_id = ?"),
            ['device-15']
        );
        expect(db.get).toHaveBeenCalledWith(
            expect.stringContaining('WHERE device_id = ? AND read = 0 AND type = \'incoming\''),
            ['device-15']
        );
        expectDeviceEvent('device-15', 'sms:bulk-read', {
            deviceId: 'device-15',
            count: 5,
            unreadCount: 0
        });
    });

    test('template create returns the same joined shape used by template list', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ lastID: 12, changes: 1 }),
            get: jest.fn().mockResolvedValue({
                id: 12,
                title: 'Hello',
                message: 'Template body',
                created_at: '2026-04-12T10:00:00.000Z',
                created_by: 'admin'
            }),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app)
            .post('/api/sms/templates')
            .send({
                title: 'Hello',
                message: 'Template body'
            });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            data: {
                id: 12,
                title: 'Hello',
                message: 'Template body',
                created_by: 'admin'
            }
        });
        expect(db.get).toHaveBeenCalledWith(
            expect.stringContaining('LEFT JOIN users u ON t.created_by = u.id'),
            [12]
        );
        expect(global.io.emit).toHaveBeenCalledWith('sms:template-added', expect.objectContaining({
            id: 12,
            created_by: 'admin'
        }));
    });

    test('creates scheduled SMS with normalized phone number and active device scope', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ lastID: 77, changes: 1 }),
            get: jest.fn(),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);
        const sendAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

        const res = await request(app)
            .post('/api/sms/scheduled?deviceId=device-6')
            .send({
                to: '01628301525',
                message: 'scheduled hello',
                send_at: sendAt
            });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            id: 77
        });
        expect(db.run).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO scheduled_sms'),
            ['device-6', '+8801628301525', 'scheduled hello', sendAt, null, 7]
        );
        expectDeviceEvent('device-6', 'sms:scheduled-created', {
            id: 77,
            deviceId: 'device-6',
            to_number: '+8801628301525',
            message: 'scheduled hello',
            send_at: sendAt,
            sim_slot: null,
            status: 'pending',
            created_by: null
        });
    });

    test('creates one scheduled SMS per recipient when multiple numbers are provided', async () => {
        let nextId = 90;
        const db = {
            run: jest.fn(async () => ({ lastID: ++nextId, changes: 1 })),
            get: jest.fn(),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);
        const sendAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

        const res = await request(app)
            .post('/api/sms/scheduled?deviceId=device-6')
            .send({
                recipients: ['01628301525', '01700000001'],
                message: 'scheduled multi',
                send_at: sendAt
            });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            multiRecipient: true,
            count: 2,
            recipients: ['+8801628301525', '+8801700000001']
        });
        expect(db.run).toHaveBeenCalledTimes(2);
        expectDeviceEvent('device-6', 'sms:scheduled-created', expect.objectContaining({
            id: 91,
            to_number: '+8801628301525'
        }));
        expectDeviceEvent('device-6', 'sms:scheduled-created', expect.objectContaining({
            id: 92,
            to_number: '+8801700000001'
        }));
    });

    test('rejects scheduled SMS longer than the firmware send payload allows', async () => {
        const db = {
            run: jest.fn(),
            get: jest.fn(),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);
        const sendAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

        const res = await request(app)
            .post('/api/sms/scheduled?deviceId=device-6')
            .send({
                to: '01628301525',
                message: 'x'.repeat(1024),
                send_at: sendAt
            });

        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
            success: false,
            message: 'Message exceeds device SMS limit (max 1023 UTF-8 bytes)'
        });
        expect(db.run).not.toHaveBeenCalled();
    });

    test('scheduled SMS delete is scoped to the active device', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn(),
            all: jest.fn()
        };

        const router = require('../routes/sms');
        const app = buildApp(router, db);

        const res = await request(app).delete('/api/sms/scheduled/77?deviceId=device-7');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(db.run).toHaveBeenCalledWith(
            `DELETE FROM scheduled_sms WHERE id = ? AND device_id = ? AND status = 'pending'`,
            ['77', 'device-7']
        );
        expectDeviceEvent('device-7', 'sms:scheduled-cancelled', {
            id: 77,
            deviceId: 'device-7'
        });
    });

    test('scheduled processor emits failed events when queueing fails', async () => {
        jest.useFakeTimers();

        const dueSms = {
            id: 91,
            device_id: 'device-11',
            to_number: '+8801628301525',
            message: 'scheduled fail',
            user_id: 7
        };

        const db = {
            run: jest.fn().mockResolvedValue({ changes: 1 }),
            get: jest.fn(),
            all: jest.fn().mockResolvedValue([dueSms])
        };

        global.mqttService = {
            publishCommand: jest.fn().mockRejectedValue(new Error('broker unavailable'))
        };

        const router = require('../routes/sms');
        const interval = router.startScheduledSmsProcessor({ locals: { db } });

        await jest.advanceTimersByTimeAsync(30000);

        expect(db.all).toHaveBeenCalledWith(
            `SELECT * FROM scheduled_sms WHERE status = 'pending' AND datetime(send_at) <= datetime('now') LIMIT 20`
        );
        expect(db.run).toHaveBeenCalledWith(
            `UPDATE scheduled_sms SET status = 'failed', error = ? WHERE id = ?`,
            ['broker unavailable', 91]
        );
        expectDeviceEvent('device-11', 'sms:scheduled-failed', {
            id: 91,
            deviceId: 'device-11',
            to: '+8801628301525',
            error: 'broker unavailable'
        });

        clearInterval(interval);
        jest.useRealTimers();
    });
});
