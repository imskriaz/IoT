#include "storage_mgr.h"
#include "storage_result_journal.h"

#include <inttypes.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/stat.h>
#include <dirent.h>
#include <unistd.h>
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
#define STORAGE_BLOB_VERSION             7U
#define STORAGE_BLOB_LEGACY_VERSION      5U
#define STORAGE_BLOB_TRANSITION_VERSION  6U
#define STORAGE_SMS_MIGRATED_ID_FIRST    0x80000001U
#define STORAGE_SMS_ID_FIRST             0xC0000001U
#define STORAGE_FLASH_PARTITION_LABEL "storage"
#define STORAGE_SD_SMS_FILE    "logs/sms.ndj"
#define STORAGE_SD_CALL_FILE   "logs/calls.ndj"
#define STORAGE_SD_PATH_LEN    128U
#define STORAGE_RECORD_LINE_MAX_LEN  512U
#define STORAGE_SMS_HASH_OFFSET      2166136261U
#define STORAGE_SMS_HASH_PRIME       16777619U
#define STORAGE_SPOOL_MAGIC          0x53504f4cU
#define STORAGE_SPOOL_DISK_VERSION   1U
#define STORAGE_SPOOL_FILE_A         "/storage/spool/spl0.dat"
#define STORAGE_SPOOL_FILE_B         "/storage/spool/spl1.dat"

static const char *TAG = "storage_mgr";

typedef enum {
    STORAGE_MGR_RECORD_SMS = 1,
    STORAGE_MGR_RECORD_CALL = 2,
} storage_mgr_record_type_t;

/* Schema 5 stored these bytes before the modem index was assigned from the
 * existing alignment gap. Keep the size and following field offsets identical
 * so old checksummed spool files remain readable byte-for-byte. */
typedef struct {
    char from[UNIFIED_TEXT_SHORT_LEN];
    char text[UNIFIED_SMS_TEXT_MAX_LEN];
    char detail[UNIFIED_TEXT_SHORT_LEN];
    char multipart_ref[UNIFIED_TEXT_SHORT_LEN];
    uint16_t multipart_part_index;
    uint16_t multipart_part_count;
    uint8_t sim_slot;
    uint32_t timestamp_ms;
    bool outgoing;
} storage_mgr_legacy_sms_payload_v5_t;

_Static_assert(sizeof(unified_sms_payload_t) == sizeof(storage_mgr_legacy_sms_payload_v5_t),
               "SMS payload schema migration must preserve the spool record size");
_Static_assert(offsetof(unified_sms_payload_t, timestamp_ms) ==
                   offsetof(storage_mgr_legacy_sms_payload_v5_t, timestamp_ms),
               "SMS timestamp offset changed across spool schemas");
_Static_assert(offsetof(unified_sms_payload_t, outgoing) ==
                   offsetof(storage_mgr_legacy_sms_payload_v5_t, outgoing),
               "SMS direction offset changed across spool schemas");

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
    /* Schema 6+ uses this as the durable storage ID for SMS records. Calls keep
     * their original event timestamp here. The payload owns the SMS timestamp. */
    uint32_t timestamp_ms;
    storage_mgr_record_payload_t payload;
} storage_mgr_record_t;

typedef struct {
    uint32_t version;
    uint32_t count;
    /* Schema 5: ring head. Schema 6+: next durable SMS storage ID. */
    uint32_t head;
    storage_mgr_record_t records[CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY];
} storage_blob_t;

typedef struct {
    uint32_t magic;
    uint32_t disk_version;
    uint32_t generation;
    uint32_t checksum;
    storage_blob_t blob;
} storage_disk_blob_t;

static SemaphoreHandle_t s_lock;
static storage_mgr_status_t s_status;
static storage_blob_t *s_blob;
static storage_disk_blob_t *s_spool_io;
static uint32_t s_spool_generation;
static unsigned s_spool_bank;
static bool s_spool_ready;
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
static esp_err_t storage_mgr_rewrite_sms_log_from_blob(const storage_blob_t *blob);
static esp_err_t storage_mgr_prepare_physical_sd_dirs(void);
static esp_err_t storage_mgr_normalize_relative_path(const char *input, char *output, size_t output_len);
static esp_err_t storage_mgr_build_sd_path(const char *relative_path, char *full_path, size_t full_path_len);
static esp_err_t storage_mgr_copy_user_mount(char *mount_point, size_t mount_point_len);
static esp_err_t storage_mgr_build_path_for_mount(
    const char *mount_point,
    const char *relative_path,
    char *full_path,
    size_t full_path_len
);

