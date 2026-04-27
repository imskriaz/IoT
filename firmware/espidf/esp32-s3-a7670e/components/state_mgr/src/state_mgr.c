#include "state_mgr.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static SemaphoreHandle_t s_lock;
static state_mgr_snapshot_t s_state;
static bool s_ready;

static void bump_state_version_locked(void) {
    s_state.state_version = unified_state_next_version(s_state.state_version);
}

esp_err_t state_mgr_init(void) {
    if (s_ready) {
        return ESP_OK;
    }

    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) {
        return ESP_ERR_NO_MEM;
    }

    unified_reported_state_reset(&s_state);
    s_ready = true;
    return ESP_OK;
}

void state_mgr_get_snapshot(state_mgr_snapshot_t *out_snapshot) {
    if (!out_snapshot) {
        return;
    }

    memset(out_snapshot, 0, sizeof(*out_snapshot));
    if (!s_ready || !s_lock) {
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    *out_snapshot = s_state;
    xSemaphoreGive(s_lock);
}

esp_err_t state_mgr_set_storage(bool sd_mounted) {
    if (!s_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    if (s_state.sd_mounted != sd_mounted) {
        s_state.sd_mounted = sd_mounted;
        bump_state_version_locked();
    }

    xSemaphoreGive(s_lock);
    return ESP_OK;
}

esp_err_t state_mgr_set_modem_runtime(bool telephony_enabled, bool data_mode_enabled) {
    if (!s_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    if (s_state.telephony_enabled != telephony_enabled ||
        s_state.data_mode_enabled != data_mode_enabled) {
        s_state.telephony_enabled = telephony_enabled;
        s_state.data_mode_enabled = data_mode_enabled;
        bump_state_version_locked();
    }

    xSemaphoreGive(s_lock);
    return ESP_OK;
}
