'use strict';

const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

describe('simInventoryService', () => {
    const { normalizeStatusSimSlots, syncDeviceSimInventory } = require('../services/simInventoryService');

    test('normalizes slot data from status payloads', () => {
        const slots = normalizeStatusSimSlots({
            sim_slots: [
                {
                    slot_index: 1,
                    subscriber_number: '+8801887300993',
                    operatorName: 'robi axiata',
                    carrier_name: 'Robi',
                    network_type: 'LTE',
                    sim_ready: true,
                    modem_registered: true
                }
            ]
        });

        expect(slots).toEqual([
            expect.objectContaining({
                slotIndex: 1,
                simNumber: '+8801887300993',
                operatorName: 'robi axiata',
                carrierName: 'Robi',
                networkType: 'LTE',
                isReady: true,
                isRegistered: true
            })
        ]);
    });

    test('fills sparse active slot metadata from top-level modem fields', () => {
        const slots = normalizeStatusSimSlots({
            sim_active_slot: 1,
            modem_operator_name: 'Grameenphone',
            modem_subscriber_number: '+8801712345678',
            sim_slots: [
                {
                    slot_index: 0,
                    subscriber_number: '+8801887300993',
                    operatorName: 'robi axiata',
                    carrier_name: 'Robi',
                    network_type: 'LTE',
                    sim_ready: true,
                    modem_registered: true
                },
                {
                    slot_index: 1,
                    carrier_name: '',
                    network_type: '',
                    sim_ready: true,
                    modem_registered: true
                }
            ]
        });

        expect(slots[1]).toEqual(expect.objectContaining({
            slotIndex: 1,
            simNumber: '+8801712345678',
            operatorName: 'Grameenphone',
            carrierName: 'Grameenphone',
            isReady: true,
            isRegistered: true
        }));
    });

    test('syncs current slot rows and prunes removed slots', async () => {
        const db = {
            run: jest.fn().mockResolvedValue({ changes: 1 })
        };

        await syncDeviceSimInventory(db, 'device-a', {
            sim: {
                slots: [
                    { slotIndex: 0, number: '+8801000000000', operator: 'Robi', ready: true, registered: true },
                    { slotIndex: 1, number: '+8801000000001', operator: 'GP', ready: false, registered: false }
                ]
            }
        });

        expect(db.run).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('INSERT INTO sims'),
            ['device-a', 0, '+8801000000000', 'Robi', 'Robi', null, 1, 1]
        );
        expect(db.run).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('INSERT INTO sims'),
            ['device-a', 1, '+8801000000001', 'GP', 'GP', null, 0, 0]
        );
        expect(db.run).toHaveBeenNthCalledWith(
            3,
            expect.stringContaining('DELETE FROM sims'),
            ['device-a', 0, 1]
        );
    });

    test('preserves existing sim metadata when a later payload is sparse', async () => {
        const db = await open({
            filename: ':memory:',
            driver: sqlite3.Database
        });

        await db.exec(`
            CREATE TABLE sims (
                device_id TEXT NOT NULL,
                slot_index INTEGER NOT NULL,
                sim_number TEXT,
                operator_name TEXT,
                carrier_name TEXT,
                network_type TEXT,
                is_ready INTEGER NOT NULL DEFAULT 0,
                is_registered INTEGER NOT NULL DEFAULT 0,
                last_seen_at DATETIME,
                updated_at DATETIME,
                PRIMARY KEY (device_id, slot_index)
            );
        `);

        await db.run(
            `INSERT INTO sims (
                device_id, slot_index, sim_number, operator_name, carrier_name, network_type, is_ready, is_registered
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ['device-a', 0, '+8801000000000', 'Robi', 'robi axiata', 'LTE', 1, 1]
        );
        await db.run(
            `INSERT INTO sims (
                device_id, slot_index, sim_number, operator_name, carrier_name, network_type, is_ready, is_registered
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ['device-a', 1, '+8801000000001', 'Airtel', 'airtel', 'LTE', 1, 1]
        );

        await syncDeviceSimInventory(db, 'device-a', {
            sim_active_slot: 1,
            modem_operator_name: 'Grameenphone',
            modem_subscriber_number: '+8801712345678',
            sim_slots: [
                { slotIndex: 0, ready: true, registered: true },
                { slotIndex: 1, ready: true, registered: true }
            ]
        });

        const rows = await db.all(`
            SELECT slot_index, sim_number, operator_name, carrier_name, network_type, is_ready, is_registered
            FROM sims
            WHERE device_id = ?
            ORDER BY slot_index ASC
        `, ['device-a']);

        expect(rows).toEqual([
            expect.objectContaining({
                slot_index: 0,
                sim_number: '+8801000000000',
                operator_name: 'Robi',
                carrier_name: 'robi axiata',
                network_type: 'LTE',
                is_ready: 1,
                is_registered: 1
            }),
            expect.objectContaining({
                slot_index: 1,
                sim_number: '+8801712345678',
                operator_name: 'Grameenphone',
                carrier_name: 'Grameenphone',
                network_type: 'LTE',
                is_ready: 1,
                is_registered: 1
            })
        ]);

        await db.close();
    });
});
