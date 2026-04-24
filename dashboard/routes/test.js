const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { getDeviceCapabilities, isCapabilityAvailable } = require('../utils/deviceCapabilities');
const { resolveSmsCommand } = require('../utils/smsLimits');
const fs = require('fs');
const path = require('path');

// Test state storage
let testResults = new Map(); // deviceId -> { testId: result }
let runningTests = new Map(); // deviceId -> { testId: status }
let testHistory = new Map(); // deviceId -> [test results]

function emitDeviceEvent(deviceId, event, payload) {
    const normalizedDeviceId = String(deviceId || '').trim();
    if (!global.io) return;
    if (normalizedDeviceId) {
        const room = global.io.to?.('device:' + normalizedDeviceId);
        if (room?.emit) room.emit(event, payload);
        else global.io.emit?.(event, payload);
    } else {
        global.io.emit?.(event, payload);
    }
}

// Available tests for ESP32-S3 A7670E
const AVAILABLE_TESTS = {
    // Communication Tests
    modem: {
        name: 'Modem Communication',
        category: 'communication',
        icon: 'bi-broadcast',
        description: 'Test modem AT commands and response',
        requiredCaps: [],
        steps: [
            { name: 'AT', command: 'AT', expected: 'OK' },
            { name: 'SIM Status', command: 'AT+CPIN?', expected: 'READY' },
            { name: 'Signal Quality', command: 'AT+CSQ', handler: 'parseCSQ' },
            { name: 'Network Registration', command: 'AT+CREG?', handler: 'parseCREG' },
            { name: 'Operator', command: 'AT+COPS?', handler: 'parseCOPS' }
        ],
        timeout: 30000
    },
    
    sms: {
        name: 'SMS Functionality',
        category: 'communication',
        icon: 'bi-chat-dots',
        description: 'Test SMS sending and receiving',
        requiredCaps: [],
        parameters: [
            { name: 'to', type: 'string', required: false },
            { name: 'message', type: 'string', default: 'Dashboard SMS test', required: false }
        ],
        steps: [
            { name: 'SMS Format', command: 'AT+CMGF=1', expected: 'OK' },
            { name: 'SMS Storage', command: 'AT+CPMS?', handler: 'parseCPMS' },
            { name: 'New SMS Indication', command: 'AT+CNMI=2,2', expected: 'OK' }
        ],
        timeout: 10000
    },
    
    // Hardware Tests
    led: {
        name: 'LED Test',
        category: 'hardware',
        icon: 'bi-led-on',
        description: 'Test onboard and external LEDs',
        requiredCaps: [],
        parameters: [
            { name: 'pin', type: 'number', default: 2, min: 0, max: 39 },
            { name: 'duration', type: 'number', default: 1000, min: 100, max: 10000 },
            { name: 'pattern', type: 'select', options: ['blink', 'pulse', 'solid'], default: 'blink' }
        ],
        timeout: 10000
    },
    
    button: {
        name: 'Button Test',
        category: 'hardware',
        icon: 'bi-toggle-on',
        description: 'Test button input',
        requiredCaps: [],
        parameters: [
            { name: 'pin', type: 'number', default: 0, min: 0, max: 39 },
            { name: 'pull', type: 'select', options: ['up', 'down', 'none'], default: 'up' }
        ],
        timeout: 30000
    },
    
    // Audio Tests
    microphone: {
        name: 'Microphone Test',
        category: 'audio',
        icon: 'bi-mic',
        description: 'Test microphone input',
        requiredCaps: ['audio'],
        parameters: [
            { name: 'duration', type: 'number', default: 3, min: 1, max: 10 },
            { name: 'sensitivity', type: 'number', default: 50, min: 0, max: 100 }
        ],
        timeout: 15000
    },
    
    speaker: {
        name: 'Speaker Test',
        category: 'audio',
        icon: 'bi-speaker',
        description: 'Test speaker output',
        requiredCaps: ['audio'],
        parameters: [
            { name: 'frequency', type: 'number', default: 440, min: 20, max: 20000 },
            { name: 'duration', type: 'number', default: 1000, min: 100, max: 5000 },
            { name: 'volume', type: 'number', default: 50, min: 0, max: 100 }
        ],
        timeout: 10000
    },
    
    // Camera Tests
    camera: {
        name: 'Camera Test',
        category: 'camera',
        icon: 'bi-camera',
        description: 'Test camera module',
        requiredCaps: ['camera'],
        parameters: [
            { name: 'resolution', type: 'select', options: ['QVGA', 'VGA', 'SVGA', 'XGA'], default: 'VGA' },
            { name: 'format', type: 'select', options: ['JPEG', 'BMP', 'RGB565'], default: 'JPEG' }
        ],
        timeout: 10000
    },
    
    // GPS Tests
    gps: {
        name: 'GPS Test',
        category: 'gps',
        icon: 'bi-geo-alt',
        description: 'Test GPS module',
        requiredCaps: ['gps'],
        parameters: [
            { name: 'timeout', type: 'number', default: 60, min: 10, max: 300 }
        ],
        timeout: 310000 // 5 min + 10s
    },
    
    // Storage Tests
    sdCard: {
        name: 'SD Card Test',
        category: 'storage',
        icon: 'bi-sd-card',
        description: 'Test SD card read/write',
        requiredCaps: ['storage'],
        parameters: [
            { name: 'testFile', type: 'string', default: 'test.txt' },
            { name: 'testSize', type: 'number', default: 1024, min: 64, max: 1048576 }
        ],
        timeout: 30000
    },

    storageBenchmark: {
        name: 'Storage Benchmark',
        category: 'storage',
        icon: 'bi-speedometer2',
        description: 'Quick SD card write/read throughput benchmark',
        requiredCaps: ['storage'],
        parameters: [
            { name: 'testSize', type: 'number', default: 8192, min: 1024, max: 131072 },
            { name: 'iterations', type: 'number', default: 3, min: 1, max: 10 }
        ],
        timeout: 120000
    },

    storageDiagnostics: {
        name: 'Storage Diagnostics',
        category: 'storage',
        icon: 'bi-clipboard2-pulse',
        description: 'Check card detection, mount status, filesystem, and last storage error',
        requiredCaps: ['storage'],
        timeout: 10000
    },
    
    // Network Tests
    wifi: {
        name: 'WiFi Test',
        category: 'network',
        icon: 'bi-wifi',
        description: 'Test WiFi connectivity',
        requiredCaps: ['wifi'],
        parameters: [
            { name: 'ssid', type: 'string', required: true },
            { name: 'password', type: 'password', required: false },
            { name: 'timeout', type: 'number', default: 30, min: 5, max: 60 }
        ],
        timeout: 65000
    },
    
    // Power Tests
    battery: {
        name: 'Battery Test',
        category: 'power',
        icon: 'bi-battery',
        description: 'Test battery voltage and charging',
        requiredCaps: ['battery'],
        steps: [
            { name: 'Voltage Reading', command: 'AT+CBC?', handler: 'parseBattery' },
            { name: 'Charging Status', command: 'AT+CBC?', handler: 'parseCharging' }
        ],
        timeout: 10000
    },
    
    // GPIO Tests
    gpioLoopback: {
        name: 'GPIO Loopback',
        category: 'gpio',
        icon: 'bi-arrow-left-right',
        description: 'Test GPIO input/output with loopback',
        requiredCaps: [],
        parameters: [
            { name: 'outputPin', type: 'number', default: 2, min: 0, max: 39 },
            { name: 'inputPin', type: 'number', default: 4, min: 0, max: 39 },
            { name: 'testPattern', type: 'select', options: ['0101', '1010', 'pulse'], default: '0101' }
        ],
        timeout: 30000
    },
    
    // Comprehensive Tests
    fullSystem: {
        name: 'Full System Test',
        category: 'system',
        icon: 'bi-cpu',
        description: 'Test all components sequentially',
        requiredCaps: [],
        timeout: 300000 // 5 minutes
    }
};

