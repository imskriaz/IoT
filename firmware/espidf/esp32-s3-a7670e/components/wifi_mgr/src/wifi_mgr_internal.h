#pragma once

#include <stdbool.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "esp_err.h"
#include "esp_wifi.h"

#include "config_mgr.h"
#include "wifi_mgr.h"

#define WIFI_MGR_TAG "wifi_mgr"

extern SemaphoreHandle_t wifi_mgr_lock;
extern TaskHandle_t wifi_mgr_task_handle;
extern wifi_mgr_status_t wifi_mgr_status;
extern bool wifi_mgr_scan_in_progress;
extern bool wifi_mgr_scan_suppress_connect;
extern bool wifi_mgr_startup_connect_suppressed;
extern bool wifi_mgr_runtime_connect_suppressed;
extern bool wifi_mgr_connect_requested;
extern bool wifi_mgr_ready;

#define s_lock wifi_mgr_lock
#define s_task_handle wifi_mgr_task_handle
#define s_status wifi_mgr_status
#define s_scan_in_progress wifi_mgr_scan_in_progress
#define s_scan_suppress_connect wifi_mgr_scan_suppress_connect
#define s_startup_connect_suppressed wifi_mgr_startup_connect_suppressed
#define s_runtime_connect_suppressed wifi_mgr_runtime_connect_suppressed
#define s_connect_requested wifi_mgr_connect_requested
#define s_ready wifi_mgr_ready

void wifi_mgr_notify_task(void);
bool wifi_mgr_refresh_config_locked(config_mgr_data_t *out_config);
void wifi_mgr_build_sta_config(
    const config_mgr_data_t *config,
    wifi_config_t *wifi_config,
    const wifi_ap_record_t *target_ap
);
esp_err_t wifi_mgr_issue_connect(const char *detail);
esp_err_t wifi_mgr_run_connect_attempt(void);
