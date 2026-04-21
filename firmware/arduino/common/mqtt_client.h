#pragma once
// MQTT client with Wi-Fi-first transport and SIM/modem fallback.
// The rest of the firmware keeps using the same mqtt* API.

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <PubSubClient.h>

#include "modem.h"
#include "config.h"
#include "runtime_defaults.h"

static char _mqttHost[201] = "";
static int  _mqttPort = 0;
static char _mqttDeviceId[65] = "";
static char _mqttUser[101] = "";
static char _mqttPass[201] = "";

inline void mqttSetConfig(const char* host, int port, const char* deviceId,
                          const char* user, const char* pass) {
    strncpy(_mqttHost, host ? host : "", sizeof(_mqttHost) - 1);
    strncpy(_mqttDeviceId, deviceId ? deviceId : "", sizeof(_mqttDeviceId) - 1);
    strncpy(_mqttUser, user ? user : "", sizeof(_mqttUser) - 1);
    strncpy(_mqttPass, pass ? pass : "", sizeof(_mqttPass) - 1);
    _mqttHost[sizeof(_mqttHost) - 1] = '\0';
    _mqttDeviceId[sizeof(_mqttDeviceId) - 1] = '\0';
    _mqttUser[sizeof(_mqttUser) - 1] = '\0';
    _mqttPass[sizeof(_mqttPass) - 1] = '\0';
    _mqttPort = port;
}

static const char* _mqttGetHost() { return _mqttHost; }
static int _mqttGetPort() { return _mqttPort > 0 ? _mqttPort : FW_DEFAULT_MQTT_PORT; }
static const char* _mqttGetDeviceId() { return _mqttDeviceId; }
static const char* _mqttGetUser() { return _mqttUser; }
static const char* _mqttGetPass() { return _mqttPass; }

enum MqttState {
    MQTT_STATE_IDLE,
    MQTT_STATE_STARTING,
    MQTT_STATE_ACQUIRING,
    MQTT_STATE_CONNECTING,
    MQTT_STATE_CONNECTED,
    MQTT_STATE_DISCONNECTED,
    MQTT_STATE_RECONNECTING
};

enum MqttTransport {
    MQTT_TRANSPORT_NONE,
    MQTT_TRANSPORT_WIFI,
    MQTT_TRANSPORT_MODEM
};

static MqttState _mqttState = MQTT_STATE_IDLE;
static MqttTransport _mqttTransport = MQTT_TRANSPORT_NONE;
static unsigned long _reconnectMs = 0;
static unsigned long _reconnectDelay = RECONNECT_BASE_MS;

static WiFiClient _mqttWifiNetClient;
static PubSubClient _mqttWifiClient(_mqttWifiNetClient);

static const char* _mqttTransportName(MqttTransport transport) {
    switch (transport) {
        case MQTT_TRANSPORT_WIFI: return "wifi";
        case MQTT_TRANSPORT_MODEM: return "modem";
        default: return "none";
    }
}

static bool _mqttWifiAvailable() {
    return WiFi.status() == WL_CONNECTED;
}

const char* mqttTransportName() {
    return _mqttTransportName(_mqttTransport);
}

bool mqttUsingWifi() {
    return _mqttTransport == MQTT_TRANSPORT_WIFI;
}

static void _mqttMarkDisconnected(const char* reason = nullptr) {
    if (_mqttState != MQTT_STATE_DISCONNECTED) {
        if (reason && reason[0]) {
            Serial.printf("[MQTT] Marking %s disconnected: %s\n",
                          _mqttTransportName(_mqttTransport), reason);
        } else {
            Serial.printf("[MQTT] Marking %s disconnected\n",
                          _mqttTransportName(_mqttTransport));
        }
    }
    if (_mqttTransport == MQTT_TRANSPORT_WIFI && _mqttWifiClient.connected()) {
        _mqttWifiClient.disconnect();
    }
    _mqttState = MQTT_STATE_DISCONNECTED;
    _mqttTransport = MQTT_TRANSPORT_NONE;
    _reconnectMs = millis();
}

enum MqttRxState { RX_IDLE, RX_TOPIC, RX_PAYLOAD };
static MqttRxState _rxState = RX_IDLE;
static char _rxTopic[TOPIC_BUF_SIZE];
static char _rxPayload[CMD_BUF_SIZE];
static int _rxPayloadLen = 0;

typedef void (*MqttMessageCb)(const char* topic, const char* payload, int payloadLen);
static MqttMessageCb _msgCb = nullptr;

