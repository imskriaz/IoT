'use strict';

/**
 * Default device ID.
 * Empty means "no forced fallback"; runtime should resolve a real device
 * from session, request, or discovered devices instead of inventing "1".
 * A single source of truth for server-side code.
 */
const DEFAULT_DEVICE_ID = (process.env.DEVICE_ID || '').trim();

module.exports = { DEFAULT_DEVICE_ID };
