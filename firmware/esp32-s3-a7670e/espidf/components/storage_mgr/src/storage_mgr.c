#include "storage_mgr.h"

#include <inttypes.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <sys/stat.h>
#include "driver/gpio.h"
#include "driver/sdmmc_host.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "esp_log.h"
#include "esp_vfs_fat.h"
#include "nvs.h"
#include "sdmmc_cmd.h"

#include "board_bsp.h"
#include "config_mgr.h"
#include "health_monitor.h"
#include "payload_models.h"
#include "state_mgr.h"
#include "task_registry.h"
#include "unified_runtime.h"

#ifndef CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY
#define CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY  32
#endif

#ifndef CONFIG_UNIFIED_STORAGE_MOUNT_RETRY_MS
#define CONFIG_UNIFIED_STORAGE_MOUNT_RETRY_MS  15000
#endif

#ifndef CONFIG_UNIFIED_STORAGE_MAX_OPEN_FILES
#define CONFIG_UNIFIED_STORAGE_MAX_OPEN_FILES  8
#endif

#ifndef CONFIG_UNIFIED_STORAGE_TASK_STACK_SIZE
#define CONFIG_UNIFIED_STORAGE_TASK_STACK_SIZE  16384
#endif

#ifndef CONFIG_UNIFIED_STORAGE_SMS_HISTORY_MAX_ENTRIES
#define CONFIG_UNIFIED_STORAGE_SMS_HISTORY_MAX_ENTRIES  8
#endif

#define STORAGE_USAGE_REFRESH_INTERVAL_MS 30000U

#define STORAGE_NAMESPACE      "storage_mgr"
#define STORAGE_SPOOL_KEY      "telemetry"
#define STORAGE_BLOB_VERSION   3U
#define STORAGE_SD_SPOOL_FILE  "spool/telem.ndj"
#define STORAGE_SD_PATH_LEN    128U

static const char *TAG = "storage_mgr";

typedef enum {
    STORAGE_MGR_RECORD_SMS = 1,
} storage_mgr_record_type_t;

typedef struct {
    storage_mgr_record_type_t type;
    uint32_t timestamp_ms;
    unified_sms_payload_t sms;
} storage_mgr_record_t;

typedef struct {
    uint32_t version;
    uint32_t count;
    uint32_t head;
    storage_mgr_record_t records[CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY];
} storage_blob_t;

static SemaphoreHandle_t s_lock;
static storage_mgr_status_t s_status;
static storage_blob_t s_blob;
static bool s_ready;
static TaskHandle_t s_task_handle;
static uint32_t s_last_mount_attempt_ms;
static bool s_sd_recovery_exported;
static bool s_mount_probe_pending;
static uint32_t s_config_revision;
static sdmmc_card_t *s_sd_card;
static char s_mount_point[16];
static bool s_usage_dirty;
static uint32_t s_last_usage_refresh_ms;

static size_t storage_mgr_snapshot_records(storage_mgr_record_t *out_records, size_t max_records);
static void storage_mgr_escape_json(const char *input, char *output, size_t output_len);

static void storage_mgr_notify_task(void) {
    if (s_task_handle) {
        xTaskNotifyGive(s_task_handle);
    }
}