static esp_err_t storage_mgr_resolve_existing_path(
    const char *relative_path,
    const char *mount_point,
    char *normalized_path,
    size_t normalized_path_len,
    char *full_path,
    size_t full_path_len,
    struct stat *out_stat
) {
    esp_err_t err = ESP_OK;

    if (!relative_path || !normalized_path || normalized_path_len == 0U || !full_path || full_path_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    err = storage_mgr_normalize_relative_path(relative_path, normalized_path, normalized_path_len);
    if (err != ESP_OK) {
        return err;
    }
    err = storage_mgr_build_path_for_mount(mount_point, normalized_path, full_path, full_path_len);
    if (err != ESP_OK) {
        return err;
    }
    if (stat(full_path, out_stat) != 0) {
        return errno == ENOENT ? ESP_ERR_NOT_FOUND : ESP_FAIL;
    }
    return ESP_OK;
}

static void *storage_mgr_alloc_zeroed(size_t size) {
    void *buffer = heap_caps_calloc(1U, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);

    if (!buffer) {
        buffer = heap_caps_calloc(1U, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }

    return buffer;
}

static uint32_t storage_mgr_hash_bytes(uint32_t hash, const void *data, size_t len) {
    const uint8_t *bytes = (const uint8_t *)data;

    for (size_t index = 0U; index < len; ++index) {
        hash ^= bytes[index];
        hash *= STORAGE_SMS_HASH_PRIME;
    }

    return hash;
}

static uint32_t storage_mgr_hash_cstr(uint32_t hash, const char *text) {
    const char *cursor = text ? text : "";

    while (*cursor != '\0') {
        const uint8_t byte = (uint8_t)*cursor++;
        hash = storage_mgr_hash_bytes(hash, &byte, 1U);
    }

    return hash;
}

static uint32_t storage_mgr_sms_fingerprint(const unified_sms_payload_t *payload) {
    uint32_t hash = STORAGE_SMS_HASH_OFFSET;

    if (!payload) {
        return 0U;
    }

    hash = storage_mgr_hash_cstr(hash, payload->from);
    hash = storage_mgr_hash_cstr(hash, payload->text);
    hash = storage_mgr_hash_cstr(hash, payload->detail);
    hash = storage_mgr_hash_bytes(hash, &payload->timestamp_ms, sizeof(payload->timestamp_ms));
    hash = storage_mgr_hash_bytes(hash, &payload->multipart_part_index, sizeof(payload->multipart_part_index));
    hash = storage_mgr_hash_bytes(hash, &payload->multipart_part_count, sizeof(payload->multipart_part_count));
    hash = storage_mgr_hash_bytes(hash, &payload->sim_slot, sizeof(payload->sim_slot));
    hash = storage_mgr_hash_bytes(hash, &payload->storage_index, sizeof(payload->storage_index));
    hash = storage_mgr_hash_bytes(hash, &payload->outgoing, sizeof(payload->outgoing));
    return hash == 0U ? 1U : hash;
}

static bool storage_mgr_sms_matches(
    const unified_sms_payload_t *left,
    const unified_sms_payload_t *right
) {
    return left && right &&
        storage_mgr_sms_fingerprint(left) == storage_mgr_sms_fingerprint(right) &&
        left->timestamp_ms == right->timestamp_ms &&
        left->multipart_part_index == right->multipart_part_index &&
        left->multipart_part_count == right->multipart_part_count &&
        left->sim_slot == right->sim_slot &&
        left->storage_index == right->storage_index &&
        left->outgoing == right->outgoing &&
        strcmp(left->from, right->from) == 0 &&
        strcmp(left->text, right->text) == 0 &&
        strcmp(left->detail, right->detail) == 0 &&
        strcmp(left->multipart_ref, right->multipart_ref) == 0;
}

/* STORAGE_SMS_MIGRATION_TEST_BEGIN */
static bool storage_mgr_blob_layout_valid(const storage_blob_t *blob) {
    if (!blob || blob->count > CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY) {
        return false;
    }
    if (blob->version == STORAGE_BLOB_LEGACY_VERSION) {
        return blob->head < CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY;
    }
    return (blob->version == STORAGE_BLOB_TRANSITION_VERSION ||
            blob->version == STORAGE_BLOB_VERSION) && blob->head != 0U;
}

/* Schema 6+ keeps records contiguous and assigns each retained SMS a stable,
 * monotonically increasing ID. The migration preserves every schema-5 record
 * and uses the payload timestamp for the original SMS event time. */
static esp_err_t storage_mgr_migrate_legacy_blob(
    storage_blob_t *destination,
    const storage_blob_t *legacy
) {
    uint32_t next_migrated_id = STORAGE_SMS_MIGRATED_ID_FIRST;
    const bool ring_layout = legacy && legacy->version == STORAGE_BLOB_LEGACY_VERSION;

    if (!destination || !legacy || destination == legacy ||
        (legacy->version != STORAGE_BLOB_LEGACY_VERSION &&
         legacy->version != STORAGE_BLOB_TRANSITION_VERSION) ||
        !storage_mgr_blob_layout_valid(legacy)) {
        return ESP_ERR_INVALID_ARG;
    }

    memset(destination, 0, sizeof(*destination));
    destination->version = STORAGE_BLOB_VERSION;
    destination->count = legacy->count;
    for (size_t index = 0U; index < legacy->count; ++index) {
        const size_t source_index = ring_layout
            ? (legacy->head + index) % CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY
            : index;
        destination->records[index] = legacy->records[source_index];
        if (destination->records[index].type == STORAGE_MGR_RECORD_SMS) {
            if (ring_layout) {
                destination->records[index].timestamp_ms = next_migrated_id++;
                destination->records[index].payload.sms.storage_index = -2;
            } else if (destination->records[index].timestamp_ms >= STORAGE_SMS_MIGRATED_ID_FIRST &&
                destination->records[index].timestamp_ms < STORAGE_SMS_ID_FIRST &&
                destination->records[index].payload.sms.storage_index < 0) {
                destination->records[index].payload.sms.storage_index = -2;
            }
        }
    }
    destination->head = STORAGE_SMS_ID_FIRST;
    return ESP_OK;
}
/* STORAGE_SMS_MIGRATION_TEST_END */

static uint32_t storage_mgr_next_sms_id_locked(void) {
    uint32_t storage_id = s_blob ? s_blob->head : 0U;

    if (storage_id == 0U) {
        storage_id = STORAGE_SMS_ID_FIRST;
    }
    if (s_blob) {
        s_blob->head = storage_id + 1U;
        if (s_blob->head == 0U) {
            s_blob->head = STORAGE_SMS_ID_FIRST;
        }
    }
    return storage_id;
}

static const char *storage_mgr_spool_path(unsigned bank) {
    return bank == 0U ? STORAGE_SPOOL_FILE_A : STORAGE_SPOOL_FILE_B;
}

static uint32_t storage_mgr_spool_checksum(const storage_disk_blob_t *disk) {
    uint32_t hash = STORAGE_SMS_HASH_OFFSET;

    hash = storage_mgr_hash_bytes(hash, &disk->disk_version, sizeof(disk->disk_version));
    hash = storage_mgr_hash_bytes(hash, &disk->generation, sizeof(disk->generation));
    hash = storage_mgr_hash_bytes(hash, &disk->blob, sizeof(disk->blob));
    return hash;
}

static bool storage_mgr_spool_read(unsigned bank, storage_disk_blob_t *disk) {
    FILE *file = NULL;
    size_t count = 0U;
    int extra = 0;

    if (!disk) {
        return false;
    }
    memset(disk, 0, sizeof(*disk));
    file = fopen(storage_mgr_spool_path(bank), "rb");
    if (!file) {
        return false;
    }
    count = fread(disk, 1U, sizeof(*disk), file);
    extra = fgetc(file);
    (void)fclose(file);
    return count == sizeof(*disk) && extra == EOF &&
        disk->magic == STORAGE_SPOOL_MAGIC &&
        disk->disk_version == STORAGE_SPOOL_DISK_VERSION &&
        disk->generation != 0U &&
        storage_mgr_blob_layout_valid(&disk->blob) &&
        disk->checksum == storage_mgr_spool_checksum(disk);
}

static esp_err_t storage_mgr_spool_write_locked(void) {
    FILE *file = NULL;
    bool okay = false;
    unsigned target_bank = 0U;

    if (!s_blob || !s_spool_io || !s_spool_ready || s_wl_handle == WL_INVALID_HANDLE) {
        return ESP_ERR_INVALID_STATE;
    }

    target_bank = s_spool_generation == 0U ? 0U : (1U - s_spool_bank);
    memset(s_spool_io, 0, sizeof(*s_spool_io));
    s_spool_io->magic = STORAGE_SPOOL_MAGIC;
    s_spool_io->disk_version = STORAGE_SPOOL_DISK_VERSION;
    s_spool_io->generation = s_spool_generation + 1U;
    if (s_spool_io->generation == 0U) {
        s_spool_io->generation = 1U;
    }
    s_spool_io->blob = *s_blob;
    s_spool_io->checksum = storage_mgr_spool_checksum(s_spool_io);

    file = fopen(storage_mgr_spool_path(target_bank), "wb");
    if (!file) {
        return ESP_FAIL;
    }
    okay = fwrite(s_spool_io, 1U, sizeof(*s_spool_io), file) == sizeof(*s_spool_io) &&
        fflush(file) == 0 && fsync(fileno(file)) == 0;
    if (fclose(file) != 0) {
        okay = false;
    }
    if (!okay || !storage_mgr_spool_read(target_bank, s_spool_io)) {
        return ESP_FAIL;
    }

    s_spool_generation = s_spool_io->generation;
    s_spool_bank = target_bank;
    return ESP_OK;
}

static esp_err_t storage_mgr_spool_open_locked(void) {
    uint32_t generations[2] = {0U, 0U};
    bool valid[2] = {false, false};
    uint32_t selected_generation = 0U;
    unsigned selected_bank = 0U;
    bool found = false;

    if (!s_blob || !s_spool_io || s_wl_handle == WL_INVALID_HANDLE) {
        return ESP_ERR_INVALID_STATE;
    }

    for (unsigned bank = 0U; bank < 2U; ++bank) {
        if (!storage_mgr_spool_read(bank, s_spool_io)) {
            continue;
        }
        valid[bank] = true;
        generations[bank] = s_spool_io->generation;
        if (!found || (int32_t)(generations[bank] - selected_generation) > 0) {
            selected_generation = generations[bank];
            selected_bank = bank;
            found = true;
        }
    }

    s_spool_generation = selected_generation;
    s_spool_bank = selected_bank;
    s_spool_ready = true;
    if (found) {
        /* Re-read the selected bank into the reusable PSRAM buffer. Keeping a
         * storage_blob_t local here would place roughly 35 KiB on the 16 KiB
         * storage task stack and corrupt the heap during concurrent boot. */
        if (!valid[selected_bank] || !storage_mgr_spool_read(selected_bank, s_spool_io)) {
            s_spool_ready = false;
            return ESP_FAIL;
        }
        if (s_spool_io->blob.version != STORAGE_BLOB_VERSION) {
            if (storage_mgr_migrate_legacy_blob(s_blob, &s_spool_io->blob) != ESP_OK) {
                s_spool_ready = false;
                return ESP_FAIL;
            }
            if (storage_mgr_spool_write_locked() != ESP_OK) {
                s_spool_ready = false;
                return ESP_FAIL;
            }
        } else {
            *s_blob = s_spool_io->blob;
        }
        s_status.record_count = s_blob->count;
        return ESP_OK;
    }

    /* First boot after migration: preserve any valid legacy NVS snapshot in
     * RAM, then establish the first checksummed flash generation. */
    if (s_blob->version != STORAGE_BLOB_VERSION) {
        s_spool_io->blob = *s_blob;
        if (storage_mgr_migrate_legacy_blob(s_blob, &s_spool_io->blob) != ESP_OK) {
            return ESP_FAIL;
        }
    }
    return storage_mgr_spool_write_locked();
}

uint32_t storage_mgr_sms_storage_id(const unified_sms_payload_t *payload) {
    uint32_t storage_id = 0U;

    if (!payload || !s_lock || !s_blob) {
        return 0U;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return 0U;
    }
    for (size_t index = s_blob->count; index > 0U; --index) {
        const storage_mgr_record_t *record = &s_blob->records[index - 1U];
        if (record->type == STORAGE_MGR_RECORD_SMS &&
            storage_mgr_sms_matches(&record->payload.sms, payload)) {
            storage_id = record->timestamp_ms;
            break;
        }
    }
    xSemaphoreGive(s_lock);
    return storage_id;
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
    return storage_mgr_build_path_for_mount(s_mount_point, relative_path, full_path, full_path_len);
}

/* Generic user-file APIs are SD-only.  The private /storage flash mount is
 * reserved for the durable system journal and must never be selected by a
 * dashboard file request, even while the SD worker is retrying a mount. */
static esp_err_t storage_mgr_copy_user_mount(char *mount_point, size_t mount_point_len) {
    bool mounted = false;

    if (!mount_point || mount_point_len == 0U || !s_lock) {
        return ESP_ERR_INVALID_ARG;
    }
    mount_point[0] = '\0';
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    mounted = s_status.sd.mounted;
    xSemaphoreGive(s_lock);
    if (!mounted) {
        return ESP_ERR_NOT_FOUND;
    }
    if (snprintf(mount_point, mount_point_len, "%s", "/sd") < 0 ||
        strlen(mount_point) >= mount_point_len) {
        mount_point[0] = '\0';
        return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}

static esp_err_t storage_mgr_build_path_for_mount(
    const char *mount_point,
    const char *relative_path,
    char *full_path,
    size_t full_path_len
) {
    int written = 0;

    if (!mount_point || mount_point[0] == '\0' || !relative_path || !full_path || full_path_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    written = snprintf(full_path, full_path_len, "%s/%s", mount_point, relative_path);
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
    } else if (s_status.runtime.last_error != ESP_OK) {
        state = HEALTH_MODULE_STATE_DEGRADED;
        detail = "storage_persist_failed";
        s_status.runtime.state = UNIFIED_MODULE_STATE_DEGRADED;
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
    esp_err_t err = ESP_OK;

    if (!s_blob) {
        s_status.persist_failures++;
        s_status.runtime.last_error = ESP_ERR_INVALID_STATE;
        unified_copy_cstr(
            s_status.runtime.last_error_text,
            sizeof(s_status.runtime.last_error_text),
            "storage_blob_unavailable"
        );
        return ESP_ERR_INVALID_STATE;
    }

    err = storage_mgr_spool_write_locked();

    if (err != ESP_OK) {
        s_status.persist_failures++;
        s_status.runtime.last_error = err;
        unified_copy_cstr(
            s_status.runtime.last_error_text,
            sizeof(s_status.runtime.last_error_text),
            esp_err_to_name(err)
        );
    } else {
        s_persist_dirty = false;
        s_last_persist_ms = unified_tick_now_ms();
        s_status.runtime.last_error = ESP_OK;
        s_status.runtime.last_error_text[0] = '\0';
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

/* STORAGE_DURABILITY_TEST_BEGIN */
static esp_err_t storage_mgr_append_record_locked(storage_mgr_record_t *record) {
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

    if (s_blob->count >= CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY) {
        /* Every retained entry is unacknowledged until the dashboard's durable
         * database import queues an idempotent flash delete. Never overwrite
         * the oldest entry: incoming SMS then stays on the modem and is retried,
         * while the caller receives explicit backpressure. */
        return ESP_ERR_NO_MEM;
    }

    if (record->type == STORAGE_MGR_RECORD_SMS && record->timestamp_ms == 0U) {
        record->timestamp_ms = storage_mgr_next_sms_id_locked();
    }
    write_index = s_blob->count;
    s_blob->count++;
    s_blob->records[write_index] = *record;
    s_status.record_count = s_blob->count;
    s_persist_dirty = true;
    return ESP_OK;
}

/* The in-memory ring is only a view of committed storage. If the synchronous
 * private-flash commit fails, restore the exact pre-append state so idempotency checks
 * cannot mistake a RAM-only record for a durable one. */
static esp_err_t storage_mgr_append_record_durable_locked(storage_mgr_record_t *record) {
    storage_mgr_record_t previous_record = {0};
    const uint32_t previous_count = s_blob ? s_blob->count : 0U;
    const uint32_t previous_head = s_blob ? s_blob->head : 0U;
    const uint32_t previous_status_count = s_status.record_count;
    const uint32_t previous_dropped_count = s_status.dropped_count;
    const bool previous_persist_dirty = s_persist_dirty;
    size_t write_index = 0U;
    esp_err_t err = ESP_OK;

    if (!record || !s_blob ||
        s_blob->version != STORAGE_BLOB_VERSION ||
        s_blob->count > CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY) {
        return ESP_ERR_INVALID_ARG;
    }

    write_index = s_blob->count < CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY
        ? s_blob->count
        : (CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY - 1U);
    previous_record = s_blob->records[write_index];

    err = storage_mgr_append_record_locked(record);
    if (err == ESP_OK) {
        err = storage_mgr_flush_persist_locked(unified_tick_now_ms());
    }
    if (err != ESP_OK) {
        s_blob->records[write_index] = previous_record;
        s_blob->count = previous_count;
        s_blob->head = previous_head;
        s_status.record_count = previous_status_count;
        s_status.dropped_count = previous_dropped_count;
        s_persist_dirty = previous_persist_dirty;
    }

    return err;
}
/* STORAGE_DURABILITY_TEST_END */

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
    s_status.pending_flush_count = (uint32_t)s_pending_count;
    return ESP_OK;
}

static bool storage_mgr_pop_pending_record_locked(storage_mgr_pending_record_t *out_record) {
    if (!out_record || !s_pending_records || s_pending_count == 0U) {
        return false;
    }

    *out_record = s_pending_records[s_pending_head];
    s_pending_head = (s_pending_head + 1U) % CONFIG_UNIFIED_STORAGE_PENDING_FLUSH_CAPACITY;
    s_pending_count--;
    s_status.pending_flush_count = (uint32_t)s_pending_count;
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
                "{\"type\":\"sms\",\"storage_id\":%" PRIu32 ",\"timestamp\":%" PRIu32 ",\"peer\":\"%s\",\"direction\":\"%s\",\"detail\":\"%s\",\"text\":\"%s\"}\n",
                record->timestamp_ms,
                record->payload.sms.timestamp_ms,
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
    storage_result_journal_set_available(false);
    s_spool_ready = false;
    if (s_wl_handle != WL_INVALID_HANDLE) {
        esp_vfs_fat_spiflash_unmount_rw_wl(s_mount_point, s_wl_handle);
        s_wl_handle = WL_INVALID_HANDLE;
    }

    s_sd_recovery_exported = false;
    s_pending_head = 0U;
    s_pending_count = 0U;
    s_status.pending_flush_count = 0U;
    storage_mgr_update_media_state(false, true);
    (void)storage_mgr_set_mount_state(false);
}

static esp_err_t storage_mgr_prepare_sd_dirs(void) {
    /* CONFIG_FATFS_LFN_NONE only accepts DOS 8.3 names. A leading-dot
     * directory such as ".results" is rejected by FatFs, which previously
     * caused the otherwise healthy private flash mount to be torn down and
     * made every durable command fail closed. */
    static const char *dirs[] = { "spool", "logs", "files", "exports", "diag", "results" };
    size_t index = 0;
    esp_err_t err = ESP_OK;

    for (index = 0; index < sizeof(dirs) / sizeof(dirs[0]); ++index) {
        err = storage_mgr_create_dir(dirs[index]);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "flash storage mkdir failed dir=%s err=%s errno=%d",
                     dirs[index], esp_err_to_name(err), errno);
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

static esp_err_t storage_mgr_export_buffered_records(void) {
    storage_mgr_record_t *snapshot = NULL;
    size_t count = 0;
    size_t index = 0;
    bool first_sms = true;
    bool first_call = true;
    esp_err_t err = ESP_OK;

    snapshot = storage_mgr_alloc_zeroed(sizeof(*snapshot) * CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY);
    if (!snapshot) {
        return ESP_ERR_NO_MEM;
    }

    count = storage_mgr_snapshot_records(snapshot, CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY);
    err = storage_mgr_write_file(STORAGE_SD_SMS_FILE, "", 0U, false);
    if (err == ESP_OK) {
        err = storage_mgr_write_file(STORAGE_SD_CALL_FILE, "", 0U, false);
    }
    for (index = 0; index < count; ++index) {
        storage_mgr_pending_record_t pending = {0};
        const char *relative_path = NULL;
        bool append = false;

        if (err != ESP_OK) {
            break;
        }
        if (snapshot[index].type == STORAGE_MGR_RECORD_SMS) {
            relative_path = STORAGE_SD_SMS_FILE;
            append = !first_sms;
        } else if (snapshot[index].type == STORAGE_MGR_RECORD_CALL) {
            relative_path = STORAGE_SD_CALL_FILE;
            append = !first_call;
        } else {
            continue;
        }
        err = storage_mgr_build_pending_record(&snapshot[index], &pending);
        if (err == ESP_OK) {
            err = storage_mgr_write_file(relative_path, pending.line, pending.line_len, append);
        }
        if (err != ESP_OK) {
            break;
        }
        if (snapshot[index].type == STORAGE_MGR_RECORD_SMS) {
            first_sms = false;
        } else {
            first_call = false;
        }
    }

    heap_caps_free(snapshot);
    if (err == ESP_OK) {
        s_sd_recovery_exported = true;
    }
    return err;
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
        ESP_LOGW(TAG, "flash storage mount failed label=%s path=%s err=%s; formatting is explicit recovery only",
                 STORAGE_FLASH_PARTITION_LABEL, s_mount_point, esp_err_to_name(err));
        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            s_status.mount_failures++;
            xSemaphoreGive(s_lock);
        }
        storage_mgr_update_media_state(false, true);
        return err;
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

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(2000)) != pdTRUE) {
        storage_mgr_unmount_sd();
        return ESP_ERR_TIMEOUT;
    }
    err = storage_mgr_spool_open_locked();
    if (err != ESP_OK) {
        s_status.persist_failures++;
        s_status.runtime.last_error = err;
        unified_copy_cstr(s_status.runtime.last_error_text,
                          sizeof(s_status.runtime.last_error_text),
                          esp_err_to_name(err));
    } else {
        s_status.runtime.last_error = ESP_OK;
        s_status.runtime.last_error_text[0] = '\0';
    }
    xSemaphoreGive(s_lock);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "flash spool open failed: %s", esp_err_to_name(err));
        storage_mgr_unmount_sd();
        return err;
    }

    storage_mgr_update_media_state(true, false);
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        storage_mgr_refresh_usage_locked();
        xSemaphoreGive(s_lock);
    }

    /* Removable-media export is secondary and runs only after the physical SD
     * has mounted. Its absence must never tear down the private flash spool or
     * disable the action-result journal. */
    s_sd_recovery_exported = false;

    ESP_LOGI(TAG, "flash storage mounted label=%s path=%s", STORAGE_FLASH_PARTITION_LABEL, s_mount_point);
    storage_result_journal_set_available(true);
    return ESP_OK;
}

