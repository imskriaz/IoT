#include "storage_mgr.h"

#include <inttypes.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <sys/stat.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_vfs_fat.h"
#include "nvs.h"
#include "wear_levelling.h"

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

#ifndef CONFIG_UNIFIED_STORAGE_PENDING_FLUSH_CAPACITY
#define CONFIG_UNIFIED_STORAGE_PENDING_FLUSH_CAPACITY  8
#endif

#define STORAGE_USAGE_REFRESH_INTERVAL_MS 30000U
#define STORAGE_PERSIST_INTERVAL_MS      15000U

#define STORAGE_NAMESPACE      "storage_mgr"
#define STORAGE_SPOOL_KEY      "telemetry"
#define STORAGE_BLOB_VERSION   5U
#define STORAGE_FLASH_PARTITION_LABEL "storage"
#define STORAGE_SD_SMS_FILE    "logs/sms.ndj"
#define STORAGE_SD_CALL_FILE   "logs/calls.ndj"
#define STORAGE_SD_PATH_LEN    128U
#define STORAGE_RECORD_LINE_MAX_LEN  512U

static const char *TAG = "storage_mgr";

typedef enum {
    STORAGE_MGR_RECORD_SMS = 1,
    STORAGE_MGR_RECORD_CALL = 2,
} storage_mgr_record_type_t;

typedef union {
    unified_sms_payload_t sms;
    unified_call_payload_t call;
} storage_mgr_record_payload_t;

typedef struct {
    storage_mgr_record_type_t type;
    size_t line_len;
    char line[STORAGE_RECORD_LINE_MAX_LEN];
} storage_mgr_pending_record_t;

typedef struct {
    storage_mgr_record_type_t type;
    uint32_t timestamp_ms;
    storage_mgr_record_payload_t payload;
} storage_mgr_record_t;

typedef struct {
    uint32_t version;
    uint32_t count;
    uint32_t head;
    storage_mgr_record_t records[CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY];
} storage_blob_t;

static SemaphoreHandle_t s_lock;
static storage_mgr_status_t s_status;
static storage_blob_t *s_blob;
static bool s_ready;
static TaskHandle_t s_task_handle;
static uint32_t s_last_mount_attempt_ms;
static bool s_sd_recovery_exported;
static bool s_mount_probe_pending;
static uint32_t s_config_revision;
static wl_handle_t s_wl_handle = WL_INVALID_HANDLE;
static char s_mount_point[16];
static bool s_usage_dirty;
static uint32_t s_last_usage_refresh_ms;
static bool s_persist_dirty;
static uint32_t s_last_persist_ms;
static storage_mgr_pending_record_t *s_pending_records;
static size_t s_pending_head;
static size_t s_pending_count;

static size_t storage_mgr_snapshot_records(storage_mgr_record_t *out_records, size_t max_records);
static void storage_mgr_escape_json(const char *input, char *output, size_t output_len);
static esp_err_t storage_mgr_flush_persist_locked(uint32_t now_ms);
static esp_err_t storage_mgr_record_to_line(const storage_mgr_record_t *record, char *line, size_t line_len);
static esp_err_t storage_mgr_build_pending_record(const storage_mgr_record_t *record, storage_mgr_pending_record_t *out_record);
static esp_err_t storage_mgr_queue_pending_record_locked(const storage_mgr_pending_record_t *record);
static bool storage_mgr_pop_pending_record_locked(storage_mgr_pending_record_t *out_record);

static void *storage_mgr_alloc_zeroed(size_t size) {
    void *buffer = heap_caps_calloc(1U, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);

    if (!buffer) {
        buffer = heap_caps_calloc(1U, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }

    return buffer;
}

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

    if (s_wl_handle == WL_INVALID_HANDLE || !s_status.media_available || s_mount_point[0] == '\0') {
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

    if (!s_blob) {
        nvs_close(handle);
        return ESP_ERR_INVALID_STATE;
    }

    err = nvs_set_blob(handle, STORAGE_SPOOL_KEY, s_blob, sizeof(*s_blob));
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);

    if (err != ESP_OK) {
        s_status.persist_failures++;
    } else {
        s_persist_dirty = false;
        s_last_persist_ms = unified_tick_now_ms();
    }
    return err;
}

