'use strict';

const automationEngine = require('../services/automationEngine');
const mqttService = require('../services/mqttService');
const serialBridgeService = require('../services/serialBridgeService');

afterAll(async () => {
    try {
        automationEngine.destroy?.();
    } catch (_) {}

    try {
        mqttService.disconnect?.();
        mqttService.removeAllListeners?.();
        mqttService.clearAllDevices?.();
    } catch (_) {}

    try {
        serialBridgeService.stop?.();
        serialBridgeService.removeAllListeners?.();
    } catch (_) {}

    try {
        if (global.io && typeof global.io.close === 'function') {
            await new Promise((resolve) => global.io.close(() => resolve()));
        }
    } catch (_) {}

    global.io = undefined;
});