static esp_err_t storage_mgr_normalize_relative_path(const char *input, char *output, size_t output_len) {
    const char *cursor = input;
    size_t input_len = 0U;

    if (!input || !output || output_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    output[0] = '\0';
    input_len = strlen(input);
    if (input_len == 0U || input_len >= output_len) {
        return ESP_ERR_INVALID_ARG;
    }
    if (input[0] == '/' || input[0] == '\\' || strchr(input, '\\') || strchr(input, ':')) {
        return ESP_ERR_INVALID_ARG;
    }

    while (*cursor != '\0') {
        const char *segment_end = strchr(cursor, '/');
        size_t segment_len = segment_end ? (size_t)(segment_end - cursor) : strlen(cursor);

        if (segment_len == 0U) {
            return ESP_ERR_INVALID_ARG;
        }
        if ((segment_len == 1U && cursor[0] == '.') ||
            (segment_len == 2U && cursor[0] == '.' && cursor[1] == '.')) {
            return ESP_ERR_INVALID_ARG;
        }

        cursor += segment_len;
        if (*cursor == '/') {
            ++cursor;
        }
    }

    memcpy(output, input, input_len + 1U);
    return ESP_OK;
}

static esp_err_t storage_mgr_build_sd_path(const char *relative_path, char *full_path, size_t full_path_len) {
    int written = 0;

    if (!relative_path || !full_path || full_path_len == 0U || s_mount_point[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }

    written = snprintf(full_path, full_path_len, "%s/%s", s_mount_point, relative_path);
    if (written < 0 || (size_t)written >= full_path_len) {
        return ESP_ERR_INVALID_SIZE;
    }

    return ESP_OK;
}

static esp_err_t storage_mgr_set_mount_state(bool mounted) {
    return state_mgr_set_storage(mounted);
}

static esp_err_t storage_mgr_create_dir(const char *relative_path) {
    char normalized_path[STORAGE_SD_PATH_LEN] = {0};
    char full_path[STORAGE_SD_PATH_LEN] = {0};
    struct stat file_stat = {0};
    esp_err_t err = storage_mgr_normalize_relative_path(relative_path, normalized_path, sizeof(normalized_path));

    if (err != ESP_OK) {
        return err;
    }

    err = storage_mgr_build_sd_path(normalized_path, full_path, sizeof(full_path));
    if (err != ESP_OK) {
        return err;
    }

    if (stat(full_path, &file_stat) == 0) {
        return S_ISDIR(file_stat.st_mode) ? ESP_OK : ESP_ERR_INVALID_STATE;
    }

    if (mkdir(full_path, 0775) != 0 && errno != EEXIST) {
        return ESP_FAIL;
    }

    return ESP_OK;
}

static esp_err_t storage_mgr_write_file(const char *relative_path, const void *data, size_t length, bool append) {
    char normalized_path[STORAGE_SD_PATH_LEN] = {0};
    char full_path[STORAGE_SD_PATH_LEN] = {0};
    FILE *handle = NULL;
    const char *mode = append ? "a" : "w";
    esp_err_t err = storage_mgr_normalize_relative_path(relative_path, normalized_path, sizeof(normalized_path));

    if ((!data && length > 0U) || err != ESP_OK) {
        return ESP_ERR_INVALID_ARG;
    }

    err = storage_mgr_build_sd_path(normalized_path, full_path, sizeof(full_path));
    if (err != ESP_OK) {
        return err;
    }

    handle = fopen(full_path, mode);
    if (!handle) {
        return ESP_FAIL;
    }
    if (length > 0U && fwrite(data, 1U, length, handle) != length) {
        fclose(handle);
        return ESP_FAIL;
    }
    if (fflush(handle) != 0) {
        fclose(handle);
        return ESP_FAIL;
    }

    fclose(handle);
    return ESP_OK;
}

static void storage_mgr_refresh_config_locked(void) {
    uint32_t config_revision = config_mgr_revision();

    if (config_revision != 0U && s_config_revision == config_revision) {
        return;
    }

    s_config_revision = config_revision;
    s_status.enabled = config_mgr_storage_enabled();
}

static void storage_mgr_set_usage_locked(uint64_t total_bytes, uint64_t used_bytes, uint64_t free_bytes) {
    s_status.total_bytes = total_bytes;
    s_status.used_bytes = used_bytes;
    s_status.free_bytes = free_bytes;
    s_last_usage_refresh_ms = unified_tick_now_ms();
    s_usage_dirty = false;
}

static void storage_mgr_refresh_usage_locked(void) {
    uint64_t total_bytes = 0U;
    uint64_t free_bytes = 0U;
    uint64_t used_bytes = 0U;
    esp_err_t err = ESP_OK;

    if (s_sd_card == NULL || !s_status.media_available || s_mount_point[0] == '\0') {
        storage_mgr_set_usage_locked(0U, 0U, 0U);
        return;
    }

    err = esp_vfs_fat_info(s_mount_point, &total_bytes, &free_bytes);
    if (err != ESP_OK) {
        storage_mgr_set_usage_locked(0U, 0U, 0U);
        return;
    }

    used_bytes = total_bytes > free_bytes ? (total_bytes - free_bytes) : 0U;
    storage_mgr_set_usage_locked(total_bytes, used_bytes, free_bytes);
}

static void storage_mgr_set_health_locked(void) {
    health_module_state_t state = HEALTH_MODULE_STATE_OK;
    const char *detail = "running";

    if (!s_status.enabled) {
        state = HEALTH_MODULE_STATE_FAILED;
        detail = "storage_disabled";
        s_status.runtime.state = UNIFIED_MODULE_STATE_ISOLATED;
    } else if (s_status.buffered_only) {
        state = HEALTH_MODULE_STATE_DEGRADED;
        detail = s_status.media_available ? "sd_export_degraded" : "nvs_buffer_only";
        s_status.runtime.state = UNIFIED_MODULE_STATE_DEGRADED;
    } else {
        s_status.runtime.state = UNIFIED_MODULE_STATE_RUNNING;
    }

    s_status.runtime.running = s_status.enabled;
    (void)health_monitor_set_module_state("storage_mgr", state, detail);
}

static esp_err_t storage_mgr_persist_locked(void) {
    nvs_handle_t handle = 0;
    esp_err_t err = nvs_open(STORAGE_NAMESPACE, NVS_READWRITE, &handle);

    if (err != ESP_OK) {
        s_status.persist_failures++;
        return err;
    }

    err = nvs_set_blob(handle, STORAGE_SPOOL_KEY, &s_blob, sizeof(s_blob));
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);

    if (err != ESP_OK) {
        s_status.persist_failures++;
    }
    return err;
}

static esp_err_t storage_mgr_append_record_locked(const storage_mgr_record_t *record) {
    size_t write_index = 0;

    if (!record) {
        return ESP_ERR_INVALID_ARG;
    }

    storage_mgr_refresh_config_locked();
    if (!s_status.enabled) {
        return ESP_ERR_INVALID_STATE;
    }

    if (s_blob.count < CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY) {
        write_index = (s_blob.head + s_blob.count) % CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY;
        s_blob.count++;
    } else {
        write_index = s_blob.head;
        s_blob.head = (s_blob.head + 1U) % CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY;
        s_status.dropped_count++;
    }

    s_blob.records[write_index] = *record;
    s_status.record_count = s_blob.count;
    return storage_mgr_persist_locked();
}

static void storage_mgr_escape_json(const char *input, char *output, size_t output_len) {
    const char *cursor = input ? input : "";
    size_t write_index = 0;

    if (!output || output_len == 0) {
        return;
    }

    while (*cursor != '\0' && write_index + 1U < output_len) {
        unsigned char current = (unsigned char)*cursor++;

        if (current == '\\' && write_index + 2U < output_len) {
            output[write_index++] = '\\';
            output[write_index++] = '\\';
        } else if (current == '"' && write_index + 2U < output_len) {
            output[write_index++] = '\\';
            output[write_index++] = '"';
        } else if (current == '\n' && write_index + 2U < output_len) {
            output[write_index++] = '\\';
            output[write_index++] = 'n';
        } else if (current == '\r' && write_index + 2U < output_len) {
            output[write_index++] = '\\';
            output[write_index++] = 'r';
        } else if (current == '\t' && write_index + 2U < output_len) {
            output[write_index++] = '\\';
            output[write_index++] = 't';
        } else if (current < 0x20U && write_index + 6U < output_len) {
            /* Escape all other control characters as \u00XX for valid JSON. */
            static const char hex[] = "0123456789abcdef";
            output[write_index++] = '\\';
            output[write_index++] = 'u';
            output[write_index++] = '0';
            output[write_index++] = '0';
            output[write_index++] = hex[(current >> 4) & 0xF];
            output[write_index++] = hex[current & 0xF];
        } else if (current >= 0x20U) {
            output[write_index++] = (char)current;
        }
        /* Characters >= 0x20 that are not special pass through (UTF-8 safe). */
    }

    output[write_index] = '\0';
}

static esp_err_t storage_mgr_record_to_line(const storage_mgr_record_t *record, char *line, size_t line_len) {
    char field_a[192] = {0};
    char field_b[256] = {0};
    char field_c[96] = {0};
    int written = 0;

    if (!record || !line || line_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    switch (record->type) {
        case STORAGE_MGR_RECORD_SMS:
            storage_mgr_escape_json(record->sms.from, field_a, sizeof(field_a));
            storage_mgr_escape_json(record->sms.text, field_b, sizeof(field_b));
            storage_mgr_escape_json(record->sms.detail, field_c, sizeof(field_c));
            written = snprintf(
                line,
                line_len,
                "{\"type\":\"sms\",\"timestamp\":%" PRIu32 ",\"peer\":\"%s\",\"direction\":\"%s\",\"detail\":\"%s\",\"text\":\"%s\"}\n",
                record->timestamp_ms,
                field_a,
                record->sms.outgoing ? "outgoing" : "incoming",
                field_c[0] != '\0' ? field_c : (record->sms.outgoing ? "sms_sent" : "incoming_sms"),
                field_b
            );
            break;
        default:
            return ESP_ERR_INVALID_ARG;
    }

    if (written < 0 || (size_t)written >= line_len) {
        return ESP_ERR_INVALID_SIZE;
    }

    return ESP_OK;
}

static bool storage_mgr_card_present(const board_bsp_sdcard_config_t *sd_config) {
    gpio_config_t gpio_cfg = {0};
    int level = 0;

    if (!sd_config || sd_config->pin_card_detect < 0) {
        return true;
    }

    gpio_cfg.pin_bit_mask = 1ULL << sd_config->pin_card_detect;
    gpio_cfg.mode = GPIO_MODE_INPUT;
    gpio_cfg.pull_up_en = GPIO_PULLUP_ENABLE;
    gpio_cfg.pull_down_en = GPIO_PULLDOWN_DISABLE;
    gpio_cfg.intr_type = GPIO_INTR_DISABLE;
    (void)gpio_config(&gpio_cfg);

    level = gpio_get_level(sd_config->pin_card_detect);
    return sd_config->card_detect_active_low ? (level == 0) : (level != 0);
}

static void storage_mgr_update_media_state(bool media_available, bool buffered_only) {
    bool notify = false;

    if (!s_lock) {
        return;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    s_status.media_available = media_available;
    s_status.buffered_only = buffered_only;
    s_usage_dirty = true;
    if (!media_available) {
        storage_mgr_set_usage_locked(0U, 0U, 0U);
    }
    storage_mgr_set_health_locked();
    notify = true;
    xSemaphoreGive(s_lock);

    if (notify) {
        storage_mgr_notify_task();
    }
}

static void storage_mgr_unmount_sd(void) {
    if (s_sd_card != NULL) {
        esp_vfs_fat_sdcard_unmount(s_mount_point, s_sd_card);
        s_sd_card = NULL;
    }

    s_sd_recovery_exported = false;
    storage_mgr_update_media_state(false, true);
    (void)storage_mgr_set_mount_state(false);
}

static esp_err_t storage_mgr_prepare_sd_dirs(void) {
    static const char *dirs[] = { "spool", "logs", "files", "exports", "diag" };
    size_t index = 0;
    esp_err_t err = ESP_OK;

    for (index = 0; index < sizeof(dirs) / sizeof(dirs[0]); ++index) {
        err = storage_mgr_create_dir(dirs[index]);
        if (err != ESP_OK) {
            return err;
        }
    }

    return ESP_OK;
}

static esp_err_t storage_mgr_append_record_to_sd(const storage_mgr_record_t *record, bool count_flush) {
    char line[512] = {0};
    esp_err_t err = storage_mgr_record_to_line(record, line, sizeof(line));

    if (err != ESP_OK) {
        return err;
    }

    err = storage_mgr_write_file(STORAGE_SD_SPOOL_FILE, line, strlen(line), true);
    if (err != ESP_OK) {
        return err;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        if (count_flush) {
            s_status.sd_flush_count++;
        }
        s_usage_dirty = true;
        xSemaphoreGive(s_lock);
        storage_mgr_notify_task();
    }

    return ESP_OK;
}

static esp_err_t storage_mgr_export_buffered_records(void) {
    storage_mgr_record_t snapshot[CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY];
    size_t count = 0;
    size_t index = 0;
    esp_err_t err = ESP_OK;

    count = storage_mgr_snapshot_records(snapshot, CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY);
    for (index = 0; index < count; ++index) {
        err = storage_mgr_append_record_to_sd(&snapshot[index], true);
        if (err != ESP_OK) {
            return err;
        }
    }

    s_sd_recovery_exported = true;
    return ESP_OK;
}

static esp_err_t storage_mgr_try_mount_sd(void) {
    board_bsp_sdcard_config_t sd_config = {0};
    esp_vfs_fat_sdmmc_mount_config_t mount_config = {
        .format_if_mount_failed = false,
        .max_files = CONFIG_UNIFIED_STORAGE_MAX_OPEN_FILES,
        .allocation_unit_size = 16 * 1024,
        .disk_status_check_enable = false,
        .use_one_fat = false,
    };
    sdmmc_host_t host = SDMMC_HOST_DEFAULT();
    sdmmc_slot_config_t slot_config = SDMMC_SLOT_CONFIG_DEFAULT();
    esp_err_t err = ESP_OK;

    board_bsp_get_sdcard_config(&sd_config);
    snprintf(s_mount_point, sizeof(s_mount_point), "%s", sd_config.mount_point[0] ? sd_config.mount_point : "/sd");

    if (!sd_config.enabled) {
        ESP_LOGI(TAG, "sd storage disabled in board configuration");
        storage_mgr_update_media_state(false, true);
        return ESP_ERR_NOT_SUPPORTED;
    }
    if (!storage_mgr_card_present(&sd_config)) {
        if (sd_config.require_card_detect) {
            ESP_LOGI(TAG, "sd card not detected on gpio %d", sd_config.pin_card_detect);
            storage_mgr_update_media_state(false, true);
            return ESP_ERR_NOT_FOUND;
        }
        ESP_LOGW(TAG, "sd card detect on gpio %d reports not present, continuing mount probe", sd_config.pin_card_detect);
    }

    host.flags &= ~(SDMMC_HOST_FLAG_8BIT | SDMMC_HOST_FLAG_4BIT | SDMMC_HOST_FLAG_DDR);
    if (sd_config.one_line_mode) {
        host.flags |= SDMMC_HOST_FLAG_1BIT;
    } else {
        host.flags |= SDMMC_HOST_FLAG_4BIT;
    }
    slot_config.width = sd_config.one_line_mode ? 1 : 4;
    slot_config.clk = sd_config.pin_clk;
    slot_config.cmd = sd_config.pin_cmd;
    slot_config.d0 = sd_config.pin_d0;
    slot_config.cd = sd_config.require_card_detect ? sd_config.pin_card_detect : SDMMC_SLOT_NO_CD;
    slot_config.wp = SDMMC_SLOT_NO_WP;

    ESP_LOGI(
        TAG,
        "sd probe width=%d clk=%d cmd=%d d0=%d cd=%d",
        slot_config.width,
        slot_config.clk,
        slot_config.cmd,
        slot_config.d0,
        slot_config.cd
    );

    err = esp_vfs_fat_sdmmc_mount(s_mount_point, &host, &slot_config, &mount_config, &s_sd_card);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "sd mount failed at %s: %s", s_mount_point, esp_err_to_name(err));
        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            s_status.mount_failures++;
            xSemaphoreGive(s_lock);
        }
        storage_mgr_update_media_state(false, true);
        return err;
    }

    err = storage_mgr_set_mount_state(true);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "sd mount state publish failed: %s", esp_err_to_name(err));
        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            s_status.mount_failures++;
            xSemaphoreGive(s_lock);
        }
        storage_mgr_unmount_sd();
        return err;
    }

    err = storage_mgr_prepare_sd_dirs();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "sd directory preparation failed: %s", esp_err_to_name(err));
        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            s_status.mount_failures++;
            xSemaphoreGive(s_lock);
        }
        storage_mgr_unmount_sd();
        return err;
    }

    storage_mgr_update_media_state(true, false);
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        storage_mgr_refresh_usage_locked();
        xSemaphoreGive(s_lock);
    }

    if (!s_sd_recovery_exported) {
        err = storage_mgr_export_buffered_records();
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "sd recovery export failed: %s", esp_err_to_name(err));
            if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                s_status.mount_failures++;
                s_status.sd_write_failures++;
                xSemaphoreGive(s_lock);
            }
            storage_mgr_unmount_sd();
            return err;
        }
    }

    ESP_LOGI(TAG, "sd mounted at %s", s_mount_point);
    return ESP_OK;
}