struct _QueuedMqttMessage {
    char topic[TOPIC_BUF_SIZE];
    char payload[CMD_BUF_SIZE];
    int payloadLen;
};

#define MQTT_MSG_QUEUE_MAX 10
static _QueuedMqttMessage _mqttMsgQueue[MQTT_MSG_QUEUE_MAX];
static int _mqttMsgQueueHead = 0;
static int _mqttMsgQueueTail = 0;
static _QueuedMqttMessage _mqttDispatchSlot = {};

static bool _mqttQueueIsEmpty() {
    return _mqttMsgQueueHead == _mqttMsgQueueTail;
}

int mqttInboundQueueDepth() {
    int depth = _mqttMsgQueueTail - _mqttMsgQueueHead;
    if (depth < 0) depth += MQTT_MSG_QUEUE_MAX;
    return depth;
}

static bool _mqttQueuePush(const char* topic, const char* payload, int payloadLen) {
    int nextTail = (_mqttMsgQueueTail + 1) % MQTT_MSG_QUEUE_MAX;
    if (nextTail == _mqttMsgQueueHead) {
        Serial.println("[MQTT] RX queue full - dropping incoming command");
        return false;
    }

    strncpy(_mqttMsgQueue[_mqttMsgQueueTail].topic, topic ? topic : "", TOPIC_BUF_SIZE - 1);
    _mqttMsgQueue[_mqttMsgQueueTail].topic[TOPIC_BUF_SIZE - 1] = '\0';
    strncpy(_mqttMsgQueue[_mqttMsgQueueTail].payload, payload ? payload : "", CMD_BUF_SIZE - 1);
    _mqttMsgQueue[_mqttMsgQueueTail].payload[CMD_BUF_SIZE - 1] = '\0';
    _mqttMsgQueue[_mqttMsgQueueTail].payloadLen = payloadLen;
    _mqttMsgQueueTail = nextTail;
    return true;
}

static bool _mqttQueuePop(_QueuedMqttMessage& out) {
    if (_mqttQueueIsEmpty()) return false;
    out = _mqttMsgQueue[_mqttMsgQueueHead];
    _mqttMsgQueueHead = (_mqttMsgQueueHead + 1) % MQTT_MSG_QUEUE_MAX;
    return true;
}

static void _mqttWifiInboundCb(char* topic, byte* payload, unsigned int length) {
    char payloadBuf[CMD_BUF_SIZE];
    unsigned int copyLen = min(length, (unsigned int)(CMD_BUF_SIZE - 1));
    if (copyLen > 0) {
        memcpy(payloadBuf, payload, copyLen);
    }
    payloadBuf[copyLen] = '\0';
    _mqttQueuePush(topic ? topic : "", payloadBuf, (int)copyLen);
}

void mqttSetCallback(MqttMessageCb cb) {
    _msgCb = cb;
    _mqttWifiClient.setCallback(_mqttWifiInboundCb);
}

static void _mqttModemShutdown() {
    if (atBusIsLocked()) return;
    atSend("AT+CMQTTDISC=0,10");
    delay(100);
    atSend("AT+CMQTTREL=0");
    delay(100);
    atSend("AT+CMQTTSTOP");
    delay(150);
    _atFlushRx(100);
}

void mqttDispatchQueuedMessages() {
    if (_mqttTransport == MQTT_TRANSPORT_WIFI) {
        if (_mqttWifiAvailable()) {
            _mqttWifiClient.loop();
        }
        if (!_mqttWifiAvailable() || !_mqttWifiClient.connected()) {
            _mqttMarkDisconnected("wifi transport lost");
            return;
        }
    } else if (_mqttTransport == MQTT_TRANSPORT_MODEM && _mqttWifiAvailable() && !atBusIsLocked()) {
        Serial.println("[MQTT] Wi-Fi available - switching preferred transport");
        _mqttModemShutdown();
        _mqttMarkDisconnected("switching to wifi");
        return;
    }

    if (!_msgCb) return;
    if (_mqttTransport == MQTT_TRANSPORT_MODEM && atBusIsLocked()) return;

    if (_mqttQueuePop(_mqttDispatchSlot)) {
        _msgCb(_mqttDispatchSlot.topic, _mqttDispatchSlot.payload, _mqttDispatchSlot.payloadLen);
        memset(&_mqttDispatchSlot, 0, sizeof(_mqttDispatchSlot));
    }
}

