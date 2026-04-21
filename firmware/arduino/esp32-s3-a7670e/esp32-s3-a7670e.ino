/*
 * ESP32-S3-A7670E Dashboard Firmware
 * Board  : ESP32-S3-A7670E-4G
 * IDE    : Arduino IDE 2.x + esp32 by Espressif ≥ 3.0
 *
 * Libraries required (install via Library Manager):
 *   - ArduinoJson          by Benoit Blanchon  (≥ 7.x)
 *   - Adafruit NeoPixel    by Adafruit
 *   - Adafruit BusIO       by Adafruit         (NeoPixel dep)
 *   - SD                   (bundled with esp32 core ≥ 2.0)
 *
 * Optional:
 *   - Adafruit SSD1306     by Adafruit         (OLED display)
 *   - Adafruit GFX Lib     by Adafruit         (SSD1306 dep)
 *   - Define ENABLE_DISPLAY in your build flags to activate OLED support.
 *
 * Setup:
 *   1. Provision settings from dashboard onboarding / setup transport.
 *   2. Select board "ESP32S3 Dev Module" (or Waveshare variant) in Arduino IDE.
 *   3. Flash USB Mode switch (DIP SW2-4) to ESP32 side before uploading.
 *   4. After flashing, switch DIP SW2-3 (4G) ON to power the A7670E.
 *   5. Open Serial Monitor at 115200 baud.
 */

// Compile with:
//   arduino-cli compile \
//     --fqbn esp32:esp32:esp32s3:PSRAM=enabled,PartitionScheme=huge_app \
//     --library firmware/common \
//     firmware/esp32-s3-a7670e
//
// Then upload the generated .bin to the dashboard OTA manager and push to device.
// The dashboard does NOT compile — it stores and serves pre-built .bin files only.

#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WebServer.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <BLESecurity.h>
#include <esp_system.h>
#include "config.h"        // ← board-specific pin map (must come first)

#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "2.0.0"
#endif

#include <camera_service.h>

#include <nvs_config.h>    // common — NVS read/write
#include <runtime_defaults.h>
#include <setup_server.h>  // common — WiFi AP onboarding server
#include <led.h>           // common
#include <battery.h>       // common
#include <boot_state.h>    // common - startup diagnostics + runtime state
#include <modem.h>         // common
#include <gps.h>           // common
#include <mqtt_client.h>   // common
#include <work_queue.h>    // common - tiny central deferred work queue
#include <storage.h>       // common — SD card (SPI mode)
#include <device_logs.h>   // common — internal flash log ring (SPIFFS)
#include <touch.h>           // common — ESP32-S3 capacitive touch
#include <display.h>       // common — SSD1306 OLED (stub when ENABLE_DISPLAY unset)

// ── Direct HTTP server (same-network access via WiFi soft-AP) ─────────────────
static WebServer _directServer(80);

static void _directHandleStatus();  // forward declarations
static void _directHandleConfig();
static void _directHandleReboot();
static void _syncBootRuntimeState();
static void _runBootDiagnostics();
static void _publishWifiStatusChange();
static void _cmdPublishInternetStatusResponse(const char* msgId);
static void _refreshIdleLedState();
static bool _refreshSimIdentity(bool force = false);
static void _applyDeviceMode(bool refreshWifi = true);
static bool deviceSetMode(const char* modeName, bool persist, char* statusMsg, size_t statusMsgLen);
static const char* deviceModeName();
static void _setupBleSetEnabled(bool enabled);
static void _setupBleTick();
static bool _handleSetupTransportLine(const char* line, bool fromBle);
static void _publishUssdResponseLine(const char* line);
static void _queueCallStatusEvent(const char* status, const char* number, int duration = -1);
static const char* _currentCallNumber();
static void _setCurrentCallNumber(const char* number);
static void callBeginProgressTracking(const char* direction, const char* number);
static void callStopProgressTracking();
static void _scheduleFwWork(FwWorkType type, unsigned long delayMs = 0, const char* messageId = nullptr);
static void _processFwWorkQueue(unsigned long now, int maxItems, bool commandQuiet);

#include <commands.h>      // common — must come after WebServer so WiFi.h is already included

// ── Active device config (loaded from NVS) ──────────
#ifndef SET_LOOP_TASK_STACK_SIZE
#define SET_LOOP_TASK_STACK_SIZE(sz)
#endif
SET_LOOP_TASK_STACK_SIZE(16 * 1024);

static DeviceConfig _cfg = {};

enum {
    DEVICE_MODE_NORMAL = 0,
    DEVICE_MODE_LOW_POWER,
    DEVICE_MODE_HOTSPOT,
    DEVICE_MODE_DIAGNOSTIC,
    DEVICE_MODE_SILENT
};

static int _deviceMode = DEVICE_MODE_NORMAL;

// Setup transports: shared JSON protocol over BLE + USB serial
#define SETUP_BLE_SERVICE_UUID "6e400001-b5b4-f393-e0a9-e50e24dcca9e"
#define SETUP_BLE_TX_UUID      "6e400002-b5b4-f393-e0a9-e50e24dcca9e"  // browser writes here
#define SETUP_BLE_RX_UUID      "6e400003-b5b4-f393-e0a9-e50e24dcca9e"  // browser listens here
#define SETUP_LINE_BUF_SIZE    512

static BLEServer*         _setupBleServer = nullptr;
static BLECharacteristic* _setupBleTxChar = nullptr;
static BLECharacteristic* _setupBleRxChar = nullptr;
static bool               _setupBleInitialized = false;
static bool               _setupBleAdvertisingActive = false;
static bool               _setupBleAdvertisingWanted = false;
static bool               _setupBleClientConnected = false;
static bool               _setupRebootPending = false;
static unsigned long      _setupRebootAt = 0;
static uint32_t           _setupBlePasskey = 0;
static char               _setupBleName[32] = "";
static char               _setupBleLineBuf[SETUP_LINE_BUF_SIZE] = "";
static size_t             _setupBleLinePos = 0;
static char               _directApPassword[16] = "";

// ── Factory reset detection ───────────────────────────────────────────────────
// Hold BOOT button (GPIO0) for 5 s at startup to wipe NVS and re-enter setup mode.
#define BOOT_PIN 0
static void checkFactoryReset() {
    pinMode(BOOT_PIN, INPUT_PULLUP);
    if (digitalRead(BOOT_PIN) == HIGH) return;  // not held

    Serial.println("[RESET] BOOT button held — hold 5s for factory reset...");
    ledSetState(LED_FACTORY_RESET);
    unsigned long t0 = millis();
    while (digitalRead(BOOT_PIN) == LOW) {
        if (millis() - t0 >= 5000) {
            Serial.println("[RESET] Factory reset! Erasing NVS config...");
            ledSetState(LED_FACTORY_RESET);
            delay(500);
            nvsConfigErase();
            Serial.println("[RESET] Done — rebooting into setup mode.");
            delay(500);
            ESP.restart();
        }
        ledTick();
        delay(50);
    }
    Serial.println("[RESET] Button released early — continuing normal boot.");
}

// ── Timers ────────────────────────────────────────────────────────────────────
static unsigned long _lastStatus     = 0;
static unsigned long _lastGps        = 0;
static unsigned long _lastSignal     = 0;
static unsigned long _lastHeartbeat  = 0;
static unsigned long _lastGpioStatus = 0;
static unsigned long _lastBatTick  = 0;
static unsigned long _lastDisplay    = 0;
static unsigned long _lastRecovery   = 0;
static unsigned long _lastMqttConnect = 0;
static bool _mqttNeedsStatusPublish = false;
#define HEARTBEAT_INTERVAL_MS    60000   // keep-alive ping every 1 min
#define GPIO_STATUS_INTERVAL_MS  60000   // periodic GPIO snapshot every 1 min
#define BAT_TICK_INTERVAL_MS      5000   // voltage trend sample for charging detection
#define DISPLAY_UPDATE_MS         5000   // refresh OLED every 5 s
#define MODEM_RECOVERY_MS        15000   // retry modem/network recovery every 15 s
static unsigned long _statusIntervalMs = STATUS_INTERVAL_MS;
static unsigned long _heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
static unsigned long _gpioStatusIntervalMs = GPIO_STATUS_INTERVAL_MS;
static unsigned long _displayUpdateIntervalMs = DISPLAY_UPDATE_MS;
static unsigned long _modemRecoveryIntervalMs = MODEM_RECOVERY_MS;

// ── Live state ────────────────────────────────────────────────────────────────
static int    _rssi           = 99;  // 0–31 or 99 = unknown
static char   _operator[32]   = "";
static char   _ipAddr[32]     = "";
static char   _imei[24]       = "";
static char   _simNumber[32]  = "";
static char   _simMcc[8]      = "";
static unsigned long _lastSimIdentityRefreshMs = 0;
static bool   _inCall         = false;
static char   _callNumber[32] = "";
static char   _callDirection[16] = "";
static char   _lastCallStatus[24] = "";
static char   _lastCallStatusNumber[32] = "";
static unsigned long _callStartMs = 0;  // millis() when call connected
static unsigned long _lastCallProgressPollMs = 0;
static bool   _callProgressPollActive = false;
static bool   _callDataSessionSuspended = false;
static bool   _modemConfigured = false;
static bool   _networkReady    = false;
static char   _statusTopicBuf[TOPIC_BUF_SIZE] = "";
static char   _statusPayloadBuf[JSON_BUF_SIZE] = "";
static char   _heartbeatTopicBuf[TOPIC_BUF_SIZE] = "";
static char   _heartbeatPayloadBuf[80] = "";
static char   _gpsTopicBuf[TOPIC_BUF_SIZE] = "";
static char   _gpsPayloadBuf[JSON_BUF_SIZE] = "";
static char   _gpsStatusTopicBuf[TOPIC_BUF_SIZE] = "";
static char   _gpsStatusPayloadBuf[JSON_BUF_SIZE] = "";
static char   _capabilitiesTopicBuf[TOPIC_BUF_SIZE] = "";
static char   _capabilitiesPayloadBuf[JSON_BUF_SIZE] = "";
static char   _wifiStatusTopicBuf[TOPIC_BUF_SIZE] = "";
static char   _wifiStatusPayloadBuf[JSON_BUF_SIZE] = "";
static char   _internetStatusTopicBuf[TOPIC_BUF_SIZE] = "";
static char   _internetStatusPayloadBuf[JSON_BUF_SIZE] = "";
static char   _loopUrcLines[URC_LINE_MAX][URC_LEN_MAX];
static bool   _gpsHasFix = false;
static int    _gpsSatellites = 0;
static float  _gpsHdop = 0.0f;
static char   _gpsLastFixIso[32] = "";
static unsigned long _gpsLastFixMs = 0;
static unsigned long _gpsPowerOnMs = 0;
static unsigned long _gpsUpdateIntervalMs = GPS_INTERVAL_MS;
static unsigned long _gpsMinFixTimeMs = 30000;
static bool   _gpsPowerSaveMode = false;
static bool   _sdInitFailed = false;
static esp_reset_reason_t _lastResetReason = ESP_RST_UNKNOWN;
static char   _lastResetReasonText[24] = "UNKNOWN";

// Pending incoming SMS (multi-line: +CMT header then body)
// 64 bytes: enough room for a typical E.164 phone number encoded in UCS-2 hex
static char   _pendingSmsFrom[64] = "";
static bool   _smtHeaderPending   = false;

struct DeferredEvent;

enum DeferredEventType {
    DEFER_SMS_READ,
    DEFER_SMS_PUBLISH,
    DEFER_SMS_DELIVERY_READ,
    DEFER_SMS_DELIVERY_PUBLISH,
    DEFER_CALL_STATUS
};

struct DeferredEvent {
    DeferredEventType type;
    int value;
    unsigned long queuedAt;
    char a[96];
    char b[512];
};

static const unsigned long DEFERRED_EVENT_TTL_MS = 180000UL;

static const char* _resetReasonToString(esp_reset_reason_t reason) {
    switch (reason) {
        case ESP_RST_UNKNOWN:   return "unknown";
        case ESP_RST_POWERON:   return "poweron";
        case ESP_RST_EXT:       return "external";
        case ESP_RST_SW:        return "software";
        case ESP_RST_PANIC:     return "panic";
        case ESP_RST_INT_WDT:   return "int_wdt";
        case ESP_RST_TASK_WDT:  return "task_wdt";
        case ESP_RST_WDT:       return "wdt";
        case ESP_RST_DEEPSLEEP: return "deepsleep";
        case ESP_RST_BROWNOUT:  return "brownout";
        case ESP_RST_SDIO:      return "sdio";
        case ESP_RST_USB:       return "usb";
        case ESP_RST_JTAG:      return "jtag";
        case ESP_RST_EFUSE:     return "efuse";
        case ESP_RST_PWR_GLITCH:return "power_glitch";
        case ESP_RST_CPU_LOCKUP:return "cpu_lockup";
        default:                return "other";
    }
}

static void _captureResetReason() {
    _lastResetReason = esp_reset_reason();
    snprintf(_lastResetReasonText, sizeof(_lastResetReasonText), "%s", _resetReasonToString(_lastResetReason));
}

static void _copyDigitsWithPlus(const char* src, char* dst, size_t dstLen) {
    if (!dst || dstLen == 0) return;
    size_t pos = 0;
    bool allowPlus = true;
    for (const char* p = src; p && *p; ++p) {
        if (allowPlus && *p == '+') {
            if (pos < dstLen - 1) dst[pos++] = *p;
            allowPlus = false;
            continue;
        }
        allowPlus = false;
        if (*p >= '0' && *p <= '9') {
            if (pos < dstLen - 1) dst[pos++] = *p;
        }
    }
    dst[pos] = '\0';
}

static void _extractQuotedSimNumber(const char* line, char* out, size_t outLen) {
    if (!out || outLen == 0) return;
    out[0] = '\0';
    if (!line || !line[0]) return;

    const char* p = line;
    while ((p = strchr(p, '"')) != nullptr) {
        const char* q = strchr(p + 1, '"');
        if (!q) break;
        char candidate[32] = {};
        size_t len = (size_t)(q - (p + 1));
        if (len >= sizeof(candidate)) len = sizeof(candidate) - 1;
        strncpy(candidate, p + 1, len);
        candidate[len] = '\0';
        _copyDigitsWithPlus(candidate, out, outLen);
        if (out[0]) return;
        p = q + 1;
    }

    _copyDigitsWithPlus(line, out, outLen);
}

static bool _refreshSimIdentity(bool force) {
    const unsigned long refreshIntervalMs = 3600000UL;
    if (atBusIsLocked() || _inCall || _callDataSessionSuspended) {
        return _simNumber[0] || _simMcc[0];
    }
    if (!force && _lastSimIdentityRefreshMs && (millis() - _lastSimIdentityRefreshMs) < refreshIntervalMs) {
        return _simNumber[0] || _simMcc[0];
    }

    _lastSimIdentityRefreshMs = millis();

    char imsi[32] = {};
    if (atCmdResp("AT+CIMI", imsi, sizeof(imsi), 5000) && imsi[0] >= '0' && imsi[0] <= '9') {
        strncpy(_simMcc, imsi, 3);
        _simMcc[3] = '\0';
    } else {
        _simMcc[0] = '\0';
    }

    char cnum[128] = {};
    if (atCmdResp("AT+CNUM", cnum, sizeof(cnum), 5000)) {
        _extractQuotedSimNumber(cnum, _simNumber, sizeof(_simNumber));
    } else {
        _simNumber[0] = '\0';
    }

    return _simNumber[0] || _simMcc[0];
}

static bool _deferredEventQueueIsEmpty();
static bool _deferredEventQueuePush(const DeferredEvent& event);
static bool _deferredEventQueuePeek(DeferredEvent& out);
static void _deferredEventQueuePop();

#define DEFERRED_EVENT_QUEUE_MAX 24
static DeferredEvent _deferredEvents[DEFERRED_EVENT_QUEUE_MAX];
static int _deferredEventHead = 0;
static int _deferredEventTail = 0;

static bool _deferredEventQueueIsEmpty() {
    return _deferredEventHead == _deferredEventTail;
}

static const char* _deferredEventTypeName(int type) {
    switch (type) {
        case DEFER_SMS_READ: return "sms-read";
        case DEFER_SMS_PUBLISH: return "sms-publish";
        case DEFER_SMS_DELIVERY_READ: return "sms-dr-read";
        case DEFER_SMS_DELIVERY_PUBLISH: return "sms-dr-publish";
        case DEFER_CALL_STATUS: return "call-status";
        default: return "unknown";
    }
}

static int _deferredEventQueueDepth() {
    int depth = _deferredEventTail - _deferredEventHead;
    if (depth < 0) depth += DEFERRED_EVENT_QUEUE_MAX;
    return depth;
}

static bool _deferredEventHasPendingWork() {
    return _deferredEventQueueDepth() > 0;
}