static void storage_mgr_task(void *arg) {
    uint32_t now_ms = 0;
    uint32_t delay_ms = STORAGE_USAGE_REFRESH_INTERVAL_MS;
    uint32_t last_usage_refresh_ms = 0U;
    uint32_t last_mount_attempt_ms = 0U;
    bool storage_enabled = true;
    bool media_available = false;
    bool usage_dirty = false;
    bool mount_probe_pending = false;
    bool have_sd_card = false;
    bool mount_probe_due = false;
    bool attempted_mount_probe = false;
    TickType_t delay_ticks = pdMS_TO_TICKS(STORAGE_USAGE_REFRESH_INTERVAL_MS);

    (void)arg;

    s_task_handle = xTaskGetCurrentTaskHandle();
    ESP_ERROR_CHECK(task_registry_register_expected("storage_task"));
    ESP_ERROR_CHECK(task_registry_mark_running("storage_task", true));
    ESP_ERROR_CHECK(health_monitor_register_module("storage_mgr"));

    while (true) {
        now_ms = unified_tick_now_ms();
        delay_ms = STORAGE_USAGE_REFRESH_INTERVAL_MS;
        attempted_mount_probe = false;

        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            storage_mgr_refresh_config_locked();
            storage_enabled = s_status.enabled;
            if (s_status.media_available &&
                (s_usage_dirty ||
                 s_last_usage_refresh_ms == 0U ||
                 (now_ms - s_last_usage_refresh_ms) >= STORAGE_USAGE_REFRESH_INTERVAL_MS)) {
                storage_mgr_refresh_usage_locked();
            }
            storage_mgr_set_health_locked();
            media_available = s_status.media_available;
            usage_dirty = s_usage_dirty;
            last_usage_refresh_ms = s_last_usage_refresh_ms;
            mount_probe_pending = s_mount_probe_pending;
            last_mount_attempt_ms = s_last_mount_attempt_ms;
            have_sd_card = (s_sd_card != NULL);
            if (media_available) {
                if (usage_dirty || last_usage_refresh_ms == 0U) {
                    delay_ms = 0U;
                } else {
                    uint32_t usage_elapsed_ms = now_ms - last_usage_refresh_ms;
                    uint32_t usage_due_ms = usage_elapsed_ms >= STORAGE_USAGE_REFRESH_INTERVAL_MS
                        ? 0U
                        : (STORAGE_USAGE_REFRESH_INTERVAL_MS - usage_elapsed_ms);
                    if (usage_due_ms < delay_ms) {
                        delay_ms = usage_due_ms;
                    }
                }
            }
            if (storage_enabled && (mount_probe_pending || !have_sd_card)) {
                uint32_t mount_due_ms = 0U;

                if (!mount_probe_pending &&
                    last_mount_attempt_ms != 0U &&
                    (now_ms - last_mount_attempt_ms) < CONFIG_UNIFIED_STORAGE_MOUNT_RETRY_MS) {
                    mount_due_ms = CONFIG_UNIFIED_STORAGE_MOUNT_RETRY_MS - (now_ms - last_mount_attempt_ms);
                }
                if (mount_due_ms < delay_ms) {
                    delay_ms = mount_due_ms;
                }
            }
            xSemaphoreGive(s_lock);
        }

        mount_probe_due = storage_enabled &&
            (mount_probe_pending ||
             last_mount_attempt_ms == 0U ||
             (now_ms - last_mount_attempt_ms) >= CONFIG_UNIFIED_STORAGE_MOUNT_RETRY_MS);
        if (mount_probe_due) {
            attempted_mount_probe = true;
            s_mount_probe_pending = false;
            s_last_mount_attempt_ms = now_ms;
            if (!have_sd_card) {
                (void)storage_mgr_try_mount_sd();
            } else {
                board_bsp_sdcard_config_t sd_config = {0};

                board_bsp_get_sdcard_config(&sd_config);
                if (sd_config.require_card_detect && !storage_mgr_card_present(&sd_config)) {
                    ESP_LOGW(TAG, "sd card removed, falling back to nvs spool");
                    storage_mgr_unmount_sd();
                }
            }
        }

        ESP_ERROR_CHECK(task_registry_heartbeat("storage_task"));
        if (attempted_mount_probe && delay_ms < CONFIG_UNIFIED_STORAGE_MOUNT_RETRY_MS) {
            delay_ms = CONFIG_UNIFIED_STORAGE_MOUNT_RETRY_MS;
        }
        delay_ticks = pdMS_TO_TICKS(delay_ms);
        (void)ulTaskNotifyTake(pdTRUE, delay_ticks);
    }
}

