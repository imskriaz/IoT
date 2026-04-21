#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

typedef struct {
    bool present;
    bool initialized;
    int battery_percent;
    int32_t voltage_mv;
    int charging_state; /* 1 = charging, 0 = discharging, -1 = unknown */
    uint32_t sample_count;
    uint32_t last_update_ms;
} battery_monitor_status_t;

esp_err_t battery_monitor_init(void);
void battery_monitor_get_status(battery_monitor_status_t *out_status);