static void _deferredEventQueueDropExpired(unsigned long now) {
    while (!_deferredEventQueueIsEmpty()) {
        DeferredEvent& event = _deferredEvents[_deferredEventHead];
        if ((long)(now - event.queuedAt) < (long)DEFERRED_EVENT_TTL_MS) break;
        deviceLogPrintf("evtq", "drop-stale age=%lu type=%s value=%d a=%s",
                        now - event.queuedAt, _deferredEventTypeName(event.type), event.value, event.a);
        memset(&event, 0, sizeof(event));
        _deferredEventHead = (_deferredEventHead + 1) % DEFERRED_EVENT_QUEUE_MAX;
    }
}

static bool _deferredEventQueuePush(const DeferredEvent& event) {
    int nextTail = (_deferredEventTail + 1) % DEFERRED_EVENT_QUEUE_MAX;
    if (nextTail == _deferredEventHead) {
        Serial.println("[EVT] Deferred event queue full");
        deviceLogPrintf("evtq", "enqueue-full type=%s value=%d a=%s",
                        _deferredEventTypeName(event.type), event.value, event.a);
        return false;
    }
    _deferredEvents[_deferredEventTail] = event;
    _deferredEvents[_deferredEventTail].queuedAt = millis();
    _deferredEventTail = nextTail;
    deviceLogPrintf("evtq", "enqueue depth=%d type=%s value=%d a=%s",
                    _deferredEventQueueDepth(), _deferredEventTypeName(event.type), event.value, event.a);
    _scheduleFwWork(FW_WORK_PROCESS_DEFERRED_EVENTS);
    return true;
}

static bool _deferredEventQueuePeek(DeferredEvent& out) {
    if (_deferredEventQueueIsEmpty()) return false;
    out = _deferredEvents[_deferredEventHead];
    return true;
}

static void _deferredEventQueuePop() {
    if (_deferredEventQueueIsEmpty()) return;
    memset(&_deferredEvents[_deferredEventHead], 0, sizeof(_deferredEvents[_deferredEventHead]));
    _deferredEventHead = (_deferredEventHead + 1) % DEFERRED_EVENT_QUEUE_MAX;
}

static void _scheduleFwWork(FwWorkType type, unsigned long delayMs, const char* messageId) {
    if (!fwWorkQueueSchedule(type, delayMs, messageId, true)) {
        deviceLogPrintf("workq", "enqueue-full type=%s", fwWorkTypeName(type));
    } else {
        deviceLogPrintf("workq", "enqueue depth=%d type=%s", fwWorkQueueDepth(), fwWorkTypeName(type));
    }
}

// ── Message ID helper ─────────────────────────────────────────────────────────
// Compact 16-hex-char ID built from hardware RNG — no library needed.
static void _genMsgId(char* out, int len) {
    snprintf(out, len, "%08lx%08lx",
             (unsigned long)esp_random(),
             (unsigned long)esp_random());
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

// Escape a string for embedding in JSON (in-place, dest must be large enough)
static void _jsonEscape(const char* src, char* dest, int destLen) {
    int di = 0;
    for (int i = 0; src[i] && di < destLen - 2; i++) {
        char c = src[i];
        if (c == '"' || c == '\\') { dest[di++] = '\\'; }
        else if (c == '\n') { dest[di++] = '\\'; c = 'n'; }
        else if (c == '\r') { continue; }
        dest[di++] = c;
    }
    dest[di] = '\0';
}

static char _ussdAssembly[512] = "";
static unsigned long _ussdAssemblyStartedAt = 0;
static char _pendingUssdTopic[TOPIC_BUF_SIZE] = "";
static char _pendingUssdPayload[JSON_BUF_SIZE] = "";

static bool _ussdPublishPending() {
    return _pendingUssdTopic[0] && _pendingUssdPayload[0];
}

static bool _ussdResponseComplete(const char* line) {
    if (!line || strncmp(line, "+CUSD:", 6) != 0) {
        return false;
    }

    int ussdMode = atoi(line + 6);
    const char* q1 = strchr(line, '"');
    if (!q1) {
        return ussdMode == 2;
    }

    const char* q2 = strrchr(line, '"');
    return q2 && q2 > q1;
}

static void _publishUssdResponseLine(const char* line) {
    if (!line || strncmp(line, "+CUSD:", 6) != 0) {
        return;
    }

    Serial.printf("[USSD] Stage candidate: %s\n", line);

    int ussdMode = atoi(line + 6);
    const char* q1 = strchr(line, '"');
    const char* q2 = q1 ? strchr(q1 + 1, '"') : nullptr;
    char resp[256];
    if (q1 && q2) {
        int len = (int)(q2 - q1) - 1;
        if (len >= (int)sizeof(resp)) len = sizeof(resp) - 1;
        strncpy(resp, q1 + 1, len);
        resp[len] = '\0';
    } else if (ussdMode == 2) {
        strncpy(resp, "USSD session terminated", sizeof(resp) - 1);
        resp[sizeof(resp) - 1] = '\0';
    } else {
        resp[0] = '\0';
    }

    const char* statusLabel = "complete";
    if (ussdMode == 1) statusLabel = "session";
    else if (ussdMode == 2) statusLabel = "terminated";

    char escaped[256];
    _jsonEscape(resp, escaped, sizeof(escaped));

    char topic[TOPIC_BUF_SIZE];
    char payload[JSON_BUF_SIZE];
    snprintf(topic, sizeof(topic), "device/%s/ussd/response", _cfg.device_id);
    snprintf(payload, sizeof(payload),
        "{\"response\":\"%s\",\"status\":\"%s\",\"code\":\"%s\",\"sessionActive\":%s,\"mode\":%d,\"messageId\":\"%s\"}",
        escaped,
        statusLabel,
        _pendingUssdCode[0] ? _pendingUssdCode : "",
        ussdMode == 1 ? "true" : "false",
        ussdMode,
        _pendingUssdMessageId[0] ? _pendingUssdMessageId : "");
    strncpy(_pendingUssdTopic, topic, sizeof(_pendingUssdTopic) - 1);
    _pendingUssdTopic[sizeof(_pendingUssdTopic) - 1] = '\0';
    strncpy(_pendingUssdPayload, payload, sizeof(_pendingUssdPayload) - 1);
    _pendingUssdPayload[sizeof(_pendingUssdPayload) - 1] = '\0';
    _scheduleFwWork(FW_WORK_PUBLISH_USSD);
    Serial.printf("[USSD] Staged: %s\n", payload);

    if (ussdMode != 1) {
        _pendingUssdCode[0] = '\0';
        _pendingUssdMessageId[0] = '\0';
    }
}

static bool _consumeUssdResponseFragment(const char* line) {
    if (!line || !line[0]) {
        return false;
    }

    if (strncmp(line, "+CUSD:", 6) == 0) {
        strncpy(_ussdAssembly, line, sizeof(_ussdAssembly) - 1);
        _ussdAssembly[sizeof(_ussdAssembly) - 1] = '\0';
        _ussdAssemblyStartedAt = millis();
        Serial.printf("[USSD] Start: %s\n", line);
    } else if (_ussdAssembly[0]) {
        size_t used = strlen(_ussdAssembly);
        if (used < sizeof(_ussdAssembly) - 1) {
            _ussdAssembly[used++] = '\n';
            _ussdAssembly[used] = '\0';
        }
        strncat(_ussdAssembly, line, sizeof(_ussdAssembly) - strlen(_ussdAssembly) - 1);
        Serial.printf("[USSD] Continue: %s\n", line);
    } else {
        return false;
    }

    if (_ussdResponseComplete(_ussdAssembly)) {
        Serial.println("[USSD] Complete");
        _publishUssdResponseLine(_ussdAssembly);
        _ussdAssembly[0] = '\0';
        _ussdAssemblyStartedAt = 0;
    } else if (_ussdAssemblyStartedAt && (millis() - _ussdAssemblyStartedAt) > 15000UL) {
        Serial.println("[USSD] Timeout waiting for completion");
        _ussdAssembly[0] = '\0';
        _ussdAssemblyStartedAt = 0;
    }

    return true;
}

bool ussdWaitForResponse(unsigned long timeoutMs) {
    unsigned long startedAt = millis();
    char line[URC_LEN_MAX];

    while (millis() - startedAt < timeoutMs) {
        if (_ussdPublishPending()) {
            return true;
        }

        if (!_readLine(line, sizeof(line), 500)) {
            continue;
        }

        if (!line[0]) {
            continue;
        }

        Serial.printf("[USSD] < %s\n", line);

        if (_captureAsyncMqttRxLine(line)) {
            continue;
        }

        if (_consumeUssdResponseFragment(line)) {
            if (_ussdPublishPending()) {
                return true;
            }
            continue;
        }

        if (_isAtErrorLine(line)) {
            Serial.println("[USSD] Modem returned error");
            return false;
        }

        if (strcmp(line, "OK") == 0) {
            continue;
        }

        // Preserve unrelated URCs seen while waiting for +CUSD so the normal
        // loop can process them after this command returns.
        _urcQueuePush(line);
    }

    return _ussdPublishPending();
}

static bool _extractQuotedField(const char* src, int fieldIndex, char* out, int outLen) {
    if (!src || !out || outLen <= 0 || fieldIndex < 0) return false;
    out[0] = '\0';

    int current = 0;
    const char* p = src;
    while ((p = strchr(p, '"')) != nullptr) {
        const char* q = strchr(p + 1, '"');
        if (!q) break;
        if (current == fieldIndex) {
            int len = (int)(q - p - 1);
            if (len >= outLen) len = outLen - 1;
            strncpy(out, p + 1, len);
            out[len] = '\0';
            return true;
        }
        current++;
        p = q + 1;
    }

    return false;
}

static int _smsHexNibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
    if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
    return -1;
}

static bool _looksLikeSmsUcs2Hex(const char* src) {
    if (!src) return false;

    size_t len = strlen(src);
    if (len < 4 || (len % 4) != 0) return false;

    for (size_t i = 0; i < len; i++) {
        if (_smsHexNibble(src[i]) < 0) return false;
    }

    return true;
}

static bool _appendUtf8Codepoint(char* dst, size_t dstLen, size_t& out, uint32_t cp) {
    if (!dst || dstLen == 0) return false;

    if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = '?';

    if (cp < 0x80) {
        if (out + 1 >= dstLen) return false;
        dst[out++] = (char)cp;
        return true;
    }

    if (cp < 0x800) {
        if (out + 2 >= dstLen) return false;
        dst[out++] = (char)(0xC0 | ((cp >> 6) & 0x1F));
        dst[out++] = (char)(0x80 | (cp & 0x3F));
        return true;
    }

    if (cp < 0x10000) {
        if (out + 3 >= dstLen) return false;
        dst[out++] = (char)(0xE0 | ((cp >> 12) & 0x0F));
        dst[out++] = (char)(0x80 | ((cp >> 6) & 0x3F));
        dst[out++] = (char)(0x80 | (cp & 0x3F));
        return true;
    }

    if (out + 4 >= dstLen) return false;
    dst[out++] = (char)(0xF0 | ((cp >> 18) & 0x07));
    dst[out++] = (char)(0x80 | ((cp >> 12) & 0x3F));
    dst[out++] = (char)(0x80 | ((cp >> 6) & 0x3F));
    dst[out++] = (char)(0x80 | (cp & 0x3F));
    return true;
}

static void _decodeSmsField(const char* src, char* dst, size_t dstLen) {
    if (!dst || dstLen == 0) return;
    dst[0] = '\0';
    if (!src || !src[0]) return;

    if (!_looksLikeSmsUcs2Hex(src)) {
        strncpy(dst, src, dstLen - 1);
        dst[dstLen - 1] = '\0';
        return;
    }

    size_t out = 0;
    size_t len = strlen(src);
    for (size_t i = 0; i + 3 < len; i += 4) {
        uint32_t cp =
            ((uint32_t)_smsHexNibble(src[i]) << 12) |
            ((uint32_t)_smsHexNibble(src[i + 1]) << 8) |
            ((uint32_t)_smsHexNibble(src[i + 2]) << 4) |
            (uint32_t)_smsHexNibble(src[i + 3]);

        if (!_appendUtf8Codepoint(dst, dstLen, out, cp)) {
            break;
        }
    }

    dst[out] = '\0';
    if (!dst[0]) {
        strncpy(dst, src, dstLen - 1);
        dst[dstLen - 1] = '\0';
    }
}

static bool _publishIncomingSmsNow(const char* from, const char* message) {
    char topic[TOPIC_BUF_SIZE];
    char payload[JSON_BUF_SIZE];
    char escapedMsg[JSON_BUF_SIZE];
    char escapedFrom[64];
    char msgId[20];
    _genMsgId(msgId, sizeof(msgId));

    _jsonEscape(message ? message : "", escapedMsg, sizeof(escapedMsg));
    _jsonEscape(from ? from : "", escapedFrom, sizeof(escapedFrom));

    snprintf(topic, sizeof(topic), "device/%s/sms/incoming", _cfg.device_id);
    snprintf(
        payload,
        sizeof(payload),
        "{\"from\":\"%s\",\"message\":\"%s\",\"messageId\":\"%s\"}",
        escapedFrom, escapedMsg, msgId
    );

    if (!mqttPublish(topic, payload, 1)) {
        return false;
    }
    ledSetState(LED_SMS_RECEIVED);
    displayNotify("SMS", escapedFrom);
    deviceLogPrintf("sms-in", "from=%s text=%s", from ? from : "", message ? message : "");
    Serial.printf("[SMS] From %s: %s\n", from ? from : "", message ? message : "");
    return true;
}

static bool _publishSmsDeliveredNow(const char* to, int statusCode, const char* rawLine) {
    char topic[TOPIC_BUF_SIZE];
    char payload[JSON_BUF_SIZE];
    char escapedTo[64];
    char escapedRaw[192];
    char msgId[20];
    _genMsgId(msgId, sizeof(msgId));

    _jsonEscape(to ? to : "", escapedTo, sizeof(escapedTo));
    _jsonEscape(rawLine ? rawLine : "", escapedRaw, sizeof(escapedRaw));

    snprintf(topic, sizeof(topic), "device/%s/sms/delivered", _cfg.device_id);
    snprintf(
        payload,
        sizeof(payload),
        "{"
          "\"to\":\"%s\","
          "\"delivered\":%s,"
          "\"statusCode\":%d,"
          "\"raw\":\"%s\","
          "\"messageId\":\"%s\""
        "}",
        escapedTo,
        statusCode == 0 ? "true" : "false",
        statusCode,
        escapedRaw,
        msgId
    );

    if (!mqttPublish(topic, payload, 1)) {
        return false;
    }
    if (statusCode == 0) {
        ledSetState(LED_SMS_DELIVERED);
    }
    deviceLogPrintf("sms-dr", "to=%s status=%d", to ? to : "", statusCode);
    Serial.printf("[SMS] Delivery report for %s status=%d\n", to ? to : "", statusCode);
    return true;
}

static bool _readStoredSms(int index, char* from, int fromLen, char* body, int bodyLen) {
    if (index < 0) return false;

    char cmd[24];
    char line[512];
    char rawFrom[96] = "";
    char rawBody[JSON_BUF_SIZE] = "";
    bool haveHeader = false;
    bool haveBody = false;

    if (from && fromLen > 0) from[0] = '\0';
    if (body && bodyLen > 0) body[0] = '\0';

    snprintf(cmd, sizeof(cmd), "AT+CMGRD=%d", index);
    atSend(cmd);

    unsigned long t0 = millis();
    while (millis() - t0 < 15000) {
        if (!_readLine(line, sizeof(line), 500)) continue;
        if (strlen(line) == 0) continue;
        if (_handleAsyncLineDuringWait(line)) continue;

        if (strncmp(line, "+CMGRD:", 7) == 0 || strncmp(line, "+CMGR:", 6) == 0) {
            haveHeader = true;
            _extractQuotedField(line, 1, rawFrom, sizeof(rawFrom));
            continue;
        }

        if (strcmp(line, "OK") == 0) break;
        if (strstr(line, "ERROR")) return false;

        if (haveHeader && !haveBody) {
            strncpy(rawBody, line, sizeof(rawBody) - 1);
            rawBody[sizeof(rawBody) - 1] = '\0';
            haveBody = true;
        }
    }

    if (haveHeader && from && fromLen > 0) {
        _decodeSmsField(rawFrom, from, (size_t)fromLen);
    }
    if (haveBody && body && bodyLen > 0) {
        _decodeSmsField(rawBody, body, (size_t)bodyLen);
    }

    return haveBody;
}