esp_err_t storage_mgr_init(void) {
    BaseType_t task_ok = pdFAIL;
    nvs_handle_t handle = 0;
    size_t actual_size = sizeof(s_blob);
    esp_err_t err = ESP_OK;

    if (s_ready) {
        return ESP_OK;
    }

    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) {
        return ESP_ERR_NO_MEM;
    }

    memset(&s_status, 0, sizeof(s_status));
    memset(&s_blob, 0, sizeof(s_blob));
    memset(s_mount_point, 0, sizeof(s_mount_point));
    s_blob.version = STORAGE_BLOB_VERSION;
    s_status.runtime.initialized = true;
    s_status.runtime.state = UNIFIED_MODULE_STATE_INITIALIZED;

    s_config_revision = config_mgr_revision();
    s_status.enabled = config_mgr_storage_enabled();
    s_status.media_available = false;
    s_status.buffered_only = true;
    s_mount_probe_pending = true;
    s_last_mount_attempt_ms = 0;
    s_last_usage_refresh_ms = 0U;
    s_usage_dirty = true;
    snprintf(s_mount_point, sizeof(s_mount_point), "%s", "/sd");

    err = nvs_open(STORAGE_NAMESPACE, NVS_READONLY, &handle);
    if (err == ESP_OK) {
        err = nvs_get_blob(handle, STORAGE_SPOOL_KEY, &s_blob, &actual_size);
        nvs_close(handle);
        if (err == ESP_OK && actual_size == sizeof(s_blob) && s_blob.version == STORAGE_BLOB_VERSION) {
            s_status.record_count = s_blob.count;
        } else {
            memset(&s_blob, 0, sizeof(s_blob));
            s_blob.version = STORAGE_BLOB_VERSION;
        }
    }

    task_ok = xTaskCreatePinnedToCore(
        storage_mgr_task,
        "storage_task",
        CONFIG_UNIFIED_STORAGE_TASK_STACK_SIZE,
        NULL,
        4,
        NULL,
        1
    );
    if (task_ok != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    s_ready = true;
    return ESP_OK;
}