static esp_err_t storage_mgr_flush_persist_locked(uint32_t now_ms) {
    esp_err_t err = ESP_OK;

    if (!s_persist_dirty) {
        return ESP_OK;
    }

    err = storage_mgr_persist_locked();
    if (err == ESP_OK && now_ms != 0U) {
        s_last_persist_ms = now_ms;
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

    if (!s_blob) {
        return ESP_ERR_INVALID_STATE;
    }

    if (s_blob->count < CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY) {
        write_index = (s_blob->head + s_blob->count) % CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY;
        s_blob->count++;
    } else {
        write_index = s_blob->head;
        s_blob->head = (s_blob->head + 1U) % CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY;
        s_status.dropped_count++;
    }

    s_blob->records[write_index] = *record;
    s_status.record_count = s_blob->count;
    s_persist_dirty = true;
    return ESP_OK;
}

static esp_err_t storage_mgr_build_pending_record(const storage_mgr_record_t *record, storage_mgr_pending_record_t *out_record) {
    esp_err_t err = ESP_OK;

    if (!record || !out_record) {
        return ESP_ERR_INVALID_ARG;
    }

    memset(out_record, 0, sizeof(*out_record));
    out_record->type = record->type;
    err = storage_mgr_record_to_line(record, out_record->line, sizeof(out_record->line));
    if (err != ESP_OK) {
        return err;
    }

    out_record->line_len = strlen(out_record->line);
    return out_record->line_len > 0U ? ESP_OK : ESP_ERR_INVALID_SIZE;
}

static esp_err_t storage_mgr_queue_pending_record_locked(const storage_mgr_pending_record_t *record) {
    size_t write_index = 0U;

    if (!record || !s_pending_records) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_pending_count >= CONFIG_UNIFIED_STORAGE_PENDING_FLUSH_CAPACITY) {
        return ESP_ERR_NO_MEM;
    }

    write_index = (s_pending_head + s_pending_count) % CONFIG_UNIFIED_STORAGE_PENDING_FLUSH_CAPACITY;
    s_pending_records[write_index] = *record;
    s_pending_count++;
    return ESP_OK;
}

