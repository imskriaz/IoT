'use strict';

const { applyStoredSimFallback, readStoredSimRows } = require('../services/storedSimService');

describe('storedSimService', () => {
    test('reads stored sim rows ordered by slot index', async () => {
        const db = {
            all: jest.fn().mockResolvedValue([
                { slot_index: 1, sim_number: '+8801000000001', operator_name: 'GP', carrier_name: 'Grameenphone', network_type: 'LTE', is_ready: 1, is_registered: 1 },
                { slot_index: 0, sim_number: '+8801000000000', operator_name: 'Robi', carrier_name: 'robi axiata', network_type: 'LTE', is_ready: 1, is_registered: 1 }
            ])
        };

        const rows = await readStoredSimRows(db, 'device-a');

        expect(db.all).toHaveBeenCalledWith(
            expect.stringContaining('FROM sims'),
            ['device-a']
        );
        expect(rows.map((row) => row.slotIndex)).toEqual([0, 1]);
    });

    test('fills missing top-level sim fields and slots from stored rows', () => {
        const result = applyStoredSimFallback({
            simNumber: '',
            subscriberNumber: '',
            operator: '',
            activeSimSlotIndex: 1,
            sim: {}
        }, [
            { slot_index: 0, sim_number: '+8801000000000', operator_name: 'Robi' },
            { slot_index: 1, sim_number: '+8801000000001', operator_name: 'Grameenphone' }
        ]);

        expect(result.simNumber).toBe('+8801000000001');
        expect(result.subscriberNumber).toBe('+8801000000001');
        expect(result.operator).toBe('Grameenphone');
        expect(result.simSlots).toHaveLength(2);
        expect(result.sim.slots).toHaveLength(2);
    });
});