static bool _readStoredSmsDelivery(int index, char* recipient, int recipientLen,
                                   char* rawLine, int rawLen, int* statusCodeOut) {
    if (index < 0) return false;

    char cmd[24];
    char line[256];
    char header[256] = "";
    bool haveHeader = false;

    if (recipient && recipientLen > 0) recipient[0] = '\0';
    if (rawLine && rawLen > 0) rawLine[0] = '\0';
    if (statusCodeOut) *statusCodeOut = -1;

    snprintf(cmd, sizeof(cmd), "AT+CMGRD=%d", index);
    atSend(cmd);

    unsigned long t0 = millis();
    while (millis() - t0 < 15000) {
        if (!_readLine(line, sizeof(line), 500)) continue;
        if (strlen(line) == 0) continue;
        if (_handleAsyncLineDuringWait(line)) continue;

        if (strncmp(line, "+CMGRD:", 7) == 0 || strncmp(line, "+CMGR:", 6) == 0) {
            haveHeader = true;
            strncpy(header, line, sizeof(header) - 1);
            header[sizeof(header) - 1] = '\0';
            if (!_extractQuotedField(line, 1, recipient, recipientLen)) {
                _extractQuotedField(line, 0, recipient, recipientLen);
            }
            if (recipient && recipient[0]) {
                char decodedRecipient[64];
                _decodeSmsField(recipient, decodedRecipient, sizeof(decodedRecipient));
                strncpy(recipient, decodedRecipient, recipientLen - 1);
                recipient[recipientLen - 1] = '\0';
            }
            continue;
        }

        if (strcmp(line, "OK") == 0) break;
        if (strstr(line, "ERROR")) return false;
    }

    if (!haveHeader) return false;

    if (rawLine && rawLen > 0) {
        strncpy(rawLine, header, rawLen - 1);
        rawLine[rawLen - 1] = '\0';
    }
    if (statusCodeOut) {
        const char* lastComma = strrchr(header, ',');
        *statusCodeOut = lastComma ? atoi(lastComma + 1) : -1;
    }
    return true;
}

static void _queueSmsReadEvent(int index) {
    DeferredEvent event = {};
    event.type = DEFER_SMS_READ;
    event.value = index;
    _deferredEventQueuePush(event);
}

static void _queueSmsPublishEvent(const char* from, const char* message) {
    DeferredEvent event = {};
    event.type = DEFER_SMS_PUBLISH;
    strncpy(event.a, from ? from : "", sizeof(event.a) - 1);
    strncpy(event.b, message ? message : "", sizeof(event.b) - 1);
    _deferredEventQueuePush(event);
}

static void _queueSmsDeliveryReadEvent(int index) {
    DeferredEvent event = {};
    event.type = DEFER_SMS_DELIVERY_READ;
    event.value = index;
    _deferredEventQueuePush(event);
}

static void _queueSmsDeliveryPublishEvent(const char* to, int statusCode, const char* rawLine) {
    DeferredEvent event = {};
    event.type = DEFER_SMS_DELIVERY_PUBLISH;
    event.value = statusCode;
    strncpy(event.a, to ? to : "", sizeof(event.a) - 1);
    strncpy(event.b, rawLine ? rawLine : "", sizeof(event.b) - 1);
    _deferredEventQueuePush(event);
}

static const char* _currentCallNumber() {
    return _callNumber;
}

static void _setCurrentCallNumber(const char* number) {
    snprintf(_callNumber, sizeof(_callNumber), "%s", number ? number : "");
}

static void _setCallDirection(const char* direction) {
    snprintf(_callDirection, sizeof(_callDirection), "%s", direction ? direction : "");
}

static const char* _currentCallDirection() {
    return _callDirection[0] ? _callDirection : "unknown";
}

static void callBeginProgressTracking(const char* direction, const char* number) {
    _callProgressPollActive = true;
    _lastCallProgressPollMs = 0;
    _setCallDirection(direction);
    if (number && number[0]) {
        _setCurrentCallNumber(number);
    }
}

static void callStopProgressTracking() {
    _callProgressPollActive = false;
    _lastCallProgressPollMs = 0;
}

static void _suspendMqttForVoiceSession(const char* reason) {
    if (_callDataSessionSuspended) return;
    _callDataSessionSuspended = true;
    if (mqttConnected()) {
        _mqttMarkDisconnected(reason && reason[0] ? reason : "voice session");
    }
    deviceLogPrintf("call", "mqtt-suspend reason=%s", reason ? reason : "voice");
}

static void _resumeMqttAfterVoiceSession() {
    if (!_callDataSessionSuspended) return;
    _callDataSessionSuspended = false;
    _reconnectMs = 0;
    deviceLogAppend("call", "mqtt-resume");
}

static void _queueCallStatusEvent(const char* status, const char* number, int duration) {
    const char* normalizedStatus = status ? status : "";
    const char* normalizedNumber = number ? number : "";
    if (!strcmp(_lastCallStatus, normalizedStatus) &&
        !strcmp(_lastCallStatusNumber, normalizedNumber) &&
        strcmp(normalizedStatus, "ended") != 0 &&
        strcmp(normalizedStatus, "missed") != 0 &&
        strcmp(normalizedStatus, "rejected") != 0) {
        return;
    }

    DeferredEvent event = {};
    event.type = DEFER_CALL_STATUS;
    event.value = duration;
    strncpy(event.a, normalizedStatus, sizeof(event.a) - 1);
    strncpy(event.b, normalizedNumber, sizeof(event.b) - 1);
    _deferredEventQueuePush(event);
    snprintf(_lastCallStatus, sizeof(_lastCallStatus), "%s", normalizedStatus);
    snprintf(_lastCallStatusNumber, sizeof(_lastCallStatusNumber), "%s", normalizedNumber);
}

static bool _pollCurrentCallState(int* stateOut, int* dirOut, char* numberOut, size_t numberOutLen) {
    if (!stateOut || !dirOut || !numberOut || numberOutLen == 0) return false;
    if (atBusIsLocked()) return false;

    *stateOut = -1;
    *dirOut = -1;
    numberOut[0] = '\0';

    atBusLock();
    atSend("AT+CLCC");

    char line[256];
    bool ok = false;
    unsigned long startedAt = millis();
    while (millis() - startedAt < 2500UL) {
        if (!_readLine(line, sizeof(line), 300)) continue;
        if (!line[0]) continue;
        if (_handleAsyncLineDuringWait(line)) continue;

        if (strncmp(line, "+CLCC:", 6) == 0) {
            int idx = 0;
            int dir = -1;
            int stat = -1;
            int mode = 0;
            int mpty = 0;
            int type = 0;
            char parsedNumber[32] = "";
            int matched = sscanf(line, "+CLCC: %d,%d,%d,%d,%d,\"%31[^\"]\",%d",
                                 &idx, &dir, &stat, &mode, &mpty, parsedNumber, &type);
            if (matched >= 5) {
                *stateOut = stat;
                *dirOut = dir;
                if (matched >= 6) {
                    snprintf(numberOut, numberOutLen, "%s", parsedNumber);
                }
                ok = true;
            }
            continue;
        }

        if (strcmp(line, "OK") == 0) break;
        if (_isAtErrorLine(line)) break;
    }

    atBusUnlock();
    return ok;
}

static void _callProgressPollTick(unsigned long now) {
    if (!_callProgressPollActive) return;
    if ((long)(now - _lastCallProgressPollMs) < 1200L) return;
    _lastCallProgressPollMs = now;

    int state = -1;
    int dir = -1;
    char number[32];
    if (!_pollCurrentCallState(&state, &dir, number, sizeof(number))) return;

    if (number[0] && !_callNumber[0]) {
        _setCurrentCallNumber(number);
    }
    if (dir == 0) _setCallDirection("outgoing");
    else if (dir == 1) _setCallDirection("incoming");

    if (state == 0) {
        if (_callStartMs == 0) _callStartMs = now;
        _inCall = true;
        ledSetState(LED_BUSY);
        _queueCallStatusEvent("connected", _currentCallNumber());
    } else if (state == 2) {
        _queueCallStatusEvent("dialing", _currentCallNumber());
    } else if (state == 3) {
        _queueCallStatusEvent("ringing", _currentCallNumber());
    } else if (state == 4 || state == 5) {
        _inCall = true;
        ledSetState(LED_CALL_RINGING);
        _queueCallStatusEvent("ringing", _currentCallNumber());
    }
}

static void _processDeferredEvents(int maxEvents = 2) {
    _deferredEventQueueDropExpired(millis());
    for (int i = 0; i < maxEvents; i++) {
        DeferredEvent event;
        if (!_deferredEventQueuePeek(event)) return;

        deviceLogPrintf("evtq", "process depth=%d type=%s value=%d a=%s",
                        _deferredEventQueueDepth(), _deferredEventTypeName(event.type), event.value, event.a);
        bool done = false;
        bool needsAtBus = (event.type == DEFER_SMS_READ || event.type == DEFER_SMS_DELIVERY_READ);
        if (needsAtBus) atBusLock();
        if (event.type == DEFER_SMS_READ) {
            char from[64];
            char body[JSON_BUF_SIZE];
            done = _readStoredSms(event.value, from, sizeof(from), body, sizeof(body));
            if (done) {
                _queueSmsPublishEvent(from, body);
            } else {
                deviceLogPrintf("sms-in", "stored read failed index=%d", event.value);
            }
        } else if (event.type == DEFER_SMS_PUBLISH) {
            if (!mqttConnected()) {
                deviceLogPrintf("evtq", "defer-wait type=%s reason=mqtt-disconnected",
                                _deferredEventTypeName(event.type));
                return;
            }
            done = _publishIncomingSmsNow(event.a, event.b);
        } else if (event.type == DEFER_SMS_DELIVERY_READ) {
            char recipient[64];
            char rawLine[256];
            int statusCode = -1;
            done = _readStoredSmsDelivery(event.value, recipient, sizeof(recipient),
                                          rawLine, sizeof(rawLine), &statusCode);
            if (done) {
                _queueSmsDeliveryPublishEvent(recipient, statusCode, rawLine);
            } else {
                deviceLogPrintf("sms-dr", "stored delivery read failed index=%d", event.value);
            }
        } else if (event.type == DEFER_SMS_DELIVERY_PUBLISH) {
            if (!mqttConnected()) {
                deviceLogPrintf("evtq", "defer-wait type=%s reason=mqtt-disconnected",
                                _deferredEventTypeName(event.type));
                return;
            }
            done = _publishSmsDeliveredNow(event.a, event.value, event.b);
        } else if (event.type == DEFER_CALL_STATUS) {
            if (!mqttConnected()) {
                deviceLogPrintf("evtq", "defer-wait type=%s reason=mqtt-disconnected",
                                _deferredEventTypeName(event.type));
                return;
            }

            char topic[TOPIC_BUF_SIZE];
            char payload[JSON_BUF_SIZE];
            char msgId[20];
            _genMsgId(msgId, sizeof(msgId));

            if (!strcmp(event.a, "ringing") && event.b[0]) {
                snprintf(topic, sizeof(topic), "device/%s/call/incoming", _cfg.device_id);
                snprintf(payload, sizeof(payload), "{\"number\":\"%s\"}", event.b);
                if (!mqttPublish(topic, payload, 1)) return;
            }

            snprintf(topic, sizeof(topic), "device/%s/call/status", _cfg.device_id);
            if (!strcmp(event.a, "ended")) {
                snprintf(payload, sizeof(payload),
                         "{\"status\":\"ended\",\"number\":\"%s\",\"duration\":%d,\"messageId\":\"%s\"}",
                         event.b, event.value < 0 ? 0 : event.value, msgId);
            } else {
                snprintf(payload, sizeof(payload),
                         "{\"status\":\"%s\",\"number\":\"%s\",\"messageId\":\"%s\"}",
                         event.a, event.b, msgId);
            }
            done = mqttPublish(topic, payload, 1);
        }
        if (needsAtBus) atBusUnlock();

        if (!done) {
            deviceLogPrintf("evtq", "process-failed type=%s value=%d a=%s",
                            _deferredEventTypeName(event.type), event.value, event.a);
            return;
        }
        deviceLogPrintf("evtq", "process-done depth=%d type=%s",
                        _deferredEventQueueDepth(), _deferredEventTypeName(event.type));
        _deferredEventQueuePop();
    }
}

static void _processFwWorkQueue(unsigned long now, int maxItems, bool commandQuiet) {
    if (commandQuiet) return;

    for (int i = 0; i < maxItems; i++) {
        FwWorkItem item = {};
        if (!fwWorkQueueClaimDue(now, item)) return;

        bool done = false;

        switch (item.type) {
            case FW_WORK_PUBLISH_USSD:
                if (!_ussdPublishPending()) {
                    done = true;
                    break;
                }
                if (!mqttConnected() || _callDataSessionSuspended) {
                    fwWorkQueueReschedule(item, 1500);
                    break;
                }
                done = mqttPublish(_pendingUssdTopic, _pendingUssdPayload, 1);
                Serial.printf("[USSD] Deferred publish %s: %s\n", done ? "ok" : "failed", _pendingUssdPayload);
                if (done) {
                    _pendingUssdTopic[0] = '\0';
                    _pendingUssdPayload[0] = '\0';
                } else {
                    fwWorkQueueReschedule(item, 2000);
                }
                break;

            case FW_WORK_PUBLISH_STATUS:
                if (!mqttConnected() || atBusIsLocked() || _callDataSessionSuspended) {
                    fwWorkQueueReschedule(item, 1200);
                    break;
                }
                publishStatus(item.messageId);
                done = true;
                break;

            case FW_WORK_PUBLISH_GPS_STATUS:
                if (!mqttConnected() || atBusIsLocked() || _callDataSessionSuspended) {
                    fwWorkQueueReschedule(item, 1200);
                    break;
                }
                done = publishGpsStatus(item.messageId);
                if (!done) fwWorkQueueReschedule(item, 1500);
                break;

            case FW_WORK_PUBLISH_GPIO_STATUS:
                if (!mqttConnected() || atBusIsLocked() || _callDataSessionSuspended) {
                    fwWorkQueueReschedule(item, 1200);
                    break;
                }
                _publishGpioStatusEvent(item.messageId);
                done = true;
                break;

            case FW_WORK_PROCESS_DEFERRED_EVENTS:
                if (_callDataSessionSuspended) {
                    fwWorkQueueReschedule(item, 1500);
                    break;
                }
                _processDeferredEvents(2);
                done = true;
                if (_deferredEventHasPendingWork()) {
                    fwWorkQueueSchedule(FW_WORK_PROCESS_DEFERRED_EVENTS, 200, nullptr, true);
                }
                break;

            case FW_WORK_NONE:
            default:
                done = true;
                break;
        }

        deviceLogPrintf("workq", "%s depth=%d type=%s tries=%u",
                        done ? "done" : "yield",
                        fwWorkQueueDepth(), fwWorkTypeName(item.type), (unsigned)item.attempts);
    }
}

// Convert RSSI (0–31, 99) to signal bars percent (0–100)
static int _rssiToBars(int rssi) {
    if (rssi == 99 || rssi < 0) return 0;
    return (int)((float)rssi / 31.0f * 100.0f);
}

// Convert RSSI to dBm
static int _rssiToDbm(int rssi) {
    if (rssi == 99) return -113;
    return (rssi * 2) - 113;
}

static const char* _wifiModeToString(wifi_mode_t mode) {
    switch (mode) {
        case WIFI_MODE_STA:   return "sta";
        case WIFI_MODE_AP:    return "ap";
        case WIFI_MODE_APSTA: return "ap+sta";
        case WIFI_MODE_NULL:
        default:
            return "off";
    }
}

static const char* _deviceModeToString(int mode) {
    switch (mode) {
        case DEVICE_MODE_LOW_POWER: return "low-power";
        case DEVICE_MODE_HOTSPOT: return "hotspot";
        case DEVICE_MODE_DIAGNOSTIC: return "diagnostic";
        case DEVICE_MODE_SILENT: return "silent";
        case DEVICE_MODE_NORMAL:
        default:
            return "normal";
    }
}

static bool _deviceModeFromString(const char* value, int& out) {
    if (!value || !value[0]) return false;
    if (!strcmp(value, "normal")) {
        out = DEVICE_MODE_NORMAL;
    } else if (!strcmp(value, "low-power")) {
        out = DEVICE_MODE_LOW_POWER;
    } else if (!strcmp(value, "hotspot")) {
        out = DEVICE_MODE_HOTSPOT;
    } else if (!strcmp(value, "diagnostic")) {
        out = DEVICE_MODE_DIAGNOSTIC;
    } else if (!strcmp(value, "silent")) {
        out = DEVICE_MODE_SILENT;
    } else {
        return false;
    }
    return true;
}

static const char* deviceModeName() {
    return _deviceModeToString(_deviceMode);
}

static unsigned long _effectiveGpsPublishIntervalMs() {
    switch (_deviceMode) {
        case DEVICE_MODE_LOW_POWER:
            return max(_gpsUpdateIntervalMs, 180000UL);
        case DEVICE_MODE_DIAGNOSTIC:
            return min(_gpsUpdateIntervalMs, 30000UL);
        default:
            return _gpsUpdateIntervalMs;
    }
}