static size_t storage_mgr_snapshot_records(storage_mgr_record_t *out_records, size_t max_records) {
    size_t index = 0;
    size_t copy_count = 0;

    if (!out_records || max_records == 0 || !s_lock) {
        return 0;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return 0;
    }

    copy_count = s_blob.count < max_records ? s_blob.count : max_records;
    for (index = 0; index < copy_count; ++index) {
        out_records[index] = s_blob.records[(s_blob.head + index) % CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY];
    }

    xSemaphoreGive(s_lock);
    return copy_count;
}

esp_err_t storage_mgr_append_sms(const unified_sms_payload_t *payload) {
    storage_mgr_record_t record = {
        .type = STORAGE_MGR_RECORD_SMS,
        .timestamp_ms = payload ? payload->timestamp_ms : 0U,
    };
    bool can_write_sd = false;
    esp_err_t err = ESP_OK;
    esp_err_t sd_err = ESP_OK;

    if (!payload || !s_lock) {
        return ESP_ERR_INVALID_ARG;
    }

    record.sms = *payload;

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    err = storage_mgr_append_record_locked(&record);
    can_write_sd = (err == ESP_OK) && s_status.media_available && !s_status.buffered_only;
    storage_mgr_set_health_locked();
    xSemaphoreGive(s_lock);

    if (can_write_sd) {
        sd_err = storage_mgr_append_record_to_sd(&record, false);
        if (sd_err != ESP_OK) {
            if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                s_status.sd_write_failures++;
                xSemaphoreGive(s_lock);
            }
        } else if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            s_status.sd_flush_count++;
            xSemaphoreGive(s_lock);
        }
    }

    return err == ESP_OK ? sd_err : err;
}