function normalizeRequiredCaps(test = {}) {
    return Array.isArray(test.requiredCaps) ? test.requiredCaps : [];
}

function getMissingCapabilities(test, caps = {}) {
    return normalizeRequiredCaps(test).filter((cap) => !isCapabilityAvailable(caps, cap));
}

function buildSupportMessage(test, missingCaps) {
    if (!missingCaps.length) return 'Ready to run';
    return `${test.name} skipped: active device has not reported ${missingCaps.join(', ')} support`;
}

function annotateTestDefinition(testId, test, caps = {}) {
    const missingCaps = testId === 'fullSystem' ? [] : getMissingCapabilities(test, caps);
    return {
        ...test,
        id: testId,
        requiredCaps: normalizeRequiredCaps(test),
        missingCaps,
        supported: missingCaps.length === 0,
        supportMessage: buildSupportMessage(test, missingCaps)
    };
}

async function getSupportContext(db, deviceId) {
    if (!db) return { caps: {} };
    const capabilityData = await getDeviceCapabilities(db, deviceId);
    return { caps: capabilityData.caps || {} };
}

function recordHistoryEntry(deviceId, entry) {
    const history = testHistory.get(deviceId) || [];
    history.unshift(entry);
    testHistory.set(deviceId, history.slice(0, 100));
}

function recordSkippedTest(deviceId, runId, test, reason, details = {}) {
    updateTestStatus(deviceId, runId, 'skipped', reason, details);
    recordHistoryEntry(deviceId, {
        runId,
        testId: test.id || test.name,
        name: test.name,
        result: 'skipped',
        timestamp: new Date().toISOString(),
        details: {
            skipped: true,
            ...details
        }
    });
}

// ==================== TEST MANAGEMENT ====================

/**
 * Get all available tests
 * GET /api/test/available
 */
router.get('/available', async (req, res) => {
    try {
        const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;
        const support = await getSupportContext(req.app.locals.db, deviceId);
        const tests = Object.fromEntries(
            Object.entries(AVAILABLE_TESTS).map(([id, test]) => [id, annotateTestDefinition(id, test, support.caps)])
        );

        res.json({
            success: true,
            data: tests,
            caps: support.caps
        });
    } catch (error) {
        logger.error('Available tests error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load available tests'
        });
    }
});

/**
 * Get test categories
 * GET /api/test/categories
 */
router.get('/categories', async (req, res) => {
    try {
        const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;
        const support = await getSupportContext(req.app.locals.db, deviceId);
        const categories = {};

        Object.entries(AVAILABLE_TESTS).forEach(([id, test]) => {
            const annotated = annotateTestDefinition(id, test, support.caps);
            if (!categories[test.category]) {
                categories[test.category] = {
                    name: test.category.charAt(0).toUpperCase() + test.category.slice(1),
                    icon: getCategoryIcon(test.category),
                    tests: []
                };
            }
            categories[test.category].tests.push({
                id,
                name: test.name,
                icon: test.icon,
                description: test.description,
                supported: annotated.supported,
                missingCaps: annotated.missingCaps,
                supportMessage: annotated.supportMessage,
                requiredCaps: annotated.requiredCaps
            });
        });

        res.json({
            success: true,
            data: categories,
            caps: support.caps
        });
    } catch (error) {
        logger.error('Test categories error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load test categories'
        });
    }
});

/**
 * Run a test
 * POST /api/test/run
 */
