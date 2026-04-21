#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#define UNIFIED_CORRELATION_ID_LEN  32
#define UNIFIED_DEVICE_ID_LEN       32
#define UNIFIED_WIFI_SSID_LEN       33
#define UNIFIED_IPV4_ADDR_LEN       16
#define UNIFIED_TEXT_SHORT_LEN      24
#define UNIFIED_TEXT_MEDIUM_LEN     48
#define UNIFIED_TEXT_LONG_LEN       96
#define UNIFIED_SMS_TEXT_MAX_LEN    1024

typedef enum {
    UNIFIED_MODULE_STATE_UNINITIALIZED = 0,
    UNIFIED_MODULE_STATE_INITIALIZED,
    UNIFIED_MODULE_STATE_RUNNING,
    UNIFIED_MODULE_STATE_DEGRADED,
    UNIFIED_MODULE_STATE_ISOLATED,
    UNIFIED_MODULE_STATE_FAILED,
    UNIFIED_MODULE_STATE_STUB,
} unified_module_state_t;

typedef enum {
    UNIFIED_FEATURE_REASON_NONE = 0,
    UNIFIED_FEATURE_REASON_NOT_AVAILABLE_UNTIL_PHASE2,
    UNIFIED_FEATURE_REASON_FEATURE_NOT_INSTALLED,
} unified_feature_reason_t;

typedef struct {
    bool initialized;
    bool running;
    esp_err_t last_error;
    unified_module_state_t state;
    char last_error_text[UNIFIED_TEXT_MEDIUM_LEN];
} unified_service_runtime_t;

typedef struct {
    char correlation_id[UNIFIED_CORRELATION_ID_LEN];
    char device_id[UNIFIED_DEVICE_ID_LEN];
    uint32_t created_ms;
} unified_correlation_t;
