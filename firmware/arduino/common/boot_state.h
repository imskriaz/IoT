#pragma once

#include <Arduino.h>

enum BootCheckId {
    BOOT_CHECK_MODEM_ALIVE = 0,
    BOOT_CHECK_SIM_PRESENT,
    BOOT_CHECK_NETWORK_REG,
    BOOT_CHECK_BATTERY,
    BOOT_CHECK_MQTT_CONN,
    BOOT_CHECK_SD_CARD,
    BOOT_CHECK_WIFI_STA,
    BOOT_CHECK_COUNT
};

enum BootStateChangeBit {
    BOOT_STATE_CHANGED_MODEM   = 1 << 0,
    BOOT_STATE_CHANGED_NETWORK = 1 << 1,
    BOOT_STATE_CHANGED_MQTT    = 1 << 2,
    BOOT_STATE_CHANGED_STORAGE = 1 << 3,
    BOOT_STATE_CHANGED_GPS     = 1 << 4,
    BOOT_STATE_CHANGED_WIFI    = 1 << 5,
    BOOT_STATE_CHANGED_DIAG    = 1 << 6
};

struct BootCheckResult {
    bool valid;
    bool pass;
    unsigned long durationMs;
    unsigned long updatedAtMs;
    char details[96];
};

struct BootRuntimeState {
    bool modemConfigured;
    bool networkReady;
    bool mqttConnected;
    bool sdPresent;
    bool gpsPowered;
    bool wifiStationConnected;
    unsigned long diagnosticsCompletedAtMs;
    unsigned long revision;
    uint32_t changeMask;
    char wifiSsid[33];
    char wifiIp[24];
    BootCheckResult checks[BOOT_CHECK_COUNT];
};

static BootRuntimeState _bootState = {};

static inline const char* bootCheckIdString(BootCheckId id) {
    switch (id) {
        case BOOT_CHECK_MODEM_ALIVE: return "modem-alive";
        case BOOT_CHECK_SIM_PRESENT: return "sim-present";
        case BOOT_CHECK_NETWORK_REG: return "network-reg";
        case BOOT_CHECK_BATTERY:     return "battery";
        case BOOT_CHECK_MQTT_CONN:   return "mqtt-conn";
        case BOOT_CHECK_SD_CARD:     return "sd-card";
        case BOOT_CHECK_WIFI_STA:    return "wifi-sta";
        default:                     return "unknown";
    }
}

static inline const char* bootCheckNameString(BootCheckId id) {
    switch (id) {
        case BOOT_CHECK_MODEM_ALIVE: return "Modem AT Response";
        case BOOT_CHECK_SIM_PRESENT: return "SIM Card Present";
        case BOOT_CHECK_NETWORK_REG: return "LTE Network Registration";
        case BOOT_CHECK_BATTERY:     return "Battery Gauge";
        case BOOT_CHECK_MQTT_CONN:   return "MQTT Broker Connection";
        case BOOT_CHECK_SD_CARD:     return "SD Card";
        case BOOT_CHECK_WIFI_STA:    return "WiFi Station";
        default:                     return "Unknown";
    }
}

static inline void _bootMarkChanged(uint32_t bit) {
    _bootState.changeMask |= bit;
    _bootState.revision++;
}

static inline void bootStateSetCheck(BootCheckId id, bool pass, unsigned long durationMs, const char* details) {
    if (id < 0 || id >= BOOT_CHECK_COUNT) return;

    BootCheckResult& check = _bootState.checks[id];
    check.valid = true;
    check.pass = pass;
    check.durationMs = durationMs;
    check.updatedAtMs = millis();
    if (details && details[0]) {
        strncpy(check.details, details, sizeof(check.details) - 1);
        check.details[sizeof(check.details) - 1] = '\0';
    } else {
        check.details[0] = '\0';
    }
    _bootState.diagnosticsCompletedAtMs = check.updatedAtMs;
    _bootMarkChanged(BOOT_STATE_CHANGED_DIAG);
}

static inline const BootCheckResult* bootStateGetCheck(BootCheckId id) {
    if (id < 0 || id >= BOOT_CHECK_COUNT) return nullptr;
    return &_bootState.checks[id];
}

static inline bool bootStateDiagnosticsReady() {
    for (int i = 0; i < BOOT_CHECK_COUNT; i++) {
        if (!_bootState.checks[i].valid) return false;
    }
    return true;
}

static inline void bootStateSetModemConfigured(bool value) {
    if (_bootState.modemConfigured == value) return;
    _bootState.modemConfigured = value;
    _bootMarkChanged(BOOT_STATE_CHANGED_MODEM);
}

static inline void bootStateSetNetworkReady(bool value) {
    if (_bootState.networkReady == value) return;
    _bootState.networkReady = value;
    _bootMarkChanged(BOOT_STATE_CHANGED_NETWORK);
}

static inline void bootStateSetMqttConnected(bool value) {
    if (_bootState.mqttConnected == value) return;
    _bootState.mqttConnected = value;
    _bootMarkChanged(BOOT_STATE_CHANGED_MQTT);
}

static inline void bootStateSetSdPresent(bool value) {
    if (_bootState.sdPresent == value) return;
    _bootState.sdPresent = value;
    _bootMarkChanged(BOOT_STATE_CHANGED_STORAGE);
}

static inline void bootStateSetGpsPowered(bool value) {
    if (_bootState.gpsPowered == value) return;
    _bootState.gpsPowered = value;
    _bootMarkChanged(BOOT_STATE_CHANGED_GPS);
}

static inline void bootStateSetWifiStation(bool connected, const char* ssid, const char* ip) {
    bool changed = false;
    if (_bootState.wifiStationConnected != connected) {
        _bootState.wifiStationConnected = connected;
        changed = true;
    }

    const char* nextSsid = ssid ? ssid : "";
    const char* nextIp = ip ? ip : "";
    if (strncmp(_bootState.wifiSsid, nextSsid, sizeof(_bootState.wifiSsid) - 1) != 0) {
        strncpy(_bootState.wifiSsid, nextSsid, sizeof(_bootState.wifiSsid) - 1);
        _bootState.wifiSsid[sizeof(_bootState.wifiSsid) - 1] = '\0';
        changed = true;
    }
    if (strncmp(_bootState.wifiIp, nextIp, sizeof(_bootState.wifiIp) - 1) != 0) {
        strncpy(_bootState.wifiIp, nextIp, sizeof(_bootState.wifiIp) - 1);
        _bootState.wifiIp[sizeof(_bootState.wifiIp) - 1] = '\0';
        changed = true;
    }

    if (changed) _bootMarkChanged(BOOT_STATE_CHANGED_WIFI);
}

static inline uint32_t bootStateConsumeChanges() {
    uint32_t changes = _bootState.changeMask;
    _bootState.changeMask = 0;
    return changes;
}

static inline const BootRuntimeState& bootStateSnapshot() {
    return _bootState;
}