router.post('/run', [
    body('testId').notEmpty(),
    body('parameters').optional().isObject(),
    body('deviceId').optional()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: errors.array()[0]?.msg || "Validation failed", errors: errors.array()
            });
        }

        const { testId, parameters = {}, deviceId = DEFAULT_DEVICE_ID } = req.body;

        // Check if test exists
        const test = AVAILABLE_TESTS[testId];
        if (!test) {
            return res.status(404).json({
                success: false,
                message: 'Test not found'
            });
        }

        const support = await getSupportContext(req.app.locals.db, deviceId);
        const runnableTest = annotateTestDefinition(testId, test, support.caps);

        // Generate test ID
        const runId = `${testId}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

        if (!runnableTest.supported) {
            const reason = runnableTest.supportMessage;
            recordSkippedTest(deviceId, runId, runnableTest, reason, {
                missingCaps: runnableTest.missingCaps,
                requiredCaps: runnableTest.requiredCaps
            });

            return res.json({
                success: true,
                message: reason,
                data: {
                    runId,
                    testId,
                    name: runnableTest.name,
                    skipped: true,
                    missingCaps: runnableTest.missingCaps
                }
            });
        }

        // Store running test
        if (!runningTests.has(deviceId)) {
            runningTests.set(deviceId, new Map());
        }
        runningTests.get(deviceId).set(runId, {
            runId,
            testId,
            parameters,
            testName: runnableTest.name,
            status: 'running',
            startTime: new Date().toISOString(),
            progress: 0,
            steps: [],
            logs: []
        });
        appendTestTrace(deviceId, runId, 'info', 'test initiated', { testId, testName: runnableTest.name, parameters, deviceId });

        // Start test in background
        runTest(deviceId, runId, runnableTest, parameters, support).catch(error => {
            logger.error(`Test ${runId} failed:`, error);
            updateTestStatus(deviceId, runId, 'failed', error.message);
        });

        res.json({
            success: true,
            message: `Test "${runnableTest.name}" started`,
            data: {
                runId,
                testId,
                name: runnableTest.name,
                estimatedTime: runnableTest.timeout / 1000
            }
        });

    } catch (error) {
        logger.error('Run test error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to start test'
        });
    }
});

/**
 * Get test status
 * GET /api/test/status/:runId?deviceId=1
 */
router.get('/status/:runId', (req, res) => {
    try {
        const { runId } = req.params;
        const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;

        const running = runningTests.get(deviceId)?.get(runId);
        if (running) {
            return res.json({
                success: true,
                data: {
                    ...running,
                    completed: false
                }
            });
        }

        const result = testResults.get(deviceId)?.get(runId);
        if (result) {
            return res.json({
                success: true,
                data: {
                    ...result,
                    completed: true
                }
            });
        }

        res.status(404).json({
            success: false,
            message: 'Test not found'
        });

    } catch (error) {
        logger.error('Test status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get test status'
        });
    }
});

/**
 * Get all test results for device
 * GET /api/test/results?deviceId=1&limit=50
 */
router.get('/results', (req, res) => {
    try {
        const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 50), 500);

        const history = testHistory.get(deviceId) || [];
        const results = history.slice(0, limit);

        res.json({
            success: true,
            data: results
        });

    } catch (error) {
        logger.error('Test results error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get test results'
        });
    }
});

/**
 * Stop a running test
 * POST /api/test/stop/:runId
 */
router.post('/stop/:runId', (req, res) => {
    try {
        const { runId } = req.params;
        const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;

        const running = runningTests.get(deviceId)?.get(runId);
        if (!running) {
            return res.status(404).json({
                success: false,
                message: 'Test not running'
            });
        }

        updateTestStatus(deviceId, runId, 'stopped', 'Test stopped by user');
        runningTests.get(deviceId).delete(runId);

        res.json({
            success: true,
            message: 'Test stopped'
        });

    } catch (error) {
        logger.error('Stop test error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to stop test'
        });
    }
});

/**
 * Clear test history
 * DELETE /api/test/history
 */
router.delete('/history', (req, res) => {
    try {
        const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;
        
        testHistory.set(deviceId, []);
        testResults.delete(deviceId);

        res.json({
            success: true,
            message: 'Test history cleared'
        });

    } catch (error) {
        logger.error('Clear history error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to clear history'
        });
    }
});

/**
 * Delete specific test result
 * DELETE /api/test/result/:runId
 */
router.delete('/result/:runId', (req, res) => {
    try {
        const { runId } = req.params;
        const deviceId = req.query.deviceId || DEFAULT_DEVICE_ID;

        const history = testHistory.get(deviceId) || [];
        const newHistory = history.filter(r => r.runId !== runId);
        testHistory.set(deviceId, newHistory);

        testResults.get(deviceId)?.delete(runId);

        res.json({
            success: true,
            message: 'Test result deleted'
        });

    } catch (error) {
        logger.error('Delete result error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete result'
        });
    }
});

// ==================== RETRY HELPER ====================

const STEP_MAX_RETRIES = 2;       // total attempts = 1 + STEP_MAX_RETRIES
const STEP_RETRY_DELAY_MS = 1500; // wait between attempts
const DEVICE_SELF_TEST_EXPECTED_RESULTS = 6;

function waitForMqttEvent(eventName, deviceId, timeoutMs, predicate = null) {
    return new Promise((resolve, reject) => {
        const mqttService = global.mqttService;
        if (!mqttService || typeof mqttService.on !== 'function') {
            reject(new Error('MQTT service unavailable'));
            return;
        }

        const cleanup = () => {
            clearTimeout(timer);
            if (typeof mqttService.off === 'function') {
                mqttService.off(eventName, onEvent);
            }
        };

        const onEvent = (incomingDeviceId, data) => {
            if (incomingDeviceId !== deviceId) return;
            if (predicate && !predicate(data)) return;
            cleanup();
            resolve(data);
        };

        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for ${eventName}`));
        }, timeoutMs);

        mqttService.on(eventName, onEvent);
    });
}

function waitForDeviceSelfTestResults(deviceId, timeoutMs = 25000, expectedCount = DEVICE_SELF_TEST_EXPECTED_RESULTS) {
    return new Promise((resolve, reject) => {
        if (!global.mqttService || typeof global.mqttService.on !== 'function') {
            reject(new Error('MQTT service unavailable'));
            return;
        }

        const results = [];
        const seen = new Set();
        const cleanup = () => {
            clearTimeout(timer);
            global.mqttService.off('test:result', onResult);
        };

        const onResult = (incomingDeviceId, data) => {
            if (incomingDeviceId !== deviceId) return;
            if (!data?.testId || seen.has(data.testId)) return;
            seen.add(data.testId);
            results.push(data);
            if (results.length >= expectedCount) {
                cleanup();
                resolve(results);
            }
        };

        const timer = setTimeout(() => {
            cleanup();
            if (results.length > 0) {
                resolve(results);
            } else {
                reject(new Error('No self-test results received'));
            }
        }, timeoutMs);

        global.mqttService.on('test:result', onResult);
    });
}

/**
 * Run a single test step via MQTT with automatic retry on failure.
 * Returns { name, command, response, success, attempts } or throws after all retries exhausted.
 */
async function runStepWithRetry(deviceId, runId, step, commandTopic, progressMsg) {
    let lastResult = null;
    for (let attempt = 1; attempt <= 1 + STEP_MAX_RETRIES; attempt++) {
        if (attempt > 1) {
            updateTestProgress(deviceId, runId, null, `Retry ${attempt - 1}/${STEP_MAX_RETRIES}: ${step.name}`);
            await new Promise(r => setTimeout(r, STEP_RETRY_DELAY_MS));
        }
        try {
            const response = await publishTestCommand(
                deviceId,
                runId,
                commandTopic,
                { command: step.command },
                true,
                5000,
                step.name
            );
            const success = checkResponse(response?.data, step);
            lastResult = { name: step.name, command: step.command, response: response?.data, success, attempts: attempt };
            if (success) return lastResult;
            appendTestTrace(deviceId, runId, 'warning', `${step.name}: device responded but validation failed`, {
                expected: step.expected || step.handler || null,
                response: response?.data
            });
            // Step ran but check failed — retry
        } catch (mqttErr) {
            // Timeout or transport error — retry
            lastResult = { name: step.name, command: step.command, response: null, success: false, attempts: attempt, error: mqttErr.message };
        }
    }
    // All attempts exhausted
    throw new Error(`${step.name} failed after ${1 + STEP_MAX_RETRIES} attempts`);
}

// ==================== TEST IMPLEMENTATIONS ====================