static void _configureDirectAccessNetworking() {
    char ssid[32];
    fwBuildDirectApSsid(ssid, sizeof(ssid));
    fwBuildDirectApPassword(_directApPassword, sizeof(_directApPassword));

    const bool wantsSta = _cfg.wifi_ssid[0] != '\0';
    const bool wantsHotspot = (_deviceMode == DEVICE_MODE_HOTSPOT);

    if (wantsHotspot) {
        WiFi.mode(wantsSta ? WIFI_AP_STA : WIFI_AP);
        WiFi.softAP(ssid, _directApPassword);
        if (wantsSta && WiFi.status() != WL_CONNECTED) {
            WiFi.begin(_cfg.wifi_ssid, _cfg.wifi_pass);
        }
        Serial.printf("[WiFi] Hotspot mode active: %s  Pass: %s  IP: %s\n",
                      ssid, _directApPassword, WiFi.softAPIP().toString().c_str());
        return;
    }

    if (WiFi.status() == WL_CONNECTED && wantsSta) {
        WiFi.softAPdisconnect(true);
        WiFi.mode(WIFI_STA);
        return;
    }

    WiFi.mode(WIFI_AP);
    WiFi.softAP(ssid, _directApPassword);
    Serial.printf("[WiFi] Direct AP active: %s  Pass: %s  IP: %s\n",
                  ssid, _directApPassword, WiFi.softAPIP().toString().c_str());
}

static void _applyDeviceMode(bool refreshWifi) {
    switch (_deviceMode) {
        case DEVICE_MODE_LOW_POWER:
            _statusIntervalMs = 120000UL;
            _heartbeatIntervalMs = 120000UL;
            _gpioStatusIntervalMs = 120000UL;
            _displayUpdateIntervalMs = 15000UL;
            _modemRecoveryIntervalMs = 30000UL;
            break;
        case DEVICE_MODE_HOTSPOT:
            _statusIntervalMs = STATUS_INTERVAL_MS;
            _heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
            _gpioStatusIntervalMs = GPIO_STATUS_INTERVAL_MS;
            _displayUpdateIntervalMs = DISPLAY_UPDATE_MS;
            _modemRecoveryIntervalMs = MODEM_RECOVERY_MS;
            break;
        case DEVICE_MODE_DIAGNOSTIC:
            _statusIntervalMs = 30000UL;
            _heartbeatIntervalMs = 30000UL;
            _gpioStatusIntervalMs = 30000UL;
            _displayUpdateIntervalMs = 2000UL;
            _modemRecoveryIntervalMs = 10000UL;
            break;
        case DEVICE_MODE_SILENT:
        case DEVICE_MODE_NORMAL:
        default:
            _statusIntervalMs = STATUS_INTERVAL_MS;
            _heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
            _gpioStatusIntervalMs = GPIO_STATUS_INTERVAL_MS;
            _displayUpdateIntervalMs = DISPLAY_UPDATE_MS;
            _modemRecoveryIntervalMs = MODEM_RECOVERY_MS;
            break;
    }

    if (refreshWifi && _cfg.valid) {
        _configureDirectAccessNetworking();
        _syncBootRuntimeState();
    }
    _refreshIdleLedState();
}

static bool deviceSetMode(const char* modeName, bool persist, char* statusMsg, size_t statusMsgLen) {
    int parsed = DEVICE_MODE_NORMAL;
    if (!_deviceModeFromString(modeName, parsed)) {
        if (statusMsg && statusMsgLen) snprintf(statusMsg, statusMsgLen, "invalid mode");
        return false;
    }

    _deviceMode = parsed;
    snprintf(_cfg.mode, sizeof(_cfg.mode), "%s", _deviceModeToString(parsed));

    if (persist && !nvsConfigSave(_cfg)) {
        if (statusMsg && statusMsgLen) snprintf(statusMsg, statusMsgLen, "failed to save mode");
        return false;
    }

    _applyDeviceMode(true);
    _mqttNeedsStatusPublish = true;
    requestStatusPublish(nullptr);
    requestGpsStatusPublish(nullptr);
    if (statusMsg && statusMsgLen) snprintf(statusMsg, statusMsgLen, "mode set to %s", _cfg.mode);
    deviceLogPrintf("mode", "set mode=%s persist=%d", _cfg.mode, persist ? 1 : 0);
    return true;
}

static const char* _callStatusSummary() {
    if (_inCall) return "connected";
    if (_callProgressPollActive) return "dialing";
    if (_callNumber[0]) return "ringing";
    return "idle";
}

static void _formatGpsTimestamp(const GpsData& fix, char* out, int len) {
    if (!out || len <= 0) return;
    out[0] = '\0';
    if (strlen(fix.date) < 6 || strlen(fix.timestamp) < 6) return;

    int day = (fix.date[0] - '0') * 10 + (fix.date[1] - '0');
    int month = (fix.date[2] - '0') * 10 + (fix.date[3] - '0');
    int year = 2000 + (fix.date[4] - '0') * 10 + (fix.date[5] - '0');
    int hour = (fix.timestamp[0] - '0') * 10 + (fix.timestamp[1] - '0');
    int minute = (fix.timestamp[2] - '0') * 10 + (fix.timestamp[3] - '0');
    int second = (fix.timestamp[4] - '0') * 10 + (fix.timestamp[5] - '0');

    snprintf(out, len, "%04d-%02d-%02dT%02d:%02d:%02dZ", year, month, day, hour, minute, second);
}

static void _refreshRadioSnapshot() {
    _rssi = modemCSQ();
    if (!modemOperator(_operator, sizeof(_operator))) {
        _operator[0] = '\0';
    }
}

static bool _configureApn() {
    if (!_cfg.apn[0]) return true;
    char apnCmd[128];
    snprintf(apnCmd, sizeof(apnCmd), "AT+CGDCONT=1,\"IP\",\"%s\"", _cfg.apn);
    bool ok = atCmd(apnCmd, 5000);
    if (ok) {
        Serial.printf("[NET] APN: %s\n", _cfg.apn);
    } else {
        Serial.println("[NET] Failed to configure APN");
    }
    return ok;
}

static void _syncBootRuntimeState() {
    bootStateSetModemConfigured(_modemConfigured);
    bootStateSetNetworkReady(_networkReady);
    bootStateSetMqttConnected(mqttConnected());
    bootStateSetSdPresent(storagePresent());
    bootStateSetGpsPowered(gpsIsPowered());

    if (WiFi.status() == WL_CONNECTED) {
        String wifiSsid = WiFi.SSID();
        String wifiIp = WiFi.localIP().toString();
        bootStateSetWifiStation(true, wifiSsid.c_str(), wifiIp.c_str());
    } else {
        bootStateSetWifiStation(false, "", "");
    }
}

static void _publishWifiStatusChange() {
    char wifiSsidEsc[96];
    char wifiIpEsc[48];
    char apSsidEsc[96];
    char apIpEsc[48];
    const BootRuntimeState& state = bootStateSnapshot();
    wifi_mode_t wifiMode = WiFi.getMode();
    bool apEnabled = (wifiMode == WIFI_MODE_AP || wifiMode == WIFI_MODE_APSTA);
    String apSsid = apEnabled ? WiFi.softAPSSID() : "";
    String apIp = apEnabled ? WiFi.softAPIP().toString() : "";
    int clients = apEnabled ? WiFi.softAPgetStationNum() : 0;

    _jsonEscape(state.wifiSsid, wifiSsidEsc, sizeof(wifiSsidEsc));
    _jsonEscape(state.wifiIp, wifiIpEsc, sizeof(wifiIpEsc));
    _jsonEscape(apSsid.c_str(), apSsidEsc, sizeof(apSsidEsc));
    _jsonEscape(apIp.c_str(), apIpEsc, sizeof(apIpEsc));

    snprintf(_wifiStatusTopicBuf, sizeof(_wifiStatusTopicBuf), "device/%s/wifi/status-change", _cfg.device_id);
    snprintf(
        _wifiStatusPayloadBuf,
        sizeof(_wifiStatusPayloadBuf),
        "{"
          "\"state\":\"%s\","
          "\"mode\":\"%s\","
          "\"connected\":%s,"
          "\"ssid\":\"%s\","
          "\"ipAddress\":\"%s\","
          "\"apEnabled\":%s,"
          "\"apSsid\":\"%s\","
          "\"apIp\":\"%s\","
          "\"clients\":%d"
        "}",
        state.wifiStationConnected ? "connected" : "disconnected",
        _wifiModeToString(wifiMode),
        state.wifiStationConnected ? "true" : "false",
        wifiSsidEsc,
        wifiIpEsc,
        apEnabled ? "true" : "false",
        apSsidEsc,
        apIpEsc,
        clients
    );
    mqttPublish(_wifiStatusTopicBuf, _wifiStatusPayloadBuf, 0);
}

static void _cmdPublishInternetStatusResponse(const char* msgId) {
    char wifiSsid[64];
    char wifiIp[32];
    char wifiApSsid[64];
    char wifiApIp[32];
    wifi_mode_t wifiMode = WiFi.getMode();
    bool wifiStaConnected = WiFi.status() == WL_CONNECTED;
    bool wifiApEnabled = (wifiMode == WIFI_MODE_AP || wifiMode == WIFI_MODE_APSTA);
    snprintf(wifiSsid, sizeof(wifiSsid), "%s", wifiStaConnected ? WiFi.SSID().c_str() : "");
    snprintf(wifiIp, sizeof(wifiIp), "%s", wifiStaConnected ? WiFi.localIP().toString().c_str() : "");
    snprintf(wifiApSsid, sizeof(wifiApSsid), "%s", wifiApEnabled ? WiFi.softAPSSID().c_str() : "");
    snprintf(wifiApIp, sizeof(wifiApIp), "%s", wifiApEnabled ? WiFi.softAPIP().toString().c_str() : "");

    int _inetSoc = batterySOC();
    int _inetVmv = batteryVoltage_mV();
    char _inetBatJson[12], _inetVmvJson[12];
    if (_inetSoc >= 0) snprintf(_inetBatJson, sizeof(_inetBatJson), "%d", _inetSoc);
    else strncpy(_inetBatJson, "null", sizeof(_inetBatJson) - 1);
    _inetBatJson[sizeof(_inetBatJson)-1] = '\0';
    if (_inetVmv >= 0) snprintf(_inetVmvJson, sizeof(_inetVmvJson), "%d", _inetVmv);
    else strncpy(_inetVmvJson, "null", sizeof(_inetVmvJson) - 1);
    _inetVmvJson[sizeof(_inetVmvJson)-1] = '\0';
    const char* _inetCharging = batteryChargingState() == 1 ? "true"
                              : batteryChargingState() == 0 ? "false"
                              : "null";

    snprintf(_internetStatusTopicBuf, sizeof(_internetStatusTopicBuf), "device/%s/command/response", _mqttGetDeviceId());
    snprintf(
        _internetStatusPayloadBuf,
        sizeof(_internetStatusPayloadBuf),
        "{"
          "\"success\":true,"
          "\"message\":\"internet status sent\","
          "\"messageId\":\"%s\","
          "\"data\":{"
            "\"mobile\":{"
              "\"enabled\":true,"
              "\"connected\":%s,"
              "\"signalStrength\":%d,"
              "\"signalDbm\":%d,"
              "\"networkType\":\"LTE\","
              "\"operator\":\"%s\","
              "\"ipAddress\":\"%s\","
              "\"registered\":%s"
            "},"
            "\"wifi\":{"
              "\"enabled\":true,"
              "\"connected\":%s,"
              "\"mode\":\"%s\","
              "\"ssid\":\"%s\","
              "\"ipAddress\":\"%s\","
              "\"apEnabled\":%s,"
              "\"apSsid\":\"%s\","
              "\"apIp\":\"%s\","
              "\"clients\":%d"
            "},"
            "\"hotspot\":{"
              "\"enabled\":%s,"
              "\"ssid\":\"%s\","
              "\"ipAddress\":\"%s\","
              "\"clients\":%d"
            "},"
            "\"usb\":{"
              "\"enabled\":false,"
              "\"connected\":false"
            "},"
            "\"system\":{"
              "\"battery\":%s,"
              "\"voltage_mV\":%s,"
              "\"charging\":%s,"
              "\"uptime\":%lu,"
              "\"temperature\":%.2f"
            "}"
          "}"
        "}",
        msgId && msgId[0] ? msgId : "0",
        _networkReady ? "true" : "false",
        _rssiToBars(_rssi),
        _rssiToDbm(_rssi),
        _operator,
        _ipAddr,
        _networkReady ? "true" : "false",
        wifiStaConnected ? "true" : "false",
        _wifiModeToString(wifiMode),
        wifiSsid,
        wifiIp,
        wifiApEnabled ? "true" : "false",
        wifiApSsid,
        wifiApIp,
        wifiApEnabled ? WiFi.softAPgetStationNum() : 0,
        wifiApEnabled ? "true" : "false",
        wifiApSsid,
        wifiApIp,
        wifiApEnabled ? WiFi.softAPgetStationNum() : 0,
        _inetBatJson,
        _inetVmvJson,
        _inetCharging,
        millis() / 1000,
        temperatureRead()
    );

    mqttPublish(_internetStatusTopicBuf, _internetStatusPayloadBuf, 1);
    if (wifiStaConnected || wifiApEnabled || _networkReady) {
        Serial.println("[NET] Published on-demand internet status snapshot");
    }
}

static bool _ledCanYieldToIdleState() {
    switch (ledGetState()) {
        case LED_BUSY:
        case LED_CALL_RINGING:
        case LED_OTA:
        case LED_ERROR:
        case LED_FACTORY_RESET:
            return false;
        default:
            return !ledIsFlashState(ledGetState());
    }
}

static bool _ledSignalWeak() {
    return _rssi != 99 && _rssi > 0 && _rssi <= 9;
}

static int _systemPendingTaskCount() {
    int count = 0;
    count += fwWorkQueueDepth();
    count += commandQueueDepth();
    count += commandResponseQueueDepth();
    count += _deferredEventQueueDepth();
    count += mqttInboundQueueDepth();
    if (_ussdPublishPending()) count++;
    if (commandQuietActive()) count++;
    return count;
}

static bool _systemHasPendingTaskWork() {
    return _systemPendingTaskCount() > 0 || commandHasPendingWork() || _deferredEventHasPendingWork();
}

void requestStatusPublish(const char* messageId) {
    _scheduleFwWork(FW_WORK_PUBLISH_STATUS, 0, messageId);
}

void requestGpsStatusPublish(const char* messageId) {
    _scheduleFwWork(FW_WORK_PUBLISH_GPS_STATUS, 0, messageId);
}

void requestGpioStatusPublish(const char* messageId) {
    _scheduleFwWork(FW_WORK_PUBLISH_GPIO_STATUS, 0, messageId);
}

static LedState _idleLedState() {
    int soc = batterySOC();
    bool lowBattery = soc >= 0 && soc <= 15;

    if (!_cfg.valid) return LED_SETUP_MODE;
    if (!_modemConfigured) return LED_CONNECTING;
    if (!_networkReady) {
        if (millis() > 30000UL && (_rssi == 99 || _rssi <= 0)) {
            return LED_NO_SIGNAL;
        }
        return LED_CONNECTING;
    }
    if (lowBattery) return LED_LOW_BATTERY;
    if (!mqttConnected()) {
        if (_deviceMode == DEVICE_MODE_SILENT) return LED_OFF;
        if (_ledSignalWeak()) return LED_WEAK_SIGNAL;
        return LED_NETWORK_READY;
    }
    if (lowBattery) return LED_LOW_BATTERY;
    if (_deviceMode == DEVICE_MODE_SILENT) return LED_OFF;
    if (_systemHasPendingTaskWork()) return LED_TASK_PENDING;
    if (_ledSignalWeak()) return LED_WEAK_SIGNAL;
    return LED_CONNECTED;
}

static void _refreshIdleLedState() {
    if (_ledCanYieldToIdleState()) {
        LedState target = _idleLedState();
        if (ledGetState() != target) {
            ledSetState(target);
        }
    }
}

static void _runBootDiagnostics() {
    char details[96];
    unsigned long t0 = 0;

    t0 = millis();
    bool modemOk = _modemConfigured || modemAlive(2);
    bootStateSetCheck(
        BOOT_CHECK_MODEM_ALIVE,
        modemOk,
        millis() - t0,
        modemOk ? "AT OK during boot" : "no modem response during boot"
    );

    t0 = millis();
    bool simOk = _refreshSimIdentity(true);
    bootStateSetCheck(
        BOOT_CHECK_SIM_PRESENT,
        simOk,
        millis() - t0,
        _simNumber[0] ? _simNumber : (_simMcc[0] ? _simMcc : "no SIM identity at boot")
    );

    t0 = millis();
    bool netOk = _networkReady || modemRegistered();
    bootStateSetCheck(
        BOOT_CHECK_NETWORK_REG,
        netOk,
        millis() - t0,
        netOk ? "registered at boot" : "not registered at boot"
    );

    t0 = millis();
    bool batOk = batteryPresent();
    if (batOk) {
        snprintf(details, sizeof(details), "SOC=%d%% V=%dmV", batterySOC(), batteryVoltage_mV());
    } else {
        strncpy(details, "MAX17048 not found at boot", sizeof(details) - 1);
        details[sizeof(details) - 1] = '\0';
    }
    bootStateSetCheck(BOOT_CHECK_BATTERY, batOk, millis() - t0, details);

    t0 = millis();
    bool mqttOk = mqttConnected();
    bootStateSetCheck(
        BOOT_CHECK_MQTT_CONN,
        mqttOk,
        millis() - t0,
        mqttOk ? "connected at boot" : "not connected at boot"
    );

    t0 = millis();
    bool sdOk = storagePresent();
    bootStateSetCheck(
        BOOT_CHECK_SD_CARD,
        sdOk,
        millis() - t0,
        sdOk ? "card present at boot" : "no card at boot"
    );

    t0 = millis();
    bool wifiOk = WiFi.status() == WL_CONNECTED;
    if (wifiOk) {
        String wifiSsid = WiFi.SSID();
        String wifiIp = WiFi.localIP().toString();
        snprintf(details, sizeof(details), "%s %s", wifiSsid.c_str(), wifiIp.c_str());
    } else {
        strncpy(details, "station not connected at boot", sizeof(details) - 1);
        details[sizeof(details) - 1] = '\0';
    }
    bootStateSetCheck(BOOT_CHECK_WIFI_STA, wifiOk, millis() - t0, details);

    _syncBootRuntimeState();
}