static void storage_mgr_task(void *arg) {
    uint32_t now_ms = 0;
    uint32_t delay_ms = STORAGE_USAGE_REFRESH_INTERVAL_MS;
    uint32_t last_usage_refresh_ms = 0U;
    uint32_t last_mount_attempt_ms = 0U;
    uint32_t last_persist_ms = 0U;
    uint32_t last_sd_poll_ms = 0U;
    bool sd_polled = false;
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
                    } else {
                        s_status.sd_flush_count++;
                    }
                    xSemaphoreGive(s_lock);
                }
                if (flush_err != ESP_OK) {
                    /* The private flash copy is canonical. Rebuild the
                     * removable-media logs after the next successful SD poll. */
                    s_sd_recovery_exported = false;
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

        /* Physical SD I/O is serialized here, outside s_lock so snapshots and
         * modem persistence never wait on removable-media detection. */
        if (!sd_polled || (now_ms - last_sd_poll_ms) >= STORAGE_USAGE_REFRESH_INTERVAL_MS) {
            storage_sd_status_t sd = {0};
            bool export_recovery = false;
            storage_sd_poll(storage_enabled, &sd);
            if (sd.mounted) {
                esp_err_t dir_err = storage_mgr_prepare_physical_sd_dirs();
                if (dir_err != ESP_OK) {
                    snprintf(sd.error, sizeof(sd.error), "%s", "log_dir_failed");
                    ESP_LOGW(TAG, "physical SD log directory preparation failed: %s errno=%d",
                             esp_err_to_name(dir_err), errno);
                }
            }
            if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                if (!sd.mounted) {
                    s_sd_recovery_exported = false;
                }
                s_status.sd = sd;
                export_recovery = sd.mounted && sd.error[0] == '\0' &&
                    s_status.media_available && !s_sd_recovery_exported;
                xSemaphoreGive(s_lock);
            }
            if (export_recovery) {
                esp_err_t export_err = storage_mgr_export_buffered_records();
                if (export_err != ESP_OK) {
                    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                        s_status.sd_write_failures++;
                        xSemaphoreGive(s_lock);
                    }
                    ESP_LOGW(TAG, "physical SD recovery export failed: %s", esp_err_to_name(export_err));
                }
            }
            sd_polled = true;
            last_sd_poll_ms = now_ms;
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

    err = storage_result_journal_init();
    if (err != ESP_OK) {
        return err;
    }

    err = storage_sd_init();
    if (err != ESP_OK) {
        return err;
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
    s_spool_io = storage_mgr_alloc_zeroed(sizeof(*s_spool_io));
    if (!s_spool_io) {
        heap_caps_free(s_blob);
        s_blob = NULL;
        vSemaphoreDelete(s_lock);
        s_lock = NULL;
        return ESP_ERR_NO_MEM;
    }
    s_pending_records = storage_mgr_alloc_zeroed(sizeof(*s_pending_records) * CONFIG_UNIFIED_STORAGE_PENDING_FLUSH_CAPACITY);
    if (!s_pending_records) {
        heap_caps_free(s_spool_io);
        s_spool_io = NULL;
        heap_caps_free(s_blob);
        s_blob = NULL;
        vSemaphoreDelete(s_lock);
        s_lock = NULL;
        return ESP_ERR_NO_MEM;
    }

    memset(&s_status, 0, sizeof(s_status));
    snprintf(s_status.sd.error, sizeof(s_status.sd.error), "%s", "not_probed");
    memset(s_mount_point, 0, sizeof(s_mount_point));
    s_blob->version = STORAGE_BLOB_VERSION;
    s_blob->head = STORAGE_SMS_ID_FIRST;
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
    s_status.pending_flush_count = 0U;
    s_spool_generation = 0U;
    s_spool_bank = 0U;
    s_spool_ready = false;
    snprintf(s_mount_point, sizeof(s_mount_point), "%s", "/sd");

    err = nvs_open(STORAGE_NAMESPACE, NVS_READONLY, &handle);
    if (err == ESP_OK) {
        err = nvs_get_blob(handle, STORAGE_SPOOL_KEY, s_blob, &actual_size);
        nvs_close(handle);
        if (err == ESP_OK && actual_size == sizeof(*s_blob) && storage_mgr_blob_layout_valid(s_blob)) {
            if (s_blob->version != STORAGE_BLOB_VERSION) {
                s_spool_io->blob = *s_blob;
                err = storage_mgr_migrate_legacy_blob(s_blob, &s_spool_io->blob);
            }
            if (err == ESP_OK) {
                s_status.record_count = s_blob->count;
                s_last_persist_ms = unified_tick_now_ms();
            }
        } else {
            err = ESP_ERR_INVALID_STATE;
        }
        if (err != ESP_OK) {
            memset(s_blob, 0, sizeof(*s_blob));
            s_blob->version = STORAGE_BLOB_VERSION;
            s_blob->head = STORAGE_SMS_ID_FIRST;
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
        heap_caps_free(s_spool_io);
        s_spool_io = NULL;
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
        out_records[index] = s_blob->records[index];
    }

    xSemaphoreGive(s_lock);
    return copy_count;
}

static esp_err_t storage_mgr_append_record(storage_mgr_record_t *record) {
    bool can_write_sd = false;
    bool notify_flush = false;
    bool flush_inline = false;
    storage_mgr_pending_record_t pending_record = {0};
    esp_err_t err = ESP_OK;
    esp_err_t sd_err = ESP_OK;

    if (!record || !s_lock || !s_blob) {
        return ESP_ERR_INVALID_ARG;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    err = storage_mgr_append_record_durable_locked(record);
    can_write_sd = (err == ESP_OK) && s_status.sd.mounted;
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
            } else {
                s_status.sd_flush_count++;
            }
            xSemaphoreGive(s_lock);
        }
    }

    /* Private flash is the canonical reboot-readable spool. A failed secondary file
     * export degrades storage telemetry but cannot make a committed append
     * false, and it must never alter the flash commit state. */
    return ESP_OK;
}

