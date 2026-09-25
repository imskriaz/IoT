#include "diagnostics.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs.h"

#include "unified_runtime.h"

#define DIAGNOSTICS_NAMESPACE "diag"
#define DIAGNOSTICS_KEY_LAST  "last_boot"
#define DIAGNOSTICS_RUNTIME_REFRESH_INTERVAL_MS  1000U

static const char *TAG = "diagnostics";

static char s_last_boot[DIAGNOSTICS_BREADCRUMB_LEN];
static SemaphoreHandle_t s_runtime_lock;
static diagnostics_runtime_t s_cached_runtime;
static uint32_t s_last_runtime_refresh_ms;
static bool s_ready;

static uint32_t diagnostics_u32_from_size(size_t value) {
    return value > UINT32_MAX ? UINT32_MAX : (uint32_t)value;
}

static uint32_t diagnostics_subtract_u32(uint32_t value, uint32_t subtract) {
    return value > subtract ? value - subtract : 0U;
}

static uint32_t diagnostics_used_bytes(uint32_t total, uint32_t free_bytes) {
    return total > free_bytes ? total - free_bytes : 0U;
}

static const char *reset_reason_name(esp_reset_reason_t reason) {
    switch (reason) {
        case ESP_RST_POWERON: return "power_on";
        case ESP_RST_SW: return "software";
        case ESP_RST_PANIC: return "panic";
        case ESP_RST_INT_WDT: return "int_wdt";
        case ESP_RST_TASK_WDT: return "task_wdt";
        case ESP_RST_WDT: return "wdt";
        case ESP_RST_BROWNOUT: return "brownout";
        default: return "other";
    }
}

esp_err_t diagnostics_init(void) {
    nvs_handle_t handle = 0;
    size_t required = sizeof(s_last_boot);
    char next_breadcrumb[DIAGNOSTICS_BREADCRUMB_LEN] = "";
    esp_err_t err = ESP_OK;

    if (s_ready) {
        return ESP_OK;
    }

    memset(s_last_boot, 0, sizeof(s_last_boot));
    memset(&s_cached_runtime, 0, sizeof(s_cached_runtime));
    if (!s_runtime_lock) {
        s_runtime_lock = xSemaphoreCreateMutex();
        if (!s_runtime_lock) {
            return ESP_ERR_NO_MEM;
        }
    }
    s_last_runtime_refresh_ms = 0U;

    err = nvs_open(DIAGNOSTICS_NAMESPACE, NVS_READWRITE, &handle);
    if (err == ESP_OK) {
        err = nvs_get_str(handle, DIAGNOSTICS_KEY_LAST, s_last_boot, &required);
        if (err == ESP_ERR_NVS_NOT_FOUND) {
            s_last_boot[0] = '\0';
            err = ESP_OK;
        }

        snprintf(next_breadcrumb, sizeof(next_breadcrumb), "boot:%s", reset_reason_name(esp_reset_reason()));
        if (err == ESP_OK) {
            err = nvs_set_str(handle, DIAGNOSTICS_KEY_LAST, next_breadcrumb);
            if (err == ESP_OK) {
                err = nvs_commit(handle);
            }
        }
        nvs_close(handle);
    }

    if (err != ESP_OK) {
        if (s_runtime_lock) {
            vSemaphoreDelete(s_runtime_lock);
            s_runtime_lock = NULL;
        }
        return err;
    }

    s_ready = true;
    ESP_LOGI(TAG, "ready last_boot=%s", s_last_boot[0] ? s_last_boot : "none");
    return ESP_OK;
}

void diagnostics_snapshot(diagnostics_runtime_t *out_runtime) {
    diagnostics_runtime_t runtime = {0};
    uint32_t now_ms = 0U;
    bool use_cached = false;

    if (!out_runtime) {
        return;
    }

    memset(out_runtime, 0, sizeof(*out_runtime));
    now_ms = unified_time_now_ms();

    if (s_runtime_lock && xSemaphoreTake(s_runtime_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        if (s_last_runtime_refresh_ms != 0U &&
            (now_ms - s_last_runtime_refresh_ms) < DIAGNOSTICS_RUNTIME_REFRESH_INTERVAL_MS) {
            *out_runtime = s_cached_runtime;
            use_cached = true;
        }
        xSemaphoreGive(s_runtime_lock);
    }

    if (use_cached) {
        out_runtime->uptime_ms = now_ms;
        return;
    }

    runtime.uptime_ms = now_ms;
    runtime.heap_total_bytes = diagnostics_u32_from_size(heap_caps_get_total_size(MALLOC_CAP_8BIT));
    runtime.heap_free_bytes = diagnostics_u32_from_size(heap_caps_get_free_size(MALLOC_CAP_8BIT));
    runtime.heap_used_bytes = diagnostics_used_bytes(runtime.heap_total_bytes, runtime.heap_free_bytes);
    runtime.heap_largest_free_block_bytes = diagnostics_u32_from_size(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
    runtime.runtime_ram_total_bytes = diagnostics_u32_from_size(heap_caps_get_total_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    runtime.runtime_ram_free_bytes = diagnostics_u32_from_size(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    runtime.runtime_ram_used_bytes = diagnostics_used_bytes(runtime.runtime_ram_total_bytes, runtime.runtime_ram_free_bytes);
    runtime.runtime_ram_largest_free_block_bytes = diagnostics_u32_from_size(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    runtime.psram_total_bytes = diagnostics_u32_from_size(heap_caps_get_total_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    runtime.psram_free_bytes = diagnostics_u32_from_size(heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    runtime.psram_used_bytes = diagnostics_used_bytes(runtime.psram_total_bytes, runtime.psram_free_bytes);
    runtime.psram_largest_free_block_bytes = diagnostics_u32_from_size(heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    runtime.other_heap_total_bytes = diagnostics_subtract_u32(
        diagnostics_subtract_u32(runtime.heap_total_bytes, runtime.runtime_ram_total_bytes),
        runtime.psram_total_bytes
    );
    runtime.other_heap_free_bytes = diagnostics_subtract_u32(
        diagnostics_subtract_u32(runtime.heap_free_bytes, runtime.runtime_ram_free_bytes),
        runtime.psram_free_bytes
    );
    runtime.other_heap_used_bytes = diagnostics_used_bytes(runtime.other_heap_total_bytes, runtime.other_heap_free_bytes);
    runtime.free_heap_bytes = runtime.heap_free_bytes;
    runtime.min_free_heap_bytes = esp_get_minimum_free_heap_size();
    runtime.largest_free_block_bytes = runtime.heap_largest_free_block_bytes;
    runtime.internal_free_heap_bytes = runtime.runtime_ram_free_bytes;
    runtime.internal_largest_free_block_bytes = runtime.runtime_ram_largest_free_block_bytes;
    runtime.free_psram_bytes = runtime.psram_free_bytes;
    runtime.reset_reason = esp_reset_reason();
    snprintf(runtime.last_boot_breadcrumb, sizeof(runtime.last_boot_breadcrumb), "%s", s_last_boot);

    if (s_runtime_lock && xSemaphoreTake(s_runtime_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        s_cached_runtime = runtime;
        s_last_runtime_refresh_ms = now_ms;
        *out_runtime = s_cached_runtime;
        xSemaphoreGive(s_runtime_lock);
    } else {
        *out_runtime = runtime;
    }

    out_runtime->uptime_ms = now_ms;
}

