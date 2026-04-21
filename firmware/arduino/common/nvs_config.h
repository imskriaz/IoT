#pragma once
/*
 * nvs_config.h  — NVS-backed device configuration
 *
 * Uses Arduino Preferences library (wraps ESP-IDF NVS).
 * All config is stored under namespace "esp32cfg".
 *
 * On first boot (empty NVS) all getters return empty strings / defaults.
 * Use nvsConfigSave() to persist values received via BLE or WiFi-AP setup.
 *
 * Factory reset: call nvsConfigErase() then ESP.restart().
 */

#include <Preferences.h>
#include <Arduino.h>
#include "runtime_defaults.h"

// Maximum field lengths (including null terminator)
#define NVS_DEVICE_ID_LEN   65
#define NVS_MQTT_HOST_LEN  201
#define NVS_MQTT_USER_LEN  101
#define NVS_MQTT_PASS_LEN  201
#define NVS_APN_LEN        101
#define NVS_WIFI_SSID_LEN  65
#define NVS_WIFI_PASS_LEN  65
#define NVS_MODE_LEN       16

static Preferences _nvsPref;

// ── Runtime config struct ──────────────────────────────────────────────────────

struct DeviceConfig {
    char device_id[NVS_DEVICE_ID_LEN];
    char mqtt_host[NVS_MQTT_HOST_LEN];
    int  mqtt_port;
    char mqtt_user[NVS_MQTT_USER_LEN];
    char mqtt_pass[NVS_MQTT_PASS_LEN];
    char apn[NVS_APN_LEN];
    char wifi_ssid[NVS_WIFI_SSID_LEN];
    char wifi_pass[NVS_WIFI_PASS_LEN];
    char mode[NVS_MODE_LEN];
    bool valid;   // true if device_id and mqtt_host are present in NVS
};

// ── Load config from NVS (returns false if NVS is empty / not configured) ─────

static bool nvsConfigLoad(DeviceConfig& cfg) {
    _nvsPref.begin("esp32cfg", true); // read-only

    cfg.valid = false;
    _nvsPref.getString("device_id",  cfg.device_id,  sizeof(cfg.device_id));
    _nvsPref.getString("mqtt_host",  cfg.mqtt_host,  sizeof(cfg.mqtt_host));
    cfg.mqtt_port = _nvsPref.getInt("mqtt_port", 0);
    _nvsPref.getString("mqtt_user",  cfg.mqtt_user,  sizeof(cfg.mqtt_user));
    _nvsPref.getString("mqtt_pass",  cfg.mqtt_pass,  sizeof(cfg.mqtt_pass));
    _nvsPref.getString("apn",        cfg.apn,        sizeof(cfg.apn));
    _nvsPref.getString("wifi_ssid",  cfg.wifi_ssid,  sizeof(cfg.wifi_ssid));
    _nvsPref.getString("wifi_pass",  cfg.wifi_pass,  sizeof(cfg.wifi_pass));
    _nvsPref.getString("mode",       cfg.mode,       sizeof(cfg.mode));

    _nvsPref.end();

    if (cfg.mode[0] == '\0') {
        strncpy(cfg.mode, "normal", sizeof(cfg.mode) - 1);
        cfg.mode[sizeof(cfg.mode) - 1] = '\0';
    }

    cfg.valid = (cfg.device_id[0] != '\0' && cfg.mqtt_host[0] != '\0');
    return cfg.valid;
}

// ── Save config to NVS ────────────────────────────────────────────────────────

static bool nvsConfigSave(const DeviceConfig& cfg) {
    if (cfg.device_id[0] == '\0' || cfg.mqtt_host[0] == '\0') return false;

    _nvsPref.begin("esp32cfg", false); // read-write

    _nvsPref.putString("device_id",  cfg.device_id);
    _nvsPref.putString("mqtt_host",  cfg.mqtt_host);
    _nvsPref.putInt   ("mqtt_port",  cfg.mqtt_port > 0 ? cfg.mqtt_port : FW_DEFAULT_MQTT_PORT);
    _nvsPref.putString("mqtt_user",  cfg.mqtt_user);
    _nvsPref.putString("mqtt_pass",  cfg.mqtt_pass);
    _nvsPref.putString("apn",        cfg.apn);
    _nvsPref.putString("wifi_ssid",  cfg.wifi_ssid);
    _nvsPref.putString("wifi_pass",  cfg.wifi_pass);
    _nvsPref.putString("mode",       cfg.mode[0] ? cfg.mode : "normal");

    _nvsPref.end();
    return true;
}

// ── Erase all config (factory reset) ─────────────────────────────────────────

static void nvsConfigErase() {
    _nvsPref.begin("esp32cfg", false);
    _nvsPref.clear();
    _nvsPref.end();
}