static esp_err_t storage_mgr_prepare_physical_sd_dirs(void) {
    struct stat dir_stat = {0};
    esp_err_t err = storage_sd_acquire(1000U);

    if (err != ESP_OK) {
        return err;
    }
    if (stat("/sd/logs", &dir_stat) == 0) {
        err = S_ISDIR(dir_stat.st_mode) ? ESP_OK : ESP_ERR_INVALID_STATE;
    } else if (mkdir("/sd/logs", 0775) == 0 || errno == EEXIST) {
        err = ESP_OK;
    } else {
        err = ESP_FAIL;
    }
    storage_sd_release();
    return err;
}

esp_err_t storage_mgr_append_sms(const unified_sms_payload_t *payload) {
    storage_mgr_record_t record = {
        .type = STORAGE_MGR_RECORD_SMS,
        .timestamp_ms = 0U,
    };

    if (!payload) {
        return ESP_ERR_INVALID_ARG;
    }

    record.payload.sms = *payload;
    return storage_mgr_append_record(&record);
}

/* SMS-02 idempotency: a re-read of a message still on the SIM must not be
 * stored twice. The storage id hash is the message key. */
bool storage_mgr_sms_exists(const unified_sms_payload_t *payload) {
    bool exists = false;

    if (!payload || !s_lock || !s_blob) {
        return false;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return false;
    }

    for (size_t index = 0U; index < s_blob->count; ++index) {
        const storage_mgr_record_t *record = &s_blob->records[index];
        if (record->type != STORAGE_MGR_RECORD_SMS) {
            continue;
        }
        if (storage_mgr_sms_matches(&record->payload.sms, payload)) {
            exists = true;
            break;
        }
    }

    xSemaphoreGive(s_lock);
    return exists;
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

static esp_err_t storage_mgr_delete_sms_locked(
    uint32_t storage_id,
    bool match_id,
    bool include_incoming,
    bool include_outgoing,
    uint32_t *out_deleted,
    storage_blob_t *replacement
) {
    uint32_t deleted = 0U;

    if (!replacement || !s_blob) {
        return ESP_ERR_INVALID_ARG;
    }

    memset(replacement, 0, sizeof(*replacement));
    replacement->version = STORAGE_BLOB_VERSION;
    replacement->head = s_blob->head;

    for (size_t index = 0U; index < s_blob->count; ++index) {
        const storage_mgr_record_t *record = &s_blob->records[index];
        bool delete_record = false;

        if (record->type == STORAGE_MGR_RECORD_SMS) {
            delete_record = match_id
                ? record->timestamp_ms == storage_id
                : ((include_incoming && !record->payload.sms.outgoing) || (include_outgoing && record->payload.sms.outgoing));
        }

        if (delete_record) {
            deleted++;
            continue;
        }
        if (replacement->count >= CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY) {
            return ESP_ERR_INVALID_SIZE;
        }
        replacement->records[replacement->count] = *record;
        replacement->count++;
    }

    if (deleted == 0U) {
        if (out_deleted) {
            *out_deleted = 0U;
        }
        return ESP_ERR_NOT_FOUND;
    }

    if (out_deleted) {
        *out_deleted = deleted;
    }
    return ESP_OK;
}

/* STORAGE_DELETE_DURABILITY_TEST_BEGIN */
static esp_err_t storage_mgr_commit_replacement_locked(storage_blob_t *replacement) {
    storage_blob_t *active = s_blob;
    const bool previous_persist_dirty = s_persist_dirty;
    esp_err_t err = ESP_OK;

    if (!active || !replacement) {
        return ESP_ERR_INVALID_ARG;
    }

    /* Persist the candidate before making it the canonical in-memory view. */
    s_blob = replacement;
    s_persist_dirty = true;
    err = storage_mgr_flush_persist_locked(unified_tick_now_ms());
    s_blob = active;
    if (err != ESP_OK) {
        s_persist_dirty = previous_persist_dirty;
        return err;
    }

    *active = *replacement;
    s_status.record_count = active->count;
    return ESP_OK;
}
/* STORAGE_DELETE_DURABILITY_TEST_END */

static esp_err_t storage_mgr_delete_sms(
    uint32_t storage_id,
    bool match_id,
    bool include_incoming,
    bool include_outgoing,
    uint32_t *out_deleted
) {
    storage_blob_t *replacement = NULL;
    bool rewrite_sd = false;
    uint32_t deleted = 0U;
    esp_err_t err = ESP_OK;

    if (!s_lock || !s_blob || (!match_id && !include_incoming && !include_outgoing)) {
        return ESP_ERR_INVALID_ARG;
    }

    replacement = storage_mgr_alloc_zeroed(sizeof(*replacement));
    if (!replacement) {
        return ESP_ERR_NO_MEM;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(250)) != pdTRUE) {
        heap_caps_free(replacement);
        return ESP_ERR_TIMEOUT;
    }
    err = storage_mgr_delete_sms_locked(storage_id, match_id, include_incoming, include_outgoing, &deleted, replacement);
    if (err == ESP_OK) {
        err = storage_mgr_commit_replacement_locked(replacement);
        if (err == ESP_OK) {
            rewrite_sd = s_status.media_available && !s_status.buffered_only;
            if (out_deleted) *out_deleted = deleted;
        } else {
            /* The canonical RAM view remains untouched when flash commit fails. */
            if (out_deleted) *out_deleted = 0U;
        }
    }
    storage_mgr_set_health_locked();
    xSemaphoreGive(s_lock);

    if (rewrite_sd) {
        esp_err_t sd_err = storage_mgr_rewrite_sms_log_from_blob(replacement);
        if (sd_err != ESP_OK) {
            if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
                s_status.sd_write_failures++;
                s_status.runtime.last_error = sd_err;
                unified_copy_cstr(s_status.runtime.last_error_text,
                                  sizeof(s_status.runtime.last_error_text),
                                  esp_err_to_name(sd_err));
                storage_mgr_set_health_locked();
                xSemaphoreGive(s_lock);
            }
        }
    }

    heap_caps_free(replacement);
    return err;
}

