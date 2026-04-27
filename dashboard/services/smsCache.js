'use strict';

/**
 * In-memory unread SMS count cache, scoped by device.
 *
 * Lifecycle:
 *   - get(deviceId) returns the current count, or null until seeded.
 *   - set(count, deviceId) stores a fresh DB count for one device.
 *   - set(null, deviceId) invalidates one device; omit deviceId to clear all.
 *   - increment/decrement only adjust a device after it has been seeded.
 */

const countsByDevice = new Map();

function keyFor(deviceId) {
    return String(deviceId || '__default__');
}

function safeCount(value) {
    return Math.max(0, Number(value) || 0);
}

module.exports = {
    get(deviceId) {
        const key = keyFor(deviceId);
        return countsByDevice.has(key) ? countsByDevice.get(key) : null;
    },

    set(count, deviceId) {
        if (count === null || count === undefined) {
            if (deviceId) {
                countsByDevice.delete(keyFor(deviceId));
            } else {
                countsByDevice.clear();
            }
            return;
        }

        countsByDevice.set(keyFor(deviceId), safeCount(count));
    },

    increment(deviceId) {
        const key = keyFor(deviceId);
        if (countsByDevice.has(key)) {
            countsByDevice.set(key, countsByDevice.get(key) + 1);
        }
    },

    decrement(deviceId, count = 1) {
        const key = keyFor(deviceId);
        if (countsByDevice.has(key)) {
            countsByDevice.set(key, safeCount(countsByDevice.get(key) - count));
        }
    }
};
