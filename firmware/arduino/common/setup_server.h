#pragma once
/*
 * setup_server.h  — WiFi-AP setup server for device onboarding
 *
 * Starts a soft-AP with a chip-derived SSID/password.
 * Hosts a tiny HTTP server at 192.168.4.1:
 *
 *   GET  /status      → { "board":"...", "firmware":"...", "mac":"..." }
 *   POST /configure   → accepts JSON config, saves to NVS, reboots
 *
 * The dashboard's onboarding route (/api/onboard/wifi-probe and /wifi-send)
 * proxies these requests server-side to bypass browser CORS.
 *
 * Requires: WiFi.h, WebServer.h, ArduinoJson.h, nvs_config.h
 */

#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include "nvs_config.h"
#include "runtime_defaults.h"

#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "1.0.0"
#endif

#ifndef BOARD_TYPE
#define BOARD_TYPE BOARD_SLUG
#endif

static WebServer _setupServer(80);
static bool _setupServerRunning = false;
static volatile bool _setupConfigReceived = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

static void _setupHandleStatus() {
    uint8_t mac[6];
    WiFi.macAddress(mac);
    char macStr[18];
    snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    String json = "{\"board\":\"" BOARD_TYPE "\","
                    "\"firmware\":\"" FIRMWARE_VERSION "\","
                    "\"mac\":\"" + String(macStr) + "\"}";
    _setupServer.send(200, "application/json", json);
}

static void _setupHandleConfigure() {
    if (_setupServer.method() != HTTP_POST) {
        _setupServer.send(405, "application/json", "{\"error\":\"POST required\"}");
        return;
    }

    String body = _setupServer.arg("plain");
    if (body.isEmpty()) {
        _setupServer.send(400, "application/json", "{\"error\":\"Empty body\"}");
        return;
    }

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, body);
    if (err) {
        _setupServer.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
        return;
    }

    const char* device_id = doc["device_id"] | "";
    const char* mqtt_host = doc["mqtt_host"] | "";
    int         mqtt_port = doc["mqtt_port"] | FW_DEFAULT_MQTT_PORT;
    const char* mqtt_user = doc["mqtt_user"] | "";
    const char* mqtt_pass = doc["mqtt_pass"] | "";
    const char* apn       = doc["apn"]       | "";
    const char* wifi_ssid = doc["wifi_ssid"] | "";
    const char* wifi_pass = doc["wifi_pass"] | "";

    if (strlen(device_id) == 0 || strlen(mqtt_host) == 0) {
        _setupServer.send(400, "application/json", "{\"error\":\"device_id and mqtt_host required\"}");
        return;
    }

    // Save to NVS
    DeviceConfig cfg = {};
    strncpy(cfg.device_id, device_id, sizeof(cfg.device_id) - 1);
    strncpy(cfg.mqtt_host, mqtt_host, sizeof(cfg.mqtt_host) - 1);
    cfg.mqtt_port = (mqtt_port > 0 && mqtt_port <= 65535) ? mqtt_port : FW_DEFAULT_MQTT_PORT;
    strncpy(cfg.mqtt_user, mqtt_user, sizeof(cfg.mqtt_user) - 1);
    strncpy(cfg.mqtt_pass, mqtt_pass, sizeof(cfg.mqtt_pass) - 1);
    strncpy(cfg.apn,       apn,       sizeof(cfg.apn)       - 1);
    strncpy(cfg.wifi_ssid, wifi_ssid, sizeof(cfg.wifi_ssid) - 1);
    strncpy(cfg.wifi_pass, wifi_pass, sizeof(cfg.wifi_pass) - 1);

    if (!nvsConfigSave(cfg)) {
        _setupServer.send(500, "application/json", "{\"error\":\"NVS write failed\"}");
        return;
    }

    _setupServer.send(200, "application/json", "{\"success\":true,\"message\":\"Config saved — rebooting\"}");
    _setupConfigReceived = true;
    // Reboot after sending response (give server time to flush)
    delay(500);
    ESP.restart();
}

// ── Public API ────────────────────────────────────────────────────────────────

// Start the WiFi AP and HTTP server. Call once in setup() when in setup mode.
static void setupServerBegin() {
    char ssid[32];
    char pass[16];
    fwBuildSetupApSsid(ssid, sizeof(ssid));
    fwBuildSetupApPassword(pass, sizeof(pass));

    WiFi.mode(WIFI_AP);
    WiFi.softAP(ssid, pass);
    Serial.printf("[SETUP] WiFi AP started: %s  Pass: %s  IP: %s\n",
                  ssid, pass, WiFi.softAPIP().toString().c_str());

    _setupServer.on("/status",    HTTP_GET,  _setupHandleStatus);
    _setupServer.on("/configure", HTTP_POST, _setupHandleConfigure);
    _setupServer.onNotFound([]() {
        _setupServer.send(404, "application/json", "{\"error\":\"Not found\"}");
    });
    _setupServer.begin();
    _setupServerRunning = true;
}

// Call this in loop() while in setup mode.
static void setupServerHandle() {
    if (_setupServerRunning) _setupServer.handleClient();
}

// Returns true once /configure has been accepted (device is about to reboot).
static bool setupConfigReceived() {
    return _setupConfigReceived;
}

// Stop the server and AP (call before switching to normal MQTT operation).
static void setupServerStop() {
    if (_setupServerRunning) {
        _setupServer.stop();
        WiFi.softAPdisconnect(true);
        WiFi.mode(WIFI_OFF);
        _setupServerRunning = false;
    }
}
