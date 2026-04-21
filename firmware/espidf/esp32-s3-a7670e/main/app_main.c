#include <inttypes.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_log.h"
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

static esp_err_t init_nvs(void) {
    esp_err_t err = nvs_flash_init();

    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
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
    ESP_ERROR_CHECK(init_nvs());

    boot_component("board_bsp", board_bsp_init);
    boot_component("task_registry", task_registry_init);

    boot_component("config_mgr", config_mgr_init);
    boot_component("state_mgr", state_mgr_init);
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
        vTaskDelay(portMAX_DELAY);
    }
}