esp_err_t storage_mgr_delete_sms_by_id(uint32_t storage_id, uint32_t *out_deleted) {
    if (storage_id == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    return storage_mgr_delete_sms(storage_id, true, false, false, out_deleted);
}

esp_err_t storage_mgr_delete_sms_by_scope(bool include_incoming, bool include_outgoing, uint32_t *out_deleted) {
    return storage_mgr_delete_sms(0U, false, include_incoming, include_outgoing, out_deleted);
}

/* STORAGE_SMS_PAGINATION_TEST_BEGIN */
esp_err_t storage_mgr_build_sms_history_json(
    char *buffer,
    size_t buffer_len,
    uint16_t max_entries,
    uint32_t before_storage_id
) {
    size_t record_count = 0U;
    size_t sms_count = 0U;
    size_t eligible_count = 0U;
    size_t written = 0U;
    size_t included = 0U;
    uint32_t next_cursor = 0U;
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
        const storage_mgr_record_t *record = &s_blob->records[index];
        if (record->type == STORAGE_MGR_RECORD_SMS) {
            sms_count++;
            if (before_storage_id == 0U || record->timestamp_ms < before_storage_id) {
                eligible_count++;
            }
        }
    }

    written = (size_t)snprintf(
        buffer,
        buffer_len,
        "{\"total\":%u,\"count\":%u,\"entries\":[",
        (unsigned)sms_count,
        (unsigned)((eligible_count < effective_max_entries) ? eligible_count : effective_max_entries)
    );
    if (written >= buffer_len) {
        buffer[0] = '\0';
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_SIZE;
    }

    for (size_t index = record_count; index > 0U && included < effective_max_entries; --index) {
        const storage_mgr_record_t *record = &s_blob->records[index - 1U];
        char from[sizeof(record->payload.sms.from) * 2U] = {0};
        char text[sizeof(record->payload.sms.text) * 2U] = {0};
        char detail[sizeof(record->payload.sms.detail) * 2U] = {0};
        char storage_index[16] = {0};
        int append_result = 0;

        if (record->type != STORAGE_MGR_RECORD_SMS) {
            continue;
        }
        if (before_storage_id != 0U && record->timestamp_ms >= before_storage_id) {
            continue;
        }

        storage_mgr_escape_json(record->payload.sms.from, from, sizeof(from));
        storage_mgr_escape_json(record->payload.sms.text, text, sizeof(text));
        storage_mgr_escape_json(record->payload.sms.detail, detail, sizeof(detail));
        if (record->payload.sms.storage_index >= 0) {
            (void)snprintf(storage_index, sizeof(storage_index), "%d", (int)record->payload.sms.storage_index);
        } else {
            snprintf(storage_index, sizeof(storage_index), "%s", "null");
        }
        append_result = snprintf(
            buffer + written,
            buffer_len - written,
            "%s{\"storage_id\":%" PRIu32 ",\"storage_index\":%s,\"identity_migrated\":%s,\"from\":\"%s\",\"text\":\"%s\",\"detail\":\"%s\",\"sim_slot\":%u,\"timestamp_ms\":%" PRIu32 ",\"outgoing\":%s}",
            included > 0U ? "," : "",
            record->timestamp_ms,
            storage_index,
            record->payload.sms.storage_index == -2 ? "true" : "false",
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
        next_cursor = record->timestamp_ms;
        included++;
    }

    {
        const bool has_more = eligible_count > included;
        const int append_result = snprintf(
            buffer + written,
            buffer_len - written,
            "],\"has_more\":%s,\"next_cursor\":%" PRIu32 "}",
            has_more ? "true" : "false",
            has_more ? next_cursor : 0U
        );
        if (append_result < 0 || (size_t)append_result >= (buffer_len - written)) {
            buffer[0] = '\0';
            xSemaphoreGive(s_lock);
            return ESP_ERR_INVALID_SIZE;
        }
        written += (size_t)append_result;
    }
    if (written + 1U > buffer_len) {
        buffer[0] = '\0';
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_SIZE;
    }
    buffer[written] = '\0';
    xSemaphoreGive(s_lock);
    return ESP_OK;
}
/* STORAGE_SMS_PAGINATION_TEST_END */

static esp_err_t storage_mgr_rewrite_sms_log_from_blob(const storage_blob_t *blob) {
    esp_err_t err = ESP_OK;
    bool first_sms = true;

    if (!blob) {
        return ESP_ERR_INVALID_ARG;
    }

    err = storage_mgr_write_file(STORAGE_SD_SMS_FILE, "", 0U, false);
    if (err != ESP_OK) {
        return err;
    }

    for (size_t index = 0U; index < blob->count; ++index) {
        const storage_mgr_record_t *record = &blob->records[index];
        storage_mgr_pending_record_t pending = {0};

        if (record->type != STORAGE_MGR_RECORD_SMS) {
            continue;
        }

        err = storage_mgr_build_pending_record(record, &pending);
        if (err != ESP_OK) {
            return err;
        }
        err = storage_mgr_write_file(STORAGE_SD_SMS_FILE, pending.line, pending.line_len, !first_sms);
        if (err != ESP_OK) {
            return err;
        }
        first_sms = false;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
        s_usage_dirty = true;
        xSemaphoreGive(s_lock);
        storage_mgr_notify_task();
    }

    return ESP_OK;
}

esp_err_t storage_mgr_list_files_json(const char *relative_path, uint16_t max_entries, char *buffer, size_t buffer_len) {
    char mount_point[sizeof(s_mount_point)] = {0};
    char normalized_path[STORAGE_SD_PATH_LEN] = {0};
    char full_path[STORAGE_SD_PATH_LEN] = {0};
    char escaped_path[STORAGE_SD_PATH_LEN * 2U] = {0};
    struct stat path_stat = {0};
    DIR *dir = NULL;
    struct dirent *entry = NULL;
    size_t header_len = 0U;
    size_t written = 0U;
    uint16_t count = 0U;
    bool truncated = false;
    bool sd_lease_held = false;
    const char *effective_path = (relative_path && relative_path[0] != '\0') ? relative_path : "logs";
    esp_err_t err = ESP_OK;

    if (!buffer || buffer_len == 0U || !s_lock) {
        return ESP_ERR_INVALID_ARG;
    }
    buffer[0] = '\0';

    err = storage_mgr_copy_user_mount(mount_point, sizeof(mount_point));
    if (err != ESP_OK) {
        return err;
    }
    err = storage_sd_acquire(250U);
    if (err != ESP_OK) {
        return err;
    }
    sd_lease_held = true;

    err = storage_mgr_resolve_existing_path(
        effective_path,
        mount_point,
        normalized_path,
        sizeof(normalized_path),
        full_path,
        sizeof(full_path),
        &path_stat
    );
    if (err != ESP_OK) {
        goto cleanup;
    }
    if (!S_ISDIR(path_stat.st_mode)) {
        err = ESP_ERR_INVALID_ARG;
        goto cleanup;
    }

    dir = opendir(full_path);
    if (!dir) {
        err = ESP_FAIL;
        goto cleanup;
    }

    storage_mgr_escape_json(normalized_path, escaped_path, sizeof(escaped_path));
    written = (size_t)snprintf(buffer, buffer_len, "{\"path\":\"%s\",\"count\":0,\"truncated\":false,\"entries\":[", escaped_path);
    if (written >= buffer_len) {
        buffer[0] = '\0';
        err = ESP_ERR_INVALID_SIZE;
        goto cleanup;
    }
    header_len = written;

    while ((entry = readdir(dir)) != NULL) {
        char child_relative[STORAGE_SD_PATH_LEN] = {0};
        char child_full[STORAGE_SD_PATH_LEN] = {0};
        char escaped_name[STORAGE_SD_PATH_LEN * 2U] = {0};
        struct stat child_stat = {0};
        int append_result = 0;

        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
            continue;
        }
        if (max_entries > 0U && count >= max_entries) {
            truncated = true;
            break;
        }
        if (snprintf(child_relative, sizeof(child_relative), "%s/%s", normalized_path, entry->d_name) >= (int)sizeof(child_relative)) {
            continue;
        }
        if (storage_mgr_build_path_for_mount(mount_point, child_relative, child_full, sizeof(child_full)) != ESP_OK) {
            continue;
        }
        if (stat(child_full, &child_stat) != 0) {
            continue;
        }

        storage_mgr_escape_json(entry->d_name, escaped_name, sizeof(escaped_name));
        append_result = snprintf(
            buffer + written,
            buffer_len - written,
            "%s{\"name\":\"%s\",\"type\":\"%s\",\"size\":%" PRIu64 "}",
            count > 0U ? "," : "",
            escaped_name,
            S_ISDIR(child_stat.st_mode) ? "directory" : "file",
            (uint64_t)child_stat.st_size
        );
        if (append_result < 0 || (size_t)append_result >= (buffer_len - written)) {
            buffer[0] = '\0';
            err = ESP_ERR_INVALID_SIZE;
            goto cleanup;
        }
        written += (size_t)append_result;
        count++;
    }

    closedir(dir);
    dir = NULL;
    {
        const size_t old_header_len = header_len;
        int header_result = snprintf(
            buffer,
            buffer_len,
            "{\"path\":\"%s\",\"count\":%u,\"truncated\":%s,\"entries\":[",
            escaped_path,
            (unsigned)count,
            truncated ? "true" : "false"
        );
        if (header_result < 0 || (size_t)header_result >= buffer_len) {
            buffer[0] = '\0';
            err = ESP_ERR_INVALID_SIZE;
            goto cleanup;
        }
        if ((size_t)header_result != old_header_len) {
            if ((size_t)header_result > old_header_len &&
                written + ((size_t)header_result - old_header_len) >= buffer_len) {
                buffer[0] = '\0';
                err = ESP_ERR_INVALID_SIZE;
                goto cleanup;
            }
            memmove(
                buffer + (size_t)header_result,
                buffer + old_header_len,
                written - old_header_len + 1U
            );
        }
        written = (size_t)header_result + (written - old_header_len);
    }
    if (written + 3U > buffer_len) {
        buffer[0] = '\0';
        err = ESP_ERR_INVALID_SIZE;
        goto cleanup;
    }
    buffer[written++] = ']';
    buffer[written++] = '}';
    buffer[written] = '\0';
    err = ESP_OK;

cleanup:
    if (dir) {
        closedir(dir);
    }
    if (sd_lease_held) {
        storage_sd_release();
    }
    return err;
}