static bool storage_mgr_pop_pending_record_locked(storage_mgr_pending_record_t *out_record) {
    if (!out_record || !s_pending_records || s_pending_count == 0U) {
        return false;
    }

    *out_record = s_pending_records[s_pending_head];
    s_pending_head = (s_pending_head + 1U) % CONFIG_UNIFIED_STORAGE_PENDING_FLUSH_CAPACITY;
    s_pending_count--;
    return true;
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
            storage_mgr_escape_json(record->payload.sms.from, field_a, sizeof(field_a));
            storage_mgr_escape_json(record->payload.sms.text, field_b, sizeof(field_b));
            storage_mgr_escape_json(record->payload.sms.detail, field_c, sizeof(field_c));
            written = snprintf(
                line,
                line_len,
                "{\"type\":\"sms\",\"timestamp\":%" PRIu32 ",\"peer\":\"%s\",\"direction\":\"%s\",\"detail\":\"%s\",\"text\":\"%s\"}\n",
                record->timestamp_ms,
                field_a,
                record->payload.sms.outgoing ? "outgoing" : "incoming",
                field_c[0] != '\0' ? field_c : (record->payload.sms.outgoing ? "sms_sent" : "incoming_sms"),
                field_b
            );
            break;
        case STORAGE_MGR_RECORD_CALL:
            storage_mgr_escape_json(record->payload.call.number, field_a, sizeof(field_a));
            storage_mgr_escape_json(record->payload.call.state, field_b, sizeof(field_b));
            written = snprintf(
                line,
                line_len,
                "{\"type\":\"call\",\"timestamp\":%" PRIu32 ",\"number\":\"%s\",\"state\":\"%s\",\"sim_slot\":%u}\n",
                record->timestamp_ms,
                field_a,
                field_b,
                (unsigned)record->payload.call.sim_slot
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
    if (s_wl_handle != WL_INVALID_HANDLE) {
        esp_vfs_fat_spiflash_unmount_rw_wl(s_mount_point, s_wl_handle);
        s_wl_handle = WL_INVALID_HANDLE;
    }

    s_sd_recovery_exported = false;
    s_pending_head = 0U;
    s_pending_count = 0U;
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

static esp_err_t storage_mgr_append_pending_record_to_sd(const storage_mgr_pending_record_t *record, bool count_flush) {
    const char *relative_path = NULL;

    if (record->type == STORAGE_MGR_RECORD_SMS) {
        relative_path = STORAGE_SD_SMS_FILE;
    } else if (record->type == STORAGE_MGR_RECORD_CALL) {
        relative_path = STORAGE_SD_CALL_FILE;
    } else {
        return ESP_ERR_INVALID_ARG;
    }

    if (record->line_len == 0U || record->line_len >= sizeof(record->line)) {
        return ESP_ERR_INVALID_SIZE;
    }

    esp_err_t err = storage_mgr_write_file(relative_path, record->line, record->line_len, true);
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

static esp_err_t storage_mgr_append_record_to_sd(const storage_mgr_record_t *record, bool count_flush) {
    storage_mgr_pending_record_t pending_record = {0};
    esp_err_t err = storage_mgr_build_pending_record(record, &pending_record);

    if (err != ESP_OK) {
        return err;
    }

    return storage_mgr_append_pending_record_to_sd(&pending_record, count_flush);
}

static esp_err_t storage_mgr_export_buffered_records(void) {
    storage_mgr_record_t *snapshot = NULL;
    size_t count = 0;
    size_t index = 0;
    esp_err_t err = ESP_OK;

    snapshot = storage_mgr_alloc_zeroed(sizeof(*snapshot) * CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY);
    if (!snapshot) {
        return ESP_ERR_NO_MEM;
    }

    count = storage_mgr_snapshot_records(snapshot, CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY);
    for (index = 0; index < count; ++index) {
        err = storage_mgr_append_record_to_sd(&snapshot[index], true);
        if (err != ESP_OK) {
            heap_caps_free(snapshot);
            return err;
        }
    }

    heap_caps_free(snapshot);
    s_sd_recovery_exported = true;
    return ESP_OK;
}

static esp_err_t storage_mgr_try_mount_sd(void) {
    esp_vfs_fat_mount_config_t mount_config = {
        .format_if_mount_failed = false,
        .max_files = CONFIG_UNIFIED_STORAGE_MAX_OPEN_FILES,
        .allocation_unit_size = 16 * 1024,
        .disk_status_check_enable = false,
        .use_one_fat = false,
    };
    esp_err_t err = ESP_OK;

    snprintf(s_mount_point, sizeof(s_mount_point), "%s", "/storage");
    err = esp_vfs_fat_spiflash_mount_rw_wl(
        s_mount_point,
        STORAGE_FLASH_PARTITION_LABEL,
        &mount_config,
        &s_wl_handle
    );
    if (err != ESP_OK) {
        esp_err_t initial_err = err;

        ESP_LOGW(
            TAG,
            "flash storage mount failed label=%s path=%s err=%s; retrying with format",
            STORAGE_FLASH_PARTITION_LABEL,
            s_mount_point,
            esp_err_to_name(err)
        );
        mount_config.format_if_mount_failed = true;
        err = esp_vfs_fat_spiflash_mount_rw_wl(
            s_mount_point,
            STORAGE_FLASH_PARTITION_LABEL,
            &mount_config,
            &s_wl_handle
        );
        if (err != ESP_OK) {
            ESP_LOGW(
                TAG,
                "flash storage format+mount failed label=%s path=%s initial_err=%s err=%s",
                STORAGE_FLASH_PARTITION_LABEL,
                s_mount_point,
                esp_err_to_name(initial_err),
                esp_err_to_name(err)
            );
            if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                s_status.mount_failures++;
                xSemaphoreGive(s_lock);
            }
            storage_mgr_update_media_state(false, true);
            return err;
        }

        ESP_LOGW(
            TAG,
            "flash storage formatted and mounted label=%s path=%s initial_err=%s",
            STORAGE_FLASH_PARTITION_LABEL,
            s_mount_point,
            esp_err_to_name(initial_err)
        );
    }

    err = storage_mgr_set_mount_state(true);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "flash storage mount state publish failed: %s", esp_err_to_name(err));
        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            s_status.mount_failures++;
            xSemaphoreGive(s_lock);
        }
        storage_mgr_unmount_sd();
        return err;
    }

    err = storage_mgr_prepare_sd_dirs();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "flash storage directory preparation failed: %s", esp_err_to_name(err));
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
            ESP_LOGW(TAG, "flash recovery export failed: %s", esp_err_to_name(err));
            if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                s_status.mount_failures++;
                s_status.sd_write_failures++;
                xSemaphoreGive(s_lock);
            }
            storage_mgr_unmount_sd();
            return err;
        }
    }

    ESP_LOGI(TAG, "flash storage mounted label=%s path=%s", STORAGE_FLASH_PARTITION_LABEL, s_mount_point);
    return ESP_OK;
}

