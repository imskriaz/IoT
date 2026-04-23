#pragma once

#include <stddef.h>

#include "esp_err.h"
#include "esp_wifi_types_generic.h"

#include "common_models.h"

typedef struct {
    unified_service_runtime_t runtime;
    bool configured;
    bool started;
    bool connected;
    bool ip_assigned;
    bool reconnect_suppressed;
    bool last_scan_target_visible;
    int8_t rssi;
    uint32_t connect_attempt_count;
    uint32_t reconnect_count;
    uint32_t last_disconnect_reason;
    uint32_t last_scan_elapsed_ms;
    uint16_t last_scan_visible_count;
    char last_disconnect_reason_text[UNIFIED_TEXT_MEDIUM_LEN];
    char last_scan_summary[UNIFIED_TEXT_LONG_LEN];
    char ssid[33];
    char ip_address[16];
    char security[24];
} wifi_mgr_status_t;

typedef struct {
    char ssid[33];
    int8_t rssi;
    uint8_t primary_channel;
    wifi_auth_mode_t authmode;
} wifi_mgr_scan_result_t;

typedef enum {
    WIFI_MGR_SCAN_MODE_ACTIVE = 0,
    WIFI_MGR_SCAN_MODE_PASSIVE = 1,
} wifi_mgr_scan_mode_t;

typedef struct {
    wifi_mgr_scan_mode_t mode;
    uint8_t channel;
    uint16_t dwell_time_ms;
} wifi_mgr_scan_request_t;

typedef struct {
    wifi_mgr_scan_mode_t mode;
    uint8_t channel;
    uint16_t dwell_time_ms;
    uint16_t total_visible;
    uint32_t elapsed_ms;
    wifi_mode_t wifi_mode_before;
    wifi_mode_t wifi_mode_after;
    bool temporary_apsta;
    bool reconnect_after_scan;
} wifi_mgr_scan_report_t;

esp_err_t wifi_mgr_init(void);
void wifi_mgr_get_status(wifi_mgr_status_t *out_status);
esp_err_t wifi_mgr_request_connect(void);
esp_err_t wifi_mgr_set_enabled(bool enabled);
esp_err_t wifi_mgr_disconnect(bool suppress_reconnect);
esp_err_t wifi_mgr_scan_networks(
    const wifi_mgr_scan_request_t *request,
    wifi_mgr_scan_result_t *results,
    size_t max_results,
    size_t *out_count,
    wifi_mgr_scan_report_t *out_report
);
const char *wifi_mgr_disconnect_reason_name(uint32_t reason);
const char *wifi_mgr_scan_mode_name(wifi_mgr_scan_mode_t mode);
const char *wifi_mgr_wifi_mode_name(wifi_mode_t mode);
const char *wifi_mgr_auth_mode_name(wifi_auth_mode_t authmode);