esp_err_t storage_mgr_build_file_meta_json(const char *relative_path, char *buffer, size_t buffer_len) {
    char mount_point[sizeof(s_mount_point)] = {0};
    char normalized_path[STORAGE_SD_PATH_LEN] = {0};
    char full_path[STORAGE_SD_PATH_LEN] = {0};
    char escaped_path[STORAGE_SD_PATH_LEN * 2U] = {0};
    struct stat path_stat = {0};
    bool sd_lease_held = false;
    esp_err_t err = ESP_OK;

    if (!relative_path || relative_path[0] == '\0' || !buffer || buffer_len == 0U || !s_lock) {
        return ESP_ERR_INVALID_ARG;
    }
    buffer[0] = '\0';

    err = storage_mgr_copy_user_mount(mount_point, sizeof(mount_point));
    if (err != ESP_OK) {
        return err;
    }
    err = storage_sd_acquire(250U);
    if (err != ESP_OK) {
        return err;
    }
    sd_lease_held = true;

    err = storage_mgr_resolve_existing_path(
        relative_path,
        mount_point,
        normalized_path,
        sizeof(normalized_path),
        full_path,
        sizeof(full_path),
        &path_stat
    );
    if (err != ESP_OK) {
        goto cleanup;
    }

    storage_mgr_escape_json(normalized_path, escaped_path, sizeof(escaped_path));
    if (snprintf(
            buffer,
            buffer_len,
            "{\"path\":\"%s\",\"type\":\"%s\",\"size\":%" PRIu64 ",\"mtime\":%" PRIu64 "}",
            escaped_path,
            S_ISDIR(path_stat.st_mode) ? "directory" : "file",
            (uint64_t)path_stat.st_size,
            (uint64_t)path_stat.st_mtime
        ) >= (int)buffer_len) {
        buffer[0] = '\0';
        err = ESP_ERR_INVALID_SIZE;
        goto cleanup;
    }
    err = ESP_OK;

cleanup:
    if (sd_lease_held) {
        storage_sd_release();
    }
    return err;
}

