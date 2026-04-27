'use strict';

function normalizeStoredSimRows(rows = []) {
    return (Array.isArray(rows) ? rows : [])
        .map((row) => {
            const slotIndex = Number.parseInt(String(row?.slot_index ?? row?.slotIndex ?? '').trim(), 10);
            if (!Number.isFinite(slotIndex) || slotIndex < 0) {
                return null;
            }
            const simNumber = String(row?.sim_number || row?.simNumber || '').trim();
            const operatorName = String(row?.operator_name || row?.operatorName || '').trim();
            const carrierName = String(row?.carrier_name || row?.carrierName || '').trim();
            const networkType = String(row?.network_type || row?.networkType || '').trim();

            return {
                slotIndex,
                number: simNumber,
                subscriberNumber: simNumber,
                simNumber,
                operator: operatorName || carrierName,
                operatorName: operatorName || carrierName,
                carrierName: carrierName || operatorName,
                networkType,
                ready: row?.is_ready === 1 || row?.is_ready === true,
                registered: row?.is_registered === 1 || row?.is_registered === true
            };
        })
        .filter(Boolean)
        .sort((left, right) => left.slotIndex - right.slotIndex);
}

async function readStoredSimRows(db, deviceId) {
    if (!db || typeof db.all !== 'function' || !deviceId) {
        return [];
    }

    return normalizeStoredSimRows(await db.all(
        `SELECT slot_index, sim_number, operator_name, carrier_name, network_type, is_ready, is_registered
         FROM sims
         WHERE device_id = ?
         ORDER BY slot_index ASC`,
        [deviceId]
    ));
}

function applyStoredSimFallback(deviceStatus = {}, storedRows = []) {
    const storedSlots = normalizeStoredSimRows(storedRows);
    if (!storedSlots.length || !deviceStatus || typeof deviceStatus !== 'object') {
        return deviceStatus;
    }

    const existingSlots = Array.isArray(deviceStatus.simSlots) ? deviceStatus.simSlots : [];
    const slotMap = new Map();

    existingSlots.forEach((slot) => {
        const slotIndex = Number.parseInt(String(slot?.slotIndex ?? '').trim(), 10);
        if (Number.isFinite(slotIndex) && slotIndex >= 0) {
            slotMap.set(slotIndex, { ...slot });
        }
    });

    storedSlots.forEach((storedSlot) => {
        const current = slotMap.get(storedSlot.slotIndex) || {};
        slotMap.set(storedSlot.slotIndex, {
            ...storedSlot,
            ...current,
            number: String(current.number || current.subscriberNumber || storedSlot.number || '').trim(),
            subscriberNumber: String(current.subscriberNumber || current.number || storedSlot.subscriberNumber || '').trim(),
            operator: String(current.operator || current.operatorName || storedSlot.operator || '').trim(),
            operatorName: String(current.operatorName || current.operator || storedSlot.operatorName || '').trim(),
            carrierName: String(current.carrierName || current.operatorName || storedSlot.carrierName || '').trim(),
            networkType: String(current.networkType || storedSlot.networkType || '').trim()
        });
    });

    const mergedSlots = Array.from(slotMap.values()).sort((left, right) => left.slotIndex - right.slotIndex);
    const activeSlotIndex = Number.parseInt(String(
        deviceStatus?.activeSimSlotIndex
        ?? deviceStatus?.sim?.activeSlotIndex
        ?? deviceStatus?.sim?.selectedSlotIndex
        ?? ''
    ).trim(), 10);
    const selectedSlot = mergedSlots.find((slot) => slot.slotIndex === activeSlotIndex)
        || mergedSlots[0]
        || null;

    return {
        ...deviceStatus,
        simNumber: String(deviceStatus.simNumber || deviceStatus.subscriberNumber || selectedSlot?.number || '').trim() || null,
        subscriberNumber: String(deviceStatus.subscriberNumber || deviceStatus.simNumber || selectedSlot?.subscriberNumber || '').trim() || null,
        operator: String(deviceStatus.operator || selectedSlot?.operatorName || selectedSlot?.operator || '').trim() || null,
        simSlots: mergedSlots,
        simSlotCount: Math.max(Number(deviceStatus.simSlotCount || 0), mergedSlots.length),
        dualSim: Boolean(deviceStatus.dualSim || mergedSlots.length >= 2),
        sim: {
            ...(deviceStatus.sim || {}),
            number: String(deviceStatus?.sim?.number || deviceStatus.simNumber || selectedSlot?.number || '').trim() || null,
            subscriberNumber: String(deviceStatus?.sim?.subscriberNumber || deviceStatus.subscriberNumber || selectedSlot?.subscriberNumber || '').trim() || null,
            operator: String(deviceStatus?.sim?.operator || selectedSlot?.operator || selectedSlot?.operatorName || '').trim() || null,
            operatorName: String(deviceStatus?.sim?.operatorName || selectedSlot?.operatorName || selectedSlot?.operator || '').trim() || null,
            slots: mergedSlots,
            slotCount: Math.max(Number(deviceStatus?.sim?.slotCount || 0), mergedSlots.length)
        }
    };
}

module.exports = {
    readStoredSimRows,
    applyStoredSimFallback
};