static bool _mqttStartModem() {
    char line[128];

    atSend("AT+CMQTTDISC=0,10");
    delay(200);
    atSend("AT+CMQTTREL=0");
    delay(200);
    atSend("AT+CMQTTSTOP");
    delay(500);
    _atFlushRx(100);

    atSend("AT+CMQTTSTART");
    unsigned long t0 = millis();
    while (millis() - t0 < 5000) {
        if (_readLine(line, sizeof(line), 300)) {
            Serial.printf("[MQTT] < %s\n", line);
            if (_handleAsyncLineDuringWait(line)) continue;
            if (strstr(line, "+CMQTTSTART: 0")) return true;
            if (strstr(line, "+CMQTTSTART: 23")) return true;
            if (strstr(line, "already")) return true;
            if (_isAtErrorLine(line)) return false;
        }
    }
    return false;
}

static bool _mqttAccqModem() {
    char cmd[128];
    snprintf(cmd, sizeof(cmd), "AT+CMQTTACCQ=0,\"%s\",0", _mqttGetDeviceId());
    char line[128];
    atSend(cmd);
    unsigned long t0 = millis();
    while (millis() - t0 < 5000) {
        if (_readLine(line, sizeof(line), 300)) {
            if (_handleAsyncLineDuringWait(line)) continue;
            if (strstr(line, "OK")) return true;
            if (strstr(line, "+CMQTTACCQ:")) {
                char* p = strchr(line, ',');
                if (p && atoi(p + 1) == 0) return true;
                if (strstr(line, "11")) return true;
            }
            if (_isAtErrorLine(line)) return false;
        }
    }
    return false;
}

static bool _mqttConnectModemBearer() {
    char cmd[256];
    if (strlen(_mqttGetUser()) > 0 && strlen(_mqttGetPass()) > 0) {
        snprintf(cmd, sizeof(cmd),
                 "AT+CMQTTCONNECT=0,\"tcp://%s:%d\",%d,1,\"%s\",\"%s\"",
                 _mqttGetHost(), _mqttGetPort(), MQTT_KEEPALIVE_SEC,
                 _mqttGetUser(), _mqttGetPass());
    } else {
        snprintf(cmd, sizeof(cmd),
                 "AT+CMQTTCONNECT=0,\"tcp://%s:%d\",%d,1",
                 _mqttGetHost(), _mqttGetPort(), MQTT_KEEPALIVE_SEC);
    }
    char line[128];
    atSend(cmd);
    unsigned long t0 = millis();
    while (millis() - t0 < AT_CONNECT_TIMEOUT_MS) {
        if (_readLine(line, sizeof(line), 500)) {
            if (_handleAsyncLineDuringWait(line)) continue;
            if (strstr(line, "+CMQTTCONNECT: 0,0")) return true;
            if (strstr(line, "+CMQTTCONNECT:") && strstr(line, ",0")) return true;
            if (_isAtErrorLine(line)) return false;
        }
    }
    return false;
}

static bool _mqttSubscribeModem(const char* topic, int qos = 1) {
    char cmd[128];
    int topicLen = strlen(topic);
    snprintf(cmd, sizeof(cmd), "AT+CMQTTSUB=0,%d,%d", topicLen, qos);
    atSend(cmd);
    if (!atWaitPromptAndSend(topic, topicLen, 3000)) return false;
    char line[128];
    unsigned long t0 = millis();
    while (millis() - t0 < 5000) {
        if (_readLine(line, sizeof(line), 300)) {
            if (_handleAsyncLineDuringWait(line)) continue;
            if (strstr(line, "+CMQTTSUB: 0,0")) return true;
            if (strstr(line, "OK")) return true;
            if (_isAtErrorLine(line)) return false;
        }
    }
    return false;
}

static bool _mqttSubscribeCommandTopicsModem() {
    char topic[TOPIC_BUF_SIZE];
    snprintf(topic, sizeof(topic), "device/%s/command/#", _mqttGetDeviceId());
    Serial.printf("[MQTT] Subscribing via modem to %s\n", topic);
    return _mqttSubscribeModem(topic, 1);
}

static bool _mqttSubscribeCommandTopicsWifi() {
    char topic[TOPIC_BUF_SIZE];
    snprintf(topic, sizeof(topic), "device/%s/command/#", _mqttGetDeviceId());
    Serial.printf("[MQTT] Subscribing via Wi-Fi to %s\n", topic);
    return _mqttWifiClient.subscribe(topic);
}