static void _maintainConnectivity(unsigned long now) {
    if (now - _lastRecovery < _modemRecoveryIntervalMs) return;
    _lastRecovery = now;

    if (!modemAlive(1)) {
        Serial.println("[RECOVERY] Modem not responding - reinitialising UART");
        _modemConfigured = false;
        _networkReady = false;
        _ipAddr[0] = '\0';
        modemInit();
        if (!modemAlive(3)) {
            ledSetState(LED_ERROR);
            return;
        }
    }

    if (!_modemConfigured) {
        Serial.println("[RECOVERY] Running modem setup");
        if (!modemSetup()) {
            Serial.println("[RECOVERY] modemSetup failed");
            ledSetState(LED_ERROR);
            return;
        }
        _modemConfigured = true;
    }

    _refreshRadioSnapshot();
    if (!modemRegistered()) {
        Serial.println("[RECOVERY] Waiting for LTE registration");
        _networkReady = false;
        _ipAddr[0] = '\0';
        ledSetState(LED_NO_SIGNAL);
        return;
    }

    if (!_configureApn()) {
        _networkReady = false;
        _ipAddr[0] = '\0';
        return;
    }
    if (!modemNetOpen()) {
        Serial.println("[RECOVERY] NETOPEN failed");
        _networkReady = false;
        _ipAddr[0] = '\0';
        return;
    }

    _networkReady = modemGetIP(_ipAddr, sizeof(_ipAddr));
    if (_networkReady) {
        Serial.printf("[RECOVERY] Data link ready, IP: %s\n", _ipAddr);
    } else {
        Serial.println("[RECOVERY] Data link open but IP unavailable yet");
    }
}

// ── Publish status heartbeat ──────────────────────────────────────────────────
void publishStatus(const char* requestedMsgId) {
    char msgId[64];
    char operatorEsc[96];
    char ipAddrEsc[48];
    char resetReasonEsc[32];
    char simNumberEsc[48];
    char simMccEsc[16];
    char wifiSsidEsc[96];
    char wifiIpEsc[48];
    char wifiApSsidEsc[96];
    char wifiApIpEsc[48];
    char modeEsc[24];
    if (requestedMsgId && requestedMsgId[0]) {
        snprintf(msgId, sizeof(msgId), "%s", requestedMsgId);
    } else {
        _genMsgId(msgId, sizeof(msgId));
    }

    snprintf(_statusTopicBuf, sizeof(_statusTopicBuf), "device/%s/status", _cfg.device_id);

    int soc = batterySOC();
    int vmv = batteryVoltage_mV();
    unsigned long uptimeSec = millis() / 1000;
    float chipTempC = temperatureRead();
    wifi_mode_t wifiMode = WiFi.getMode();
    bool wifiStaConnected = WiFi.status() == WL_CONNECTED;
    bool wifiApEnabled = (wifiMode == WIFI_MODE_AP || wifiMode == WIFI_MODE_APSTA);
    String wifiSsid = wifiStaConnected ? WiFi.SSID() : "";
    String wifiIp = wifiStaConnected ? WiFi.localIP().toString() : "";
    long wifiRssi = wifiStaConnected ? WiFi.RSSI() : 0;
    String wifiApSsid = wifiApEnabled ? WiFi.softAPSSID() : "";
    String wifiApIp = wifiApEnabled ? WiFi.softAPIP().toString() : "";
    int wifiClients = wifiApEnabled ? WiFi.softAPgetStationNum() : 0;
    char batteryJson[12];
    char voltageMvJson[12];
    char voltageVJson[24];
    char temperatureJson[24];
    char callNumberEsc[48];
    const char* chargingJson = batteryChargingState() == 1 ? "true"
                             : batteryChargingState() == 0 ? "false"
                             : "null";

    _refreshSimIdentity(false);

    _jsonEscape(_operator, operatorEsc, sizeof(operatorEsc));
    _jsonEscape(_ipAddr, ipAddrEsc, sizeof(ipAddrEsc));
    _jsonEscape(_lastResetReasonText, resetReasonEsc, sizeof(resetReasonEsc));
    _jsonEscape(_simNumber, simNumberEsc, sizeof(simNumberEsc));
    _jsonEscape(_simMcc, simMccEsc, sizeof(simMccEsc));
    _jsonEscape(wifiSsid.c_str(), wifiSsidEsc, sizeof(wifiSsidEsc));
    _jsonEscape(wifiIp.c_str(), wifiIpEsc, sizeof(wifiIpEsc));
    _jsonEscape(wifiApSsid.c_str(), wifiApSsidEsc, sizeof(wifiApSsidEsc));
    _jsonEscape(wifiApIp.c_str(), wifiApIpEsc, sizeof(wifiApIpEsc));
    _jsonEscape(deviceModeName(), modeEsc, sizeof(modeEsc));
    _jsonEscape(_callNumber, callNumberEsc, sizeof(callNumberEsc));

    if (soc >= 0) snprintf(batteryJson, sizeof(batteryJson), "%d", soc);
    else strncpy(batteryJson, "null", sizeof(batteryJson) - 1);
    batteryJson[sizeof(batteryJson) - 1] = '\0';

    if (vmv >= 0) {
        snprintf(voltageMvJson, sizeof(voltageMvJson), "%d", vmv);
        snprintf(voltageVJson, sizeof(voltageVJson), "%.3f", (float)vmv / 1000.0f);
    } else {
        strncpy(voltageMvJson, "null", sizeof(voltageMvJson) - 1);
        voltageMvJson[sizeof(voltageMvJson) - 1] = '\0';
        strncpy(voltageVJson, "null", sizeof(voltageVJson) - 1);
        voltageVJson[sizeof(voltageVJson) - 1] = '\0';
    }

    if (isnan(chipTempC)) {
        strncpy(temperatureJson, "null", sizeof(temperatureJson) - 1);
        temperatureJson[sizeof(temperatureJson) - 1] = '\0';
    } else {
        snprintf(temperatureJson, sizeof(temperatureJson), "%.2f", chipTempC);
    }

    // Nested payload matching modemService.js schema:
    // { mobile: { signalStrength, signalDbm, networkType, operator, ipAddress },
    //   wifi: { mode, connected, ssid, ipAddress, apEnabled, apSsid, apIp, clients },
    //   system: { battery, voltage_mV, charging, uptime, temperature },
    //   sensors: { batteryVoltage_V, chargingIc, fuelGaugeIc, ... },
    //   imei: "...", messageId: "..." }
    snprintf(_statusPayloadBuf, sizeof(_statusPayloadBuf),
        "{"
          "\"mobile\":{"
            "\"signalStrength\":%d,"
            "\"signalDbm\":%d,"
            "\"networkType\":\"LTE\","
            "\"operator\":\"%s\","
            "\"ipAddress\":\"%s\","
            "\"registered\":%s"
          "},"
          "\"wifi\":{"
            "\"mode\":\"%s\","
            "\"connected\":%s,"
            "\"ssid\":\"%s\","
            "\"ipAddress\":\"%s\","
            "\"rssi\":%ld,"
            "\"apEnabled\":%s,"
            "\"apSsid\":\"%s\","
            "\"apIp\":\"%s\","
            "\"clients\":%d"
          "},"
          "\"system\":{"
            "\"battery\":%s,"
            "\"voltage_mV\":%s,"
            "\"charging\":%s,"
            "\"uptime\":%lu,"
            "\"temperature\":%s,"
            "\"resetReason\":\"%s\","
            "\"fuelGaugeIc\":\"MAX17048G\","
            "\"chargingIc\":\"ETA6098\","
            "\"solarChargingIc\":\"CN3791\""
          "},"
          "\"sensors\":{"
            "\"batterySoc\":%s,"
            "\"batteryVoltage_mV\":%s,"
            "\"batteryVoltage_V\":%s,"
            "\"charging\":%s,"
            "\"temperature_C\":%s,"
            "\"fuelGaugeIc\":\"MAX17048G\","
            "\"chargingIc\":\"ETA6098\","
            "\"solarChargingIc\":\"CN3791\""
          "},"
          "\"queues\":{"
            "\"work\":%d,"
            "\"command\":%d,"
            "\"response\":%d,"
            "\"deferred\":%d,"
            "\"mqttInbound\":%d,"
            "\"quietMs\":%lu,"
            "\"pendingUssd\":%s,"
            "\"total\":%d,"
            "\"hasPending\":%s"
          "},"
          "\"call\":{"
            "\"active\":%s,"
            "\"status\":\"%s\","
            "\"number\":\"%s\","
            "\"transportSuspended\":%s"
          "},"
          "\"transport\":{"
            "\"voiceSessionActive\":%s,"
            "\"mqttCommandAccepting\":%s,"
            "\"reason\":\"%s\""
          "},"
          "\"sim\":{"
            "\"number\":\"%s\","
            "\"mcc\":\"%s\""
          "},"
          "\"mode\":\"%s\","
          "\"imei\":\"%s\","
          "\"messageId\":\"%s\""
        "}",
        _rssiToBars(_rssi),
        _rssiToDbm(_rssi),
        operatorEsc,
        ipAddrEsc,
        _networkReady ? "true" : "false",
        _wifiModeToString(wifiMode),
        wifiStaConnected ? "true" : "false",
        wifiSsidEsc,
        wifiIpEsc,
        wifiRssi,
        wifiApEnabled ? "true" : "false",
        wifiApSsidEsc,
        wifiApIpEsc,
        wifiClients,
        batteryJson,
        voltageMvJson,
        chargingJson,
        uptimeSec,
        temperatureJson,
        resetReasonEsc,
        batteryJson,
        voltageMvJson,
        voltageVJson,
        chargingJson,
        temperatureJson,
        fwWorkQueueDepth(),
        commandQueueDepth(),
        commandResponseQueueDepth(),
        _deferredEventQueueDepth(),
        mqttInboundQueueDepth(),
        commandQuietRemainingMs(),
        _ussdPublishPending() ? "true" : "false",
        _systemPendingTaskCount(),
        _systemHasPendingTaskWork() ? "true" : "false",
        (_inCall || _callProgressPollActive || _callNumber[0]) ? "true" : "false",
        _callStatusSummary(),
        callNumberEsc,
        _callDataSessionSuspended ? "true" : "false",
        _callDataSessionSuspended ? "true" : "false",
        _callDataSessionSuspended ? "false" : "true",
        _callDataSessionSuspended ? "voice-session" : "ready",
        simNumberEsc,
        simMccEsc,
        modeEsc,
        _imei,
        msgId
    );

    mqttPublish(_statusTopicBuf, _statusPayloadBuf, 0);  // QoS 0 — high-frequency heartbeat
}

// ── Publish keep-alive heartbeat ─────────────────────────────────────────────
void publishHeartbeat() {
    char msgId[20];
    _genMsgId(msgId, sizeof(msgId));
    snprintf(_heartbeatTopicBuf, sizeof(_heartbeatTopicBuf), "device/%s/heartbeat", _cfg.device_id);
    snprintf(_heartbeatPayloadBuf, sizeof(_heartbeatPayloadBuf), "{\"uptime\":%lu,\"messageId\":\"%s\"}",
             millis() / 1000, msgId);
    mqttPublish(_heartbeatTopicBuf, _heartbeatPayloadBuf, 0);  // QoS 0 — heartbeat loss is acceptable
}

// ── Publish GPS fix ───────────────────────────────────────────────────────────
void publishGps() {
    GpsData fix;
    if (!gpsGetFix(fix)) {
        _gpsHasFix = false;
        _gpsSatellites = 0;
        _gpsHdop = 0.0f;
        return;
    }

    char gpsTimestamp[32];
    _formatGpsTimestamp(fix, gpsTimestamp, sizeof(gpsTimestamp));
    if (!gpsTimestamp[0]) {
        snprintf(gpsTimestamp, sizeof(gpsTimestamp), "%lu", millis() / 1000);
    }

    strncpy(_gpsLastFixIso, gpsTimestamp, sizeof(_gpsLastFixIso) - 1);
    _gpsLastFixIso[sizeof(_gpsLastFixIso) - 1] = '\0';
    _gpsHasFix = true;
    _gpsSatellites = fix.satellites;
    _gpsHdop = fix.hdop;
    _gpsLastFixMs = millis();

    char msgId[20];
    _genMsgId(msgId, sizeof(msgId));
    snprintf(_gpsTopicBuf, sizeof(_gpsTopicBuf), "device/%s/gps/location", _cfg.device_id);
    snprintf(_gpsPayloadBuf, sizeof(_gpsPayloadBuf),
        "{"
          "\"lat\":%.7f,"
          "\"lng\":%.7f,"
          "\"altitude\":%.1f,"
          "\"speed\":%.1f,"
          "\"satellites\":%d,"
          "\"hdop\":%.2f,"
          "\"timestamp\":\"%s\","
          "\"fix\":1,"
          "\"messageId\":\"%s\""
        "}",
        fix.lat, fix.lon, fix.altitude, fix.speed, fix.satellites, fix.hdop, gpsTimestamp, msgId
    );

    mqttPublish(_gpsTopicBuf, _gpsPayloadBuf, 0);
    ledSetState(LED_GPS_FIX);  // teal flash — GPS location published
}

bool publishGpsStatus(const char* messageId) {
    char lastFixJson[48];
    char messageIdJson[96];

    if (_gpsLastFixIso[0]) {
        snprintf(lastFixJson, sizeof(lastFixJson), "\"%s\"", _gpsLastFixIso);
    } else {
        strncpy(lastFixJson, "null", sizeof(lastFixJson) - 1);
        lastFixJson[sizeof(lastFixJson) - 1] = '\0';
    }

    if (messageId && messageId[0]) {
        snprintf(messageIdJson, sizeof(messageIdJson), ",\"messageId\":\"%s\"", messageId);
    } else {
        messageIdJson[0] = '\0';
    }

    snprintf(_gpsStatusTopicBuf, sizeof(_gpsStatusTopicBuf), "device/%s/gps/status", _cfg.device_id);
    snprintf(
        _gpsStatusPayloadBuf,
        sizeof(_gpsStatusPayloadBuf),
        "{"
          "\"enabled\":%s,"
          "\"powered\":%s,"
          "\"fix\":%s,"
          "\"satellites\":%d,"
          "\"lastFix\":%s,"
          "\"powerSave\":%s,"
          "\"updateRate\":%lu,"
          "\"minFixTime\":%lu,"
          "\"hdop\":%.2f"
          "%s"
        "}",
        gpsIsPowered() ? "true" : "false",
        gpsIsPowered() ? "true" : "false",
        _gpsHasFix ? "true" : "false",
        _gpsSatellites,
        lastFixJson,
        _gpsPowerSaveMode ? "true" : "false",
        _gpsUpdateIntervalMs / 1000,
        _gpsMinFixTimeMs / 1000,
        _gpsHdop,
        messageIdJson
    );
    bool hadLock = atBusIsLocked();
    if (hadLock) atBusUnlock();
    bool ok = mqttPublish(_gpsStatusTopicBuf, _gpsStatusPayloadBuf, 0);
    if (hadLock) atBusLock();
    return ok;
}

