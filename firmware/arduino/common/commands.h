#pragma once
// Dispatch incoming MQTT command payloads to AT actions
// Topic format: device/{deviceId}/command/{commandName}

#include <Arduino.h>
#include <ArduinoJson.h>
#include "modem.h"
#include "mqtt_client.h"
#include "boot_state.h"
#include "led.h"
#include "config.h"
#include "storage.h"
#include "device_logs.h"
#include "display.h"

// Forward declarations — defined in firmware.ino (same translation unit)
bool gpsSetPower(bool on);
bool gpsConfigureRuntime(unsigned long updateRateSeconds, unsigned long minFixTimeSeconds, bool powerSave);
void gpsRuntimeUpdatePowerState(bool on);
void publishStatus(const char* msgId = nullptr);
void publishGps();
void publishCapabilities();
bool publishGpsStatus(const char* messageId = nullptr);
void requestStatusPublish(const char* messageId);
void requestGpsStatusPublish(const char* messageId);
void requestGpioStatusPublish(const char* messageId);
bool deviceSetMode(const char* modeName, bool persist, char* statusMsg, size_t statusMsgLen);
const char* deviceModeName();
bool gpsWarmStart();
bool gpsColdStart();
bool gpsHotStart();
bool gpsSetAgps(bool enable);
bool gpsFetchAgps();
bool gpsWaitForFix(GpsData& out, unsigned long timeoutMs, unsigned long pollMs);
int  gpsGetSatelliteCount();
bool ussdWaitForResponse(unsigned long timeoutMs);
void touchInit(const int* pins, int count, uint32_t threshold);
void touchSetThreshold(uint32_t threshold);
bool touchTick();
bool touchDrainEvent(TouchEvent& out);
uint32_t touchReadRaw(int pin);
bool touchAnyPressed();
bool touchIsPinPressed(int pin);
bool touchIsInitialized();
int  touchPinCount();
static void callBeginProgressTracking(const char* direction, const char* number);
static void callStopProgressTracking();
static void _suspendMqttForVoiceSession(const char* reason);
static void _resumeMqttAfterVoiceSession();

// Track the most recent USSD request so async +CUSD URCs can be matched to
// the original command on the dashboard side.
static char _pendingUssdCode[32] = "";
static char _pendingUssdMessageId[64] = "";

struct _RecentReplaySafeCommand {
    char messageId[64];
    char command[32];
    bool success;
    char message[160];
    unsigned long completedAt;
};

struct _PendingCmdResponse {
    char topic[TOPIC_BUF_SIZE];
    char payload[JSON_BUF_SIZE];
    unsigned long queuedAt;
};

struct _PendingCommand {
    char topic[TOPIC_BUF_SIZE];
    char payload[CMD_BUF_SIZE];
    int payloadLen;
    unsigned long queuedAt;
};

#define COMMAND_QUEUE_TTL_MS 120000UL
#define CMD_RESP_QUEUE_MAX 10
static _PendingCmdResponse _pendingCmdResponses[CMD_RESP_QUEUE_MAX];
static int _pendingCmdRespHead = 0;
static int _pendingCmdRespTail = 0;
static _PendingCommand _commandExecSlot = {};
static _PendingCmdResponse _commandRespPublishSlot = {};
static char _smsWaitLineBuf[256];
static unsigned long _commandQuietUntil = 0;
#define COMMAND_QUEUE_MAX 16
static _PendingCommand _pendingCommands[COMMAND_QUEUE_MAX];
static int _pendingCommandHead = 0;
static int _pendingCommandTail = 0;
#define RECENT_REPLAY_SAFE_COMMAND_MAX 16
#define RECENT_REPLAY_SAFE_COMMAND_TTL_MS 600000UL
static _RecentReplaySafeCommand _recentReplaySafeCommands[RECENT_REPLAY_SAFE_COMMAND_MAX];
static int _recentReplaySafeCommandCount = 0;
static char _activeReplaySafeCommand[32] = "";
static char _activeReplaySafeMessageId[64] = "";
static bool _activeReplaySafeEnabled = false;

static bool _commandQueueIsEmpty() {
    return _pendingCommandHead == _pendingCommandTail;
}

static int _commandQueueDepth() {
    int depth = _pendingCommandTail - _pendingCommandHead;
    if (depth < 0) depth += COMMAND_QUEUE_MAX;
    return depth;
}

int commandQueueDepth() {
    return _commandQueueDepth();
}

static void _commandQueueDropExpired(unsigned long now) {
    while (!_commandQueueIsEmpty()) {
        _PendingCommand& pending = _pendingCommands[_pendingCommandHead];
        if ((long)(now - pending.queuedAt) < (long)COMMAND_QUEUE_TTL_MS) break;
        deviceLogPrintf("cmdq", "drop-stale age=%lu topic=%s",
                        now - pending.queuedAt, pending.topic);
        memset(&pending, 0, sizeof(pending));
        _pendingCommandHead = (_pendingCommandHead + 1) % COMMAND_QUEUE_MAX;
    }
}

static bool _commandQueuePush(const char* topic, const char* payload, int payloadLen) {
    int nextTail = (_pendingCommandTail + 1) % COMMAND_QUEUE_MAX;
    if (nextTail == _pendingCommandHead) {
        Serial.println("[CMD] Command queue full");
        deviceLogPrintf("cmdq", "enqueue-full topic=%s", topic ? topic : "");
        return false;
    }

    strncpy(_pendingCommands[_pendingCommandTail].topic, topic ? topic : "", TOPIC_BUF_SIZE - 1);
    _pendingCommands[_pendingCommandTail].topic[TOPIC_BUF_SIZE - 1] = '\0';
    strncpy(_pendingCommands[_pendingCommandTail].payload, payload ? payload : "", CMD_BUF_SIZE - 1);
    _pendingCommands[_pendingCommandTail].payload[CMD_BUF_SIZE - 1] = '\0';
    _pendingCommands[_pendingCommandTail].payloadLen = payloadLen;
    _pendingCommands[_pendingCommandTail].queuedAt = millis();
    _pendingCommandTail = nextTail;
    deviceLogPrintf("cmdq", "enqueue depth=%d topic=%s", _commandQueueDepth(), topic ? topic : "");
    return true;
}

static bool _commandQueuePop(_PendingCommand& out) {
    if (_commandQueueIsEmpty()) return false;
    out = _pendingCommands[_pendingCommandHead];
    memset(&_pendingCommands[_pendingCommandHead], 0, sizeof(_pendingCommands[_pendingCommandHead]));
    _pendingCommandHead = (_pendingCommandHead + 1) % COMMAND_QUEUE_MAX;
    return true;
}

static bool _cmdRespQueueIsEmpty() {
    return _pendingCmdRespHead == _pendingCmdRespTail;
}

static int _cmdRespQueueDepth() {
    int depth = _pendingCmdRespTail - _pendingCmdRespHead;
    if (depth < 0) depth += CMD_RESP_QUEUE_MAX;
    return depth;
}

int commandResponseQueueDepth() {
    return _cmdRespQueueDepth();
}

static void _cmdRespQueueDropExpired(unsigned long now) {
    while (!_cmdRespQueueIsEmpty()) {
        _PendingCmdResponse& pending = _pendingCmdResponses[_pendingCmdRespHead];
        if ((long)(now - pending.queuedAt) < (long)COMMAND_QUEUE_TTL_MS) break;
        deviceLogPrintf("cmdq", "drop-stale-response age=%lu topic=%s",
                        now - pending.queuedAt, pending.topic);
        memset(&pending, 0, sizeof(pending));
        _pendingCmdRespHead = (_pendingCmdRespHead + 1) % CMD_RESP_QUEUE_MAX;
    }
}

static bool _cmdRespQueuePush(const char* topic, const char* payload) {
    int nextTail = (_pendingCmdRespTail + 1) % CMD_RESP_QUEUE_MAX;
    if (nextTail == _pendingCmdRespHead) {
        Serial.println("[CMD] Deferred response queue full");
        deviceLogPrintf("cmdq", "response-full topic=%s", topic ? topic : "");
        return false;
    }

    strncpy(_pendingCmdResponses[_pendingCmdRespTail].topic, topic ? topic : "", TOPIC_BUF_SIZE - 1);
    _pendingCmdResponses[_pendingCmdRespTail].topic[TOPIC_BUF_SIZE - 1] = '\0';
    strncpy(_pendingCmdResponses[_pendingCmdRespTail].payload, payload ? payload : "", JSON_BUF_SIZE - 1);
    _pendingCmdResponses[_pendingCmdRespTail].payload[JSON_BUF_SIZE - 1] = '\0';
    _pendingCmdResponses[_pendingCmdRespTail].queuedAt = millis();
    _pendingCmdRespTail = nextTail;
    deviceLogPrintf("cmdq", "response-enqueue depth=%d topic=%s",
                    _cmdRespQueueDepth(), topic ? topic : "");
    return true;
}

static bool _cmdRespQueuePeek(_PendingCmdResponse& out) {
    if (_cmdRespQueueIsEmpty()) return false;
    out = _pendingCmdResponses[_pendingCmdRespHead];
    return true;
}

static void _cmdRespQueuePop() {
    if (_cmdRespQueueIsEmpty()) return;
    memset(&_pendingCmdResponses[_pendingCmdRespHead], 0, sizeof(_pendingCmdResponses[_pendingCmdRespHead]));
    _pendingCmdRespHead = (_pendingCmdRespHead + 1) % CMD_RESP_QUEUE_MAX;
}

static bool commandQuietActive() {
    return _commandQuietUntil != 0 && (long)(_commandQuietUntil - millis()) > 0;
}

static unsigned long commandQuietRemainingMs() {
    if (!commandQuietActive()) return 0;
    return _commandQuietUntil - millis();
}

bool commandHasPendingWork() {
    return _commandQueueDepth() > 0 || _cmdRespQueueDepth() > 0 || commandQuietActive();
}