static bool _mqttConnectWifi() {
    if (!_mqttWifiAvailable()) return false;
    if (!_mqttGetHost()[0] || !_mqttGetDeviceId()[0]) return false;

    _mqttWifiClient.setServer(_mqttGetHost(), _mqttGetPort());
    _mqttWifiClient.setBufferSize(CMD_BUF_SIZE);
    _mqttWifiClient.setKeepAlive(MQTT_KEEPALIVE_SEC);
    _mqttWifiClient.setSocketTimeout(10);

    bool ok = false;
    if (strlen(_mqttGetUser()) > 0 && strlen(_mqttGetPass()) > 0) {
        ok = _mqttWifiClient.connect(_mqttGetDeviceId(), _mqttGetUser(), _mqttGetPass());
    } else {
        ok = _mqttWifiClient.connect(_mqttGetDeviceId());
    }
    if (!ok) {
        Serial.printf("[MQTT] Wi-Fi connect failed rc=%d\n", _mqttWifiClient.state());
        return false;
    }
    if (!_mqttSubscribeCommandTopicsWifi()) {
        Serial.println("[MQTT] Wi-Fi subscribe failed");
        _mqttWifiClient.disconnect();
        return false;
    }

    _mqttTransport = MQTT_TRANSPORT_WIFI;
    _mqttState = MQTT_STATE_CONNECTED;
    _reconnectDelay = RECONNECT_BASE_MS;
    Serial.println("[MQTT] Connected via Wi-Fi");
    return true;
}

static bool _mqttConnectModem() {
    if (atBusIsLocked()) {
        Serial.println("[MQTT] Modem connect deferred - AT bus busy");
        return false;
    }

    char netIP[40] = "";
    atCmdResp("AT+IPADDR", netIP, sizeof(netIP), 2000);
    if (strlen(netIP) <= 4) {
        Serial.println("[MQTT] No modem IP - opening network stack...");
        if (!modemNetOpen()) {
            Serial.println("[MQTT] Network not open - aborting modem MQTT connect");
            return false;
        }
        atCmdResp("AT+IPADDR", netIP, sizeof(netIP), 2000);
    }

    Serial.println("[MQTT] Starting CMQTT service...");
    if (!_mqttStartModem()) {
        Serial.println("[MQTT] CMQTTSTART failed");
        return false;
    }

    Serial.println("[MQTT] Acquiring modem client...");
    if (!_mqttAccqModem()) {
        Serial.println("[MQTT] CMQTTACCQ failed");
        return false;
    }

    Serial.println("[MQTT] Connecting to broker via modem...");
    if (!_mqttConnectModemBearer()) {
        Serial.println("[MQTT] CMQTTCONNECT failed");
        return false;
    }

    if (!_mqttSubscribeCommandTopicsModem()) {
        Serial.println("[MQTT] Modem subscribe failed");
        _mqttMarkDisconnected("subscribe failed");
        return false;
    }

    _mqttTransport = MQTT_TRANSPORT_MODEM;
    _mqttState = MQTT_STATE_CONNECTED;
    _reconnectDelay = RECONNECT_BASE_MS;
    Serial.println("[MQTT] Connected via modem");
    return true;
}

bool mqttConnect() {
    if (_mqttWifiAvailable() && _mqttConnectWifi()) {
        return true;
    }
    if (_mqttWifiAvailable()) {
        Serial.println("[MQTT] Wi-Fi MQTT connect failed - trying modem fallback");
    }
    return _mqttConnectModem();
}

bool mqttConnected() {
    if (_mqttTransport == MQTT_TRANSPORT_WIFI) {
        if (_mqttState == MQTT_STATE_CONNECTED && _mqttWifiAvailable() && _mqttWifiClient.connected()) {
            return true;
        }
        _mqttMarkDisconnected("wifi session not active");
        return false;
    }
    return _mqttState == MQTT_STATE_CONNECTED;
}