void publishCapabilities() {
    const bool batteryOk = batteryPresent();
    const bool sdOk = storagePresent();
    const bool gpsOk = _modemConfigured;
    const bool cameraOk = cameraServiceReady();
    snprintf(_capabilitiesTopicBuf, sizeof(_capabilitiesTopicBuf), "device/%s/capabilities", _cfg.device_id);
    snprintf(
        _capabilitiesPayloadBuf,
        sizeof(_capabilitiesPayloadBuf),
        "{"
          "\"firmware\":\"" FIRMWARE_VERSION "\","
          "\"board\":\"" BOARD_SLUG "\","
          "\"mode\":\"%s\","
          "\"supportedModes\":[\"normal\",\"low-power\",\"hotspot\",\"diagnostic\",\"silent\"],"
          "\"caps\":{"
            "\"gps\":%s,"
            "\"battery\":%s,"
            "\"storage\":%s,"
            "\"sd\":%s,"
            "\"display\":%s,"
            "\"audio\":false,"
            "\"camera\":%s,"
            "\"nfc\":false,"
            "\"rfid\":false,"
            "\"touch\":true,"
            "\"keyboard\":false,"
            "\"cellular\":true,"
            "\"sms\":true,"
            "\"calls\":true,"
            "\"ussd\":true,"
            "\"ota\":true,"
            "\"gpio\":true,"
            "\"wifi\":true,"
            "\"charging_detection\":true"
          "},"
          "\"specs\":{"
            "\"build\":{"
              "\"date\":\"" __DATE__ "\","
              "\"time\":\"" __TIME__ "\","
              "\"gitHash\":\"" GIT_HASH "\""
            "},"
            "\"board\":{"
              "\"slug\":\"" BOARD_SLUG "\","
              "\"name\":\"" BOARD_NAME "\","
              "\"vendor\":\"" BOARD_VENDOR "\","
              "\"revision\":\"" BOARD_REVISION "\","
              "\"family\":\"" BOARD_FAMILY "\","
              "\"chip\":\"" BOARD_CHIP "\","
              "\"cpu\":\"" BOARD_CPU "\","
              "\"flash\":\"" BOARD_FLASH "\","
              "\"psram\":\"" BOARD_PSRAM "\""
            "},"
            "\"interfaces\":["
              "\"4G LTE Cat-1 via A7670E-FASE\","
              "\"GNSS via A7670E\","
              "\"Wi-Fi\","
              "\"Bluetooth LE\","
              "\"MicroSD over SPI\","
              "%s"
              "\"WS2812B RGB LED\""
            "],"
            "\"pins\":["
              "{\"label\":\"Modem RX\",\"pin\":17,\"notes\":\"ESP32 <- A7670E TXD via TXB0104PWR\"},"
              "{\"label\":\"Modem TX\",\"pin\":18,\"notes\":\"ESP32 -> A7670E RXD via TXB0104PWR\"},"
              "{\"label\":\"Modem level shifter OE\",\"pin\":21,\"notes\":\"TXB0104PWR enable\"},"
              "{\"label\":\"Battery I2C SDA\",\"pin\":15,\"notes\":\"MAX17048G SDA\"},"
              "{\"label\":\"Battery I2C SCL\",\"pin\":16,\"notes\":\"MAX17048G SCL\"},"
              "{\"label\":\"RGB LED\",\"pin\":38,\"notes\":\"WS2812B data line\"},"
              "{\"label\":\"SD CS\",\"pin\":10,\"notes\":\"MicroSD SPI chip-select\"},"
              "{\"label\":\"SD MOSI\",\"pin\":11,\"notes\":\"MicroSD SPI MOSI\"},"
              "{\"label\":\"SD CLK\",\"pin\":12,\"notes\":\"MicroSD SPI clock\"},"
              "{\"label\":\"SD MISO\",\"pin\":13,\"notes\":\"MicroSD SPI MISO\"}"
            "],"
            "\"ics\":["
              "{\"ref\":\"U3\",\"model\":\"ESP32-S3R8\",\"role\":\"Main MCU\"},"
              "{\"ref\":\"U7A\",\"model\":\"A7670E-FASE\",\"role\":\"4G LTE modem with GNSS\"},"
              "{\"ref\":\"U14\",\"model\":\"TXB0104PWR\",\"role\":\"3.3V <-> 1.8V level shifter\"},"
              "{\"ref\":\"U10\",\"model\":\"MAX17048G\",\"role\":\"Battery fuel gauge\"},"
              "{\"ref\":\"U9\",\"model\":\"ETA6098\",\"role\":\"Li-ion charger\"},"
              "{\"ref\":\"U1\",\"model\":\"CN3791\",\"role\":\"Solar MPPT charger\"},"
              "{\"ref\":\"U11\",\"model\":\"EA3036C\",\"role\":\"3.3V buck regulator\"},"
              "{\"ref\":\"U4\",\"model\":\"CH343P\",\"role\":\"USB-to-UART bridge\"},"
              "{\"ref\":\"U5\",\"model\":\"CH334F\",\"role\":\"USB 2.0 hub\"},"
              "{\"ref\":\"U12\",\"model\":\"FSUSB42UMX\",\"role\":\"USB mux\"}"
            "]"
          "}"
        "}",
        deviceModeName(),
        gpsOk ? "true" : "false",
        batteryOk ? "true" : "false",
        sdOk ? "true" : "false",
        sdOk ? "true" : "false",
        displayAvailable() ? "true" : "false",
        cameraOk ? "true" : "false",
        displayAvailable() ? "\"SSD1306 OLED over I2C\"," : ""
    );
    mqttPublish(_capabilitiesTopicBuf, _capabilitiesPayloadBuf, 1);
}

bool gpsConfigureRuntime(unsigned long updateRateSeconds, unsigned long minFixTimeSeconds, bool powerSave) {
    if (updateRateSeconds < 1) updateRateSeconds = 1;
    if (updateRateSeconds > 3600) updateRateSeconds = 3600;
    if (minFixTimeSeconds > 300) minFixTimeSeconds = 300;

    _gpsUpdateIntervalMs = updateRateSeconds * 1000UL;
    _gpsMinFixTimeMs = minFixTimeSeconds * 1000UL;
    _gpsPowerSaveMode = powerSave;
    return true;
}

void gpsRuntimeUpdatePowerState(bool on) {
    if (on) {
        _gpsPowerOnMs = millis();
        return;
    }

    _gpsHasFix = false;
    _gpsSatellites = 0;
    _gpsHdop = 0.0f;
    _gpsLastFixIso[0] = '\0';
    _gpsLastFixMs = 0;
}

// ── Handle URC lines ──────────────────────────────────────────────────────────
static void processURC(const char* line) {
    // ── Feed MQTT RX state machine ────────────────────────────────────────────
    mqttProcessLine(line);

    // ── Signal strength change (AT+AUTOCSQ URC) ───────────────────────────────
    // +CSQ: <rssi>,<ber>
    if (strncmp(line, "+CSQ:", 5) == 0) {
        _rssi = atoi(line + 5);
        _refreshIdleLedState();
        return;
    }

    // ── Incoming SMS header ───────────────────────────────────────────────────
    // +CMT: "<number>","","<timestamp>"
    if (strncmp(line, "+CMT:", 5) == 0) {
        // Extract phone number between first pair of quotes
        const char* q1 = strchr(line, '"');
        const char* q2 = q1 ? strchr(q1 + 1, '"') : nullptr;
        if (q1 && q2) {
            char rawFrom[64];
            int len = (int)(q2 - q1) - 1;
            if (len >= (int)sizeof(rawFrom)) len = sizeof(rawFrom) - 1;
            strncpy(rawFrom, q1 + 1, len);
            rawFrom[len] = '\0';
            _decodeSmsField(rawFrom, _pendingSmsFrom, sizeof(_pendingSmsFrom));
        }
        _smtHeaderPending = true;
        return;
    }

    if (strncmp(line, "+CMTI:", 6) == 0) {
        const char* comma = strrchr(line, ',');
        int index = comma ? atoi(comma + 1) : -1;
        _queueSmsReadEvent(index);
        return;
    }

    // SMS body (line after +CMT header)
    if (_smtHeaderPending) {
        char decodedBody[JSON_BUF_SIZE];
        _smtHeaderPending = false;
        _decodeSmsField(line, decodedBody, sizeof(decodedBody));
        _queueSmsPublishEvent(_pendingSmsFrom, decodedBody);
        _pendingSmsFrom[0] = '\0';
        return;
    }

    if (strncmp(line, "+CDS:", 5) == 0) {
        char recipient[32];
        recipient[0] = '\0';
        _extractQuotedField(line, 0, recipient, sizeof(recipient));
        if (recipient[0]) {
            char decodedRecipient[32];
            _decodeSmsField(recipient, decodedRecipient, sizeof(decodedRecipient));
            strncpy(recipient, decodedRecipient, sizeof(recipient) - 1);
            recipient[sizeof(recipient) - 1] = '\0';
        }

        const char* lastComma = strrchr(line, ',');
        int statusCode = lastComma ? atoi(lastComma + 1) : -1;
        if (statusCode == 0) {
            _queueSmsDeliveryPublishEvent(recipient, statusCode, line);
        } else {
            Serial.printf("[SMS] Delivery report pending/failed for %s: %s\n", recipient, line);
        }
        return;
    }

    if (strncmp(line, "+CDSI:", 6) == 0) {
        const char* comma = strrchr(line, ',');
        int index = comma ? atoi(comma + 1) : -1;
        _queueSmsDeliveryReadEvent(index);
        return;
    }

    if (_consumeUssdResponseFragment(line)) {
        return;
    }

    // ── Incoming call ring ────────────────────────────────────────────────────
    if (strcmp(line, "RING") == 0) {
        callBeginProgressTracking("incoming", _currentCallNumber());
        ledSetState(LED_CALL_RINGING);  // fast blue blink
        _queueCallStatusEvent("ringing", _currentCallNumber());
        return;
    }

    // Caller ID (follows RING) — +CLIP: "<number>",<type>
    if (strncmp(line, "+CLIP:", 6) == 0) {
        const char* q1 = strchr(line, '"');
        const char* q2 = q1 ? strchr(q1 + 1, '"') : nullptr;
        if (q1 && q2) {
            int len = (int)(q2 - q1) - 1;
            if (len >= (int)sizeof(_callNumber)) len = sizeof(_callNumber) - 1;
            strncpy(_callNumber, q1 + 1, len);
            _callNumber[len] = '\0';
        }
        _inCall = true;
        callBeginProgressTracking("incoming", _callNumber);
        ledSetState(LED_CALL_RINGING);  // keep ringing blink until answered/rejected
        displayNotify("CALL", _callNumber);
        _queueCallStatusEvent("ringing", _callNumber);
        return;
    }

    // ── Call connected (our end answered, or outgoing call picked up) ────────
    if (strcmp(line, "VOICE CALL: BEGIN") == 0) {
        _callStartMs = millis();
        _inCall = true;
        _callProgressPollActive = true;
        _suspendMqttForVoiceSession("voice-call-begin");
        ledSetState(LED_BUSY);  // solid while active
        _queueCallStatusEvent("connected", _callNumber);
        return;
    }

    // ── Call ended ────────────────────────────────────────────────────────────
    // "VOICE CALL: END: <seconds>" or "NO CARRIER" or "NO ANSWER" or "BUSY"
    if (strncmp(line, "VOICE CALL: END:", 16) == 0 ||
        strcmp(line, "NO CARRIER")  == 0 ||
        strcmp(line, "NO ANSWER")   == 0 ||
        strcmp(line, "BUSY")        == 0) {

        // Prefer modem-reported duration; fall back to our own timer
        unsigned long dur = 0;
        if (strncmp(line, "VOICE CALL: END:", 16) == 0) {
            dur = strtoul(line + 17, nullptr, 10);
        } else if (_callStartMs > 0) {
            dur = (millis() - _callStartMs) / 1000;
        }

        const bool wasIncoming = strcmp(_currentCallDirection(), "incoming") == 0;
        const bool wasConnected = _callStartMs > 0;
        const char* finalStatus = "ended";
        if (strcmp(line, "NO ANSWER") == 0 && wasIncoming && !wasConnected) {
            finalStatus = "missed";
        }

        _inCall      = false;
        _callStartMs = 0;
        callStopProgressTracking();
        _resumeMqttAfterVoiceSession();
        _refreshIdleLedState();
        _queueCallStatusEvent(finalStatus, _callNumber, (int)dur);

        _callNumber[0] = '\0';
        _callDirection[0] = '\0';
        return;
    }

    // ── USSD response ─────────────────────────────────────────────────────────
}

// ── Direct HTTP server handlers ───────────────────────────────────────────────
static void _directHandleStatus() {
    char body[1152];
    char callNumberEsc[48];
    char cameraJson[320];
    _jsonEscape(_callNumber, callNumberEsc, sizeof(callNumberEsc));
    _cameraBuildStatusJson(cameraJson, sizeof(cameraJson));
    snprintf(body, sizeof(body),
        "{"
          "\"device_id\":\"%s\","
          "\"firmware\":\"" FIRMWARE_VERSION "\","
          "\"resetReason\":\"%s\","
          "\"uptime\":%lu,"
          "\"signal\":%d,"
          "\"signalDbm\":%d,"
          "\"operator\":\"%s\","
          "\"ip\":\"%s\","
          "\"battery\":%d,"
          "\"imei\":\"%s\","
          "\"gps\":%s,"
          "\"mqtt\":%s,"
          "\"mode\":\"%s\","
          "\"queues\":{"
            "\"work\":%d,"
            "\"command\":%d,"
            "\"response\":%d,"
            "\"deferred\":%d,"
            "\"mqttInbound\":%d,"
            "\"quietMs\":%lu,"
            "\"pendingUssd\":%s,"
            "\"total\":%d,"
            "\"hasPending\":%s"
          "},"
          "\"call\":{"
            "\"active\":%s,"
            "\"status\":\"%s\","
            "\"number\":\"%s\","
            "\"transportSuspended\":%s"
          "},"
          "\"transport\":{"
            "\"voiceSessionActive\":%s,"
            "\"mqttCommandAccepting\":%s,"
            "\"reason\":\"%s\""
          "},"
          "\"camera\":%s"
        "}",
        _cfg.device_id,
        _lastResetReasonText,
        millis() / 1000,
        _rssiToBars(_rssi), _rssiToDbm(_rssi),
        _operator, _ipAddr,
        batterySOC() >= 0 ? batterySOC() : 0,
        _imei,
        gpsIsPowered() ? "true" : "false",
        mqttConnected() ? "true" : "false",
        deviceModeName(),
        fwWorkQueueDepth(),
        commandQueueDepth(),
        commandResponseQueueDepth(),
        _deferredEventQueueDepth(),
        mqttInboundQueueDepth(),
        commandQuietRemainingMs(),
        _ussdPublishPending() ? "true" : "false",
        _systemPendingTaskCount(),
        _systemHasPendingTaskWork() ? "true" : "false",
        (_inCall || _callProgressPollActive || _callNumber[0]) ? "true" : "false",
        _callStatusSummary(),
        callNumberEsc,
        _callDataSessionSuspended ? "true" : "false",
        _callDataSessionSuspended ? "true" : "false",
        _callDataSessionSuspended ? "false" : "true",
        _callDataSessionSuspended ? "voice-session" : "ready",
        cameraJson
    );
    _directServer.send(200, "application/json", body);
}

static void _directHandleConfig() {
    char body[320];
    snprintf(body, sizeof(body),
        "{"
          "\"device_id\":\"%s\","
          "\"firmware\":\"" FIRMWARE_VERSION "\"," 
          "\"board\":\"" BOARD_SLUG "\"," 
          "\"mqtt_host\":\"%s\","
          "\"mqtt_port\":%d,"
          "\"apn\":\"%s\","
          "\"mode\":\"%s\""
        "}",
        _cfg.device_id, _cfg.mqtt_host, _cfg.mqtt_port, _cfg.apn, deviceModeName()
    );
    _directServer.send(200, "application/json", body);
}

static void _directHandleReboot() {
    _directServer.send(200, "application/json", "{\"success\":true,\"message\":\"rebooting\"}");
    delay(500);
    ESP.restart();
}

static void _setupTransportRespond(bool overBle, const char* payload) {
    if (!payload || !*payload) return;

    if (overBle && _setupBleRxChar && _setupBleClientConnected) {
        char framed[JSON_BUF_SIZE];
        snprintf(framed, sizeof(framed), "%s\n", payload);
        _setupBleRxChar->setValue((uint8_t*)framed, strlen(framed));
        _setupBleRxChar->notify();
    } else if (!overBle) {
        Serial.println(payload);
    }
}

static void _queueSetupReboot(unsigned long delayMs) {
    _setupRebootPending = true;
    _setupRebootAt = millis() + delayMs;
}

static void _setupRespondIdentify(bool overBle) {
    char payload[384];
    snprintf(
        payload,
        sizeof(payload),
        "{"
          "\"device_id\":\"%s\","
          "\"chip\":\"" BOARD_CHIP "\","
          "\"board\":\"" BOARD_NAME "\","
          "\"fw_version\":\"" FIRMWARE_VERSION "\","
          "\"imei\":\"%s\","
          "\"configured\":%s,"
          "\"mqtt\":%s,"
          "\"ble\":true,"
          "\"pairing_code\":%d"
        "}",
        _cfg.valid ? _cfg.device_id : "",
        _imei,
        _cfg.valid ? "true" : "false",
        mqttConnected() ? "true" : "false",
        _setupBlePasskey
    );
    _setupTransportRespond(overBle, payload);
}