async function runTest(deviceId, runId, test, parameters, supportContext = { caps: {} }) {
    logger.info(`Starting test ${runId}: ${test.name}`);

    try {
        let result;
        
        // Route to specific test handler
        switch (test.name) {
            case 'Modem Communication':
                result = await testModem(deviceId, runId, test, parameters);
                break;
            case 'SMS Functionality':
                result = await testSMS(deviceId, runId, test, parameters);
                break;
            case 'LED Test':
                result = await testLED(deviceId, runId, test, parameters);
                break;
            case 'Button Test':
                result = await testButton(deviceId, runId, test, parameters);
                break;
            case 'Microphone Test':
                result = await testMicrophone(deviceId, runId, test, parameters);
                break;
            case 'Speaker Test':
                result = await testSpeaker(deviceId, runId, test, parameters);
                break;
            case 'Camera Test':
                result = await testCamera(deviceId, runId, test, parameters);
                break;
            case 'GPS Test':
                result = await testGPS(deviceId, runId, test, parameters);
                break;
            case 'SD Card Test':
                result = await testSDCard(deviceId, runId, test, parameters);
                break;
            case 'Storage Benchmark':
                result = await testStorageBenchmark(deviceId, runId, test, parameters);
                break;
            case 'Storage Diagnostics':
                result = await testStorageDiagnostics(deviceId, runId, test, parameters);
                break;
            case 'WiFi Test':
                result = await testWiFi(deviceId, runId, test, parameters);
                break;
            case 'Battery Test':
                result = await testBattery(deviceId, runId, test, parameters);
                break;
            case 'GPIO Loopback':
                result = await testGPIOLoopback(deviceId, runId, test, parameters);
                break;
            case 'Full System Test':
                result = await testFullSystem(deviceId, runId, test, parameters, supportContext);
                break;
            default:
                result = await runGenericTest(deviceId, runId, test, parameters);
        }

        // Store result
        updateTestStatus(deviceId, runId, 'completed', 'Test completed successfully', result);
        
        // Add to history
        recordHistoryEntry(deviceId, {
            runId,
            testId: test.id || test.name,
            name: test.name,
            result: 'pass',
            duration: result.duration,
            timestamp: new Date().toISOString(),
            details: result
        });

        logger.info(`Test ${runId} completed successfully`);

    } catch (error) {
        logger.error(`Test ${runId} failed:`, error);
        updateTestStatus(deviceId, runId, 'failed', error.message);
        
        // Add to history as failure
        recordHistoryEntry(deviceId, {
            runId,
            testId: test.id || test.name,
            name: test.name,
            result: 'fail',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    } finally {
        // Remove from running
        runningTests.get(deviceId)?.delete(runId);
    }
}

async function testModem(deviceId, runId, test, params) {
    const startTime = Date.now();
    const resultTimeout = Math.max(params.timeout || 25000, 35000);

    updateTestProgress(deviceId, runId, 10, 'Running modem self-test...');
    const resultsPromise = waitForDeviceSelfTestResults(deviceId, resultTimeout);
    await publishTestCommand(
        deviceId,
        runId,
        'run-device-test',
        {},
        true,
        15000,
        'run device self-test'
    );

    const deviceResults = await resultsPromise;
    updateTestProgress(deviceId, runId, 90, 'Self-test results received');

    const duration = (Date.now() - startTime) / 1000;
    const normalized = deviceResults.map(result => ({
        name: result.testName || result.testId,
        command: result.testId,
        response: result.details || result.result,
        success: result.result === 'pass',
        duration: result.duration || null
    }));

    return {
        steps: normalized,
        duration,
        summary: {
            total: normalized.length,
            passed: normalized.filter(r => r.success).length,
            failed: normalized.filter(r => !r.success).length
        }
    };
}

async function testSMS(deviceId, runId, test, params) {
    const startTime = Date.now();
    const timeoutMs = Math.max(10000, Number(test.timeout || 10000));
    let targetNumber = String(params.to || '').trim();
    const message = String(params.message || `Dashboard SMS test ${new Date().toISOString()}`).trim();

    updateTestProgress(deviceId, runId, 15, 'Requesting live device status...');
    const statusResponse = await publishTestCommand(
        deviceId,
        runId,
        'get-status',
        {},
        true,
        timeoutMs,
        'request device status',
        {
            source: 'dashboard-test-sms'
        }
    );

    const nestedStatusPayload = statusResponse?.payload && typeof statusResponse.payload === 'object'
        ? statusResponse.payload
        : (statusResponse?.data && typeof statusResponse.data === 'object' ? statusResponse.data : null);
    const statusPayload = nestedStatusPayload && Object.keys(nestedStatusPayload).length
        ? nestedStatusPayload
        : ((statusResponse && typeof statusResponse === 'object') ? statusResponse : {});

    const readiness = {
        telephonySupported: Boolean(statusPayload.telephony_supported),
        telephonyEnabled: Boolean(statusPayload.telephony_enabled),
        modemRegistered: Boolean(statusPayload.modem_registered),
        mqttConnected: Boolean(statusPayload.mqtt_connected),
        smsReady: typeof statusPayload.sms_ready === 'boolean' ? statusPayload.sms_ready : null,
        smsSentCount: Number(statusPayload.sms_sent_count || 0),
        smsReceivedCount: Number(statusPayload.sms_received_count || 0),
        smsFailureCount: Number(statusPayload.sms_failure_count || 0),
        smsLastDetail: statusPayload.sms_last_detail || null,
        smsLastDestination: statusPayload.sms_last_destination || null
    };

    if (!targetNumber) {
        targetNumber = String(
            statusPayload.modem_subscriber_number ||
            statusPayload.subscriber_number ||
            statusPayload.sim_number ||
            ''
        ).trim();
        if (targetNumber) {
            readiness.selfTestNumber = targetNumber;
        }
    }

    updateTestProgress(deviceId, runId, 55, 'Evaluating SMS readiness...');

    let sendResult = null;
    if (targetNumber) {
        const resolvedSms = resolveSmsCommand(message);
        updateTestProgress(deviceId, runId, 75, `Sending ${resolvedSms.analysis.encoding === 'unicode' ? 'Unicode' : 'GSM'} SMS to ${targetNumber}...`);
        sendResult = await publishTestCommand(
            deviceId,
            runId,
            resolvedSms.command,
            {
                to: targetNumber,
                message,
                timeout: resolvedSms.timeoutMs,
                ...(resolvedSms.metadata || {})
            },
            true,
            resolvedSms.timeoutMs || 60000,
            'send test sms'
        );
    }

    updateTestProgress(deviceId, runId, 100, targetNumber ? 'SMS send completed' : 'SMS readiness completed');

    return {
        duration: (Date.now() - startTime) / 1000,
        readiness,
        liveSendAttempted: Boolean(targetNumber),
        sendResult,
        success: readiness.telephonySupported &&
            readiness.telephonyEnabled &&
            readiness.modemRegistered &&
            readiness.mqttConnected &&
            (targetNumber ? Boolean(sendResult?.success !== false) : true)
    };
}

async function testLED(deviceId, runId, test, params) {
    const pin = params.pin || 2;
    const duration = params.duration || 1000;
    const pattern = params.pattern || 'blink';

    updateTestProgress(deviceId, runId, 20, 'Configuring pin...');

    // Configure pin as output
    await publishTestCommand(
        deviceId,
        runId,
        'gpio-mode',
        { pin, mode: 'output' },
        true,
        5000,
        'configure output pin'
    );

    const results = [];
    const startTime = Date.now();

    if (pattern === 'blink') {
        // Blink pattern
        for (let i = 0; i < 3; i++) {
            updateTestProgress(deviceId, runId, 30 + (i * 20), `Blink ${i+1}/3`);
            
            await publishTestCommand(
                deviceId,
                runId,
                'gpio-write',
                { pin, value: 1 },
                true,
                2000,
                `blink ${i + 1} high`
            );
            await sleep(duration / 3);
            
            await publishTestCommand(
                deviceId,
                runId,
                'gpio-write',
                { pin, value: 0 },
                true,
                2000,
                `blink ${i + 1} low`
            );
            await sleep(duration / 3);
            
            results.push({ cycle: i+1, success: true });
        }
    } else if (pattern === 'pulse') {
        // PWM pulse
        updateTestProgress(deviceId, runId, 50, 'Generating PWM pulse');
        
        await publishTestCommand(
            deviceId,
            runId,
            'gpio-write',
            { pin, value: 128, type: 'pwm' },
            true,
            5000,
            'start pwm pulse'
        );
        await sleep(duration);
        
        await publishTestCommand(
            deviceId,
            runId,
            'gpio-write',
            { pin, value: 0, type: 'pwm' },
            true,
            5000,
            'stop pwm pulse'
        );
    } else {
        // Solid on
        updateTestProgress(deviceId, runId, 50, 'Turning LED on');
        
        await publishTestCommand(
            deviceId,
            runId,
            'gpio-write',
            { pin, value: 1 },
            true,
            5000,
            'turn led on'
        );
        await sleep(duration);
        
        await publishTestCommand(
            deviceId,
            runId,
            'gpio-write',
            { pin, value: 0 },
            true,
            5000,
            'turn led off'
        );
    }

    updateTestProgress(deviceId, runId, 100, 'Test completed');

    return {
        pin,
        pattern,
        duration,
        cycles: results.length,
        success: true
    };
}

async function testButton(deviceId, runId, test, params) {
    const pin = params.pin || 0;
    const pull = params.pull || 'up';

    updateTestProgress(deviceId, runId, 20, `Configuring pin ${pin} as input...`);

    // Configure pin as input
    const mode = pull === 'up' ? 'input_pullup' : pull === 'down' ? 'input_pulldown' : 'input';
    await publishTestCommand(
        deviceId,
        runId,
        'gpio-mode',
        { pin, mode },
        true,
        5000,
        'configure button input'
    );

    updateTestProgress(deviceId, runId, 40, 'Waiting for button press...');

    // Monitor for button presses
    const presses = [];
    const startTime = Date.now();
    let lastValue = null;
    
    while (Date.now() - startTime < 30000) { // 30 second timeout
        const response = await publishTestCommand(
            deviceId,
            runId,
            'gpio-read',
            { pin },
            true,
            2000,
            'read button state'
        );

        const value = response?.value;
        
        if (lastValue !== null && value !== lastValue) {
            presses.push({
                time: new Date().toISOString(),
                value
            });
            
            updateTestProgress(deviceId, runId, 40 + (presses.length * 10), `Press detected! (${presses.length})`);
        }
        
        lastValue = value;
        await sleep(100);
    }

    updateTestProgress(deviceId, runId, 100, 'Test completed');

    return {
        pin,
        pull,
        presses: presses.length,
        pattern: presses,
        success: presses.length > 0
    };
}

async function testMicrophone(deviceId, runId, test, params) {
    const duration = params.duration || 3;
    const sensitivity = params.sensitivity || 50;

    updateTestProgress(deviceId, runId, 20, 'Initializing microphone...');

    const samples = [];
    const startTime = Date.now();
    
    updateTestProgress(deviceId, runId, 40, `Recording for ${duration} seconds...`);

    // Record audio samples
    while (Date.now() - startTime < duration * 1000) {
        const response = await publishTestCommand(
            deviceId,
            runId,
            'test-microphone',
            { duration: 100 }, // 100ms samples
            true,
            2000,
            'capture microphone sample'
        );

        if (response?.samples) {
            samples.push(...response.samples);
        }

        updateTestProgress(deviceId, runId, 40 + (Math.min(90, ((Date.now() - startTime) / (duration * 1000)) * 50)));
    }

    // Analyze samples
    const maxLevel = Math.max(...samples);
    const avgLevel = samples.reduce((a, b) => a + b, 0) / samples.length;
    const noiseFloor = samples.sort((a, b) => a - b)[Math.floor(samples.length * 0.1)];

    updateTestProgress(deviceId, runId, 100, 'Analysis complete');

    return {
        samples: samples.length,
        maxLevel,
        avgLevel,
        noiseFloor,
        signalToNoise: maxLevel - noiseFloor,
        success: maxLevel > sensitivity * 2.55 // Convert 0-100 to 0-255
    };
}

async function testSpeaker(deviceId, runId, test, params) {
    const frequency = params.frequency || 440;
    const duration = params.duration || 1000;
    const volume = params.volume || 50;

    updateTestProgress(deviceId, runId, 30, `Playing ${frequency}Hz tone...`);

    await publishTestCommand(
        deviceId,
        runId,
        'test-speaker',
        {
            frequency,
            duration,
            volume: volume / 100
        },
        true,
        duration + 2000,
        'play speaker tone'
    );

    updateTestProgress(deviceId, runId, 70, 'Tone completed');

    // Verify with microphone if available
    if (global.mqttService) {
        const response = await publishTestCommand(
            deviceId,
            runId,
            'test-microphone',
            { duration: 1 },
            true,
            3000,
            'verify tone with microphone'
        );

        updateTestProgress(deviceId, runId, 90, 'Verifying output...');

        return {
            frequency,
            duration,
            volume,
            detected: response?.detected || false,
            success: true
        };
    }

    return {
        frequency,
        duration,
        volume,
        success: true
    };
}

async function testCamera(deviceId, runId, test, params) {
    const resolution = params.resolution || 'VGA';
    const format = params.format || 'JPEG';

    updateTestProgress(deviceId, runId, 20, 'Initializing camera...');

    // Configure camera
    await publishTestCommand(
        deviceId,
        runId,
        'camera-config',
        { resolution, format },
        true,
        5000,
        'configure camera'
    );

    updateTestProgress(deviceId, runId, 50, 'Capturing image...');

    // Capture image
    const response = await publishTestCommand(
        deviceId,
        runId,
        'camera-capture',
        {},
        true,
        10000,
        'capture image'
    );

    updateTestProgress(deviceId, runId, 80, 'Saving image...');

    // Save image if received
    if (response?.image) {
        const filename = `test_${Date.now()}.jpg`;
        const filepath = path.join(__dirname, '../public/uploads/test', filename);
        
        // Ensure directory exists
        const dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Save image
        const imageBuffer = Buffer.from(response.image, 'base64');
        fs.writeFileSync(filepath, imageBuffer);

        updateTestProgress(deviceId, runId, 100, 'Image saved');

        return {
            resolution,
            format,
            size: imageBuffer.length,
            filename,
            url: `/uploads/test/${filename}`,
            success: true
        };
    }

    return {
        resolution,
        format,
        success: false,
        error: 'No image received'
    };
}

async function testGPS(deviceId, runId, test, params) {
    const timeout = params.timeout || 60;

    updateTestProgress(deviceId, runId, 20, 'Waiting for GPS fix...');

    const startTime = Date.now();
    let fix = false;
    let satellites = 0;
    let location = null;

    try {
        await publishTestCommand(
            deviceId,
            runId,
            'gps-set-enabled',
            { enabled: true },
            true,
            10000,
            'enable gps'
        );
    } catch (error) {
        appendTestTrace(deviceId, runId, 'warning', 'enable gps: device responded with error', { error: error.message });
    }

    while (Date.now() - startTime < timeout * 1000) {
        const gpsPromise = waitForMqttEvent(
            'gps:location',
            deviceId,
            7000,
            data => (data?.lat ?? data?.latitude ?? data?.lng ?? data?.longitude) !== undefined
        );
        await publishTestCommand(
            deviceId,
            runId,
            'gps-location',
            {},
            false,
            5000,
            'request gps fix'
        );

        let response = null;
        try {
            response = await gpsPromise;
        } catch (_) {
            response = null;
        }

        if (response) {
            fix = true;
            satellites = response.satellites || 0;
            location = {
                lat: response.lat ?? response.latitude,
                lng: response.lng ?? response.longitude ?? response.lon,
                alt: response.alt,
                speed: response.speed
            };
            break;
        }

        updateTestProgress(deviceId, runId, 20 + (Math.min(80, ((Date.now() - startTime) / (timeout * 1000)) * 80)));
        await sleep(1000);
    }

    updateTestProgress(deviceId, runId, 100, fix ? 'GPS fix obtained' : 'No GPS fix');

    return {
        fix,
        satellites,
        location,
        timeToFix: fix ? (Date.now() - startTime) / 1000 : null,
        success: fix
    };
}

async function testSDCard(deviceId, runId, test, params) {
    const testFile = params.testFile || 'test.txt';
    const testSize = params.testSize || 1024;
    const testPath = `/${String(testFile).replace(/^\/+/, '')}`;

    updateTestProgress(deviceId, runId, 20, 'Checking SD card...');

    // Check SD card
    const info = await requestStorageInfo(deviceId, runId, 5000, 'read storage info');

    if (!info?.mounted) {
        throw new Error('SD card not mounted');
    }

    updateTestProgress(deviceId, runId, 40, 'Writing test file...');

    // Write test data
    const testData = Buffer.alloc(testSize, 'A').toString('utf8');
    const writeResult = await publishTestCommand(
        deviceId,
        runId,
        'storage-write',
        {
            path: testPath,
            data: testData,
            append: false
        },
        true,
        10000,
        'write sd card file'
    );

    if (!writeResult?.success) {
        throw new Error('Write failed');
    }

    updateTestProgress(deviceId, runId, 70, 'Reading test file...');

    // Read back
    const readResult = await publishTestCommand(
        deviceId,
        runId,
        'storage-read',
        { path: testPath },
        true,
        10000,
        'read sd card file'
    );

    updateTestProgress(deviceId, runId, 90, 'Verifying data...');

    // Verify
    const dataMatch = readResult?.encoding === 'base64'
        && Buffer.from(readResult.data || '', 'base64').toString('utf8') === testData;

    updateTestProgress(deviceId, runId, 100, 'Cleanup...');

    // Cleanup
    await publishTestCommand(
        deviceId,
        runId,
        'storage-delete',
        { path: testPath },
        true,
        5000,
        'delete sd card file'
    );

    return {
        mounted: true,
        total: info.total,
        used: info.used,
        free: info.free,
        testFile,
        testSize,
        writeSuccess: true,
        readSuccess: true,
        dataMatch,
        success: dataMatch
    };
}

async function testStorageBenchmark(deviceId, runId, test, params) {
    const testSize = Math.max(1024, Math.min(131072, Number(params.testSize || 8192)));
    const iterations = Math.max(1, Math.min(10, Number(params.iterations || 3)));
    const baseName = `benchmark-${Date.now()}.txt`;
    const payload = 'B'.repeat(testSize);
    const writeDurations = [];
    const readDurations = [];

    updateTestProgress(deviceId, runId, 10, 'Checking storage mount...');
    const info = await requestStorageInfo(deviceId, runId, 5000, 'read storage info');

    if (!info?.mounted) {
        throw new Error(info?.lastError || info?.message || 'SD card not mounted');
    }

    for (let i = 0; i < iterations; i++) {
        const filePath = `/${baseName}-${i}`;
        updateTestProgress(deviceId, runId, 15 + Math.round((i / iterations) * 70), `Benchmark iteration ${i + 1}/${iterations} writing...`);

        const writeStart = Date.now();
        await publishTestCommand(
            deviceId,
            runId,
            'storage-write',
            { path: filePath, data: payload, append: false },
            true,
            30000,
            `benchmark write ${i + 1}`
        );
        const writeMs = Date.now() - writeStart;
        writeDurations.push(writeMs);

        const readStart = Date.now();
        const readResult = await publishTestCommand(
            deviceId,
            runId,
            'storage-read',
            { path: filePath, maxBytes: testSize },
            true,
            30000,
            `benchmark read ${i + 1}`
        );
        const readMs = Date.now() - readStart;
        readDurations.push(readMs);

        const roundTrip = Buffer.from(readResult?.data || '', 'base64').toString('utf8');
        if (roundTrip !== payload) {
            throw new Error(`Benchmark readback mismatch on iteration ${i + 1}`);
        }

        await publishTestCommand(
            deviceId,
            runId,
            'storage-delete',
            { path: filePath },
            true,
            10000,
            `benchmark cleanup ${i + 1}`
        );
    }

    updateTestProgress(deviceId, runId, 100, 'Benchmark complete');

    const avgWriteMs = writeDurations.reduce((sum, value) => sum + value, 0) / writeDurations.length;
    const avgReadMs = readDurations.reduce((sum, value) => sum + value, 0) / readDurations.length;
    const bytesPerSecond = (size, ms) => ms > 0 ? Math.round((size / ms) * 1000) : 0;

    return {
        testSize,
        iterations,
        avgWriteMs: Math.round(avgWriteMs),
        avgReadMs: Math.round(avgReadMs),
        avgWriteSpeedBytesPerSec: bytesPerSecond(testSize, avgWriteMs),
        avgReadSpeedBytesPerSec: bytesPerSecond(testSize, avgReadMs),
        writeSamplesMs: writeDurations,
        readSamplesMs: readDurations,
        success: true
    };
}

async function testStorageDiagnostics(deviceId, runId) {
    updateTestProgress(deviceId, runId, 20, 'Reading storage diagnostics...');
    const info = await requestStorageInfo(deviceId, runId, 5000, 'read storage diagnostics');

    updateTestProgress(deviceId, runId, 100, 'Diagnostics complete');

    return {
        cardDetected: Boolean(info?.cardDetected ?? info?.mounted),
        mounted: Boolean(info?.mounted),
        filesystem: info?.filesystem || null,
        type: info?.type || null,
        cardType: info?.cardType || null,
        total: info?.total || 0,
        used: info?.used || 0,
        free: info?.free || 0,
        bus: info?.bus || null,
        pins: info?.pins || null,
        lastError: info?.lastError || null,
        success: Boolean(info?.mounted)
    };
}

async function testWiFi(deviceId, runId, test, params) {
    const { ssid, password, timeout = 30 } = params;

    if (!ssid) {
        throw new Error('SSID required');
    }

    updateTestProgress(deviceId, runId, 20, 'Scanning networks...');

    // Scan networks
    const scanResult = await publishTestCommand(
        deviceId,
        runId,
        'wifi-scan',
        {},
        true,
        10000,
        'scan wifi networks'
    );

    const network = scanResult?.networks?.find(n => n.ssid === ssid);
    
    updateTestProgress(deviceId, runId, 40, network ? 'Network found' : 'Network not found');

    if (!network) {
        return {
            ssid,
            found: false,
            success: false,
            error: 'Network not found'
        };
    }

    updateTestProgress(deviceId, runId, 60, 'Connecting...');

    // Connect
    const connectResult = await publishTestCommand(
        deviceId,
        runId,
        'wifi-connect',
        { ssid, password },
        true,
        timeout * 1000,
        'connect wifi network'
    );

    updateTestProgress(deviceId, runId, 80, 'Getting IP...');

    // Get connection info
    const status = await publishTestCommand(
        deviceId,
        runId,
        'wifi-status',
        {},
        true,
        5000,
        'read wifi status'
    );

    updateTestProgress(deviceId, runId, 100, 'Test completed');

    return {
        ssid,
        found: true,
        signal: network.signal,
        security: network.security,
        connected: connectResult?.connected || false,
        ip: status?.ip,
        success: connectResult?.connected || false
    };
}

async function testBattery(deviceId, runId, test, params) {
    const results = [];

    updateTestProgress(deviceId, runId, 20, 'Reading battery status...');

    for (let i = 0; i < 5; i++) {
        const response = await publishTestCommand(
            deviceId,
            runId,
            'battery-status',
            {},
            true,
            5000,
            'read battery status'
        );

        if (response) {
            results.push({
                voltage: response.voltage,
                percentage: response.percentage,
                charging: response.charging,
                current: response.current
            });
        }

        updateTestProgress(deviceId, runId, 20 + (i * 15));
        await sleep(500);
    }

    // Calculate averages
    const avgVoltage = results.reduce((sum, r) => sum + r.voltage, 0) / results.length;
    const avgPercentage = results.reduce((sum, r) => sum + r.percentage, 0) / results.length;
    const charging = results.some(r => r.charging);

    updateTestProgress(deviceId, runId, 100, 'Analysis complete');

    return {
        samples: results.length,
        voltage: avgVoltage.toFixed(2),
        percentage: Math.round(avgPercentage),
        charging,
        minVoltage: Math.min(...results.map(r => r.voltage)).toFixed(2),
        maxVoltage: Math.max(...results.map(r => r.voltage)).toFixed(2),
        success: avgVoltage > 3.0 // Battery voltage above 3.0V is good
    };
}

async function testGPIOLoopback(deviceId, runId, test, params) {
    const outputPin = params.outputPin || 2;
    const inputPin = params.inputPin || 4;
    const pattern = params.testPattern || '0101';

    updateTestProgress(deviceId, runId, 20, 'Configuring pins...');

    // Configure pins
    await publishTestCommand(
        deviceId,
        runId,
        'gpio-mode',
        { pin: outputPin, mode: 'output' },
        true,
        5000,
        'configure loopback output pin'
    );

    await publishTestCommand(
        deviceId,
        runId,
        'gpio-mode',
        { pin: inputPin, mode: 'input' },
        true,
        5000,
        'configure loopback input pin'
    );

    const results = [];
    const patternArray = pattern === '0101' ? [0,1,0,1] :
                         pattern === '1010' ? [1,0,1,0] :
                         [0,1,1,0]; // pulse

    updateTestProgress(deviceId, runId, 40, 'Running loopback test...');

    for (let i = 0; i < patternArray.length; i++) {
        const value = patternArray[i];
        
        // Write
        await publishTestCommand(
            deviceId,
            runId,
            'gpio-write',
            { pin: outputPin, value },
            true,
            2000,
            `loopback write step ${i + 1}`
        );

        await sleep(100); // Wait for signal to settle

        // Read
        const response = await publishTestCommand(
            deviceId,
            runId,
            'gpio-read',
            { pin: inputPin },
            true,
            2000,
            `loopback read step ${i + 1}`
        );

        const readValue = response?.value;
        const success = readValue === value;

        results.push({
            step: i + 1,
            output: value,
            input: readValue,
            success
        });

        updateTestProgress(deviceId, runId, 40 + (i * 12));
    }

    updateTestProgress(deviceId, runId, 100, 'Test completed');

    return {
        outputPin,
        inputPin,
        pattern,
        steps: results,
        success: results.every(r => r.success)
    };
}

async function testFullSystem(deviceId, runId, test, params, supportContext = { caps: {} }) {
    const results = {};
    updateTestProgress(deviceId, runId, 5, 'Starting comprehensive test...');

    const suite = [
        { id: 'modem', label: 'Testing modem...', runner: () => testModem(deviceId, `${runId}_modem`, AVAILABLE_TESTS.modem, {}) },
        { id: 'battery', label: 'Testing battery...', runner: () => testBattery(deviceId, `${runId}_battery`, AVAILABLE_TESTS.battery, {}) },
        { id: 'sdCard', label: 'Testing SD card...', runner: () => testSDCard(deviceId, `${runId}_sd`, AVAILABLE_TESTS.sdCard, {}) },
        { id: 'gps', label: 'Testing GPS...', runner: () => testGPS(deviceId, `${runId}_gps`, AVAILABLE_TESTS.gps, { timeout: 30 }) },
        { id: 'camera', label: 'Testing camera...', runner: () => testCamera(deviceId, `${runId}_camera`, AVAILABLE_TESTS.camera, {}) },
        { id: 'speaker', label: 'Testing speaker...', runner: () => testSpeaker(deviceId, `${runId}_speaker`, AVAILABLE_TESTS.speaker, {}) },
        { id: 'microphone', label: 'Testing microphone...', runner: () => testMicrophone(deviceId, `${runId}_mic`, AVAILABLE_TESTS.microphone, {}) },
        { id: 'gpioLoopback', label: 'Testing GPIO...', runner: () => testGPIOLoopback(deviceId, `${runId}_gpio`, AVAILABLE_TESTS.gpioLoopback, {}) }
    ];

    for (let index = 0; index < suite.length; index++) {
        const item = suite[index];
        const progress = 10 + Math.round((index / suite.length) * 80);
        const annotated = annotateTestDefinition(item.id, AVAILABLE_TESTS[item.id], supportContext.caps || {});
        updateTestProgress(deviceId, runId, progress, item.label);

        if (!annotated.supported) {
            appendTestTrace(deviceId, runId, 'warning', annotated.supportMessage, {
                missingCaps: annotated.missingCaps
            });
            results[item.id] = {
                skipped: true,
                success: null,
                missingCaps: annotated.missingCaps,
                message: annotated.supportMessage
            };
            continue;
        }

        try {
            results[item.id] = await item.runner();
        } catch (e) {
            results[item.id] = { success: false, error: e.message };
        }
    }

    updateTestProgress(deviceId, runId, 100, 'Test completed');

    // Calculate overall success
    const totalTests = Object.keys(results).length;
    const passedTests = Object.values(results).filter(r => r.success === true).length;
    const failedTests = Object.values(results).filter(r => r.success === false).length;
    const skippedTests = Object.values(results).filter(r => r.skipped).length;

    return {
        components: results,
        summary: {
            total: totalTests,
            passed: passedTests,
            failed: failedTests,
            skipped: skippedTests,
            success: failedTests === 0
        }
    };
}

async function runGenericTest(deviceId, runId, test, params) {
    // Generic test runner for simple command-based tests
    const results = [];
    const startTime = Date.now();

    if (test.steps) {
        for (let i = 0; i < test.steps.length; i++) {
            const step = test.steps[i];
            
            updateTestProgress(deviceId, runId, (i * 100 / test.steps.length), `Step ${i+1}: ${step.name}`);
            
            const response = await publishTestCommand(
                deviceId,
                runId,
                `test-${test.name.toLowerCase().replace(/\s+/g, '-')}`,
                step,
                true,
                test.timeout || 10000,
                step.name
            );

            results.push({
                step: step.name,
                response: response?.data,
                success: response?.success || false
            });
        }
    }

    const duration = (Date.now() - startTime) / 1000;

    return {
        steps: results,
        duration,
        success: results.every(r => r.success)
    };
}

// ==================== HELPER FUNCTIONS ====================

function appendTestTrace(deviceId, runId, level, message, data = null) {
    const timestamp = new Date().toISOString();
    const trace = { timestamp, level, message, data };
    const running = runningTests.get(deviceId)?.get(runId);
    const completed = testResults.get(deviceId)?.get(runId);

    if (running) {
        running.logs = running.logs || [];
        running.logs.push(trace);
        runningTests.get(deviceId).set(runId, running);
    } else if (completed) {
        completed.logs = completed.logs || [];
        completed.logs.push(trace);
        testResults.get(deviceId).set(runId, completed);
    }

    emitDeviceEvent(deviceId, 'test:trace', {
        deviceId,
        runId,
        ...trace
    });
}

async function publishTestCommand(
    deviceId,
    runId,
    commandTopic,
    payload,
    waitForResponse = true,
    timeoutMs = 5000,
    label = commandTopic,
    options = {}
) {
    appendTestTrace(deviceId, runId, 'info', `${label}: api accepted and send to mqtt`, {
        topic: commandTopic,
        payload
    });
    appendTestTrace(deviceId, runId, 'info', `${label}: delivered to device, waiting for response`);

    try {
        let response;
        if (String(commandTopic || '').trim() === 'get-status' && typeof global.mqttService?.requestStatus === 'function') {
            response = await global.mqttService.requestStatus(deviceId, {
                timeout: timeoutMs,
                force: true,
                source: options.source || 'dashboard-test',
                messageId: options.messageId,
                userId: options.userId,
                allowCompatibilitySnapshot: options.allowCompatibilitySnapshot === true
            });
        } else {
            response = await global.mqttService.publishCommand(
                deviceId,
                commandTopic,
                payload,
                waitForResponse,
                timeoutMs,
                {
                    ...options,
                    source: options.source || 'dashboard-test',
                    domain: options.domain || (String(commandTopic || '').trim() === 'get-status' ? 'status' : undefined),
                    bypassCompatibility: String(commandTopic || '').trim() === 'get-status'
                        ? (options.allowCompatibilitySnapshot === true ? false : true)
                        : options.bypassCompatibility
                }
            );
        }
        appendTestTrace(deviceId, runId, 'success', `${label}: device responded`, response);
        return response;
    } catch (error) {
        appendTestTrace(deviceId, runId, 'danger', `${label}: device error`, {
            topic: commandTopic,
            payload,
            error: error.message
        });
        throw error;
    }
}

async function requestStorageInfo(deviceId, runId, timeoutMs = 5000, label = 'read storage info') {
    const infoPromise = waitForMqttEvent(
        'storage:info',
        deviceId,
        timeoutMs,
        data => data && (typeof data.mounted === 'boolean' || typeof data.cardDetected === 'boolean' || typeof data.success === 'boolean')
    );
    await publishTestCommand(
        deviceId,
        runId,
        'storage-info',
        {},
        false,
        timeoutMs,
        label
    );
    const info = await infoPromise;
    appendTestTrace(deviceId, runId, 'success', `${label}: storage info event received`, info);
    return info;
}

function updateTestProgress(deviceId, runId, progress, message) {
    const running = runningTests.get(deviceId)?.get(runId);
    if (running) {
        running.progress = progress;
        running.message = message;
        runningTests.get(deviceId).set(runId, running);
        appendTestTrace(deviceId, runId, 'info', message, progress === null || progress === undefined ? null : { progress });
        
        // Emit progress via Socket.IO
        emitDeviceEvent(deviceId, 'test:progress', {
            deviceId,
            runId,
            progress,
            message
        });
    }
}

function updateTestStatus(deviceId, runId, status, message, details = null) {
    const endTime = new Date().toISOString();
    
    if (!testResults.has(deviceId)) {
        testResults.set(deviceId, new Map());
    }
    
    const running = runningTests.get(deviceId)?.get(runId);
    
    testResults.get(deviceId).set(runId, {
        ...running,
        status,
        message,
        details,
        logs: running?.logs || [],
        endTime,
        duration: running ? (new Date(endTime) - new Date(running.startTime)) / 1000 : null
    });
    appendTestTrace(deviceId, runId, status === 'failed' ? 'danger' : status === 'completed' ? 'success' : 'warning', message, details);

    // Emit via Socket.IO
    emitDeviceEvent(deviceId, 'test:status', {
        deviceId,
        runId,
        status,
        message,
        details
    });
}

function checkResponse(response, step) {
    if (step.expected) {
        return response?.includes(step.expected);
    }
    if (step.handler) {
        // Custom handler would be implemented here
        return true;
    }
    return !!response;
}

function getCategoryIcon(category) {
    const icons = {
        communication: 'bi-hdd-network',
        hardware: 'bi-motherboard',
        audio: 'bi-speaker',
        camera: 'bi-camera',
        gps: 'bi-geo-alt',
        storage: 'bi-hdd-stack',
        network: 'bi-wifi',
        power: 'bi-battery',
        gpio: 'bi-pin',
        system: 'bi-cpu'
    };
    return icons[category] || 'bi-gear';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = router;