static bool _isReplaySafeActionCommand(const char* cmd) {
    if (!cmd || !cmd[0]) return false;

    return !strcmp(cmd, "send-sms") ||
           !strcmp(cmd, "send-ussd") ||
           !strcmp(cmd, "make-call") ||
           !strcmp(cmd, "call-dial") ||
           !strcmp(cmd, "answer-call") ||
           !strcmp(cmd, "reject-call") ||
           !strcmp(cmd, "end-call") ||
           !strcmp(cmd, "hold-call") ||
           !strcmp(cmd, "mute-call") ||
           !strcmp(cmd, "restart") ||
           !strcmp(cmd, "restart-modem") ||
           !strcmp(cmd, "ota-update") ||
           !strcmp(cmd, "storage-write") ||
           !strcmp(cmd, "storage-delete") ||
           !strcmp(cmd, "storage-mkdir") ||
           !strcmp(cmd, "storage-rename") ||
           !strcmp(cmd, "storage-move") ||
           !strcmp(cmd, "storage-copy") ||
           !strcmp(cmd, "storage-format") ||
           !strcmp(cmd, "storage-reinit") ||
           !strcmp(cmd, "gpio-write") ||
           !strcmp(cmd, "gpio-mode") ||
           !strcmp(cmd, "gpio-pwm") ||
           !strcmp(cmd, "led") ||
           !strcmp(cmd, "display-text") ||
           !strcmp(cmd, "display-clear") ||
           !strcmp(cmd, "display-flip") ||
           !strcmp(cmd, "display-invert") ||
           !strcmp(cmd, "display-on") ||
           !strcmp(cmd, "display-off") ||
           !strcmp(cmd, "display-brightness") ||
           !strcmp(cmd, "gps-set-enabled") ||
           !strcmp(cmd, "gps-configure");
}

static void _pruneRecentReplaySafeCommands(unsigned long now) {
    int write = 0;
    for (int i = 0; i < _recentReplaySafeCommandCount; i++) {
        _RecentReplaySafeCommand& entry = _recentReplaySafeCommands[i];
        if (!entry.messageId[0]) continue;
        if ((long)(now - entry.completedAt) >= (long)RECENT_REPLAY_SAFE_COMMAND_TTL_MS) continue;
        if (write != i) {
            _recentReplaySafeCommands[write] = entry;
        }
        write++;
    }
    for (int i = write; i < _recentReplaySafeCommandCount; i++) {
        memset(&_recentReplaySafeCommands[i], 0, sizeof(_recentReplaySafeCommands[i]));
    }
    _recentReplaySafeCommandCount = write;
}

static _RecentReplaySafeCommand* _findReplaySafeCommand(const char* cmd, const char* msgId) {
    if (!_isReplaySafeActionCommand(cmd)) return nullptr;
    if (!msgId || !msgId[0] || !strcmp(msgId, "0")) return nullptr;

    unsigned long now = millis();
    _pruneRecentReplaySafeCommands(now);
    for (int i = 0; i < _recentReplaySafeCommandCount; i++) {
        if (!strcmp(_recentReplaySafeCommands[i].command, cmd) &&
            !strcmp(_recentReplaySafeCommands[i].messageId, msgId)) {
            return &_recentReplaySafeCommands[i];
        }
    }
    return nullptr;
}

static void _rememberReplaySafeCommandResult(const char* cmd, const char* msgId, bool success, const char* msg) {
    if (!_isReplaySafeActionCommand(cmd)) return;
    if (!msgId || !msgId[0] || !strcmp(msgId, "0")) return;

    unsigned long now = millis();
    _pruneRecentReplaySafeCommands(now);

    _RecentReplaySafeCommand* existing = _findReplaySafeCommand(cmd, msgId);
    if (existing) {
        existing->success = success;
        existing->completedAt = now;
        snprintf(existing->message, sizeof(existing->message), "%s", msg ? msg : "");
        return;
    }

    if (_recentReplaySafeCommandCount >= RECENT_REPLAY_SAFE_COMMAND_MAX) {
        memmove(&_recentReplaySafeCommands[0], &_recentReplaySafeCommands[1],
                sizeof(_recentReplaySafeCommands[0]) * (RECENT_REPLAY_SAFE_COMMAND_MAX - 1));
        _recentReplaySafeCommandCount = RECENT_REPLAY_SAFE_COMMAND_MAX - 1;
    }

    _RecentReplaySafeCommand& entry = _recentReplaySafeCommands[_recentReplaySafeCommandCount++];
    memset(&entry, 0, sizeof(entry));
    strncpy(entry.messageId, msgId, sizeof(entry.messageId) - 1);
    strncpy(entry.command, cmd, sizeof(entry.command) - 1);
    entry.success = success;
    snprintf(entry.message, sizeof(entry.message), "%s", msg ? msg : "");
    entry.completedAt = now;
}

static void commandExtendQuietWindow(unsigned long durationMs, const char* reason = nullptr) {
    if (durationMs == 0) return;

    unsigned long now = millis();
    unsigned long candidate = now + durationMs;
    if (!commandQuietActive() || (long)(candidate - _commandQuietUntil) > 0) {
        _commandQuietUntil = candidate;
    }

    if (reason && reason[0]) {
        Serial.printf("[CMD] Quiet window active for %lu ms (%s)\n",
                      commandQuietRemainingMs(), reason);
    }
}

static void _cmdApplyQuietPolicy(const char* cmd) {
    unsigned long quietMs = 8000;

    if (!cmd || !cmd[0]) {
        commandExtendQuietWindow(quietMs, "command");
        return;
    }

    if (!strcmp(cmd, "send-sms")) {
        quietMs = 45000;
    } else if (!strcmp(cmd, "send-ussd")) {
        quietMs = 90000;
    } else if (!strcmp(cmd, "make-call") || !strcmp(cmd, "call-dial") || !strcmp(cmd, "answer-call")) {
        quietMs = 45000;
    } else if (!strcmp(cmd, "reject-call") || !strcmp(cmd, "end-call") || !strcmp(cmd, "hold-call") || !strcmp(cmd, "mute-call")) {
        quietMs = 15000;
    } else if (!strcmp(cmd, "gps-location") || !strcmp(cmd, "gps-status")) {
        quietMs = 15000;
    }

    commandExtendQuietWindow(quietMs, cmd);
}

// ── Pending pin-reset table (auto-reset after duration) ───────────────────────
struct _PinReset { int pin; int resetVal; unsigned long resetAt; };
static _PinReset _pinResets[8];
static int       _pinResetCount = 0;

static void _schedPinReset(int pin, int resetVal, unsigned long delayMs) {
    if (_pinResetCount >= 8) return;
    _pinResets[_pinResetCount++] = { pin, resetVal, millis() + delayMs };
}

static bool _cmdRespond(const char* messageId, bool success, const char* msg);
static void _commandExecute(const char* topic, const char* payload, int payloadLen);