static bool _setupApplyConfig(JsonDocument& doc, char* error, size_t errorLen) {
    const char* currentDeviceId = _cfg.valid ? _cfg.device_id : "";
    const char* currentMqttHost = _cfg.valid ? _cfg.mqtt_host : "";
    const char* currentMqttUser = _cfg.valid ? _cfg.mqtt_user : "";
    const char* currentMqttPass = _cfg.valid ? _cfg.mqtt_pass : "";
    const char* currentApn      = _cfg.valid ? _cfg.apn : "";
    const char* currentWifiSsid = _cfg.valid ? _cfg.wifi_ssid : "";
    const char* currentWifiPass = _cfg.valid ? _cfg.wifi_pass : "";

    const char* deviceId = doc["device_id"] | currentDeviceId;
    const char* mqttHost = doc["mqtt_host"] | currentMqttHost;
    int mqttPort         = doc["mqtt_port"] | (_cfg.mqtt_port > 0 ? _cfg.mqtt_port : FW_DEFAULT_MQTT_PORT);
    const char* mqttUser = doc["mqtt_user"] | currentMqttUser;
    const char* mqttPass = doc["mqtt_pass"] | currentMqttPass;
    const char* apn      = doc["apn"] | currentApn;
    const char* wifiSsid = doc["wifi_ssid"] | currentWifiSsid;
    const char* wifiPass = doc["wifi_pass"] | currentWifiPass;

    if (!deviceId || !deviceId[0] || !mqttHost || !mqttHost[0]) {
        snprintf(error, errorLen, "device_id and mqtt_host required");
        return false;
    }

    DeviceConfig cfg = {};
    strncpy(cfg.device_id, deviceId, sizeof(cfg.device_id) - 1);
    strncpy(cfg.mqtt_host, mqttHost, sizeof(cfg.mqtt_host) - 1);
    cfg.mqtt_port = (mqttPort > 0 && mqttPort <= 65535) ? mqttPort : FW_DEFAULT_MQTT_PORT;
    strncpy(cfg.mqtt_user, mqttUser ? mqttUser : "", sizeof(cfg.mqtt_user) - 1);
    strncpy(cfg.mqtt_pass, mqttPass ? mqttPass : "", sizeof(cfg.mqtt_pass) - 1);
    strncpy(cfg.apn, apn ? apn : "", sizeof(cfg.apn) - 1);
    strncpy(cfg.wifi_ssid, wifiSsid ? wifiSsid : "", sizeof(cfg.wifi_ssid) - 1);
    strncpy(cfg.wifi_pass, wifiPass ? wifiPass : "", sizeof(cfg.wifi_pass) - 1);
    cfg.valid = true;

    if (!nvsConfigSave(cfg)) {
        snprintf(error, errorLen, "NVS write failed");
        return false;
    }
    return true;
}

static bool _handleSetupTransportLine(const char* line, bool fromBle) {
    if (!line) return false;
    while (*line == ' ' || *line == '\t') line++;
    if (*line != '{') return false;

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, line);
    if (err) {
        _setupTransportRespond(fromBle, "{\"success\":false,\"message\":\"Invalid JSON\"}");
        return true;
    }

    const char* cmd = doc["cmd"] | "";
    if (strcmp(cmd, "identify") == 0) {
        _setupRespondIdentify(fromBle);
        return true;
    }

    if (strcmp(cmd, "configure") == 0) {
        char error[96];
        if (!_setupApplyConfig(doc, error, sizeof(error))) {
            char payload[160];
            snprintf(payload, sizeof(payload),
                "{\"success\":false,\"message\":\"%s\"}",
                error
            );
            _setupTransportRespond(fromBle, payload);
            return true;
        }

        _setupTransportRespond(fromBle, "{\"success\":true,\"message\":\"Config saved - rebooting\"}");
        _queueSetupReboot(800);
        return true;
    }

    _setupTransportRespond(fromBle, "{\"success\":false,\"message\":\"Unknown setup command\"}");
    return true;
}

class _SetupBleSecurityCallbacks : public BLESecurityCallbacks {
public:
    uint32_t onPassKeyRequest() override {
        return _setupBlePasskey;
    }

    void onPassKeyNotify(uint32_t passKey) override {
        Serial.printf("[BLE] Pair using code %lu\n", (unsigned long)passKey);
    }

    bool onSecurityRequest() override {
        return true;
    }

    bool onConfirmPIN(uint32_t passKey) override {
        return passKey == _setupBlePasskey;
    }

#if defined(CONFIG_BLUEDROID_ENABLED)
    void onAuthenticationComplete(esp_ble_auth_cmpl_t desc) override {
        Serial.printf("[BLE] Authentication %s\n", desc.success ? "successful" : "failed");
        if (!desc.success && _setupBleServer && _setupBleServer->getConnectedCount() > 0) {
            _setupBleServer->disconnect(_setupBleServer->getConnId());
        }
    }
#endif

#if defined(CONFIG_NIMBLE_ENABLED)
    void onAuthenticationComplete(ble_gap_conn_desc* desc) override {
        bool ok = desc && desc->sec_state.encrypted;
        Serial.printf("[BLE] Authentication %s\n", ok ? "successful" : "failed");
        if (!ok && _setupBleServer && _setupBleServer->getConnectedCount() > 0) {
            _setupBleServer->disconnect(_setupBleServer->getConnId());
        }
    }
#endif
};

class _SetupBleServerCallbacks : public BLEServerCallbacks {
public:
    void onConnect(BLEServer* server) override {
        (void)server;
        _setupBleClientConnected = true;
        _setupBleAdvertisingActive = false;
        Serial.println("[BLE] Setup client connected");
    }

    void onDisconnect(BLEServer* server) override {
        _setupBleClientConnected = false;
        _setupBleAdvertisingActive = false;
        Serial.println("[BLE] Setup client disconnected");
        if (_setupBleAdvertisingWanted && server) {
            server->startAdvertising();
            _setupBleAdvertisingActive = true;
        }
    }
};

class _SetupBleWriteCallbacks : public BLECharacteristicCallbacks {
public:
    void onWrite(BLECharacteristic* characteristic) override {
        String value = characteristic->getValue();
        for (size_t i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '\r') continue;
            if (c == '\n') {
                if (_setupBleLinePos > 0) {
                    _setupBleLineBuf[_setupBleLinePos] = '\0';
                    _handleSetupTransportLine(_setupBleLineBuf, true);
                    _setupBleLinePos = 0;
                }
                continue;
            }
            if (_setupBleLinePos < sizeof(_setupBleLineBuf) - 1) {
                _setupBleLineBuf[_setupBleLinePos++] = c;
            } else {
                _setupBleLinePos = 0;
                _setupTransportRespond(true, "{\"success\":false,\"message\":\"Setup line too long\"}");
            }
        }
    }
};

static void _setupBleBegin() {
    if (_setupBleInitialized) return;

    fwBuildSetupApSsid(_setupBleName, sizeof(_setupBleName));
    _setupBlePasskey = fwDeriveSetupBlePasskey();

    BLEDevice::init(_setupBleName);

    BLESecurity* security = new BLESecurity();
    security->setPassKey(true, _setupBlePasskey);
    security->setCapability(ESP_IO_CAP_OUT);
    security->setAuthenticationMode(true, true, true);
    security->setInitEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
    security->setRespEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
    security->setKeySize(16);
    BLEDevice::setSecurityCallbacks(new _SetupBleSecurityCallbacks());
#if defined(CONFIG_BLUEDROID_ENABLED)
    BLESecurity::setEncryptionLevel(ESP_BLE_SEC_ENCRYPT_MITM);
#endif

    _setupBleServer = BLEDevice::createServer();
    _setupBleServer->setCallbacks(new _SetupBleServerCallbacks());

    BLEService* service = _setupBleServer->createService(SETUP_BLE_SERVICE_UUID);
    _setupBleTxChar = service->createCharacteristic(
        SETUP_BLE_TX_UUID,
        BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
    );
    _setupBleRxChar = service->createCharacteristic(
        SETUP_BLE_RX_UUID,
        BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ
    );
    _setupBleTxChar->setCallbacks(new _SetupBleWriteCallbacks());
    _setupBleTxChar->setAccessPermissions(ESP_GATT_PERM_WRITE_ENC_MITM);
    _setupBleRxChar->setAccessPermissions(ESP_GATT_PERM_READ_ENC_MITM);
    _setupBleRxChar->addDescriptor(new BLE2902());
    service->start();

    BLEAdvertising* advertising = BLEDevice::getAdvertising();
    advertising->addServiceUUID(SETUP_BLE_SERVICE_UUID);
    advertising->setScanResponse(true);
    advertising->setMinPreferred(0x06);
    advertising->setMaxPreferred(0x12);

    _setupBleInitialized = true;
    Serial.printf("[BLE] Setup service ready: %s (pair code %lu)\n", _setupBleName, (unsigned long)_setupBlePasskey);
}

static void _setupBleStartAdvertising() {
    if (!_setupBleInitialized) {
        _setupBleBegin();
    }
    if (_setupBleAdvertisingActive || _setupBleClientConnected) return;

    _setupBleAdvertisingWanted = true;
    if (BLEDevice::getAdvertising()->start()) {
        _setupBleAdvertisingActive = true;
        Serial.printf("[BLE] Advertising setup service as %s\n", _setupBleName);
    }
}

static void _setupBleStopAdvertising() {
    if (!_setupBleInitialized || !_setupBleAdvertisingActive) return;
    BLEDevice::getAdvertising()->stop();
    _setupBleAdvertisingActive = false;
    Serial.println("[BLE] Setup advertising stopped");
}

static void _setupBleSetEnabled(bool enabled) {
    _setupBleAdvertisingWanted = enabled;
    if (enabled) {
        _setupBleStartAdvertising();
        return;
    }

    _setupBleStopAdvertising();
    if (_setupBleServer && _setupBleServer->getConnectedCount() > 0) {
        _setupBleServer->disconnect(_setupBleServer->getConnId());
    }
}

static void _setupBleTick() {
    if (_setupRebootPending && millis() >= _setupRebootAt) {
        delay(50);
        ESP.restart();
    }
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(500);
    _captureResetReason();
    Serial.println("\n=== ESP32-S3-A7670E-4G Dashboard Firmware ===");
    Serial.printf("[BOOT] Reset reason: %s (%d)\n", _lastResetReasonText, (int)_lastResetReason);

    // NeoPixel (init first so we can blink status during boot)
    ledInit();
    ledSetState(LED_CONNECTING);
    if (deviceLogInit()) {
        deviceLogPrintf("boot", "boot start fw=%s", FIRMWARE_VERSION);
        deviceLogPrintf("boot", "reset reason=%s code=%d", _lastResetReasonText, (int)_lastResetReason);
    }

    // ── Factory reset check (BOOT button held at power-on) ────────────────────
    checkFactoryReset();

    // ── Load config from NVS ─────────────────────────────────────────────────
    nvsConfigLoad(_cfg);
    deviceSetMode(_cfg.mode[0] ? _cfg.mode : "normal", false, nullptr, 0);

    if (!_cfg.valid) {
        // No config anywhere — enter WiFi-AP setup mode
        char setupSsid[32];
        char setupPass[16];
        fwBuildSetupApSsid(setupSsid, sizeof(setupSsid));
        fwBuildSetupApPassword(setupPass, sizeof(setupPass));
        Serial.println("[SETUP] No config found — entering setup mode.");
        Serial.printf("[SETUP] Connect to WiFi AP '%s' with password '%s' then use dashboard onboarding.\n",
                      setupSsid, setupPass);
        deviceLogAppend("boot", "no config found, entering setup mode");
        batteryInit();  // still init battery so /status can report it
        ledSetState(LED_SETUP_MODE);
        setupServerBegin();
        _setupBleBegin();
        _setupBleSetEnabled(true);
        Serial.printf("[SETUP] BLE setup will advertise as '%s' with pairing code %lu.\n",
                      _setupBleName, (unsigned long)_setupBlePasskey);
        // Block here — loop() handles HTTP serving, device reboots on /configure
        return;
    }

    Serial.printf("[CFG] Device ID : %s\n", _cfg.device_id);
    Serial.printf("[CFG] MQTT      : %s:%d\n", _cfg.mqtt_host, _cfg.mqtt_port);
    Serial.printf("[CFG] APN       : %s\n",   _cfg.apn);
    Serial.printf("[CFG] WiFi STA  : %s\n",   _cfg.wifi_ssid[0] ? _cfg.wifi_ssid : "(not configured)");
    Serial.printf("[CFG] Mode      : %s\n",   deviceModeName());
    deviceLogPrintf("boot", "config device=%s mqtt=%s:%d mode=%s", _cfg.device_id, _cfg.mqtt_host, _cfg.mqtt_port, deviceModeName());

      if (cameraServiceInitHardware()) {
          deviceLogAppend("camera", "hardware init ok");
      } else {
          deviceLogPrintf("camera", "hardware init failed err=0x%08lx", (unsigned long)_cameraInitErr);
      }

      // Battery fuel gauge
      batteryInit();
    if (batteryPresent()) {
        Serial.printf("[BAT] SOC=%d%%  V=%d mV\n", batterySOC(), batteryVoltage_mV());
        deviceLogPrintf("battery", "fuel gauge present soc=%d voltage=%d", batterySOC(), batteryVoltage_mV());
    } else {
        Serial.printf("[BAT] MAX17048 not found — check I2C wiring (SDA=GPIO%d, SCL=GPIO%d)\n",
                      I2C_SDA_PIN, I2C_SCL_PIN);
        deviceLogAppend("battery", "fuel gauge not detected");
    }

    // Modem
    Serial.printf("[MDM] Initialising A7670E on Serial1 RX=GPIO%d TX=GPIO%d...\n",
                  MODEM_RX_PIN, MODEM_TX_PIN);
    modemInit();
    deviceLogPrintf("modem", "init rx=%d tx=%d", MODEM_RX_PIN, MODEM_TX_PIN);

    // Wait up to 30s for any byte from the modem (it needs time to boot)
    Serial.print("[MDM] Waiting for modem boot signal...");
    {
        unsigned long t0 = millis();
        bool gotByte = false;
        while (millis() - t0 < 30000) {
            if (Serial1.available()) { gotByte = true; break; }
            delay(100);
        }
        if (gotByte) {
            Serial.println(" got data!");
            // Drain the boot messages
            while (Serial1.available()) {
                char c = Serial1.read();
                if (c >= 0x20 || c == '\n' || c == '\r') Serial.write(c);
            }
        } else {
            Serial.printf(" nothing received on GPIO%d — check DIP SW2-3 (4G) is ON.\n", MODEM_RX_PIN);
            deviceLogAppend("modem", "no boot data from modem within 30s");
        }
    }

    if (!modemAlive(3)) {
        Serial.println("[MDM] No response from modem — retrying in 5s. Check DIP SW2-3 (4G) is ON and NET LED is lit.");
        deviceLogAppend("modem", "modemAlive failed at boot");
        // Dump anything on Serial1 to help diagnose
        if (Serial1.available()) {
            Serial.print("[MDM] Raw Serial1: ");
            while (Serial1.available()) {
                char c = Serial1.read();
                if (c >= 0x20 || c == '\n' || c == '\r') Serial.write(c);
                else Serial.printf("[%02X]", (uint8_t)c);
            }
            Serial.println();
        }
        ledSetState(LED_ERROR);
    }

    else if (!modemSetup()) {
        Serial.println("[MDM] Modem setup failed — will retry from loop");
        deviceLogAppend("modem", "modem setup failed");
        ledSetState(LED_ERROR);
    } else {
        _modemConfigured = true;
        Serial.println("[MDM] Modem OK");
        deviceLogAppend("modem", "modem setup complete");
    }

    _refreshRadioSnapshot();
    Serial.printf("[MDM] Signal: %d (%d dBm)  Operator: %s\n",
                  _rssi, _rssiToDbm(_rssi), _operator);

    // Fetch IMEI before opening data connection
    {
        char imeiResp[32];
        if (atCmdResp("AT+GSN", imeiResp, sizeof(imeiResp), 3000)) {
            strncpy(_imei, imeiResp, sizeof(_imei) - 1);
            _imei[sizeof(_imei) - 1] = '\0';
            Serial.printf("[MDM] IMEI: %s\n", _imei);
        }
    }

    _configureApn();

    // Open TCP/IP stack
    Serial.println("[NET] Opening network stack...");
    if (!modemNetOpen()) {
        Serial.println("[NET] NETOPEN failed — retrying in loop");
    } else {
        _networkReady = modemGetIP(_ipAddr, sizeof(_ipAddr));
        Serial.printf("[NET] IP: %s\n", _networkReady ? _ipAddr : "(pending)");

    }

    // GNSS
    Serial.println("[GPS] Powering GNSS...");
    gpsSetPower(true);
    gpsRuntimeUpdatePowerState(true);

    // ── Direct HTTP server on WiFi ────────────────────────────────────────────
    // Try station mode first (connects to local WiFi so dashboard finds device
    // at its LAN IP). Falls back to soft-AP if no SSID is configured or connect
    // fails after 10 s.
    _directServer.on("/status", HTTP_GET,  _directHandleStatus);
    _directServer.on("/config", HTTP_GET,  _directHandleConfig);
    _directServer.on("/reboot", HTTP_POST, _directHandleReboot);
    _directServer.onNotFound([]() {
        _directServer.send(404, "application/json", "{\"error\":\"not found\"}");
    });
    {
        bool wifiOk = false;
        bool keepAp = (_deviceMode == DEVICE_MODE_HOTSPOT);
#if 0
        Serial.printf("[WiFi] Connecting to %s...", WIFI_SSID);
        WiFi.mode(WIFI_STA);
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        unsigned long wt0 = millis();
        while (WiFi.status() != WL_CONNECTED && millis() - wt0 < 10000) {
            delay(200);
            Serial.print(".");
        }
        if (WiFi.status() == WL_CONNECTED) {
            wifiOk = true;
            Serial.printf(" OK  IP: %s\n", WiFi.localIP().toString().c_str());
        } else {
            Serial.println(" TIMEOUT — falling back to AP");
            WiFi.disconnect(true);
        }
#endif
        if (_cfg.wifi_ssid[0]) {
            Serial.printf("[WiFi] Connecting to %s...", _cfg.wifi_ssid);
            WiFi.mode(keepAp ? WIFI_AP_STA : WIFI_STA);
            if (keepAp) {
                char ssid[32];
                fwBuildDirectApSsid(ssid, sizeof(ssid));
                fwBuildDirectApPassword(_directApPassword, sizeof(_directApPassword));
                WiFi.softAP(ssid, _directApPassword);
            }
            WiFi.begin(_cfg.wifi_ssid, _cfg.wifi_pass);
            unsigned long wt0 = millis();
            while (WiFi.status() != WL_CONNECTED && millis() - wt0 < 10000) {
                delay(200);
                Serial.print(".");
            }
            if (WiFi.status() == WL_CONNECTED) {
                wifiOk = true;
                Serial.printf(" OK  IP: %s\n", WiFi.localIP().toString().c_str());
                if (keepAp) {
                    Serial.printf("[WiFi] Hotspot kept active: %s  Pass: %s  AP IP: %s\n",
                                  WiFi.softAPSSID().c_str(),
                                  _directApPassword,
                                  WiFi.softAPIP().toString().c_str());
                }
            } else {
                Serial.println(" TIMEOUT - falling back to AP");
                WiFi.disconnect(true);
            }
        }
        if (!wifiOk) {
            char ssid[32];
            fwBuildDirectApSsid(ssid, sizeof(ssid));
            fwBuildDirectApPassword(_directApPassword, sizeof(_directApPassword));
            WiFi.mode(WIFI_AP);
            WiFi.softAP(ssid, _directApPassword);
            Serial.printf("[WiFi] AP: %s  Pass: %s  IP: %s\n",
                          ssid, _directApPassword, WiFi.softAPIP().toString().c_str());
        }
    }
    _directServer.begin();
    Serial.printf("[HTTP] Direct HTTP server started\n");

    if (cameraServiceStartServer()) {
        Serial.printf("[CAM] Camera HTTP service started on port %u\n", (unsigned int)cameraServicePort());
        deviceLogPrintf("camera", "service ready port=%u", (unsigned int)cameraServicePort());
    } else if (!cameraServiceReady()) {
        deviceLogPrintf("camera", "service unavailable err=0x%08lx", (unsigned long)_cameraInitErr);
    }

    // SD card
    _sdInitFailed = !storageInit();  // non-fatal if no card
    if (_sdInitFailed) {
        ledSetState(LED_STORAGE_ERROR);
        deviceLogPrintf("storage", "sd init failed: %s", storageLastError() ? storageLastError() : "unknown");
    } else {
        deviceLogPrintf("storage", "sd mounted type=%d sizeMb=%llu",
                        storageCardType(), storageCardSizeBytes() / (1024ULL * 1024ULL));
    }

    // Touch monitoring — default pins (override via touch-monitor command)
    {
        static const int defaultTouchPins[] = { 1, 2, 3 };
        touchInit(defaultTouchPins, 3, 0);  // 3 pins, default threshold
    }

    // OLED display (no-op when ENABLE_DISPLAY is not defined)
    displayInit();

    // MQTT — use NVS-loaded config
    Serial.println("[MQTT] Connecting...");
    mqttSetConfig(_cfg.mqtt_host, _cfg.mqtt_port, _cfg.device_id,
                  _cfg.mqtt_user, _cfg.mqtt_pass);
    mqttSetCallback(commandDispatch);
    if (!mqttConnect()) {
        Serial.println("[MQTT] Initial connect failed — will retry in loop");
        deviceLogAppend("mqtt", "initial connect failed");
    } else {
        Serial.println("[MQTT] Connected");
        _refreshIdleLedState();
        _lastMqttConnect = millis();
        _mqttNeedsStatusPublish = true;
        deviceLogAppend("mqtt", "connected");
    }

    _setupBleSetEnabled(!mqttConnected());
    _runBootDiagnostics();
}

