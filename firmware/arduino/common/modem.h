#pragma once
// AT command layer for SIMCom A7670E on Serial1 (RX=GPIO17, TX=GPIO18)
// Handles: sendAT, URC ring buffer, line reader

#include <Arduino.h>
#include "config.h"

// ── AT bus mutex ──────────────────────────────────────────────────────────────
// Prevents MQTT AT commands from interleaving with SMS/call AT commands.
// SMS and calls set _atBusBusy = true; MQTT loop skips its AT work while set.
static volatile bool _atBusBusy = false;

static void atBusLock()   { _atBusBusy = true; }
static void atBusUnlock() { _atBusBusy = false; }
bool atBusIsLocked()      { return _atBusBusy; }

// ── Internal state ────────────────────────────────────────────────────────────
static char   _atBuf[AT_BUF_SIZE];
static int    _atHead = 0, _atTail = 0;

// URC receive buffer for multi-line messages (MQTT RX, CMT, etc.)
#define URC_LINE_MAX  8
#define URC_LEN_MAX   512
static char   _urcLines[URC_LINE_MAX][URC_LEN_MAX];
static int    _urcCount = 0;
static bool   _capturingMqttRxUrc = false;

static bool _urcQueuePush(const char* line) {
    if (!line || !line[0]) return false;

    if (_urcCount >= URC_LINE_MAX) {
        for (int i = 1; i < URC_LINE_MAX; i++) {
            strncpy(_urcLines[i - 1], _urcLines[i], URC_LEN_MAX - 1);
            _urcLines[i - 1][URC_LEN_MAX - 1] = '\0';
        }
        _urcCount = URC_LINE_MAX - 1;
    }

    strncpy(_urcLines[_urcCount], line, URC_LEN_MAX - 1);
    _urcLines[_urcCount][URC_LEN_MAX - 1] = '\0';
    _urcCount++;
    return true;
}

