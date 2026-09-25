#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#define STATUS_WATCH_DEFAULT_ACTIVE_TTL_MS       90000U
#define STATUS_WATCH_DEFAULT_ACTIVE_INTERVAL_MS  15000U
#define STATUS_WATCH_IDLE_INTERVAL_MS            60000U

typedef struct {
    bool active;
    uint32_t ttl_ms;
    uint32_t active_interval_ms;
    uint32_t idle_interval_ms;
    uint32_t active_until_ms;
} status_watch_policy_t;

typedef void (*status_watch_update_listener_t)(void);

esp_err_t status_watch_init(void);
esp_err_t status_watch_update(bool active, uint32_t ttl_ms, uint32_t interval_ms);
void status_watch_get_policy(status_watch_policy_t *out_policy);
void status_watch_set_update_listener(status_watch_update_listener_t listener);
