#include "state_mgr.h"

#include <stdio.h>
#include <string.h>
#include <inttypes.h>
#include "esp_random.h"
#include "esp_app_desc.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static SemaphoreHandle_t s_lock;
static state_mgr_snapshot_t s_state;
static bool s_ready;
static TaskHandle_t s_ota_executor;
static char s_boot_id[17];
static char s_firmware_version[33];
static char s_firmware_elf_sha256[65];

const char *state_mgr_boot_id(void) { return s_boot_id; }
const char *state_mgr_firmware_version(void) { return s_firmware_version; }
const char *state_mgr_firmware_elf_sha256(void) { return s_firmware_elf_sha256; }

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
    snprintf(s_boot_id, sizeof(s_boot_id), "%08" PRIx32 "%08" PRIx32, esp_random(), esp_random());
    const esp_app_desc_t *app = esp_app_get_description();
    snprintf(s_firmware_version, sizeof(s_firmware_version), "%s", app->version);
    for (size_t i = 0; i < sizeof(app->app_elf_sha256); ++i) {
        snprintf(s_firmware_elf_sha256 + i * 2U, 3U, "%02x", app->app_elf_sha256[i]);
    }
    /* state_mgr_init is called by app_main. Retain that internal-SRAM task as
     * the sole executor for OTA APIs which disable the flash cache. */
    s_ota_executor = xTaskGetCurrentTaskHandle();
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

esp_err_t state_mgr_set_ota_runtime(const char *slot, const char *image_state, uint32_t address) {
    if (!slot || !image_state) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    if (strncmp(s_state.ota_slot, slot, sizeof(s_state.ota_slot)) != 0 ||
        strncmp(s_state.ota_state, image_state, sizeof(s_state.ota_state)) != 0 ||
        s_state.ota_address != address) {
        snprintf(s_state.ota_slot, sizeof(s_state.ota_slot), "%s", slot);
        snprintf(s_state.ota_state, sizeof(s_state.ota_state), "%s", image_state);
        s_state.ota_address = address;
        bump_state_version_locked();
    }

    xSemaphoreGive(s_lock);
    return ESP_OK;
}

esp_err_t state_mgr_set_ota_image_state(const char *image_state) {
    if (!image_state) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    if (strncmp(s_state.ota_state, image_state, sizeof(s_state.ota_state)) != 0) {
        snprintf(s_state.ota_state, sizeof(s_state.ota_state), "%s", image_state);
        bump_state_version_locked();
    }

    xSemaphoreGive(s_lock);
    return ESP_OK;
}

esp_err_t state_mgr_request_ota_validation(void) {
    bool already_valid = false;

    if (!s_ready || !s_lock || !s_ota_executor) {
        return ESP_ERR_NOT_FOUND;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    already_valid = strcmp(s_state.ota_state, "valid") == 0;
    xSemaphoreGive(s_lock);

    if (already_valid) {
        return ESP_ERR_INVALID_STATE;
    }
    xTaskNotifyGive(s_ota_executor);
    return ESP_OK;
}

bool state_mgr_wait_for_ota_validation(uint32_t timeout_ms) {
    TickType_t wait_ticks = timeout_ms == UINT32_MAX
        ? portMAX_DELAY
        : pdMS_TO_TICKS(timeout_ms);

    if (!s_ready || xTaskGetCurrentTaskHandle() != s_ota_executor) {
        return false;
    }
    /* Coalesce verified health ACK retries into one flash update. */
    return ulTaskNotifyTake(pdTRUE, wait_ticks) > 0U;
}