bool mqttPublish(const char* topic, const char* payload, int qos = 0) {
    (void)qos;

    if (!mqttConnected()) return false;

    if (_mqttTransport == MQTT_TRANSPORT_WIFI) {
        _mqttWifiClient.loop();
        return _mqttWifiClient.publish(topic, (const uint8_t*)payload, strlen(payload), false);
    }

    if (atBusIsLocked()) {
        Serial.println("[MQTT] Publish deferred - AT bus busy");
        return false;
    }

    int topicLen = strlen(topic);
    int payloadLen = strlen(payload);
    char cmd[64];

    snprintf(cmd, sizeof(cmd), "AT+CMQTTTOPIC=0,%d", topicLen);
    atSend(cmd);
    if (!atWaitPromptAndSend(topic, topicLen, 3000)) {
        _mqttMarkDisconnected("topic prompt failed");
        return false;
    }
    if (!atWaitFor("OK", nullptr, 0, 2000)) {
        _mqttMarkDisconnected("topic ack failed");
        return false;
    }

    snprintf(cmd, sizeof(cmd), "AT+CMQTTPAYLOAD=0,%d", payloadLen);
    atSend(cmd);
    if (!atWaitPromptAndSend(payload, payloadLen, 3000)) {
        _mqttMarkDisconnected("payload prompt failed");
        return false;
    }
    if (!atWaitFor("OK", nullptr, 0, 2000)) {
        _mqttMarkDisconnected("payload ack failed");
        return false;
    }

    snprintf(cmd, sizeof(cmd), "AT+CMQTTPUB=0,%d,60", qos);
    atSend(cmd);
    char line[128];
    unsigned long t0 = millis();
    while (millis() - t0 < 10000) {
        if (_readLine(line, sizeof(line), 500)) {
            if (_handleAsyncLineDuringWait(line)) continue;
            if (strstr(line, "+CMQTTPUB: 0,0")) return true;
            if (_isAtErrorLine(line)) {
                _mqttMarkDisconnected(line);
                return false;
            }
        }
    }
    _mqttMarkDisconnected("publish timeout");
    return false;
}

void mqttProcessLine(const char* line) {
    if (strstr(line, "+CMQTTCONNLOST") || strstr(line, "+CMQTTNONET")) {
        Serial.println("[MQTT] Modem connection lost URC");
        _mqttMarkDisconnected("broker/network lost");
        return;
    }

    if (strstr(line, "+CMQTTRXSTART:")) {
        _rxState = RX_TOPIC;
        _rxTopic[0] = '\0';
        _rxPayload[0] = '\0';
        _rxPayloadLen = 0;
        return;
    }

    if (_rxState == RX_TOPIC && strstr(line, "+CMQTTRXTOPIC:")) {
        _rxState = RX_TOPIC;
        return;
    }

    if (_rxState == RX_TOPIC && line[0] != '+') {
        strncpy(_rxTopic, line, TOPIC_BUF_SIZE - 1);
        _rxTopic[TOPIC_BUF_SIZE - 1] = '\0';
        _rxState = RX_PAYLOAD;
        return;
    }

    if (_rxState == RX_PAYLOAD && strstr(line, "+CMQTTRXPAYLOAD:")) {
        char* p = strrchr(line, ',');
        if (p) _rxPayloadLen = atoi(p + 1);
        return;
    }

    if (_rxState == RX_PAYLOAD && line[0] != '+') {
        strncpy(_rxPayload, line, CMD_BUF_SIZE - 1);
        _rxPayload[CMD_BUF_SIZE - 1] = '\0';
        return;
    }

    if (strstr(line, "+CMQTTRXEND:")) {
        if (_rxState == RX_PAYLOAD && strlen(_rxTopic) > 0) {
            _mqttQueuePush(_rxTopic, _rxPayload, strlen(_rxPayload));
        }
        _rxState = RX_IDLE;
        _rxTopic[0] = '\0';
        _rxPayload[0] = '\0';
    }
}

bool mqttReconnectTick() {
    if (_mqttTransport == MQTT_TRANSPORT_WIFI && _mqttState == MQTT_STATE_CONNECTED) {
        _mqttWifiClient.loop();
        if (!_mqttWifiAvailable() || !_mqttWifiClient.connected()) {
            _mqttMarkDisconnected("wifi session dropped");
        } else {
            return false;
        }
    } else if (_mqttState == MQTT_STATE_CONNECTED) {
        return false;
    }

    unsigned long now = millis();
    if (now - _reconnectMs < _reconnectDelay) return false;

    Serial.printf("[MQTT] Reconnecting (delay %lu ms, prefer=%s)...\n",
                  _reconnectDelay, _mqttWifiAvailable() ? "wifi" : "modem");
    if (mqttConnect()) {
        Serial.printf("[MQTT] Reconnected via %s\n", _mqttTransportName(_mqttTransport));
        return true;
    }

    _reconnectDelay = min(_reconnectDelay * 2, (unsigned long)RECONNECT_MAX_MS);
    _reconnectMs = millis();
    return false;
}
