#include "status_watch.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "unified_runtime.h"

#define STATUS_WATCH_MIN_ACTIVE_INTERVAL_MS  5000U
#define STATUS_WATCH_MAX_ACTIVE_INTERVAL_MS  60000U
#define STATUS_WATCH_MIN_TTL_MS              30000U
#define STATUS_WATCH_MAX_TTL_MS              300000U

static SemaphoreHandle_t s_lock;
static status_watch_policy_t s_policy;
static bool s_ready;
static status_watch_update_listener_t s_update_listener;

static uint32_t clamp_u32(uint32_t value, uint32_t fallback, uint32_t min_value, uint32_t max_value) {
    if (value == 0U) {
        value = fallback;
    }
    if (value < min_value) {
        return min_value;
    }
    if (value > max_value) {
        return max_value;
    }
    return value;
}

static bool active_until_valid(uint32_t now_ms, uint32_t active_until_ms) {
    return active_until_ms != 0U && (int32_t)(active_until_ms - now_ms) > 0;
}

esp_err_t status_watch_init(void) {
    if (s_ready) {
        return ESP_OK;
    }

    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) {
        return ESP_ERR_NO_MEM;
    }

    memset(&s_policy, 0, sizeof(s_policy));
    s_policy.ttl_ms = STATUS_WATCH_DEFAULT_ACTIVE_TTL_MS;
    s_policy.active_interval_ms = STATUS_WATCH_DEFAULT_ACTIVE_INTERVAL_MS;
    s_policy.idle_interval_ms = STATUS_WATCH_IDLE_INTERVAL_MS;
    s_ready = true;
    return ESP_OK;
}

esp_err_t status_watch_update(bool active, uint32_t ttl_ms, uint32_t interval_ms) {
    uint32_t now_ms = unified_tick_now_ms();
    status_watch_update_listener_t listener = NULL;
    bool previous_active = false;
    uint32_t previous_active_interval_ms = 0U;
    bool next_active = false;
    bool notify_listener = false;

    if (!s_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }

    ttl_ms = clamp_u32(ttl_ms, STATUS_WATCH_DEFAULT_ACTIVE_TTL_MS, STATUS_WATCH_MIN_TTL_MS, STATUS_WATCH_MAX_TTL_MS);
    interval_ms = clamp_u32(interval_ms, STATUS_WATCH_DEFAULT_ACTIVE_INTERVAL_MS, STATUS_WATCH_MIN_ACTIVE_INTERVAL_MS, STATUS_WATCH_MAX_ACTIVE_INTERVAL_MS);

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    previous_active = active_until_valid(now_ms, s_policy.active_until_ms);
    previous_active_interval_ms = s_policy.active_interval_ms;

    s_policy.ttl_ms = ttl_ms;
    s_policy.active_interval_ms = interval_ms;
    s_policy.idle_interval_ms = STATUS_WATCH_IDLE_INTERVAL_MS;
    s_policy.active_until_ms = active ? now_ms + ttl_ms : 0U;
    next_active = active && active_until_valid(now_ms, s_policy.active_until_ms);
    s_policy.active = next_active;
    notify_listener = (previous_active != next_active) ||
        (next_active && previous_active_interval_ms != s_policy.active_interval_ms);
    listener = notify_listener ? s_update_listener : NULL;

    xSemaphoreGive(s_lock);
    if (listener) {
        listener();
    }
    return ESP_OK;
}

void status_watch_get_policy(status_watch_policy_t *out_policy) {
    uint32_t now_ms = unified_tick_now_ms();

    if (!out_policy) {
        return;
    }

    memset(out_policy, 0, sizeof(*out_policy));
    out_policy->ttl_ms = STATUS_WATCH_DEFAULT_ACTIVE_TTL_MS;
    out_policy->active_interval_ms = STATUS_WATCH_DEFAULT_ACTIVE_INTERVAL_MS;
    out_policy->idle_interval_ms = STATUS_WATCH_IDLE_INTERVAL_MS;

    if (!s_ready || !s_lock) {
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    *out_policy = s_policy;
    out_policy->active = active_until_valid(now_ms, out_policy->active_until_ms);

    xSemaphoreGive(s_lock);
}

void status_watch_set_update_listener(status_watch_update_listener_t listener) {
    if (!s_ready || !s_lock) {
        return;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }
    s_update_listener = listener;
    xSemaphoreGive(s_lock);
}