static void storage_mgr_task(void *arg) {
    uint32_t now_ms = 0;
    uint32_t delay_ms = STORAGE_USAGE_REFRESH_INTERVAL_MS;
    uint32_t last_usage_refresh_ms = 0U;
    uint32_t last_mount_attempt_ms = 0U;
    uint32_t last_persist_ms = 0U;
    bool storage_enabled = true;
    bool media_available = false;
    bool usage_dirty = false;
    bool persist_dirty = false;
    bool has_pending_flush = false;
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
            persist_dirty = s_persist_dirty;
            last_persist_ms = s_last_persist_ms;
            has_pending_flush = s_pending_count > 0U;
            mount_probe_pending = s_mount_probe_pending;
            last_mount_attempt_ms = s_last_mount_attempt_ms;
            have_sd_card = (s_wl_handle != WL_INVALID_HANDLE);
            if (media_available) {
                if (usage_dirty || last_usage_refresh_ms == 0U || has_pending_flush) {
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
            if (persist_dirty) {
                uint32_t persist_due_ms = 0U;

                if (last_persist_ms != 0U &&
                    (now_ms - last_persist_ms) < STORAGE_PERSIST_INTERVAL_MS) {
                    persist_due_ms = STORAGE_PERSIST_INTERVAL_MS - (now_ms - last_persist_ms);
                }
                if (persist_due_ms < delay_ms) {
                    delay_ms = persist_due_ms;
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

        if (have_sd_card && has_pending_flush) {
            while (true) {
                storage_mgr_pending_record_t record = {0};
                esp_err_t flush_err = ESP_OK;

                if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
                    break;
                }
                if (!storage_mgr_pop_pending_record_locked(&record)) {
                    xSemaphoreGive(s_lock);
                    break;
                }
                xSemaphoreGive(s_lock);

                flush_err = storage_mgr_append_pending_record_to_sd(&record, false);
                if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                    if (flush_err != ESP_OK) {
                        s_status.sd_write_failures++;
                        (void)storage_mgr_flush_persist_locked(now_ms);
                    } else {
                        s_status.sd_flush_count++;
                        s_persist_dirty = false;
                        s_last_persist_ms = now_ms;
                    }
                    xSemaphoreGive(s_lock);
                }
                if (flush_err != ESP_OK) {
                    storage_mgr_unmount_sd();
                    break;
                }
            }
        }

        if (persist_dirty && xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            if (s_persist_dirty &&
                (s_last_persist_ms == 0U ||
                 (now_ms - s_last_persist_ms) >= STORAGE_PERSIST_INTERVAL_MS)) {
                (void)storage_mgr_flush_persist_locked(now_ms);
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
    size_t actual_size = sizeof(storage_blob_t);
    esp_err_t err = ESP_OK;

    if (s_ready) {
        return ESP_OK;
    }

    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) {
        return ESP_ERR_NO_MEM;
    }
    s_blob = storage_mgr_alloc_zeroed(sizeof(*s_blob));
    if (!s_blob) {
        vSemaphoreDelete(s_lock);
        s_lock = NULL;
        return ESP_ERR_NO_MEM;
    }
    s_pending_records = storage_mgr_alloc_zeroed(sizeof(*s_pending_records) * CONFIG_UNIFIED_STORAGE_PENDING_FLUSH_CAPACITY);
    if (!s_pending_records) {
        heap_caps_free(s_blob);
        s_blob = NULL;
        vSemaphoreDelete(s_lock);
        s_lock = NULL;
        return ESP_ERR_NO_MEM;
    }

    memset(&s_status, 0, sizeof(s_status));
    memset(s_mount_point, 0, sizeof(s_mount_point));
    s_blob->version = STORAGE_BLOB_VERSION;
    s_status.runtime.initialized = true;
    s_status.runtime.state = UNIFIED_MODULE_STATE_INITIALIZED;

    s_config_revision = config_mgr_revision();
    s_status.enabled = config_mgr_storage_enabled();
    s_status.media_available = false;
    s_status.buffered_only = true;
    s_mount_probe_pending = true;
    s_last_mount_attempt_ms = 0;
    s_last_usage_refresh_ms = 0U;
    s_last_persist_ms = 0U;
    s_usage_dirty = true;
    s_persist_dirty = false;
    s_pending_head = 0U;
    s_pending_count = 0U;
    snprintf(s_mount_point, sizeof(s_mount_point), "%s", "/sd");

    err = nvs_open(STORAGE_NAMESPACE, NVS_READONLY, &handle);
    if (err == ESP_OK) {
        err = nvs_get_blob(handle, STORAGE_SPOOL_KEY, s_blob, &actual_size);
        nvs_close(handle);
        if (err == ESP_OK && actual_size == sizeof(*s_blob) && s_blob->version == STORAGE_BLOB_VERSION) {
            s_status.record_count = s_blob->count;
            s_last_persist_ms = unified_tick_now_ms();
        } else {
            memset(s_blob, 0, sizeof(*s_blob));
            s_blob->version = STORAGE_BLOB_VERSION;
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
        heap_caps_free(s_pending_records);
        s_pending_records = NULL;
        heap_caps_free(s_blob);
        s_blob = NULL;
        vSemaphoreDelete(s_lock);
        s_lock = NULL;
        return ESP_ERR_NO_MEM;
    }

    s_ready = true;
    return ESP_OK;
}

static size_t storage_mgr_snapshot_records(storage_mgr_record_t *out_records, size_t max_records) {
    size_t index = 0;
    size_t copy_count = 0;

    if (!out_records || max_records == 0 || !s_lock || !s_blob) {
        return 0;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return 0;
    }

    copy_count = s_blob->count < max_records ? s_blob->count : max_records;
    for (index = 0; index < copy_count; ++index) {
        out_records[index] = s_blob->records[(s_blob->head + index) % CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY];
    }

    xSemaphoreGive(s_lock);
    return copy_count;
}

static esp_err_t storage_mgr_append_record(const storage_mgr_record_t *record) {
    bool can_write_sd = false;
    bool persist_immediately = false;
    bool notify_flush = false;
    bool flush_inline = false;
    storage_mgr_pending_record_t pending_record = {0};
    esp_err_t err = ESP_OK;
    esp_err_t sd_err = ESP_OK;
    esp_err_t fallback_err = ESP_OK;

    if (!record || !s_lock || !s_blob) {
        return ESP_ERR_INVALID_ARG;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    err = storage_mgr_append_record_locked(record);
    can_write_sd = (err == ESP_OK) && s_status.media_available && !s_status.buffered_only;
    if (can_write_sd) {
        err = storage_mgr_build_pending_record(record, &pending_record);
        if (err == ESP_OK) {
            err = storage_mgr_queue_pending_record_locked(&pending_record);
        }
        if (err == ESP_OK) {
            notify_flush = true;
            err = ESP_OK;
        } else if (err == ESP_ERR_NO_MEM) {
            flush_inline = true;
            err = ESP_OK;
        } else {
            s_status.sd_write_failures++;
            can_write_sd = false;
            err = ESP_OK;
        }
    }
    persist_immediately = (err == ESP_OK) && !can_write_sd;
    if (persist_immediately) {
        err = storage_mgr_flush_persist_locked(unified_tick_now_ms());
    }
    storage_mgr_set_health_locked();
    xSemaphoreGive(s_lock);

    if (err != ESP_OK) {
        return err;
    }

    if (notify_flush) {
        storage_mgr_notify_task();
        return ESP_OK;
    }

    if (flush_inline) {
        sd_err = storage_mgr_append_pending_record_to_sd(&pending_record, false);
        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            if (sd_err != ESP_OK) {
                s_status.sd_write_failures++;
                fallback_err = storage_mgr_flush_persist_locked(unified_tick_now_ms());
            } else {
                s_status.sd_flush_count++;
                s_persist_dirty = false;
                s_last_persist_ms = unified_tick_now_ms();
            }
            xSemaphoreGive(s_lock);
        }
    }

    if (sd_err != ESP_OK) {
        return fallback_err != ESP_OK ? fallback_err : sd_err;
    }
    return ESP_OK;
}

esp_err_t storage_mgr_append_sms(const unified_sms_payload_t *payload) {
    storage_mgr_record_t record = {
        .type = STORAGE_MGR_RECORD_SMS,
        .timestamp_ms = payload ? payload->timestamp_ms : 0U,
    };

    if (!payload) {
        return ESP_ERR_INVALID_ARG;
    }

    record.payload.sms = *payload;
    return storage_mgr_append_record(&record);
}

esp_err_t storage_mgr_append_call(const unified_call_payload_t *payload) {
    storage_mgr_record_t record = {
        .type = STORAGE_MGR_RECORD_CALL,
        .timestamp_ms = payload ? payload->timestamp_ms : 0U,
    };

    if (!payload) {
        return ESP_ERR_INVALID_ARG;
    }

    record.payload.call = *payload;
    return storage_mgr_append_record(&record);
}

esp_err_t storage_mgr_build_sms_history_json(char *buffer, size_t buffer_len, uint16_t max_entries) {
    size_t record_count = 0U;
    size_t sms_count = 0U;
    size_t written = 0U;
    size_t included = 0U;
    uint16_t effective_max_entries = max_entries;

    if (!buffer || buffer_len == 0U || !s_lock || !s_blob) {
        return ESP_ERR_INVALID_ARG;
    }

    buffer[0] = '\0';
    if (effective_max_entries == 0U || effective_max_entries > CONFIG_UNIFIED_STORAGE_SMS_HISTORY_MAX_ENTRIES) {
        effective_max_entries = CONFIG_UNIFIED_STORAGE_SMS_HISTORY_MAX_ENTRIES;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    record_count = s_blob->count;
    for (size_t index = 0U; index < record_count; ++index) {
        const size_t record_index = (s_blob->head + index) % CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY;
        if (s_blob->records[record_index].type == STORAGE_MGR_RECORD_SMS) {
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
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_SIZE;
    }

    for (size_t index = record_count; index > 0U && included < effective_max_entries; --index) {
        const size_t record_index = (s_blob->head + index - 1U) % CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY;
        const storage_mgr_record_t *record = &s_blob->records[record_index];
        char from[sizeof(record->payload.sms.from) * 2U] = {0};
        char text[sizeof(record->payload.sms.text) * 2U] = {0};
        char detail[sizeof(record->payload.sms.detail) * 2U] = {0};
        int append_result = 0;

        if (record->type != STORAGE_MGR_RECORD_SMS) {
            continue;
        }

        storage_mgr_escape_json(record->payload.sms.from, from, sizeof(from));
        storage_mgr_escape_json(record->payload.sms.text, text, sizeof(text));
        storage_mgr_escape_json(record->payload.sms.detail, detail, sizeof(detail));
        append_result = snprintf(
            buffer + written,
            buffer_len - written,
            "%s{\"from\":\"%s\",\"text\":\"%s\",\"detail\":\"%s\",\"sim_slot\":%u,\"timestamp_ms\":%" PRIu32 ",\"outgoing\":%s}",
            included > 0U ? "," : "",
            from,
            text,
            detail,
            (unsigned)record->payload.sms.sim_slot,
            record->payload.sms.timestamp_ms,
            record->payload.sms.outgoing ? "true" : "false"
        );
        if (append_result < 0 || (size_t)append_result >= (buffer_len - written)) {
            buffer[0] = '\0';
            xSemaphoreGive(s_lock);
            return ESP_ERR_INVALID_SIZE;
        }

        written += (size_t)append_result;
        included++;
    }

    if (written + 3U > buffer_len) {
        buffer[0] = '\0';
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_SIZE;
    }
    buffer[written++] = ']';
    buffer[written++] = '}';
    buffer[written] = '\0';
    xSemaphoreGive(s_lock);
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