esp_err_t storage_mgr_delete_file(const char *relative_path) {
    char mount_point[sizeof(s_mount_point)] = {0};
    char normalized_path[STORAGE_SD_PATH_LEN] = {0};
    char full_path[STORAGE_SD_PATH_LEN] = {0};
    struct stat path_stat = {0};
    bool sd_lease_held = false;
    esp_err_t err = ESP_OK;

    if (!relative_path || relative_path[0] == '\0' || !s_lock) {
        return ESP_ERR_INVALID_ARG;
    }

    err = storage_mgr_copy_user_mount(mount_point, sizeof(mount_point));
    if (err != ESP_OK) {
        return err;
    }
    err = storage_sd_acquire(250U);
    if (err != ESP_OK) {
        return err;
    }
    sd_lease_held = true;

    err = storage_mgr_resolve_existing_path(
        relative_path,
        mount_point,
        normalized_path,
        sizeof(normalized_path),
        full_path,
        sizeof(full_path),
        &path_stat
    );
    if (err == ESP_OK) {
        if (S_ISDIR(path_stat.st_mode)) {
            err = rmdir(full_path) == 0 ? ESP_OK : (errno == ENOTEMPTY ? ESP_ERR_INVALID_STATE : ESP_FAIL);
        } else {
            err = unlink(full_path) == 0 ? ESP_OK : ESP_FAIL;
        }
    }
    if (err == ESP_OK) {
        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            s_usage_dirty = true;
            xSemaphoreGive(s_lock);
        }
    }
    if (sd_lease_held) {
        storage_sd_release();
    }
    return err;
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