// ── Serial command handler (USB console → AT passthrough / SMS test) ──────────
static char   _serialLineBuf[256];
static int    _serialLinePos = 0;
static bool   _atPassthrough = false;
static unsigned long _atPassthroughEnd = 0;

static void _handleSerialLine(const char* line) {
    if (_handleSetupTransportLine(line, false)) {
        return;
    }

    // "pass" — enter full AT passthrough mode for 60 s
    if (strcasecmp(line, "pass") == 0) {
        _atPassthrough = true;
        _atPassthroughEnd = millis() + 60000;
        Serial.println("[PASS] AT passthrough ON for 60s — type AT commands directly");
        return;
    }

    // "status" — print current device state
    if (strcasecmp(line, "status") == 0) {
        Serial.printf("[STATUS] Signal=%d  Operator=%s  IP=%s  IMEI=%s  MQTT=%s\n",
                      _rssi, _operator, _ipAddr, _imei,
                      mqttConnected() ? "connected" : "disconnected");
        return;
    }

    if (strcasecmp(line, "log-info") == 0) {
        if (!deviceLogAvailable()) {
            Serial.printf("[DLOG] unavailable: %s\n", deviceLogLastError() ? deviceLogLastError() : "unknown");
            return;
        }
        Serial.printf("[DLOG] total=%u used=%u free=%u active=%u archive=%u maxFile=%lu\n",
                      (unsigned int)deviceLogTotalBytes(),
                      (unsigned int)deviceLogUsedBytes(),
                      (unsigned int)deviceLogFreeBytes(),
                      (unsigned int)_deviceLogFileSize(DEVICE_LOG_ACTIVE_PATH),
                      (unsigned int)_deviceLogFileSize(DEVICE_LOG_ARCHIVE_PATH),
                      (unsigned long)DEVICE_LOG_FILE_MAX_BYTES);
        return;
    }

    if (strcasecmp(line, "log-clear") == 0) {
        bool ok = deviceLogClearFiles();
        Serial.printf("[DLOG] clear %s\n", ok ? "ok" : (deviceLogLastError() ? deviceLogLastError() : "failed"));
        return;
    }

    if (strncasecmp(line, "log-test ", 9) == 0) {
        bool ok = deviceLogAppend("test", line + 9);
        Serial.printf("[DLOG] write %s\n", ok ? "ok" : (deviceLogLastError() ? deviceLogLastError() : "failed"));
        return;
    }

    if (strncasecmp(line, "log-read", 8) == 0) {
        size_t offset = 0;
        size_t maxBytes = 512;
        int archiveFlag = 0;
        sscanf(line + 8, "%u %u %d", (unsigned int*)&offset, (unsigned int*)&maxBytes, &archiveFlag);
        char raw[DEVICE_LOG_MAX_READ_BYTES + 1];
        size_t actual = 0;
        size_t fileSize = 0;
        if (!deviceLogReadRaw(archiveFlag != 0, offset, maxBytes, raw, sizeof(raw), &actual, &fileSize)) {
            Serial.printf("[DLOG] read failed: %s\n", deviceLogLastError() ? deviceLogLastError() : "unknown");
            return;
        }
        Serial.printf("[DLOG] read archive=%d offset=%u bytes=%u size=%u\n",
                      archiveFlag != 0 ? 1 : 0,
                      (unsigned int)offset,
                      (unsigned int)actual,
                      (unsigned int)fileSize);
        Serial.print(raw);
        if (actual > 0 && raw[actual - 1] != '\n') {
            Serial.println();
        }
        return;
    }

    // "sms <number> <message>" — send SMS directly via AT
    if (strncasecmp(line, "sms ", 4) == 0) {
        const char* rest = line + 4;
        const char* sp = strchr(rest, ' ');
        if (!sp) { Serial.println("[SMS] Usage: sms <number> <message>"); return; }
        char number[32];
        int nlen = (int)(sp - rest);
        if (nlen >= (int)sizeof(number)) nlen = sizeof(number) - 1;
        strncpy(number, rest, nlen); number[nlen] = '\0';
        const char* msg = sp + 1;

        Serial.printf("[SMS] Sending to %s: %s\n", number, msg);
        atSend("AT+CSMS=1");
        delay(300);
        atSend("AT+CMGF=1");
        delay(500);
        atSend("AT+CSMP=49,167,0,0");
        delay(300);
        atSend("AT+CNMI=2,2,2,0,0");
        delay(300);
        while (Serial1.available()) Serial1.read();

        char smscmd[64];
        snprintf(smscmd, sizeof(smscmd), "AT+CMGS=\"%s\"", number);
        atSend(smscmd);

        // Wait for '>' prompt
        unsigned long t0 = millis();
        bool gotPrompt = false;
        while (millis() - t0 < 5000) {
            if (Serial1.available()) {
                char c = Serial1.read();
                Serial.write(c);
                if (c == '>') { gotPrompt = true; break; }
            }
        }
        if (!gotPrompt) { Serial.println("[SMS] No prompt — check modem/SIM"); return; }

        Serial1.print(msg);
        Serial1.write(0x1A);  // Ctrl-Z to send
        Serial1.flush();
        Serial.println();

        // Wait for +CMGS or error (30 s)
        char resp[128];
        t0 = millis();
        while (millis() - t0 < 30000) {
            if (_readLine(resp, sizeof(resp), 500)) {
                if (strlen(resp)) {
                    Serial.printf("[SMS] < %s\n", resp);
                    if (strstr(resp, "+CMGS:"))  { Serial.println("[SMS] SENT OK"); return; }
                    if (strstr(resp, "ERROR"))   { Serial.println("[SMS] SEND FAILED"); return; }
                }
            }
        }
        Serial.println("[SMS] Timeout waiting for +CMGS");
        return;
    }

    // "at <cmd>" — run a single raw AT command and print the response.
    // Example: "at AT+CSQ"
    if (strncasecmp(line, "at", 2) == 0) {
        const char* cmd = line + 2;
        while (*cmd == ' ') cmd++;
        if (!*cmd) cmd = "AT";

        Serial.printf("[AT] > %s\n", cmd);
        atSend(cmd);
        char resp[128];
        unsigned long t0 = millis();
        while (millis() - t0 < 3000) {
            if (_readLine(resp, sizeof(resp), 300)) {
                if (strlen(resp)) Serial.printf("[AT] < %s\n", resp);
                if (strcmp(resp, "OK") == 0 || strcmp(resp, "ERROR") == 0) break;
            }
        }
        return;
    }

    Serial.println("[CMD] Commands: status | log-info | log-read [offset] [bytes] [archive] | log-clear | log-test <msg> | pass | sms <number> <message> | at <cmd>");
}

static void _serialTick() {
    // AT passthrough mode: raw forward Serial ↔ Serial1
    if (_atPassthrough) {
        if (millis() >= _atPassthroughEnd) {
            _atPassthrough = false;
            Serial.println("[PASS] AT passthrough OFF");
        } else {
            while (Serial.available())  Serial1.write(Serial.read());
            while (Serial1.available()) Serial.write(Serial1.read());
            return;
        }
    }

    // Normal line-mode serial command handler
    while (Serial.available()) {
        char c = Serial.read();
        if (c == '\n' || c == '\r') {
            if (_serialLinePos > 0) {
                _serialLineBuf[_serialLinePos] = '\0';
                _handleSerialLine(_serialLineBuf);
                _serialLinePos = 0;
            }
        } else if (_serialLinePos < (int)sizeof(_serialLineBuf) - 1) {
            _serialLineBuf[_serialLinePos++] = c;
        }
    }
}

// ── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
    // ── Setup mode: serve HTTP clients until /configure is received ───────────
    if (!_cfg.valid) {
        if (ledGetState() != LED_SETUP_MODE) {
            ledSetState(LED_SETUP_MODE);
        }
        setupServerHandle();
        _serialTick();
        _setupBleTick();
        ledTick();
        delay(5);
        return;
    }

    _serialTick();
    if (_atPassthrough) {
        ledTick();
        delay(2);
        return;
    }

    unsigned long now = millis();

    // 1. Read all available URC lines from the modem
    int n = modemPollURC(_loopUrcLines, URC_LINE_MAX);
    for (int i = 0; i < n; i++) {
        processURC(_loopUrcLines[i]);
    }

    const bool commandQuiet = commandQuietActive();

    // Dispatch queued MQTT messages only after the modem RX burst has been
    // fully drained. This avoids starting new AT transactions from inside the
    // CMQTT receive callback while the modem is still delivering RX URCs.
    mqttDispatchQueuedMessages();
    commandsTick();
    _processFwWorkQueue(now, 4, commandQuiet);
    _callProgressPollTick(now);

    if (!commandQuiet && !_callDataSessionSuspended) {
        _maintainConnectivity(now);
    }

    // 2. MQTT reconnect / LED blink
    if (!commandQuiet && !_callDataSessionSuspended && mqttReconnectTick()) {
        _refreshIdleLedState();
        _networkReady = modemGetIP(_ipAddr, sizeof(_ipAddr));
        _lastMqttConnect = now;
        _mqttNeedsStatusPublish = true;
    }
    _setupBleSetEnabled(!mqttConnected());
    _refreshIdleLedState();
    ledTick();
    _syncBootRuntimeState();
    if (!commandQuiet) {
        uint32_t stateChanges = bootStateConsumeChanges();
        if (mqttConnected() && (stateChanges & BOOT_STATE_CHANGED_WIFI)) {
            _publishWifiStatusChange();
        }
    }

    // Give the modem a brief settle window after MQTT reconnect before first publish.
    if (!commandQuiet && mqttConnected() && _mqttNeedsStatusPublish && now - _lastMqttConnect >= 1000) {
        publishStatus();
        publishCapabilities();
        publishGpsStatus();
        _lastStatus = now;
        _mqttNeedsStatusPublish = false;
    }

    // 3. Periodic status publish
    if (!commandQuiet && mqttConnected() && now - _lastStatus >= _statusIntervalMs) {
        _lastStatus = now;
        // Refresh signal (fallback — AUTOCSQ handles live changes)
        if (now - _lastSignal >= SIGNAL_FALLBACK_MS) {
            _lastSignal = now;
            _rssi = modemCSQ();
            modemOperator(_operator, sizeof(_operator));
        }
        publishStatus();
    }

    // 4. Periodic GPS publish (runtime-configurable interval, QoS 0)
    if (!commandQuiet && mqttConnected() && gpsIsPowered() && now - _lastGps >= _effectiveGpsPublishIntervalMs()) {
        _lastGps = now;
        publishGps();
    }

    // 5. Heartbeat ping
    if (!commandQuiet && mqttConnected() && now - _lastHeartbeat >= _heartbeatIntervalMs) {
        _lastHeartbeat = now;
        publishHeartbeat();
    }

    // 6. Periodic GPIO status snapshot
    if (!commandQuiet && mqttConnected() && now - _lastGpioStatus >= _gpioStatusIntervalMs) {
        _lastGpioStatus = now;
        _cmdGpioStatus("");  // unsolicited — empty msgId suppresses command/response
    }

    // 6b. Battery voltage-trend tick (every 5 s — feeds charging detection)
    if (now - _lastBatTick >= BAT_TICK_INTERVAL_MS) {
        _lastBatTick = millis();
        batteryTick();
    }

    // Touch event pump — publish on state change
    if (touchTick()) {
        TouchEvent te;
        while (touchDrainEvent(te)) {
            char touchTopic[TOPIC_BUF_SIZE];
            char touchPayload[128];
            snprintf(touchTopic, sizeof(touchTopic),
                     "device/%s/touch/event", _mqttGetDeviceId());
            snprintf(touchPayload, sizeof(touchPayload),
                     "{\"pin\":%d,\"value\":%lu,\"touched\":%s}",
                     te.pin, (unsigned long)te.value, te.touched ? "true" : "false");
            mqttPublish(touchTopic, touchPayload, 0);
        }
    }

    // 8. OLED display dim/off timer
    displayTick();

    // 9. Periodic OLED status refresh
    if (now - _lastDisplay >= _displayUpdateIntervalMs) {
        _lastDisplay = now;
        displayUpdate(_cfg.device_id,
                      _rssiToBars(_rssi), batterySOC(),
                      "LTE", _ipAddr,
                      mqttConnected(), gpsIsPowered(),
                      now / 1000);
    }

    // 10. Serve direct HTTP clients (WiFi soft-AP)
    _directServer.handleClient();

    // 11. Setup transport maintenance
    _setupBleTick();

    delay(5);  // yield / avoid WDT
}