esp_err_t storage_mgr_build_sms_history_json(char *buffer, size_t buffer_len, uint16_t max_entries) {
    storage_mgr_record_t records[CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY] = {0};
    size_t record_count = 0U;
    size_t sms_count = 0U;
    size_t written = 0U;
    size_t included = 0U;
    uint16_t effective_max_entries = max_entries;

    if (!buffer || buffer_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    buffer[0] = '\0';
    if (effective_max_entries == 0U || effective_max_entries > CONFIG_UNIFIED_STORAGE_SMS_HISTORY_MAX_ENTRIES) {
        effective_max_entries = CONFIG_UNIFIED_STORAGE_SMS_HISTORY_MAX_ENTRIES;
    }

    record_count = storage_mgr_snapshot_records(records, CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY);
    for (size_t index = 0U; index < record_count; ++index) {
        if (records[index].type == STORAGE_MGR_RECORD_SMS) {
            sms_count++;
        }
    }

    written = (size_t)snprintf(
        buffer,
        buffer_len,
        "{\"count\":%u,\"entries\":[",
        (unsigned)((sms_count < effective_max_entries) ? sms_count : effective_max_entries)
    );
    if (written >= buffer_len) {
        buffer[0] = '\0';
        return ESP_ERR_INVALID_SIZE;
    }

    for (size_t index = record_count; index > 0U && included < effective_max_entries; --index) {
        const storage_mgr_record_t *record = &records[index - 1U];
        char from[sizeof(record->sms.from) * 2U] = {0};
        char text[sizeof(record->sms.text) * 2U] = {0};
        char detail[sizeof(record->sms.detail) * 2U] = {0};
        int append_result = 0;

        if (record->type != STORAGE_MGR_RECORD_SMS) {
            continue;
        }

        storage_mgr_escape_json(record->sms.from, from, sizeof(from));
        storage_mgr_escape_json(record->sms.text, text, sizeof(text));
        storage_mgr_escape_json(record->sms.detail, detail, sizeof(detail));
        append_result = snprintf(
            buffer + written,
            buffer_len - written,
            "%s{\"from\":\"%s\",\"text\":\"%s\",\"detail\":\"%s\",\"sim_slot\":%u,\"timestamp_ms\":%" PRIu32 ",\"outgoing\":%s}",
            included > 0U ? "," : "",
            from,
            text,
            detail,
            (unsigned)record->sms.sim_slot,
            record->sms.timestamp_ms,
            record->sms.outgoing ? "true" : "false"
        );
        if (append_result < 0 || (size_t)append_result >= (buffer_len - written)) {
            buffer[0] = '\0';
            return ESP_ERR_INVALID_SIZE;
        }

        written += (size_t)append_result;
        included++;
    }

    if (written + 3U > buffer_len) {
        buffer[0] = '\0';
        return ESP_ERR_INVALID_SIZE;
    }
    buffer[written++] = ']';
    buffer[written++] = '}';
    buffer[written] = '\0';
    return ESP_OK;
}

void storage_mgr_get_status(storage_mgr_status_t *out_status) {
    if (!out_status) {
        return;
    }

    memset(out_status, 0, sizeof(*out_status));
    if (!s_lock) {
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    storage_mgr_refresh_config_locked();
    *out_status = s_status;
    xSemaphoreGive(s_lock);
}