// Call from loop() to apply any pending pin resets
void commandsTick() {
    unsigned long now = millis();
    _commandQueueDropExpired(now);
    _cmdRespQueueDropExpired(now);

    if (_pinResetCount > 0) {
        int remaining = 0;
        for (int i = 0; i < _pinResetCount; i++) {
            if (now >= _pinResets[i].resetAt) {
                digitalWrite(_pinResets[i].pin, _pinResets[i].resetVal);
            } else {
                _pinResets[remaining++] = _pinResets[i];
            }
        }
        _pinResetCount = remaining;
    }

    if (_commandQueuePop(_commandExecSlot)) {
        deviceLogPrintf("cmdq", "execute depth=%d topic=%s", _commandQueueDepth(), _commandExecSlot.topic);
        atBusLock();
        _commandExecute(_commandExecSlot.topic, _commandExecSlot.payload, _commandExecSlot.payloadLen);
        atBusUnlock();
        memset(&_commandExecSlot, 0, sizeof(_commandExecSlot));
    }

    if (mqttConnected()) {
        int publishBudget = 2;
        while (publishBudget-- > 0 && _cmdRespQueuePeek(_commandRespPublishSlot)) {
            if (!mqttPublish(_commandRespPublishSlot.topic, _commandRespPublishSlot.payload, 1)) {
                break;
            }
            Serial.printf("[CMD] Deferred response sent: %s\n", _commandRespPublishSlot.payload);
            _cmdRespQueuePop();
            memset(&_commandRespPublishSlot, 0, sizeof(_commandRespPublishSlot));
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Publish a command response back to the dashboard
// Uses runtime device ID from MQTT config (not compile-time DEVICE_ID macro).
static char _cmdRespTopic[TOPIC_BUF_SIZE];
static char _cmdRespPayload[JSON_BUF_SIZE];
static char _cmdRespEscaped[160];
static char _smsCmdBuf[64];
static char _smsResultBuf[160];
static char _smsUcs2Buf[641];
static void _cmdPublishInternetStatusResponse(const char* msgId);
static bool _cmdRespond(const char* messageId, bool success, const char* msg) {
    int ei = 0;
    for (int i = 0; msg && msg[i] && ei < (int)sizeof(_cmdRespEscaped) - 2; i++) {
        char c = msg[i];
        if (c == '"' || c == '\\') _cmdRespEscaped[ei++] = '\\';
        if (c == '\r') continue;
        if (c == '\n') c = ' ';
        _cmdRespEscaped[ei++] = c;
    }
    _cmdRespEscaped[ei] = '\0';
    if (_activeReplaySafeEnabled &&
        messageId && messageId[0] &&
        !strcmp(_activeReplaySafeMessageId, messageId)) {
        _rememberReplaySafeCommandResult(_activeReplaySafeCommand, messageId, success, _cmdRespEscaped);
    }
    snprintf(_cmdRespTopic, sizeof(_cmdRespTopic), "device/%s/command/response", _mqttGetDeviceId());
    snprintf(_cmdRespPayload, sizeof(_cmdRespPayload),
        "{\"messageId\":\"%s\",\"success\":%s,\"message\":\"%s\"}",
        messageId, success ? "true" : "false", _cmdRespEscaped);
    Serial.printf("[CMD] Respond %s success=%d msg=%s\n", messageId ? messageId : "", success ? 1 : 0, _cmdRespEscaped);
    if (mqttPublish(_cmdRespTopic, _cmdRespPayload, 1)) {
        return true;
    }

    Serial.println("[CMD] Immediate response publish failed, queueing for retry");
    return _cmdRespQueuePush(_cmdRespTopic, _cmdRespPayload);
}

// Extract the command name from the full topic
// "device/1/command/send-sms" → "send-sms"
static const char* _cmdName(const char* topic) {
    const char* p = strstr(topic, "/command/");
    if (!p) return "";
    return p + 9; // skip "/command/"
}

static bool _waitSmsSubmitResult(char* detailBuf, int detailLen, unsigned long timeoutMs = 30000) {
    unsigned long t0 = millis();

    if (detailBuf && detailLen > 0) detailBuf[0] = '\0';

    while (millis() - t0 < timeoutMs) {
        if (_readLine(_smsWaitLineBuf, sizeof(_smsWaitLineBuf), 500)) {
            if (strlen(_smsWaitLineBuf) == 0) continue;
            if (_handleAsyncLineDuringWait(_smsWaitLineBuf)) continue;
            Serial.printf("[SMS] < %s\n", _smsWaitLineBuf);

            if (strstr(_smsWaitLineBuf, "+CMGS:")) {
                if (detailBuf && detailLen > 0) {
                    strncpy(detailBuf, "sent", detailLen - 1);
                    detailBuf[detailLen - 1] = '\0';
                }
                return true;
            }

            if (strstr(_smsWaitLineBuf, "+CMS ERROR:") || strstr(_smsWaitLineBuf, "+CME ERROR:")) {
                if (detailBuf && detailLen > 0) {
                    strncpy(detailBuf, _smsWaitLineBuf, detailLen - 1);
                    detailBuf[detailLen - 1] = '\0';
                }
                return false;
            }

            if (strstr(_smsWaitLineBuf, "ERROR")) {
                if (detailBuf && detailLen > 0) {
                    strncpy(detailBuf, _smsWaitLineBuf, detailLen - 1);
                    detailBuf[detailLen - 1] = '\0';
                }
                return false;
            }
        }
    }

    if (detailBuf && detailLen > 0) {
        strncpy(detailBuf, "send timeout", detailLen - 1);
        detailBuf[detailLen - 1] = '\0';
    }
    return false;
}

static bool _smsCanUsePlainTextMode(const char* src) {
    if (!src) return false;

    const uint8_t* s = reinterpret_cast<const uint8_t*>(src);
    while (*s) {
        uint8_t c = *s++;
        if (c == '\r' || c == '\n' || c == '\t') continue;
        if (c < 0x20 || c > 0x7E) return false;
    }

    return true;
}

static size_t _utf8CodepointCount(const char* src) {
    if (!src) return 0;

    size_t count = 0;
    const uint8_t* s = reinterpret_cast<const uint8_t*>(src);
    while (*s) {
        if (*s < 0x80) {
            s += 1;
        } else if ((*s & 0xE0) == 0xC0 && s[1]) {
            s += 2;
        } else if ((*s & 0xF0) == 0xE0 && s[1] && s[2]) {
            s += 3;
        } else if ((*s & 0xF8) == 0xF0 && s[1] && s[2] && s[3]) {
            s += 4;
        } else {
            s += 1;
        }
        count++;
    }

    return count;
}

static bool _utf8ToUcs2Hex(const char* src, char* dst, size_t dstLen) {
    if (!src || !dst || dstLen < 5) return false;

    size_t out = 0;
    const uint8_t* s = reinterpret_cast<const uint8_t*>(src);
    while (*s) {
        uint32_t cp = 0;
        size_t consumed = 1;

        if (*s < 0x80) {
            cp = *s;
        } else if ((*s & 0xE0) == 0xC0 && s[1]) {
            cp = ((uint32_t)(s[0] & 0x1F) << 6)
               |  (uint32_t)(s[1] & 0x3F);
            consumed = 2;
        } else if ((*s & 0xF0) == 0xE0 && s[1] && s[2]) {
            cp = ((uint32_t)(s[0] & 0x0F) << 12)
               | ((uint32_t)(s[1] & 0x3F) << 6)
               |  (uint32_t)(s[2] & 0x3F);
            consumed = 3;
        } else if ((*s & 0xF8) == 0xF0 && s[1] && s[2] && s[3]) {
            // Text-mode UCS2 on the modem is BMP-oriented. Replace non-BMP
            // code points with '?' instead of emitting invalid hex.
            cp = '?';
            consumed = 4;
        } else {
            cp = '?';
        }

        if (cp > 0xFFFF) cp = '?';
        if (out + 4 >= dstLen) return false;
        snprintf(dst + out, dstLen - out, "%04X", (unsigned int)cp);
        out += 4;
        s += consumed;
    }

    dst[out] = '\0';
    return true;
}

// ── SMS ───────────────────────────────────────────────────────────────────────
static void _cmdSendSms(JsonDocument& doc, const char* msgId) {
    const char* to  = doc["to"]  | "";
    const char* msg = doc["message"] | "";
    if (!to[0] || !msg[0]) {
        _cmdRespond(msgId, false, "missing to or message");
        return;
    }
    if (strlen(to) >= 32) {
        _cmdRespond(msgId, false, "number too long");
        return;
    }
    const bool useUcs2 = !_smsCanUsePlainTextMode(msg);
    const size_t rawLen = strlen(msg);
    const size_t smsUnits = useUcs2 ? _utf8CodepointCount(msg) : rawLen;
    if ((!useUcs2 && smsUnits >= 161) || (useUcs2 && smsUnits >= 153)) {
        _cmdRespond(msgId, false, "message too long");
        return;
    }

    const char* smsPayload = msg;
    int smsPayloadLen = (int)rawLen;
    // Phone number stays ASCII — UCS2 encoding is only for the message body.
    // AT+CMGS always accepts ASCII E.164 numbers regardless of AT+CSCS setting.
    if (useUcs2 && !_utf8ToUcs2Hex(msg, _smsUcs2Buf, sizeof(_smsUcs2Buf))) {
        _cmdRespond(msgId, false, "message encode failed");
        return;
    }
    if (useUcs2) {
        smsPayload = _smsUcs2Buf;
        smsPayloadLen = (int)strlen(_smsUcs2Buf);
    }
    atCmd("AT+CSMS=1", 3000);
    atCmd("AT+CMGF=1", 3000);
    atCmd(useUcs2 ? "AT+CSCS=\"UCS2\"" : "AT+CSCS=\"GSM\"", 3000);
    atCmd(useUcs2 ? "AT+CSMP=49,167,0,8" : "AT+CSMP=49,167,0,0", 3000);
    atCmd("AT+CNMI=2,2,2,0,0", 3000);
    Serial.printf("[SMS] Sending to %s (%d chars, mode=%s)\n",
                  to, (int)smsUnits, useUcs2 ? "ucs2" : "text");

    bool promptReady = false;
    for (int attempt = 0; attempt < 2 && !promptReady; attempt++) {
        _atFlushRx(150);
        // Use the raw ASCII phone number — NOT UCS2-encoded.
        snprintf(_smsCmdBuf, sizeof(_smsCmdBuf), "AT+CMGS=\"%s\"", to);
        atSend(_smsCmdBuf);
        promptReady = atWaitPromptAndSend(smsPayload, smsPayloadLen, 12000);
        if (!promptReady) {
            // Cancel any half-open CMGS state before the retry.
            Serial1.write(0x1B);
            Serial1.flush();
            delay(250);
        }
    }
    if (!promptReady) {
        atCmd("AT+CSCS=\"GSM\"", 3000);
        atCmd("AT+CSMP=49,167,0,0", 3000);
        deviceLogPrintf("sms-out", "to=%s result=prompt-timeout", to);
        _cmdRespond(msgId, false, "prompt timeout");
        return;
    }
    // Send Ctrl-Z to commit
    Serial1.write(0x1A);
    Serial1.flush();

    bool ok = _waitSmsSubmitResult(_smsResultBuf, sizeof(_smsResultBuf), 30000);
    atCmd("AT+CSCS=\"GSM\"", 3000);
    atCmd("AT+CSMP=49,167,0,0", 3000);
    deviceLogPrintf("sms-out", "to=%s result=%s mode=%s", to, _smsResultBuf, useUcs2 ? "ucs2" : "text");
    _cmdRespond(msgId, ok, _smsResultBuf);
    if (ok) ledSetState(LED_SMS_SENT);
}

// ── Calls ─────────────────────────────────────────────────────────────────────
static void _cmdDial(JsonDocument& doc, const char* msgId) {
    const char* num = doc["number"] | "";
    if (!num[0]) { _cmdRespond(msgId, false, "missing number"); return; }
    char cmd[64];
    snprintf(cmd, sizeof(cmd), "ATD%s;", num);
    _suspendMqttForVoiceSession("outgoing-call");
    atSend(cmd);
    deviceLogPrintf("call", "dial number=%s requested=1", num);
    _setCurrentCallNumber(num);
    callBeginProgressTracking("outgoing", _currentCallNumber());
    _queueCallStatusEvent("dialing", _currentCallNumber());
    ledSetState(LED_BUSY);
}

static void _cmdEndCall(const char* msgId) {
    atCmd("AT+CHUP", 3000);
    deviceLogAppend("call", "end requested");
    _cmdRespond(msgId, true, "call ended");
    _queueCallStatusEvent("ending", _currentCallNumber());
    _refreshIdleLedState();
}

static void _cmdAnswerCall(const char* msgId) {
    _suspendMqttForVoiceSession("answer-call");
    bool ok = atCmd("ATA", 5000);
    deviceLogPrintf("call", "answer ok=%d", ok ? 1 : 0);
    _cmdRespond(msgId, ok, ok ? "answered" : "answer failed");
    if (ok) {
        callBeginProgressTracking("incoming", _currentCallNumber());
        _queueCallStatusEvent("answered", _currentCallNumber());
        ledSetState(LED_BUSY);
    } else {
        _resumeMqttAfterVoiceSession();
    }
}

static void _cmdRejectCall(const char* msgId) {
    atCmd("ATH", 3000);
    deviceLogAppend("call", "reject requested");
    callStopProgressTracking();
    _cmdRespond(msgId, true, "rejected");
    _queueCallStatusEvent("rejected", _currentCallNumber());
}

static void _cmdHoldCall(JsonDocument& doc, const char* msgId) {
    bool hold = doc["hold"] | true;
    bool ok = atCmd(hold ? "AT+CHLD=2" : "AT+CHLD=1", 3000);
    _cmdRespond(msgId, ok, ok ? "ok" : "failed");
}

static void _cmdMuteCall(JsonDocument& doc, const char* msgId) {
    bool mute = doc["mute"] | true;
    char cmd[16];
    snprintf(cmd, sizeof(cmd), "AT+CMUT=%d", mute ? 1 : 0);
    bool ok = atCmd(cmd, 3000);
    _cmdRespond(msgId, ok, ok ? (mute ? "muted" : "unmuted") : "mute failed");
}

// ── USSD ──────────────────────────────────────────────────────────────────────
static const char* _wifiEncryptionLabel(int encType) {
    switch (encType) {
        case WIFI_AUTH_OPEN: return "open";
        case WIFI_AUTH_WEP: return "wep";
        case WIFI_AUTH_WPA_PSK: return "WPA-PSK";
        case WIFI_AUTH_WPA2_PSK: return "WPA2-PSK";
        case WIFI_AUTH_WPA_WPA2_PSK: return "WPA/WPA2-PSK";
        case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2-ENT";
#ifdef WIFI_AUTH_WPA3_PSK
        case WIFI_AUTH_WPA3_PSK: return "WPA3-PSK";
#endif
#ifdef WIFI_AUTH_WPA2_WPA3_PSK
        case WIFI_AUTH_WPA2_WPA3_PSK: return "WPA2/WPA3-PSK";
#endif
        default: return "unknown";
    }
}

static void _cmdWifiScan(const char* msgId) {
    int count = WiFi.scanNetworks(false, true);
    if (count < 0) {
        WiFi.scanDelete();
        _cmdRespond(msgId, false, "scan failed");
        return;
    }

    JsonDocument doc;
    JsonArray networks = doc["networks"].to<JsonArray>();
    const int limit = min(count, 12);
    for (int i = 0; i < limit; i++) {
        JsonObject net = networks.add<JsonObject>();
        net["ssid"] = WiFi.SSID(i);
        net["rssi"] = WiFi.RSSI(i);
        net["channel"] = WiFi.channel(i);
        net["bssid"] = WiFi.BSSIDstr(i);
        net["encryption"] = _wifiEncryptionLabel(WiFi.encryptionType(i));
    }
    doc["count"] = count;
    doc["truncated"] = count > limit;

    String payload;
    serializeJson(doc, payload);

    char topic[TOPIC_BUF_SIZE];
    snprintf(topic, sizeof(topic), "device/%s/wifi/scan", _mqttGetDeviceId());
    bool published = mqttPublish(topic, payload.c_str(), 1);
    WiFi.scanDelete();
    _cmdRespond(msgId, published, published ? "scan complete" : "scan publish failed");
}

static void _cmdHotspotClients(const char* msgId) {
    const int count = WiFi.softAPgetStationNum();

    JsonDocument doc;
    doc["count"] = count;
    doc["clients"].to<JsonArray>();

    String payload;
    serializeJson(doc, payload);

    char topic[TOPIC_BUF_SIZE];
    snprintf(topic, sizeof(topic), "device/%s/hotspot/clients", _mqttGetDeviceId());
    bool published = mqttPublish(topic, payload.c_str(), 1);
    _cmdRespond(msgId, published, published ? "clients reported" : "client publish failed");
}

static void _cmdSendUssd(JsonDocument& doc, const char* msgId) {
    const char* code = doc["code"] | "";
    if (!code[0]) { _cmdRespond(msgId, false, "missing code"); return; }
    Serial.printf("[USSD] Command request code=%s msgId=%s\n", code, msgId ? msgId : "");
    deviceLogPrintf("ussd", "request code=%s msgId=%s", code, msgId ? msgId : "");
    strncpy(_pendingUssdCode, code, sizeof(_pendingUssdCode) - 1);
    _pendingUssdCode[sizeof(_pendingUssdCode) - 1] = '\0';
    strncpy(_pendingUssdMessageId, msgId ? msgId : "", sizeof(_pendingUssdMessageId) - 1);
    _pendingUssdMessageId[sizeof(_pendingUssdMessageId) - 1] = '\0';
    char cmd[64];
    snprintf(cmd, sizeof(cmd), "AT+CUSD=1,\"%s\",15", code);
    // Publish the immediate ACK before sending AT+CUSD. On this modem the real
    // +CUSD response can arrive very quickly; if we publish after AT+CUSD, the
    // CMQTT publish transaction can consume that URC before the main URC path
    // sees it.
    _cmdRespond(msgId, true, "sent");
    atCmd("AT+CSCS=\"GSM\"", 3000);
    atCmd("AT+CUSD=2", 3000);  // terminate any stale interactive session first
    _atFlushRx(50);
    atSend(cmd);
    if (!ussdWaitForResponse(60000)) {
        Serial.println("[USSD] No response received within 60s");
        deviceLogPrintf("ussd", "timeout code=%s", code);
    }
}

// ── GPS ───────────────────────────────────────────────────────────────────────
static void _cmdGpsSetEnabled(JsonDocument& doc, const char* msgId) {
    bool en = doc["enabled"] | true;
    bool ok = gpsSetPower(en);
    if (ok) gpsRuntimeUpdatePowerState(en);
    _cmdRespond(msgId, ok, en ? (ok ? "gps on" : "gps on failed") : "gps off");
    if (ok) publishGpsStatus();
}

static void _cmdGpsConfigure(JsonDocument& doc, const char* msgId) {
    unsigned long updateRate = doc["updateRate"] | 10;
    unsigned long minFixTime = doc["minFixTime"] | 30;
    bool powerSave = doc["powerSave"] | false;

    bool ok = gpsConfigureRuntime(updateRate, minFixTime, powerSave);
    _cmdRespond(msgId, ok, ok ? "gps config updated" : "gps config failed");
    if (ok) publishGpsStatus();
}

// ── GPIO ──────────────────────────────────────────────────────────────────────
static void _cmdGpioWrite(JsonDocument& doc, const char* msgId) {
    auto _isSafeGpioOutputPin = [](int candidate) {
        switch (candidate) {
            case 33:
            case 35:
            case 36:
            case 37:
            case 41:
            case 42:
                return true;
            default:
                return false;
        }
    };

    int pin          = doc["pin"]      | -1;
    int val          = doc["value"]    | 0;
    unsigned long dur = (unsigned long)(doc["duration"] | 0);  // hold ms then reset
    if (pin < 0) { _cmdRespond(msgId, false, "missing pin"); return; }
    if (!_isSafeGpioOutputPin(pin)) {
        _cmdRespond(msgId, false, "pin not allowed for output");
        return;
    }
    pinMode(pin, OUTPUT);
    digitalWrite(pin, val ? HIGH : LOW);
    if (dur > 0) _schedPinReset(pin, val ? LOW : HIGH, dur);
    char resp[48];
    snprintf(resp, sizeof(resp), "pin %d = %d%s", pin, val, dur > 0 ? " (timed)" : "");
    _cmdRespond(msgId, true, resp);
}

static void _cmdGpioRead(JsonDocument& doc, const char* msgId) {
    auto _isSafeGpioReadablePin = [](int candidate) {
        switch (candidate) {
            case 33:
            case 35:
            case 36:
            case 37:
            case 39:
            case 41:
            case 42:
                return true;
            default:
                return false;
        }
    };

    int pin = doc["pin"] | -1;
    const char* type = doc["type"] | "digital";
    if (pin < 0) { _cmdRespond(msgId, false, "missing pin"); return; }
    if (!_isSafeGpioReadablePin(pin)) {
        _cmdRespond(msgId, false, "pin not allowed for read");
        return;
    }

    int val = 0;
    char payload[196];
    char topic[TOPIC_BUF_SIZE];
    snprintf(topic, sizeof(topic), "device/%s/gpio/read", _mqttGetDeviceId());
    if (strcmp(type, "analog") == 0) {
        if (pin != 39) {
            _cmdRespond(msgId, false, "analog read supported only on GPIO39");
            return;
        }
        val = analogRead(pin);
        float voltage = ((float)val / 4095.0f) * 3.3f;
        snprintf(payload, sizeof(payload),
            "{\"pin\":%d,\"value\":%d,\"raw\":%d,\"voltage\":%.3f,\"type\":\"analog\",\"messageId\":\"%s\"}",
            pin, val, val, voltage, msgId);
    } else {
        val = digitalRead(pin);
        snprintf(payload, sizeof(payload),
            "{\"pin\":%d,\"value\":%d,\"type\":\"digital\",\"messageId\":\"%s\"}", pin, val, msgId);
    }
    mqttPublish(topic, payload, 1);
    _cmdRespond(msgId, true, "ok");
}

// ── GPIO PWM ──────────────────────────────────────────────────────────────────
// Payload: { pin, duty, freq?, resolution? }
// duty: 0–255 (8-bit default). freq: default 1000 Hz. resolution: default 8.
// To detach PWM from a pin, send { pin, duty: 0 } then use gpio-mode to reconfigure.
static void _cmdGpioPwm(JsonDocument& doc, const char* msgId) {
    auto _isSafeGpioOutputPin = [](int candidate) {
        switch (candidate) {
            case 33:
            case 35:
            case 36:
            case 37:
            case 41:
            case 42:
                return true;
            default:
                return false;
        }
    };

    // Debounce: prevent back-to-back rapid calls causing ledcAttach instability
    static unsigned long _pwmLastMs[50] = {0};
    static constexpr unsigned long PWM_DEBOUNCE_MS = 50;

    int pin  = doc["pin"]        | -1;
    int duty = doc["duty"]       | 0;
    int freq = doc["freq"]       | 1000;
    int res  = doc["resolution"] | 8;   // bits
    if (pin < 0) { _cmdRespond(msgId, false, "missing pin"); return; }
    if (!_isSafeGpioOutputPin(pin)) { _cmdRespond(msgId, false, "pin not allowed for pwm"); return; }
    if (pin >= 0 && pin < 50 && (millis() - _pwmLastMs[pin]) < PWM_DEBOUNCE_MS) {
        _cmdRespond(msgId, false, "pwm busy - retry after 50ms");
        return;
    }
    if (duty < 0) duty = 0;
    if (duty > 255) duty = 255;
    if (freq < 1) freq = 1;
    if (freq > 50000) freq = 50000;
    if (res < 1) res = 1;
    if (res > 14) res = 14;
    // Track which pins currently have LEDC attached to avoid double-attach panics
    static bool _pwmAttached[50] = {false};

    if (duty == 0) {
        // Stop PWM: detach cleanly then reconfigure as input (safe default)
        if (pin < 50 && _pwmAttached[pin]) {
            ledcDetach(pin);
            _pwmAttached[pin] = false;
        }
        pinMode(pin, INPUT);
        if (pin >= 0 && pin < 50) _pwmLastMs[pin] = millis();
        _cmdRespond(msgId, true, "pwm stopped");
        return;
    }

    // Detach first if already attached to avoid panic on re-attach
    if (pin < 50 && _pwmAttached[pin]) {
        ledcDetach(pin);
        _pwmAttached[pin] = false;
        delay(5);
    }

    bool ok = ledcAttach(pin, freq, res);
    if (!ok) {
        _cmdRespond(msgId, false, "ledcAttach failed");
        return;
    }
    _pwmAttached[pin] = true;
    ledcWrite(pin, duty);
    char resp[56];
    snprintf(resp, sizeof(resp), "pin %d pwm duty=%d freq=%dHz res=%dbit", pin, duty, freq, res);
    if (pin >= 0 && pin < 50) _pwmLastMs[pin] = millis();
    _cmdRespond(msgId, true, resp);
}

// ── GPIO mode ─────────────────────────────────────────────────────────────────
static void _cmdGpioMode(JsonDocument& doc, const char* msgId) {
    auto _isSafeGpioReadablePin = [](int candidate) {
        switch (candidate) {
            case 33:
            case 35:
            case 36:
            case 37:
            case 39:
            case 41:
            case 42:
                return true;
            default:
                return false;
        }
    };
    auto _isSafeGpioOutputPin = [](int candidate) {
        switch (candidate) {
            case 33:
            case 35:
            case 36:
            case 37:
            case 41:
            case 42:
                return true;
            default:
                return false;
        }
    };

    int pin = doc["pin"] | -1;
    const char* mode = doc["mode"] | "input";
    if (pin < 0) { _cmdRespond(msgId, false, "missing pin"); return; }
    if (strcmp(mode, "output") == 0) {
        if (!_isSafeGpioOutputPin(pin)) { _cmdRespond(msgId, false, "pin not allowed for output"); return; }
        pinMode(pin, OUTPUT);
    } else if (strcmp(mode, "open_drain") == 0) {
        if (!_isSafeGpioOutputPin(pin)) { _cmdRespond(msgId, false, "pin not allowed for output"); return; }
        pinMode(pin, OUTPUT_OPEN_DRAIN);
    } else if (strcmp(mode, "input_pullup") == 0) {
        if (!_isSafeGpioReadablePin(pin)) { _cmdRespond(msgId, false, "pin not allowed for input"); return; }
        pinMode(pin, INPUT_PULLUP);
    } else if (strcmp(mode, "input_pulldown") == 0) {
        if (!_isSafeGpioReadablePin(pin)) { _cmdRespond(msgId, false, "pin not allowed for input"); return; }
        pinMode(pin, INPUT_PULLDOWN);
    } else {
        if (!_isSafeGpioReadablePin(pin)) { _cmdRespond(msgId, false, "pin not allowed for input"); return; }
        pinMode(pin, INPUT);
    }
    char resp[48];
    snprintf(resp, sizeof(resp), "pin %d mode=%s", pin, mode);
    _cmdRespond(msgId, true, resp);
}

// ── GPIO status — publish state of all user-accessible GPIO ──────────────────
// Free GPIO on ESP32-S3-A7670E-4G expansion header: 33,35,36,37,39,41,42
// msgId may be "" for unsolicited periodic publish (skips command response).
static void _publishGpioStatusEvent(const char* msgId) {
    const int pins[] = {33, 35, 36, 37, 39, 41, 42};
    const int n = 7;
    char topic[TOPIC_BUF_SIZE];
    char payload[256];
    snprintf(topic, sizeof(topic), "device/%s/gpio/status", _mqttGetDeviceId());
    int pos = snprintf(payload, sizeof(payload), "{\"pins\":[");
    for (int i = 0; i < n; i++) {
        pos += snprintf(payload + pos, sizeof(payload) - pos,
                        "%s{\"pin\":%d,\"value\":%d}",
                        i > 0 ? "," : "", pins[i], digitalRead(pins[i]));
    }
    if (msgId && msgId[0]) {
        snprintf(payload + pos, sizeof(payload) - pos, "],\"messageId\":\"%s\"}", msgId);
    } else {
        snprintf(payload + pos, sizeof(payload) - pos, "]}");
    }
    mqttPublish(topic, payload, 0);
}

static void _cmdGpioStatus(const char* msgId) {
    if (msgId && msgId[0]) {
        requestGpioStatusPublish(msgId);
        _cmdRespond(msgId, true, "gpio status scheduled");
        return;
    }
    bool hadLock = atBusIsLocked();
    if (hadLock) atBusUnlock();
    _publishGpioStatusEvent(nullptr);
    if (hadLock) atBusLock();
}

// ── LED ───────────────────────────────────────────────────────────────────────
// Payload: { r, g, b }  → set custom colour (overrides state machine)
//      or: { enabled: false }  → turn LED fully off
//      or: { enabled: true }   → re-enable LED (resumes state machine)
static void _cmdLed(JsonDocument& doc, const char* msgId) {
    if (!doc["enabled"].isNull()) {
        bool en = doc["enabled"] | true;
        ledSetEnabled(en);
        _cmdRespond(msgId, true, en ? "led on" : "led off");
        return;
    }
    int r = doc["r"] | 0;
    int g = doc["g"] | 0;
    int b = doc["b"] | 0;
    ledSet(r, g, b);
    _cmdRespond(msgId, true, "ok");
}

// ── Restart ───────────────────────────────────────────────────────────────────
static void _cmdDisplayText(JsonDocument& doc, const char* msgId) {
    if (!displayAvailable()) {
        _cmdRespond(msgId, false, "display not available");
        return;
    }
    const char* text = doc["text"] | "";
    int x = doc["x"] | 0;
    int y = doc["y"] | 0;
    int size = doc["size"] | 1;
    const char* color = doc["color"] | "white";
    displayDrawText(text, x, y, size, strcmp(color, "black") != 0, true);
    _cmdRespond(msgId, true, "display text updated");
}

static void _cmdDisplayClear(const char* msgId) {
    if (!displayAvailable()) {
        _cmdRespond(msgId, false, "display not available");
        return;
    }
    displayClear();
    _cmdRespond(msgId, true, "display cleared");
}

static void _cmdDisplayFlip(const char* msgId) {
    if (!displayAvailable()) {
        _cmdRespond(msgId, false, "display not available");
        return;
    }
    displayToggleFlip();
    _cmdRespond(msgId, true, "display flipped");
}

static void _cmdDisplayInvert(const char* msgId) {
    if (!displayAvailable()) {
        _cmdRespond(msgId, false, "display not available");
        return;
    }
    displayToggleInvert();
    _cmdRespond(msgId, true, "display inverted");
}

static void _cmdDisplayPower(bool on, const char* msgId) {
    if (!displayAvailable()) {
        _cmdRespond(msgId, false, "display not available");
        return;
    }
    displaySetPower(on);
    _cmdRespond(msgId, true, on ? "display on" : "display off");
}

static void _cmdDisplayBrightness(JsonDocument& doc, const char* msgId) {
    if (!displayAvailable()) {
        _cmdRespond(msgId, false, "display not available");
        return;
    }
    int value = doc["value"] | 255;
    if (value < 0) value = 0;
    if (value > 255) value = 255;
    displaySetContrast((uint8_t)value);
    _cmdRespond(msgId, true, "display brightness updated");
}

static void _cmdRestart(const char* msgId) {
    _cmdRespond(msgId, true, "restarting");
    delay(500);
    ESP.restart();
}

static void _cmdRestartModem(const char* msgId) {
    _cmdRespond(msgId, true, "modem restarting");
    delay(250);
    modemRestart();
}

// ── OTA update ────────────────────────────────────────────────────────────────
// Downloads firmware via A7670E AT+HTTP commands and flashes with Update lib.
#include <Update.h>

static void _publishOtaProgress(int percent, const char* stage, int bytes, int total) {
    char progTopic[TOPIC_BUF_SIZE];
    char progPayload[160];
    snprintf(progTopic, sizeof(progTopic), "device/%s/ota/progress", _mqttGetDeviceId());
    snprintf(
        progPayload,
        sizeof(progPayload),
        "{\"percent\":%d,\"progress\":%d,\"stage\":\"%s\",\"bytes\":%d,\"total\":%d}",
        percent,
        percent,
        stage && stage[0] ? stage : "downloading",
        bytes,
        total
    );
    mqttPublish(progTopic, progPayload, 0);
}

static void _publishOtaStatus(bool success, const char* error) {
    char statusTopic[TOPIC_BUF_SIZE];
    char statusPayload[JSON_BUF_SIZE];
    snprintf(statusTopic, sizeof(statusTopic), "device/%s/ota/status", _mqttGetDeviceId());
    if (success) {
        snprintf(statusPayload, sizeof(statusPayload), "{\"success\":true,\"version\":\"" FIRMWARE_VERSION "\"}");
    } else {
        snprintf(
            statusPayload,
            sizeof(statusPayload),
            "{\"success\":false,\"error\":\"%s\"}",
            error && error[0] ? error : "OTA failed"
        );
    }
    mqttPublish(statusTopic, statusPayload, 0);
    ledSetState(success ? LED_OTA_SUCCESS : LED_OTA_FAILED);
}

static void _cmdOta(JsonDocument& doc, const char* msgId) {
    const char* url = doc["url"] | "";
    if (!url[0]) { _cmdRespond(msgId, false, "missing url"); return; }

    Serial.printf("[OTA] Starting update from %s\n", url);
    ledSetState(LED_OTA);
    _publishOtaProgress(0, "downloading", 0, 0);

    // Step 1: init HTTP on modem
    if (!atCmd("AT+HTTPINIT", 5000)) {
        _publishOtaStatus(false, "HTTPINIT failed");
        _cmdRespond(msgId, false, "HTTPINIT failed"); return;
    }

    char cmd[256];
    snprintf(cmd, sizeof(cmd), "AT+HTTPPARA=\"URL\",\"%s\"", url);
    atCmd(cmd, 3000);
    atCmd("AT+HTTPPARA=\"RECVTO\",30000", 2000);

    // Step 2: GET request
    atSend("AT+HTTPACTION=0");
    // Wait for +HTTPACTION: 0,200,<size>
    char line[128];
    int  fileSize = 0;
    unsigned long t0 = millis();
    while (millis() - t0 < 30000) {
        if (_readLine(line, sizeof(line), 1000)) {
            if (strstr(line, "+HTTPACTION: 0,200,")) {
                char* p = strrchr(line, ',');
                if (p) fileSize = atoi(p + 1);
                break;
            }
            if (strstr(line, "+HTTPACTION:") && !strstr(line, ",200,")) {
                atCmd("AT+HTTPTERM", 2000);
                _publishOtaStatus(false, "HTTP error");
                _cmdRespond(msgId, false, "HTTP error");
                return;
            }
        }
    }
    if (fileSize <= 0) {
        atCmd("AT+HTTPTERM", 2000);
        _publishOtaStatus(false, "no file size");
        _cmdRespond(msgId, false, "no file size");
        return;
    }

    // Step 3: stream response into Update
    if (!Update.begin(fileSize)) {
        atCmd("AT+HTTPTERM", 2000);
        _publishOtaStatus(false, "Update.begin failed");
        _cmdRespond(msgId, false, "Update.begin failed");
        return;
    }

    // Read in 1 KB chunks via AT+HTTPREAD=<offset>,<size>
    const int CHUNK = 1024;
    int offset = 0;
    int lastPct = -1;
    char readCmd[64];
    while (offset < fileSize) {
        int remaining = fileSize - offset;
        int toRead = remaining > CHUNK ? CHUNK : remaining;
        snprintf(readCmd, sizeof(readCmd), "AT+HTTPREAD=%d,%d", offset, toRead);
        atSend(readCmd);
        // Wait for +HTTPREAD: <len>
        bool gotHeader = false;
        t0 = millis();
        while (millis() - t0 < 5000) {
            if (_readLine(line, sizeof(line), 500)) {
                if (strstr(line, "+HTTPREAD:")) { gotHeader = true; break; }
            }
        }
        if (!gotHeader) {
            _publishOtaStatus(false, "HTTPREAD header timeout");
            break;
        }
        // Read raw bytes
        uint8_t buf[CHUNK];
        int received = 0;
        t0 = millis();
        while (received < toRead && millis() - t0 < 5000) {
            if (Serial1.available()) {
                buf[received++] = Serial1.read();
            }
        }
        if (received <= 0) {
            _publishOtaStatus(false, "HTTPREAD payload timeout");
            break;
        }
        size_t written = Update.write(buf, received);
        if (written != (size_t)received) {
            _publishOtaStatus(false, Update.errorString());
            break;
        }
        offset += received;

        // Publish progress every ~10%
        int pct = (int)((float)offset / fileSize * 100);
        if (pct / 10 != lastPct / 10) {
            lastPct = pct;
            _publishOtaProgress(pct, "downloading", offset, fileSize);
        }
    }

    atCmd("AT+HTTPTERM", 2000);

    if (offset < fileSize) {
        Update.abort();
        _cmdRespond(msgId, false, "download incomplete");
        return;
    }

    _publishOtaProgress(100, "verifying", offset, fileSize);

    if (!Update.end() || !Update.isFinished()) {
        _publishOtaStatus(false, Update.errorString());
        _cmdRespond(msgId, false, Update.errorString());
        return;
    }

    Serial.println("[OTA] Complete — rebooting");
    _publishOtaStatus(true, nullptr);
    _cmdRespond(msgId, true, "flashed, rebooting");
    delay(1800);
    ESP.restart();
}

// ── Storage ───────────────────────────────────────────────────────────────────
static void _cmdStorageList(JsonDocument& doc, const char* msgId) {
    const char* path = doc["path"] | "/";
    storageList(path, _mqttGetDeviceId(), msgId);
}

static void _cmdStorageInfo(const char* msgId) {
    storageInfo(_mqttGetDeviceId(), msgId);
}

static void _cmdStorageRead(JsonDocument& doc, const char* msgId) {
    const char* path = doc["path"] | "";
    int offset   = doc["offset"]   | 0;
    int maxBytes = doc["maxBytes"] | 512;
    if (!path[0]) { _cmdRespond(msgId, false, "missing path"); return; }
    storageRead(path, _mqttGetDeviceId(), msgId, offset, maxBytes);
}

static void _cmdStorageWrite(JsonDocument& doc, const char* msgId) {
    const char* path   = doc["path"]   | "";
    const char* data   = doc["data"]   | "";
    bool        append = doc["append"] | false;
    if (!path[0]) { _cmdRespond(msgId, false, "missing path"); return; }
    bool ok = storageWrite(path, data, (int)strlen(data), append, _mqttGetDeviceId(), msgId);
    if (!ok) ledSetState(LED_STORAGE_ERROR);
}

static void _cmdStorageDelete(JsonDocument& doc, const char* msgId) {
    const char* path = doc["path"] | "";
    if (!path[0]) { _cmdRespond(msgId, false, "missing path"); return; }
    bool ok = storageDelete(path, _mqttGetDeviceId(), msgId);
    if (!ok) ledSetState(LED_STORAGE_ERROR);
}

static void _cmdStorageMkdir(JsonDocument& doc, const char* msgId) {
    const char* path = doc["path"] | "";
    const char* name = doc["name"] | "";
    char finalPath[160];
    if (name[0]) {
        snprintf(finalPath, sizeof(finalPath), "%s%s%s",
                 path[0] ? path : "/",
                 (path[0] && path[strlen(path) - 1] == '/') ? "" : "/",
                 name);
    } else {
        strncpy(finalPath, path, sizeof(finalPath) - 1);
        finalPath[sizeof(finalPath) - 1] = '\0';
    }
    if (!finalPath[0]) { _cmdRespond(msgId, false, "missing path"); return; }
    bool ok = storageMkdir(finalPath);
    _cmdRespond(msgId, ok, ok ? "directory created" : (storageLastError() ? storageLastError() : "mkdir failed"));
    if (!ok) ledSetState(LED_STORAGE_ERROR);
}

static void _cmdStorageRename(JsonDocument& doc, const char* msgId) {
    const char* oldPath = doc["oldPath"] | "";
    const char* newPath = doc["newPath"] | "";
    const char* newName = doc["newName"] | "";
    char computedNewPath[160];
    computedNewPath[0] = '\0';
    if (newPath[0]) {
        strncpy(computedNewPath, newPath, sizeof(computedNewPath) - 1);
        computedNewPath[sizeof(computedNewPath) - 1] = '\0';
    } else if (oldPath[0] && newName[0]) {
        strncpy(computedNewPath, oldPath, sizeof(computedNewPath) - 1);
        computedNewPath[sizeof(computedNewPath) - 1] = '\0';
        char* slash = strrchr(computedNewPath, '/');
        if (slash && slash != computedNewPath) {
            *(slash + 1) = '\0';
            strncat(computedNewPath, newName, sizeof(computedNewPath) - strlen(computedNewPath) - 1);
        } else {
            snprintf(computedNewPath, sizeof(computedNewPath), "/%s", newName);
        }
    }
    if (!oldPath[0] || !computedNewPath[0]) { _cmdRespond(msgId, false, "missing oldPath or newPath"); return; }
    bool ok = storageRename(oldPath, computedNewPath);
    _cmdRespond(msgId, ok, ok ? "renamed" : (storageLastError() ? storageLastError() : "rename failed"));
    if (!ok) ledSetState(LED_STORAGE_ERROR);
}

static void _cmdStorageMove(JsonDocument& doc, const char* msgId) {
    JsonArray items = doc["items"].as<JsonArray>();
    const char* destination = doc["destination"] | "";
    if (items.isNull() || items.size() == 0 || !destination[0]) {
        _cmdRespond(msgId, false, "missing items or destination");
        return;
    }

    bool allOk = true;
    for (JsonVariant value : items) {
        const char* source = value | "";
        if (!source[0]) continue;
        char targetPath[160];
        const char* baseName = strrchr(source, '/');
        snprintf(targetPath, sizeof(targetPath), "%s/%s", destination, baseName ? baseName + 1 : source);
        if (!storageMove(source, targetPath)) {
            allOk = false;
            break;
        }
    }

    _cmdRespond(msgId, allOk, allOk ? "items moved" : (storageLastError() ? storageLastError() : "move failed"));
    if (!allOk) ledSetState(LED_STORAGE_ERROR);
}

static void _cmdStorageCopy(JsonDocument& doc, const char* msgId) {
    JsonArray items = doc["items"].as<JsonArray>();
    const char* destination = doc["destination"] | "";
    if (items.isNull() || items.size() == 0 || !destination[0]) {
        _cmdRespond(msgId, false, "missing items or destination");
        return;
    }

    bool allOk = true;
    for (JsonVariant value : items) {
        const char* source = value | "";
        if (!source[0]) continue;
        char targetPath[160];
        const char* baseName = strrchr(source, '/');
        snprintf(targetPath, sizeof(targetPath), "%s/%s", destination, baseName ? baseName + 1 : source);
        if (!storageCopy(source, targetPath)) {
            allOk = false;
            break;
        }
    }

    _cmdRespond(msgId, allOk, allOk ? "items copied" : (storageLastError() ? storageLastError() : "copy failed"));
    if (!allOk) ledSetState(LED_STORAGE_ERROR);
}

static void _cmdStorageFormat(const char* msgId) {
    bool ok = storageFormat(_mqttGetDeviceId(), msgId);
    deviceLogPrintf("storage", "format requested ok=%d", ok ? 1 : 0);
    _cmdRespond(msgId, ok, ok ? "storage formatted" : "storage format failed");
    if (!ok) ledSetState(LED_STORAGE_ERROR);
}

static void _cmdDeviceLogInfo(const char* msgId) {
    deviceLogInfo(_mqttGetDeviceId(), msgId);
}

static void _cmdDeviceLogRead(JsonDocument& doc, const char* msgId) {
    bool archive = doc["archive"] | false;
    int offset = doc["offset"] | 0;
    int maxBytes = doc["maxBytes"] | DEVICE_LOG_MAX_READ_BYTES;
    if (offset < 0) offset = 0;
    if (maxBytes < 1) maxBytes = DEVICE_LOG_MAX_READ_BYTES;
    deviceLogRead(archive, (size_t)offset, (size_t)maxBytes, _mqttGetDeviceId(), msgId);
}

static void _cmdDeviceLogClear(const char* msgId) {
    bool ok = deviceLogClear(_mqttGetDeviceId(), msgId);
    _cmdRespond(msgId, ok, ok ? "device log cleared" : (deviceLogLastError() ? deviceLogLastError() : "clear failed"));
}

static void _cmdSetMode(JsonDocument& doc, const char* msgId) {
    const char* mode = doc["mode"] | "";
    if (!mode[0]) {
        char buf[48];
        snprintf(buf, sizeof(buf), "current mode: %s", deviceModeName());
        _cmdRespond(msgId, true, buf);
        return;
    }

    char status[64];
    bool ok = deviceSetMode(mode, true, status, sizeof(status));
    _cmdRespond(msgId, ok, status);
}

// ── Self-test ─────────────────────────────────────────────────────────────────
// Runs a series of AT-based hardware checks and publishes each result to
// device/{id}/test/result. Tests: modem-alive, sim-present, network-reg,
// battery, mqtt-conn.
static void _cmdRunDeviceTest(const char* msgId) {
    char runId[20];
    snprintf(runId, sizeof(runId), "%08lx%08lx",
             (unsigned long)esp_random(), (unsigned long)esp_random());

    const BootRuntimeState& state = bootStateSnapshot();
    if (!bootStateDiagnosticsReady()) {
        _cmdRespond(msgId, false, "boot diagnostics not ready");
        return;
    }

    char resTopic[TOPIC_BUF_SIZE];
    snprintf(resTopic, sizeof(resTopic), "device/%s/test/result", _mqttGetDeviceId());
    char progressTopic[TOPIC_BUF_SIZE];
    snprintf(progressTopic, sizeof(progressTopic), "device/%s/test/progress", _mqttGetDeviceId());

    int totalChecks = 0;
    for (int checkId = 0; checkId < BOOT_CHECK_COUNT; checkId++) {
        const BootCheckResult* check = bootStateGetCheck((BootCheckId)checkId);
        if (check && check->valid) totalChecks++;
    }

    // Helper lambda equivalent: publish one test result
    auto _pub = [&](int testNum, const char* testId, const char* testName,
                    bool pass, unsigned long durMs, const char* details) {
        char p[256];
        snprintf(p, sizeof(p),
            "{\"runId\":\"%s\",\"testId\":\"%s\",\"testName\":\"%s\","
            "\"result\":\"%s\",\"status\":\"complete\","
            "\"duration\":%lu,\"details\":\"%s\","
            "\"sequence\":%d,\"timestamp\":%lu}",
            runId, testId, testName,
            pass ? "pass" : "fail",
            durMs, details,
            testNum, millis() / 1000);
        mqttPublish(resTopic, p, 1);
    };

    auto _pubProgress = [&](int sequence, const char* testId, const char* testName, const char* stage) {
        char p[256];
        int percent = totalChecks > 0 ? (sequence * 100) / totalChecks : 100;
        snprintf(p, sizeof(p),
            "{\"runId\":\"%s\",\"testId\":\"%s\",\"testName\":\"%s\","
            "\"stage\":\"%s\",\"sequence\":%d,\"total\":%d,\"percent\":%d,"
            "\"timestamp\":%lu}",
            runId, testId, testName, stage,
            sequence, totalChecks, percent, millis() / 1000);
        mqttPublish(progressTopic, p, 0);
    };

    int seq = 1;
    for (int checkId = 0; checkId < BOOT_CHECK_COUNT; checkId++) {
        const BootCheckResult* check = bootStateGetCheck((BootCheckId)checkId);
        if (!check || !check->valid) continue;

        _pubProgress(
            seq,
            bootCheckIdString((BootCheckId)checkId),
            bootCheckNameString((BootCheckId)checkId),
            "running"
        );

        bool pass = check->pass;
        const char* details = check->details;

        // Dynamic runtime state can drift after boot; prefer the current in-memory state
        // for checks that naturally change while still preserving the boot snapshot details.
        if (checkId == BOOT_CHECK_NETWORK_REG) {
            pass = state.networkReady;
            details = state.networkReady ? "registered (runtime state)" : check->details;
        } else if (checkId == BOOT_CHECK_MQTT_CONN) {
            pass = state.mqttConnected;
            details = state.mqttConnected ? "connected (runtime state)" : check->details;
        } else if (checkId == BOOT_CHECK_SD_CARD) {
            pass = state.sdPresent;
            details = state.sdPresent ? "card present (runtime state)" : check->details;
        } else if (checkId == BOOT_CHECK_WIFI_STA) {
            pass = state.wifiStationConnected;
            details = state.wifiStationConnected ? state.wifiIp : check->details;
        }

        _pub(
            seq++,
            bootCheckIdString((BootCheckId)checkId),
            bootCheckNameString((BootCheckId)checkId),
            pass,
            check->durationMs,
            details && details[0] ? details : "n/a"
        );

        _pubProgress(
            seq,
            bootCheckIdString((BootCheckId)checkId),
            bootCheckNameString((BootCheckId)checkId),
            "complete"
        );
    }

    {
        char p[192];
        snprintf(p, sizeof(p),
            "{\"runId\":\"%s\",\"stage\":\"complete\",\"sequence\":%d,"
            "\"total\":%d,\"percent\":100,\"timestamp\":%lu}",
            runId, totalChecks, totalChecks, millis() / 1000);
        mqttPublish(progressTopic, p, 0);
    }

    // Summary response
    _cmdRespond(msgId, true, "boot diagnostics published");
}

// ── SMS delete ────────────────────────────────────────────────────────────────
// Payload: { "all": true }  → AT+CMGDA=6 (delete all read+sent+unsent stored)
//          { "index": N }   → AT+CMGD=N  (delete specific stored SMS by index)
static void _cmdSmsDelete(JsonDocument& doc, const char* msgId) {
    char cmd[32];
    if (doc["all"] | false) {
        // Delete all read, sent, and unsent messages (flag 6 = delflag 4 + 2)
        bool ok = atCmd("AT+CMGDA=\"DEL ALL\"", 8000);
        if (!ok) ok = atCmd("AT+CMGDA=6", 8000); // numeric fallback
        _cmdRespond(msgId, ok, ok ? "all sms deleted" : "delete failed");
    } else {
        int idx = doc["index"] | -1;
        if (idx < 0) { _cmdRespond(msgId, false, "missing index or all"); return; }
        snprintf(cmd, sizeof(cmd), "AT+CMGD=%d", idx);
        bool ok = atCmd(cmd, 5000);
        _cmdRespond(msgId, ok, ok ? "sms deleted" : "delete failed");
    }
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
static void _commandExecute(const char* topic, const char* payload, int /*payloadLen*/) {
    const char* cmd = _cmdName(topic);
    if (!cmd[0]) return;
    Serial.printf("[CMD] RX topic=%s payload=%s\n", topic ? topic : "", payload ? payload : "");

    // Check it's addressed to this device (runtime device ID, not compile-time macro)
    char expected[TOPIC_BUF_SIZE];
    snprintf(expected, sizeof(expected), "device/%s/command/", _mqttGetDeviceId());
    if (!strstr(topic, expected)) return;
    if (!strcmp(cmd, "response")) {
        Serial.println("[CMD] Ignoring command response echo");
        return;
    }

    // Parse JSON — commands without payloads are OK to parse (will get empty doc)
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (err && payload[0] != '\0') {
        Serial.printf("[CMD] JSON parse error: %s\n", err.c_str());
        return;
    }

    const char* msgId = doc["messageId"] | "0";
    _RecentReplaySafeCommand* replayEntry = _findReplaySafeCommand(cmd, msgId);
    if (replayEntry) {
        deviceLogPrintf("cmdq", "duplicate cmd=%s msgId=%s", cmd, msgId);
        _cmdRespond(msgId, replayEntry->success, replayEntry->message);
        return;
    }
    _cmdApplyQuietPolicy(cmd);

    bool replaySafe = _isReplaySafeActionCommand(cmd) &&
                      msgId && msgId[0] && strcmp(msgId, "0") != 0;
    if (replaySafe) {
        _activeReplaySafeEnabled = true;
        strncpy(_activeReplaySafeCommand, cmd, sizeof(_activeReplaySafeCommand) - 1);
        _activeReplaySafeCommand[sizeof(_activeReplaySafeCommand) - 1] = '\0';
        strncpy(_activeReplaySafeMessageId, msgId, sizeof(_activeReplaySafeMessageId) - 1);
        _activeReplaySafeMessageId[sizeof(_activeReplaySafeMessageId) - 1] = '\0';
    } else {
        _activeReplaySafeEnabled = false;
        _activeReplaySafeCommand[0] = '\0';
        _activeReplaySafeMessageId[0] = '\0';
    }

    bool handled = true;
    if      (!strcmp(cmd, "send-sms"))        _cmdSendSms(doc, msgId);
    else if (!strcmp(cmd, "sms-delete"))      _cmdSmsDelete(doc, msgId);
    else if (!strcmp(cmd, "make-call") ||
             !strcmp(cmd, "call-dial"))        _cmdDial(doc, msgId);
    else if (!strcmp(cmd, "end-call"))        _cmdEndCall(msgId);
    else if (!strcmp(cmd, "answer-call"))     _cmdAnswerCall(msgId);
    else if (!strcmp(cmd, "reject-call"))     _cmdRejectCall(msgId);
    else if (!strcmp(cmd, "hold-call"))       _cmdHoldCall(doc, msgId);
    else if (!strcmp(cmd, "mute-call"))       _cmdMuteCall(doc, msgId);
    else if (!strcmp(cmd, "send-ussd"))       _cmdSendUssd(doc, msgId);
    else if (!strcmp(cmd, "wifi-scan"))       _cmdWifiScan(msgId);
    else if (!strcmp(cmd, "hotspot-clients")) _cmdHotspotClients(msgId);
    else if (!strcmp(cmd, "gps-set-enabled")) _cmdGpsSetEnabled(doc, msgId);
    else if (!strcmp(cmd, "gps-configure"))   _cmdGpsConfigure(doc, msgId);
    else if (!strcmp(cmd, "gps-location")) {  // on-demand GPS fix publish
        publishGps();
        _cmdRespond(msgId, true, "location sent");
    }
    else if (!strcmp(cmd, "gps-status")) {
        requestGpsStatusPublish(msgId);
        _cmdRespond(msgId, true, "gps status scheduled");
    }
    else if (!strcmp(cmd, "gps-warmstart")) {
        bool ok = gpsWarmStart();
        _cmdRespond(msgId, ok, ok ? "warm start issued" : "failed");
    }
    else if (!strcmp(cmd, "gps-coldstart")) {
        bool ok = gpsColdStart();
        _cmdRespond(msgId, ok, ok ? "cold start issued" : "failed");
    }
    else if (!strcmp(cmd, "gps-hotstart")) {
        bool ok = gpsHotStart();
        _cmdRespond(msgId, ok, ok ? "hot start issued" : "failed");
    }
    else if (!strcmp(cmd, "gps-agps")) {
        bool enable = doc["enable"] | true;
        bool ok = gpsSetAgps(enable);
        _cmdRespond(msgId, ok, ok ? (enable ? "agps enabled" : "agps disabled") : "failed");
    }
    else if (!strcmp(cmd, "gps-fetch-agps")) {
        bool ok = gpsFetchAgps();
        _cmdRespond(msgId, ok, ok ? "agps fetch complete" : "agps fetch failed");
    }
    else if (!strcmp(cmd, "gps-satellites")) {
        int count = gpsGetSatelliteCount();
        char buf[48];
        snprintf(buf, sizeof(buf), "satellites=%d powered=%d", count, gpsIsPowered() ? 1 : 0);
        _cmdRespond(msgId, count >= 0, buf);
    }
    else if (!strcmp(cmd, "gps-force-fix")) {
        unsigned long timeout = doc["timeout"] | 60000UL;
        timeout = constrain(timeout, 5000UL, 120000UL);
        gpsWarmStart();
        GpsData fix;
        bool ok = gpsWaitForFix(fix, timeout, 2000);
        if (ok) {
            publishGps();
            char buf[80];
            snprintf(buf, sizeof(buf), "fix acquired: %.6f,%.6f sats=%d",
                     fix.lat, fix.lon, fix.satellites);
            _cmdRespond(msgId, true, buf);
        } else {
            int sats = gpsGetSatelliteCount();
            char buf[64];
            snprintf(buf, sizeof(buf), "no fix after %lums, sats=%d", timeout, sats);
            _cmdRespond(msgId, false, buf);
        }
    }
    else if (!strcmp(cmd, "gpio-write"))      _cmdGpioWrite(doc, msgId);
    else if (!strcmp(cmd, "gpio-read"))       _cmdGpioRead(doc, msgId);
    else if (!strcmp(cmd, "gpio-mode"))       _cmdGpioMode(doc, msgId);
    else if (!strcmp(cmd, "gpio-pwm"))        _cmdGpioPwm(doc, msgId);
    else if (!strcmp(cmd, "gpio-status"))     _cmdGpioStatus(msgId);
    else if (!strcmp(cmd, "touch-monitor")) {
        // Payload: { pins: [1,2,3], threshold: 40000 }
        // Reconfigure touch monitoring at runtime
        JsonArray pinsArr = doc["pins"];
        uint32_t thresh   = doc["threshold"] | 0UL;
        if (!pinsArr.isNull() && pinsArr.size() > 0) {
            int pins[TOUCH_MAX_PINS];
            int cnt = min((int)pinsArr.size(), TOUCH_MAX_PINS);
            for (int i = 0; i < cnt; i++) pins[i] = pinsArr[i];
            touchInit(pins, cnt, thresh);
            char buf[48];
            snprintf(buf, sizeof(buf), "monitoring %d pins thresh=%lu", cnt, thresh ? thresh : (unsigned long)TOUCH_DEFAULT_THRESH);
            _cmdRespond(msgId, true, buf);
        } else if (thresh > 0) {
            touchSetThreshold(thresh);
            _cmdRespond(msgId, true, "threshold updated");
        } else {
            char buf[64];
            snprintf(buf, sizeof(buf), "pins=%d initialized=%d", touchPinCount(), touchIsInitialized() ? 1 : 0);
            _cmdRespond(msgId, true, buf);
        }
    }
    else if (!strcmp(cmd, "touch-read")) {
        int pin = doc["pin"] | -1;
        if (pin >= 0) {
            uint32_t val = touchReadRaw(pin);
            char buf[48];
            snprintf(buf, sizeof(buf), "pin=%d raw=%lu pressed=%d", pin, (unsigned long)val, touchIsPinPressed(pin) ? 1 : 0);
            _cmdRespond(msgId, true, buf);
        } else {
            // Return status of all monitored pins
            char buf[128]; int pos = 0;
            pos += snprintf(buf + pos, sizeof(buf) - pos, "pins=%d ", touchPinCount());
            _cmdRespond(msgId, true, buf);
        }
    }
    else if (!strcmp(cmd, "led"))             _cmdLed(doc, msgId);
    else if (!strcmp(cmd, "display-text"))    _cmdDisplayText(doc, msgId);
    else if (!strcmp(cmd, "display-clear"))   _cmdDisplayClear(msgId);
    else if (!strcmp(cmd, "display-flip"))    _cmdDisplayFlip(msgId);
    else if (!strcmp(cmd, "display-invert"))  _cmdDisplayInvert(msgId);
    else if (!strcmp(cmd, "display-on"))      _cmdDisplayPower(true, msgId);
    else if (!strcmp(cmd, "display-off"))     _cmdDisplayPower(false, msgId);
    else if (!strcmp(cmd, "display-brightness")) _cmdDisplayBrightness(doc, msgId);
    else if (!strcmp(cmd, "set-mode"))        _cmdSetMode(doc, msgId);
    else if (!strcmp(cmd, "restart"))         _cmdRestart(msgId);
    else if (!strcmp(cmd, "restart-modem"))   _cmdRestartModem(msgId);
    else if (!strcmp(cmd, "ota-update"))      _cmdOta(doc, msgId);
    else if (!strcmp(cmd, "get-status")) {
        requestStatusPublish(msgId);
        _cmdRespond(msgId, true, "status scheduled");
    }
    else if (!strcmp(cmd, "internet-status")) _cmdPublishInternetStatusResponse(msgId);
    else if (!strcmp(cmd, "storage-info"))    _cmdStorageInfo(msgId);
    else if (!strcmp(cmd, "storage-list"))    _cmdStorageList(doc, msgId);
    else if (!strcmp(cmd, "storage-read"))    _cmdStorageRead(doc, msgId);
    else if (!strcmp(cmd, "storage-write"))   _cmdStorageWrite(doc, msgId);
    else if (!strcmp(cmd, "storage-delete"))  _cmdStorageDelete(doc, msgId);
    else if (!strcmp(cmd, "storage-mkdir"))   _cmdStorageMkdir(doc, msgId);
    else if (!strcmp(cmd, "storage-rename"))  _cmdStorageRename(doc, msgId);
    else if (!strcmp(cmd, "storage-move"))    _cmdStorageMove(doc, msgId);
    else if (!strcmp(cmd, "storage-copy"))    _cmdStorageCopy(doc, msgId);
    else if (!strcmp(cmd, "storage-format"))  _cmdStorageFormat(msgId);
    else if (!strcmp(cmd, "device-log-info")) _cmdDeviceLogInfo(msgId);
    else if (!strcmp(cmd, "device-log-read")) _cmdDeviceLogRead(doc, msgId);
    else if (!strcmp(cmd, "device-log-clear")) _cmdDeviceLogClear(msgId);
    else if (!strcmp(cmd, "storage-reinit")) {
        SD_MMC.end();
        bool ok = storageInit();
        char buf[80];
        if (ok) {
            snprintf(buf, sizeof(buf), "SD reinit OK type=%d size=%lluMB",
                     storageCardType(), storageCardSizeBytes() / (1024ULL * 1024ULL));
        } else {
            snprintf(buf, sizeof(buf), "SD reinit failed: %s",
                     storageLastError() ? storageLastError() : "no card");
        }
        _cmdRespond(msgId, ok, buf);
        if (!ok) ledSetState(LED_STORAGE_ERROR);
    }
    else if (!strcmp(cmd, "run-device-test")) _cmdRunDeviceTest(msgId);
    else {
        handled = false;
        Serial.printf("[CMD] Unknown command: %s\n", cmd);
    }
    _activeReplaySafeEnabled = false;
    _activeReplaySafeCommand[0] = '\0';
    _activeReplaySafeMessageId[0] = '\0';
}

void commandDispatch(const char* topic, const char* payload, int payloadLen) {
    if (_commandQueuePush(topic, payload, payloadLen)) {
        return;
    }

    JsonDocument doc;
    if (!deserializeJson(doc, payload ? payload : "")) {
        const char* msgId = doc["messageId"] | "0";
        _cmdRespond(msgId, false, "device busy - command queue full");
    }
}