static bool _captureAsyncMqttRxLine(const char* line) {
    if (!line || !line[0]) return false;

    if (strncmp(line, "+CMQTTRXSTART:", 13) == 0) {
        _capturingMqttRxUrc = true;
        _urcQueuePush(line);
        return true;
    }

    if (_capturingMqttRxUrc) {
        _urcQueuePush(line);
        if (strncmp(line, "+CMQTTRXEND:", 11) == 0) {
            _capturingMqttRxUrc = false;
        }
        return true;
    }

    return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
static void _atFlushRx(unsigned long delayMs = 100) {
    delay(delayMs);
    while (Serial1.available()) Serial1.read();
}

static bool _isAtErrorLine(const char* line) {
    if (!line || !line[0]) return false;
    return strcmp(line, "ERROR") == 0 ||
           strncmp(line, "+CME ERROR:", 11) == 0 ||
           strncmp(line, "+CMS ERROR:", 11) == 0;
}

static bool _looksUsableIp(const char* value) {
    if (!value || !value[0]) return false;
    if (strcmp(value, "0.0.0.0") == 0) return false;
    if (strcmp(value, "::") == 0) return false;
    if (strcmp(value, "0:0:0:0:0:0:0:0") == 0) return false;
    return strchr(value, '.') != nullptr || strchr(value, ':') != nullptr;
}

static bool _asyncTextUrcPending = false;

static bool _looksAsyncUrcLine(const char* line) {
    if (!line || !line[0]) return false;
    return strcmp(line, "RING") == 0 ||
           strcmp(line, "NO CARRIER") == 0 ||
           strcmp(line, "NO ANSWER") == 0 ||
           strcmp(line, "BUSY") == 0 ||
           strncmp(line, "VOICE CALL:", 11) == 0 ||
           strncmp(line, "+CLIP:", 6) == 0 ||
           strncmp(line, "+CMT:", 5) == 0 ||
           strncmp(line, "+CMTI:", 6) == 0 ||
           strncmp(line, "+CDS:", 5) == 0 ||
           strncmp(line, "+CDSI:", 6) == 0 ||
           strncmp(line, "+CUSD:", 6) == 0;
}

static bool _handleAsyncLineDuringWait(const char* line) {
    if (!line || !line[0]) return false;

    if (_captureAsyncMqttRxLine(line)) return true;

    // Ignore streaming NMEA chatter during unrelated waits so it cannot
    // become the captured response line.
    if (line[0] == '$') return true;

    if (_asyncTextUrcPending) {
        _asyncTextUrcPending = false;
        return _urcQueuePush(line);
    }

    if (_looksAsyncUrcLine(line)) {
        if (strncmp(line, "+CMT:", 5) == 0) {
            _asyncTextUrcPending = true;
        }
        return _urcQueuePush(line);
    }

    return false;
}

// Read a '\n'-terminated line from Serial1 into buf (strips \r\n).
// Returns true if a full line was read within timeoutMs.
static bool _readLine(char* buf, int maxLen, unsigned long timeoutMs = AT_TIMEOUT_MS) {
    unsigned long t0 = millis();
    int pos = 0;
    while (millis() - t0 < timeoutMs) {
        while (Serial1.available()) {
            char c = Serial1.read();
            if (c == '\n') {
                buf[pos] = '\0';
                // strip trailing \r
                if (pos > 0 && buf[pos - 1] == '\r') buf[--pos] = '\0';
                return true;
            }
            if (pos < maxLen - 1) buf[pos++] = c;
        }
        delay(1);
    }
    buf[pos] = '\0';
    return false;
}

// ── Public API ────────────────────────────────────────────────────────────────

void modemInit() {
    // MODEM_EN_PIN (GPIO21 on V2) = OE for TXB0104PWR level shifter
    // Must be HIGH before any Serial1 communication will work.
    pinMode(MODEM_EN_PIN, OUTPUT);
    digitalWrite(MODEM_EN_PIN, HIGH);

    Serial1.begin(MODEM_BAUD, SERIAL_8N1, MODEM_RX_PIN, MODEM_TX_PIN);
    delay(1000);
}

// Send raw AT command (no CR/LF — appended here)
void atSend(const char* cmd) {
    Serial1.print(cmd);
    Serial1.print("\r\n");
    Serial1.flush();
}

// Send AT command, wait up to timeoutMs for a line containing `expected`.
// Returns true on match. Fills respBuf (if non-null, maxLen bytes) with
// the matched line.
bool atWaitFor(const char* expected, char* respBuf, int maxLen,
               unsigned long timeoutMs = AT_TIMEOUT_MS) {
    unsigned long t0 = millis();
    char line[256];
    while (millis() - t0 < timeoutMs) {
        if (_readLine(line, sizeof(line), 200)) {
            if (strlen(line) == 0) continue;
            if (_handleAsyncLineDuringWait(line)) continue;
            if (strstr(line, expected)) {
                if (respBuf && maxLen > 0) {
                    strncpy(respBuf, line, maxLen - 1);
                    respBuf[maxLen - 1] = '\0';
                }
                return true;
            }
            if (_isAtErrorLine(line)) return false;
        }
    }
    return false;
}

// Send command + wait for OK. Returns true on OK.
bool atCmd(const char* cmd, unsigned long timeoutMs = AT_TIMEOUT_MS) {
    atSend(cmd);
    return atWaitFor("OK", nullptr, 0, timeoutMs);
}

// Send command, capture the first non-empty response line into respBuf.
// Returns true if OK received.
bool atCmdResp(const char* cmd, char* respBuf, int maxLen,
               unsigned long timeoutMs = AT_TIMEOUT_MS) {
    atSend(cmd);
    unsigned long t0 = millis();
    char line[256];
    bool gotResp = false;
    while (millis() - t0 < timeoutMs) {
        if (_readLine(line, sizeof(line), 200)) {
            if (strlen(line) == 0) continue;
            if (_handleAsyncLineDuringWait(line)) continue;
            if (_isAtErrorLine(line)) return false;
            if (strstr(line, "OK")) return true;
            if (!gotResp && respBuf) {
                strncpy(respBuf, line, maxLen - 1);
                respBuf[maxLen - 1] = '\0';
                gotResp = true;
            }
        }
    }
    return gotResp;
}

// Wait for a '>' data-entry prompt, then write `data` bytes, then
// wait for OK. Used for AT+CMQTTTOPIC, AT+CMQTTPAYLOAD, AT+CMGF/CMGS body.
bool atWaitPromptAndSend(const char* data, int dataLen,
                         unsigned long timeoutMs = AT_TIMEOUT_MS) {
    unsigned long t0 = millis();
    char line[256];
    int pos = 0;
    while (millis() - t0 < timeoutMs) {
        if (Serial1.available()) {
            char c = Serial1.read();
            if (c == '>') {
                // brief pause per SIMCom recommendation before sending data
                delay(20);
                Serial1.write((const uint8_t*)data, dataLen);
                Serial1.flush();
                return true;
            }
            if (c == '\n') {
                line[pos] = '\0';
                if (pos > 0 && line[pos - 1] == '\r') line[--pos] = '\0';
                if (pos > 0) _handleAsyncLineDuringWait(line);
                pos = 0;
                continue;
            }
            if (pos < (int)sizeof(line) - 1) {
                line[pos++] = c;
            }
        }
        delay(1);
    }
    line[pos] = '\0';
    if (pos > 0) _handleAsyncLineDuringWait(line);
    return false;
}

// Test comms — send AT and wait for OK. Retries up to `retries` times.
bool modemAlive(int retries = 5) {
    for (int i = 0; i < retries; i++) {
        if (atCmd("AT", 1000)) return true;
        delay(500);
    }
    return false;
}

// Basic modem setup sequence. Returns false if any step fails.
bool modemSetup() {
    _atFlushRx(500);

    if (!modemAlive()) return false;
    atCmd("ATE0");              // echo off
    atCmd("AT+CMEE=2");         // verbose modem errors (e.g. +CMS ERROR text)
    atCmd("AT+CVHU=0");         // enable ATH hangup command
    atCmd("AT+CLIP=1");         // enable caller ID URC
    atCmd("AT+CSMS=1");         // GSM Phase 2+ SMS service
    atCmd("AT+CPMS=\"SM\",\"SM\",\"SM\""); // prefer SIM storage for SMS fallback
    atCmd("AT+CMGF=1");         // SMS text mode
    atCmd("AT+CSCS=\"GSM\"");   // Keep the modem in a plain charset by default; SMS send switches to UCS2 on demand.
    atCmd("AT+CSMP=49,167,0,0"); // request SMS status reports in text mode
    atCmd("AT+CNMI=2,2,2,0,0"); // direct +CMT for inbound SMS, direct +CDS for status reports
    atCmd("AT+AUTOCSQ=1,1");    // URC on signal change; 1=enable, 1=report unsolicited
    return true;
}

// Returns RSSI (0–31, 99=unknown). Sends AT+CSQ and parses "+CSQ: x,y"
int modemCSQ() {
    char resp[64];
    if (!atCmdResp("AT+CSQ", resp, sizeof(resp))) return 99;
    // resp like "+CSQ: 18,0"
    char* p = strstr(resp, "+CSQ:");
    if (!p) p = strstr(resp, "+CSQ: ");
    if (!p) return 99;
    return atoi(p + 5);
}

// Extract the quoted operator field from +COPS output.
static bool _parseCopsOperator(const char* resp, char* buf, int maxLen) {
    if (!resp || !buf || maxLen <= 1) return false;
    char* q1 = strchr((char*)resp, '"');
    if (!q1) return false;
    char* q2 = strchr(q1 + 1, '"');
    if (!q2 || q2 <= q1 + 1) return false;
    int len = (int)(q2 - q1 - 1);
    if (len >= maxLen) len = maxLen - 1;
    strncpy(buf, q1 + 1, len);
    buf[len] = '\0';
    return buf[0] != '\0';
}

bool modemOperator(char* buf, int maxLen) {
    char resp[128];
    atCmd("AT+COPS=3,0", 2000);
    if (!atCmdResp("AT+COPS?", resp, sizeof(resp))) return false;
    // +COPS: 0,0,"Operator Name",7
    if (_parseCopsOperator(resp, buf, maxLen)) {
        return true;
    }

    char code[32] = "";
    memset(resp, 0, sizeof(resp));
    atCmd("AT+COPS=3,2", 2000);
    if (!atCmdResp("AT+COPS?", resp, sizeof(resp))) return false;
    if (!_parseCopsOperator(resp, code, sizeof(code))) return false;
    strncpy(buf, code, maxLen - 1);
    buf[maxLen - 1] = '\0';
    return buf[0] != '\0';
}

// Check LTE registration. Returns true if registered (home or roaming).
bool modemRegistered() {
    char resp[64];
    if (!atCmdResp("AT+CEREG?", resp, sizeof(resp))) return false;
    // +CEREG: 0,1  or  +CEREG: 0,5
    char* p = strstr(resp, ",");
    if (!p) return false;
    int stat = atoi(p + 1);
    return (stat == 1 || stat == 5);
}

// Request a modem-only restart. SIMCom modules typically accept AT+CRESET;
// fall back to CFUN full restart if needed.
bool modemRestart() {
    if (atCmd("AT+CRESET", 5000)) return true;
    return atCmd("AT+CFUN=1,1", 5000);
}

// Open TCP/IP network stack. Must be done before MQTT.
// Safe to call multiple times — detects "already opened" and verifies IP.
// Does NOT do AT+CGATT=0 (full detach) — that destabilises the bearer.
bool modemNetOpen() {
    char line[128];

    // Flush any stale URCs before sending commands
    _atFlushRx(100);

    // Ensure packet data service is attached first
    atCmd("AT+CGATT=1", 10000);
    delay(500);

    atSend("AT+NETOPEN");
    unsigned long t0 = millis();
    while (millis() - t0 < AT_CONNECT_TIMEOUT_MS) {
        if (_readLine(line, sizeof(line), 500)) {
            Serial.printf("[NET] < %s\n", line);
            if (_captureAsyncMqttRxLine(line)) continue;

            if (strstr(line, "+NETOPEN: 0")) {
                // Fresh open — wait briefly for carrier to assign IP
                delay(2000);
                return true;
            }
            if (strstr(line, "+NETOPEN: 3") || strstr(line, "+NETOPEN: 1")) {
                return true;   // already open, known-good
            }
            if (strstr(line, "already opened")) {
                // Stack is open — verify a real data IP exists
                _atFlushRx(200);  // drain any buffered URCs before querying
                char ipCheck[40] = "";
                atCmdResp("AT+IPADDR", ipCheck, sizeof(ipCheck), 3000);
                Serial.printf("[NET] IP check: %s\n", ipCheck);
                if (_looksUsableIp(ipCheck)) return true;

                // Stale state: close TCP stack and reopen — NO CGATT=0
                Serial.println("[NET] Stale open (no IP) — NETCLOSE + reopen");
                atCmd("AT+NETCLOSE", 8000);
                delay(2000);
                atSend("AT+NETOPEN");
                t0 = millis();
                continue;
            }
            if (_isAtErrorLine(line)) {
                // Last resort: query open state
                Serial.println("[NET] NETOPEN error — querying state");
                char ipCheck[40] = "";
                atCmdResp("AT+IPADDR", ipCheck, sizeof(ipCheck), 2000);
                if (_looksUsableIp(ipCheck)) return true;
                return false;
            }
        }
    }
    return false;
}

// Get device IP address. Returns false if not connected.
bool modemGetIP(char* buf, int maxLen) {
    char resp[128];
    if (!atCmdResp("AT+IPADDR", resp, sizeof(resp))) return false;
    // Strip "+IPADDR: " prefix if modem echoes it into the response line
    const char* ip = strstr(resp, "+IPADDR:");
    if (ip) { ip += 8; while (*ip == ' ') ip++; }
    else { ip = resp; }
    strncpy(buf, ip, maxLen - 1);
    buf[maxLen - 1] = '\0';
    return _looksUsableIp(buf);
}

// Ping a host/IP. Returns round-trip ms, or -1 on failure.
int modemPing(const char* host, unsigned long timeoutMs = 10000) {
    char cmd[128];
    // A7670E: AT+CPING="host",retryCount,dataLen,timeout_ms
    snprintf(cmd, sizeof(cmd), "AT+CPING=\"%s\",1,32,%lu", host, timeoutMs);
    atSend(cmd);
    char line[128];
    unsigned long t0 = millis();
    while (millis() - t0 < timeoutMs + 3000) {
        if (_readLine(line, sizeof(line), 500)) {
            Serial.printf("[PING] < %s\n", line);
            if (_captureAsyncMqttRxLine(line)) continue;
            if (strstr(line, "+CPING:")) {
                char* p = strrchr(line, ',');
                if (p) return atoi(p + 1);
                return 0;
            }
            if (_isAtErrorLine(line)) return -1;
        }
    }
    return -1;
}

// Test raw TCP connection to host:port. Returns true if socket opened.
// Opens CIP socket 5, checks result, then closes immediately.
bool modemTcpTest(const char* host, int port) {
    char cmd[128];
    snprintf(cmd, sizeof(cmd), "AT+CIPOPEN=5,\"TCP\",\"%s\",%d,0", host, port);
    atSend(cmd);
    char line[128];
    unsigned long t0 = millis();
    bool opened = false;
    while (millis() - t0 < 15000) {
        if (_readLine(line, sizeof(line), 500)) {
            Serial.printf("[TCP] < %s\n", line);
            if (_captureAsyncMqttRxLine(line)) continue;
            if (strstr(line, "+CIPOPEN: 5,0")) { opened = true; break; }
            if (_isAtErrorLine(line) || strstr(line, "+CIPOPEN: 5,")) break;
        }
    }
    // Close socket regardless of result
    atSend("AT+CIPCLOSE=5");
    _atFlushRx(300);
    return opened;
}

// Read available URC lines from Serial1 into the ring buffer.
// Call frequently from loop(). Returns number of lines added.
int modemPollURC(char lines[][URC_LEN_MAX], int maxLines) {
    int n = 0;
    while (n < maxLines && _urcCount > 0) {
        strncpy(lines[n], _urcLines[0], URC_LEN_MAX - 1);
        lines[n][URC_LEN_MAX - 1] = '\0';
        for (int i = 1; i < _urcCount; i++) {
            strncpy(_urcLines[i - 1], _urcLines[i], URC_LEN_MAX - 1);
            _urcLines[i - 1][URC_LEN_MAX - 1] = '\0';
        }
        _urcCount--;
        n++;
    }
    while (n < maxLines && Serial1.available()) {
        if (_readLine(lines[n], URC_LEN_MAX, 50)) {
            if (strlen(lines[n]) > 0) {
                if (_captureAsyncMqttRxLine(lines[n])) continue;
                lines[n][URC_LEN_MAX - 1] = '\0';
                n++;
            }
        } else {
            break;
        }
    }
    return n;
}
