#include <inttypes.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_log.h"
#include "esp_ota_ops.h"
#include "nvs_flash.h"

#include "api_bridge.h"
#include "automation_bridge.h"
#include "battery_monitor.h"
#include "board_bsp.h"
#include "config_mgr.h"
#include "device_status.h"
#include "diagnostics.h"
#include "health_monitor.h"
#include "modem_a7670.h"
#include "mqtt_mgr.h"
#include "serial_config.h"
#include "sms_service.h"
#include "state_mgr.h"
#include "status_watch.h"
#include "storage_mgr.h"
#include "task_registry.h"
#include "telemetry_service.h"
#include "wifi_mgr.h"

static const char *TAG = "app_main";

static const char *ota_state_name(esp_ota_img_states_t state) {
    switch (state) {
        case ESP_OTA_IMG_NEW: return "new";
        case ESP_OTA_IMG_PENDING_VERIFY: return "pending_verify";
        case ESP_OTA_IMG_VALID: return "valid";
        case ESP_OTA_IMG_INVALID: return "invalid";
        case ESP_OTA_IMG_ABORTED: return "aborted";
        case ESP_OTA_IMG_UNDEFINED:
        default: return "undefined";
    }
}

static void cache_ota_runtime_state(void) {
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t image_state = ESP_OTA_IMG_UNDEFINED;

    if (!running) {
        ESP_LOGW(TAG, "running OTA partition unavailable");
        return;
    }
    if (esp_ota_get_state_partition(running, &image_state) != ESP_OK) {
        image_state = ESP_OTA_IMG_UNDEFINED;
    }
    ESP_ERROR_CHECK(state_mgr_set_ota_runtime(
        running->label, ota_state_name(image_state), running->address));
}

static esp_err_t init_nvs(void) {
    esp_err_t err = nvs_flash_init();

    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        /* Never erase configuration or the durable SMS/event spool as an
         * implicit boot-recovery action.  An explicit recovery command must
         * back up/export the partition and obtain operator authorization
         * before any destructive reset. */
        ESP_LOGE(TAG, "NVS requires explicit recovery (err=%s); preserving flash contents", esp_err_to_name(err));
    }

    return err;
}

static void boot_component(const char *name, esp_err_t (*init_fn)(void)) {
    esp_err_t err = init_fn();

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "%s init failed: %s", name, esp_err_to_name(err));
        ESP_ERROR_CHECK(err);
    }

    ESP_LOGI(TAG, "%s ready", name);
}

static void boot_optional_component(const char *name, esp_err_t (*init_fn)(void)) {
    esp_err_t err = init_fn();

    if (err != ESP_OK) {
        ESP_LOGW(TAG, "%s init skipped: %s", name, esp_err_to_name(err));
        return;
    }

    ESP_LOGI(TAG, "%s ready", name);
}

void app_main(void) {
    board_bsp_identity_t identity = {0};

    ESP_LOGI(TAG, "minimal boot start");
    esp_err_t nvs_err = init_nvs();
    if (nvs_err != ESP_OK) {
        /* Preserve the unreadable/full NVS partition and remain reachable by
         * the ROM/USB serial recovery channel. Runtime services must not start
         * with defaults that could overwrite credentials or durable state. */
        ESP_LOGE(TAG, "RECOVERY_ONLY nvs_unavailable=%s data_preserved=yes",
                 esp_err_to_name(nvs_err));
        while (true) {
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }

    boot_component("board_bsp", board_bsp_init);
    boot_component("task_registry", task_registry_init);

    boot_component("config_mgr", config_mgr_init);
    boot_component("state_mgr", state_mgr_init);
    /* This flash-backed query must run on main_task's internal-SRAM stack.
     * Status/telemetry workers may use PSRAM stacks and only read the cache. */
    cache_ota_runtime_state();
    boot_component("status_watch", status_watch_init);
    boot_component("diagnostics", diagnostics_init);
    boot_component("health_monitor", health_monitor_init);
    boot_component("battery_monitor", battery_monitor_init);
    boot_component("storage_mgr", storage_mgr_init);
    boot_component("modem_a7670", modem_a7670_init);
    boot_component("sms_service", sms_service_init);
    boot_component("wifi_mgr", wifi_mgr_init);
    boot_component("api_bridge", api_bridge_init);
    boot_component("automation_bridge", automation_bridge_init);
    boot_component("mqtt_mgr", mqtt_mgr_init);
    boot_component("device_status", device_status_init);
    boot_optional_component("serial_config", serial_config_init);
    boot_component("telemetry_service", telemetry_service_init);

    board_bsp_get_identity(&identity);
    ESP_LOGI(
        TAG,
        "main runtime ready board=%s device_id=%s flash=%" PRIu32 "MiB psram=%" PRIu32 "MiB mqtt_sms=yes",
        BOARD_NAME,
        identity.device_id,
        identity.flash_size_bytes / (1024U * 1024U),
        identity.psram_size_bytes / (1024U * 1024U)
    );
    device_status_log_json();

    while (true) {
        if (!state_mgr_wait_for_ota_validation(UINT32_MAX)) {
            continue;
        }
        /* main_task has an internal-SRAM stack. OTA validation may disable
         * flash cache and must never execute from a PSRAM-backed worker. */
        if (!task_registry_required_healthy(120000U)) {
            ESP_LOGW(TAG, "OTA validation deferred: required workers unhealthy");
            continue;
        }
        const esp_partition_t *running = esp_ota_get_running_partition();
        const esp_partition_t *selected = esp_ota_get_boot_partition();
        esp_ota_img_states_t image_state = ESP_OTA_IMG_UNDEFINED;
        if (!running || !selected || running->address != selected->address) {
            /* An OTA download can select the next image before reboot. A
             * late PUBACK from this boot must not accept that other image. */
            ESP_LOGW(TAG, "OTA validation deferred: boot partition changed");
            continue;
        }
        if (esp_ota_get_state_partition(running, &image_state) != ESP_OK ||
            image_state != ESP_OTA_IMG_PENDING_VERIFY) {
            cache_ota_runtime_state();
            continue;
        }
        esp_err_t mark_err = esp_ota_mark_app_valid_cancel_rollback();
        if (mark_err == ESP_OK) {
            /* Read back the persisted state; API success on a non-OTA boot
             * must not manufacture a valid state in telemetry. */
            cache_ota_runtime_state();
            ESP_LOGI(TAG, "running app validation completed after broker PUBACK");
        } else {
            ESP_LOGE(TAG, "OTA validation failed: %s", esp_err_to_name(mark_err));
        }
    }
}
