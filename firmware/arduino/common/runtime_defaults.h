#pragma once

#include <Arduino.h>
#include <WiFi.h>
#include <esp_system.h>

#ifndef FW_DEFAULT_MQTT_PORT
#define FW_DEFAULT_MQTT_PORT 1883
#endif

#ifndef FW_SETUP_AP_PREFIX
#define FW_SETUP_AP_PREFIX "IoT-Setup"
#endif

#ifndef FW_DIRECT_AP_PREFIX
#define FW_DIRECT_AP_PREFIX "Device-Direct"
#endif

static inline uint64_t fwDefaultDeviceMac64() {
    return ESP.getEfuseMac();
}

static inline void fwBuildMacSuffix4(char* out, size_t outLen) {
    if (!out || outLen == 0) return;
    snprintf(out, outLen, "%04llX", fwDefaultDeviceMac64() & 0xFFFFULL);
}

static inline void fwBuildSetupApSsid(char* ssid, size_t ssidLen) {
    if (!ssid || ssidLen == 0) return;
    char suffix[8];
    fwBuildMacSuffix4(suffix, sizeof(suffix));
    snprintf(ssid, ssidLen, "%s-%s", FW_SETUP_AP_PREFIX, suffix);
}

static inline void fwBuildSetupApPassword(char* pass, size_t passLen) {
    if (!pass || passLen == 0) return;
    uint64_t mac = fwDefaultDeviceMac64();
    snprintf(pass, passLen, "%08llX", mac & 0xFFFFFFFFULL);
}

static inline void fwBuildDirectApSsid(char* ssid, size_t ssidLen) {
    if (!ssid || ssidLen == 0) return;
    char suffix[8];
    fwBuildMacSuffix4(suffix, sizeof(suffix));
    snprintf(ssid, ssidLen, "%s-%s", FW_DIRECT_AP_PREFIX, suffix);
}

static inline void fwBuildDirectApPassword(char* pass, size_t passLen) {
    fwBuildSetupApPassword(pass, passLen);
}

static inline uint32_t fwDeriveSetupBlePasskey() {
    uint64_t mac = fwDefaultDeviceMac64();
    uint32_t seed = (uint32_t)((mac ^ (mac >> 24) ^ (mac >> 12)) & 0xFFFFFFUL);
    return 100000UL + (seed % 900000UL);
}
