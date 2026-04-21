'use strict';

function firstText(...values) {
    for (const value of values) {
        const text = String(value ?? '').trim();
        if (text) {
            return text;
        }
    }
    return '';
}

function firstBoolean(...values) {
    for (const value of values) {
        if (value === true || value === false) {
            return value;
        }
        if (value === 1 || value === '1') {
            return true;
        }
        if (value === 0 || value === '0') {
            return false;
        }
    }
    return false;
}

function firstNumber(...values) {
    for (const value of values) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return null;
}

function readRawStatusSimSlots(status = {}) {
    return Array.isArray(status?.sim_slots)
        ? status.sim_slots
        : (Array.isArray(status?.simSlots)
            ? status.simSlots
            : (Array.isArray(status?.sim?.slots)
                ? status.sim.slots
                : (Array.isArray(status?.status?.sim?.slots) ? status.status.sim.slots : [])));
}

function normalizeStatusSimSlots(status = {}) {
    const rawSlots = readRawStatusSimSlots(status);
    const explicitActiveSlotIndex = firstNumber(
        status?.sim_active_slot,
        status?.active_sim_slot,
        status?.selected_sim_slot,
        status?.selectedSimSlot,
        status?.sim?.activeSlotIndex,
        status?.sim?.selectedSlotIndex
    );
    const selectedSlotFallback = {
        simNumber: firstText(
            status?.modem_subscriber_number,
            status?.simNumber,
            status?.sim_number,
            status?.subscriberNumber,
            status?.subscriber_number,
            status?.sim?.number,
            status?.sim?.subscriberNumber,
            status?.mobile?.simNumber,
            status?.mobile?.subscriberNumber
        ),
        operatorName: firstText(
            status?.modem_operator_name,
            status?.operatorName,
            status?.operator_name,
            status?.sim?.operatorName,
            status?.mobile?.operatorName,
            status?.modem_operator,
            status?.operator,
            status?.sim?.operator,
            status?.mobile?.operator
        ),
        carrierName: firstText(
            status?.carrierName,
            status?.carrier_name,
            status?.modem_operator_name,
            status?.operatorName,
            status?.operator_name,
            status?.modem_operator,
            status?.operator,
            status?.sim?.carrierName,
            status?.sim?.operatorName,
            status?.mobile?.operatorName
        ),
        networkType: firstText(
            status?.networkType,
            status?.network_type,
            status?.sim?.networkType,
            status?.mobile?.networkType
        )
    };

    return rawSlots
        .map((slot, index) => {
            if (!slot || typeof slot !== 'object') {
                return null;
            }

            const slotIndex = firstNumber(
                slot.slotIndex,
                slot.slot_index,
                slot.simSlot,
                slot.sim_slot,
                index
            );
            if (slotIndex === null) {
                return null;
            }

            const normalizedSlotIndex = Math.max(0, Math.trunc(slotIndex));
            const isSelectedSlot = explicitActiveSlotIndex !== null && normalizedSlotIndex === Math.trunc(explicitActiveSlotIndex);

            return {
                slotIndex: normalizedSlotIndex,
                simNumber: firstText(
                    slot.number,
                    slot.subscriberNumber,
                    slot.subscriber_number,
                    slot.msisdn,
                    slot.phoneNumber,
                    slot.phone_number,
                    isSelectedSlot ? selectedSlotFallback.simNumber : ''
                ),
                operatorName: firstText(
                    slot.operatorName,
                    slot.operator,
                    isSelectedSlot ? selectedSlotFallback.operatorName : ''
                ),
                carrierName: firstText(
                    slot.carrierName,
                    slot.carrier_name,
                    slot.operatorName,
                    slot.operator,
                    isSelectedSlot ? selectedSlotFallback.carrierName : ''
                ),
                networkType: firstText(
                    slot.networkType,
                    slot.network_type,
                    isSelectedSlot ? selectedSlotFallback.networkType : ''
                ),
                isReady: firstBoolean(slot.ready, slot.simReady, slot.sim_ready),
                isRegistered: firstBoolean(slot.registered, slot.modemRegistered, slot.modem_registered)
            };
        })
        .filter(Boolean);
}

async function syncDeviceSimInventory(db, deviceId, status = {}) {
    if (!db || typeof db.run !== 'function' || !deviceId) {
        return [];
    }

    const normalizedDeviceId = String(deviceId || '').trim();
    if (!normalizedDeviceId) {
        return [];
    }

    const slots = normalizeStatusSimSlots(status);
    if (!slots.length) {
        return [];
    }

    for (const slot of slots) {
        await db.run(
            `INSERT INTO sims (
                device_id,
                slot_index,
                sim_number,
                operator_name,
                carrier_name,
                network_type,
                is_ready,
                is_registered,
                last_seen_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(device_id, slot_index) DO UPDATE SET
                sim_number = COALESCE(excluded.sim_number, sims.sim_number),
                operator_name = COALESCE(excluded.operator_name, sims.operator_name),
                carrier_name = COALESCE(excluded.carrier_name, sims.carrier_name),
                network_type = COALESCE(excluded.network_type, sims.network_type),
                is_ready = excluded.is_ready,
                is_registered = excluded.is_registered,
                last_seen_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP`,
            [
                normalizedDeviceId,
                slot.slotIndex,
                slot.simNumber || null,
                slot.operatorName || null,
                slot.carrierName || null,
                slot.networkType || null,
                slot.isReady ? 1 : 0,
                slot.isRegistered ? 1 : 0
            ]
        );
    }

    const slotIndexes = slots.map((slot) => slot.slotIndex);
    await db.run(
        `DELETE FROM sims
         WHERE device_id = ?
           AND slot_index NOT IN (${slotIndexes.map(() => '?').join(', ')})`,
        [normalizedDeviceId, ...slotIndexes]
    );

    return slots;
}

module.exports = {
    normalizeStatusSimSlots,
    syncDeviceSimInventory
};
