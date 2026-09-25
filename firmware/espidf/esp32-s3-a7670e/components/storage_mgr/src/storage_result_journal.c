#include "storage_mgr.h"
#include "storage_result_journal.h"

#include <stddef.h>
#include <stdio.h>
#include <string.h>
#ifdef _WIN32
#include <io.h>
#define result_fsync _commit
#define result_fileno _fileno
#else
#include <unistd.h>
#define result_fsync fsync
#define result_fileno fileno
#endif
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_heap_caps.h"

#ifndef CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN
#define CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN 4096
#endif

/* Fixed private-flash quota. Two generations per slot let a torn write leave
 * the previous valid state intact. A reservation that survives a reboot is
 * converted into a durable uncertain terminal result: hardware is never
 * executed twice, while an exact dashboard acknowledgement can reclaim it. */
#ifndef RESULT_JOURNAL_SLOTS
#define RESULT_JOURNAL_SLOTS 16U
#endif
#define RESULT_JOURNAL_MAGIC 0x52534c54U
#define RESULT_JOURNAL_VERSION 1U
/* Keep every path segment DOS 8.3 compatible because production firmware is
 * built with CONFIG_FATFS_LFN_NONE. */
#define RESULT_JOURNAL_DIR "/storage/results"

typedef enum {
    RESULT_EMPTY = 0,
    RESULT_RESERVED = 1,
    RESULT_TERMINAL = 2,
    RESULT_ACKED = 3,
} result_state_t;

typedef struct {
    uint32_t magic;
    uint32_t version;
    uint32_t generation;
    uint32_t checksum;
    uint32_t state;
    unified_action_response_t response;
    char payload[CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN];
} result_disk_record_t;

static SemaphoreHandle_t s_result_lock;
static result_disk_record_t *s_result_current;
static result_disk_record_t *s_result_probe;
static bool s_result_available;
static bool s_result_boot_reconciled;
static const char *s_result_dir = RESULT_JOURNAL_DIR;
static unsigned s_result_scan_cursor;

static uint32_t result_checksum(const result_disk_record_t *record) {
    const unsigned char *bytes = (const unsigned char *)&record->state;
    size_t length = sizeof(*record) - offsetof(result_disk_record_t, state);
    uint32_t hash = 2166136261U;
    for (size_t index = 0; index < length; ++index) {
        hash = (hash ^ bytes[index]) * 16777619U;
    }
    hash = (hash ^ record->generation) * 16777619U;
    return hash;
}

static void result_path(unsigned slot, unsigned bank, char *path, size_t length) {
    (void)snprintf(path, length, "%s/r%02u%c", s_result_dir, slot, bank ? 'b' : 'a');
}

static bool result_read(unsigned slot, unsigned bank, result_disk_record_t *record) {
    char path[sizeof(RESULT_JOURNAL_DIR) + 16U] = {0};
    FILE *file = NULL;
    size_t count = 0U;
    int extra = 0;
    result_path(slot, bank, path, sizeof(path));
    file = fopen(path, "rb");
    if (!file) {
        return false;
    }
    count = fread(record, 1U, sizeof(*record), file);
    extra = fgetc(file);
    (void)fclose(file);
    return count == sizeof(*record) && extra == EOF &&
        record->magic == RESULT_JOURNAL_MAGIC &&
        record->version == RESULT_JOURNAL_VERSION &&
        record->generation != 0U &&
        record->state >= RESULT_RESERVED && record->state <= RESULT_ACKED &&
        record->checksum == result_checksum(record);
}

static bool result_load_slot(unsigned slot, result_disk_record_t *record, unsigned *bank) {
    bool found = false;
    memset(record, 0, sizeof(*record));
    for (unsigned candidate = 0U; candidate < 2U; ++candidate) {
        if (!result_read(slot, candidate, s_result_probe)) {
            continue;
        }
        if (!found || (int32_t)(s_result_probe->generation - record->generation) > 0) {
            *record = *s_result_probe;
            *bank = candidate;
            found = true;
        }
    }
    return found;
}

static esp_err_t result_write(unsigned slot, unsigned bank, result_disk_record_t *record) {
    char path[sizeof(RESULT_JOURNAL_DIR) + 16U] = {0};
    FILE *file = NULL;
    bool okay = false;
    result_path(slot, bank, path, sizeof(path));
    record->magic = RESULT_JOURNAL_MAGIC;
    record->version = RESULT_JOURNAL_VERSION;
    record->checksum = result_checksum(record);
    file = fopen(path, "wb");
    if (!file) {
        return ESP_FAIL;
    }
    okay = fwrite(record, 1U, sizeof(*record), file) == sizeof(*record) &&
        fflush(file) == 0 && result_fsync(result_fileno(file)) == 0;
    if (fclose(file) != 0) {
        okay = false;
    }
    /* A successful syscall is insufficient if the file is truncated or the
     * data read back with a bad checksum. The other bank remains untouched. */
    if (!okay || !result_read(slot, bank, s_result_probe) ||
        s_result_probe->generation != record->generation ||
        s_result_probe->checksum != record->checksum) {
        return ESP_FAIL;
    }
    return ESP_OK;
}

static bool result_same_action(const result_disk_record_t *record,
                               const unified_action_envelope_t *action) {
    return strcmp(record->response.action.correlation.device_id,
                  action->correlation.device_id) == 0 &&
        strcmp(record->response.action.correlation.correlation_id,
               action->correlation.correlation_id) == 0 &&
        record->response.action.command == action->command;
}

esp_err_t storage_result_journal_init(void) {
    if (s_result_lock) {
        return ESP_OK;
    }
    s_result_lock = xSemaphoreCreateMutex();
    if (!s_result_lock) {
        return ESP_ERR_NO_MEM;
    }
    s_result_current = heap_caps_calloc(1U, sizeof(*s_result_current), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    s_result_probe = heap_caps_calloc(1U, sizeof(*s_result_probe), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_result_current || !s_result_probe) {
        if (s_result_current) heap_caps_free(s_result_current);
        if (s_result_probe) heap_caps_free(s_result_probe);
        s_result_current = s_result_probe = NULL;
        vSemaphoreDelete(s_result_lock);
        s_result_lock = NULL;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

static bool result_reconcile_boot_reservations_locked(void) {
    bool complete = true;
    static const char uncertain_payload[] = "{\"outcome_uncertain\":true,\"replay_safe\":false}";
    for (unsigned slot = 0U; slot < RESULT_JOURNAL_SLOTS; ++slot) {
        unsigned bank = 0U;
        if (!result_load_slot(slot, s_result_current, &bank) ||
            s_result_current->state != RESULT_RESERVED) {
            continue;
        }
        s_result_current->generation++;
        if (s_result_current->generation == 0U) s_result_current->generation = 1U;
        s_result_current->state = RESULT_TERMINAL;
        s_result_current->response.result = UNIFIED_ACTION_RESULT_FAILED;
        s_result_current->response.feature_reason = UNIFIED_FEATURE_REASON_NONE;
        s_result_current->response.result_code = ESP_ERR_INVALID_STATE;
        snprintf(s_result_current->response.detail,
                 sizeof(s_result_current->response.detail),
                 "%s", "action_outcome_uncertain_after_reboot");
        memset(s_result_current->payload, 0, sizeof(s_result_current->payload));
        memcpy(s_result_current->payload, uncertain_payload, sizeof(uncertain_payload));
        if (result_write(slot, 1U - bank, s_result_current) != ESP_OK) {
            complete = false;
        }
    }
    return complete;
}

void storage_result_journal_set_available(bool available) {
    if (s_result_lock && xSemaphoreTake(s_result_lock, portMAX_DELAY) == pdTRUE) {
        s_result_available = available;
        if (available && !s_result_boot_reconciled &&
            result_reconcile_boot_reservations_locked()) {
            s_result_boot_reconciled = true;
        }
        xSemaphoreGive(s_result_lock);
    }
}

esp_err_t storage_mgr_result_reserve(const unified_action_envelope_t *action) {
    unsigned free_slot = RESULT_JOURNAL_SLOTS;
    unsigned free_bank = 0U;
    uint32_t generation = 0U;
    esp_err_t err = ESP_ERR_NO_MEM;
    if (!action || !action->correlation.correlation_id[0] ||
        !action->correlation.device_id[0] || !s_result_lock) {
        return ESP_ERR_INVALID_ARG;
    }
    if (xSemaphoreTake(s_result_lock, pdMS_TO_TICKS(2000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    if (!s_result_available) {
        err = ESP_ERR_INVALID_STATE;
        goto done;
    }
    for (unsigned slot = 0U; slot < RESULT_JOURNAL_SLOTS; ++slot) {
        unsigned bank = 0U;
        bool found = result_load_slot(slot, s_result_current, &bank);
        if (found && s_result_current->state != RESULT_ACKED &&
            result_same_action(s_result_current, action)) {
            err = s_result_current->state == RESULT_TERMINAL
                ? ESP_ERR_NOT_ALLOWED /* caller can replay the original terminal result */
                : ESP_ERR_NOT_FINISHED; /* prior execution outcome is uncertain */
            goto done;
        }
        if ((!found || s_result_current->state == RESULT_ACKED) && free_slot == RESULT_JOURNAL_SLOTS) {
            free_slot = slot;
            free_bank = found ? 1U - bank : 0U;
            generation = found ? s_result_current->generation : 0U;
        }
    }
    if (free_slot == RESULT_JOURNAL_SLOTS) {
        goto done;
    }
    memset(s_result_current, 0, sizeof(*s_result_current));
    s_result_current->generation = generation + 1U;
    if (s_result_current->generation == 0U) s_result_current->generation = 1U;
    s_result_current->state = RESULT_RESERVED;
    s_result_current->response.action = *action;
    err = result_write(free_slot, free_bank, s_result_current);
done:
    xSemaphoreGive(s_result_lock);
    return err;
}

#ifdef STORAGE_RESULT_JOURNAL_HOST_TEST
void storage_result_journal_test_reboot(const char *directory) {
    if (s_result_current) heap_caps_free(s_result_current);
    if (s_result_probe) heap_caps_free(s_result_probe);
    if (s_result_lock) vSemaphoreDelete(s_result_lock);
    s_result_current = s_result_probe = NULL;
    s_result_lock = NULL;
    s_result_available = false;
    s_result_boot_reconciled = false;
    s_result_scan_cursor = 0U;
    s_result_dir = directory;
    (void)storage_result_journal_init();
    storage_result_journal_set_available(true);
}
#endif

esp_err_t storage_mgr_result_commit(const unified_action_response_t *response, const char *payload_json) {
    esp_err_t err = ESP_ERR_NOT_FOUND;
    size_t payload_size = payload_json ? strlen(payload_json) : 0U;
    if (!response || payload_size >= CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN || !s_result_lock) {
        return ESP_ERR_INVALID_ARG;
    }
    if (response->result == UNIFIED_ACTION_RESULT_ACCEPTED ||
        response->result == UNIFIED_ACTION_RESULT_NONE) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_result_lock, pdMS_TO_TICKS(2000)) != pdTRUE) return ESP_ERR_TIMEOUT;
    if (!s_result_available) {
        err = ESP_ERR_INVALID_STATE;
        goto done;
    }
    for (unsigned slot = 0U; slot < RESULT_JOURNAL_SLOTS; ++slot) {
        unsigned bank = 0U;
        if (!result_load_slot(slot, s_result_current, &bank) ||
            s_result_current->state == RESULT_ACKED ||
            !result_same_action(s_result_current, &response->action)) continue;
        if (s_result_current->state == RESULT_TERMINAL) {
            err = ESP_ERR_INVALID_STATE;
            goto done;
        }
        s_result_current->generation++;
        s_result_current->state = RESULT_TERMINAL;
        s_result_current->response = *response;
        memset(s_result_current->payload, 0, sizeof(s_result_current->payload));
        if (payload_size) memcpy(s_result_current->payload, payload_json, payload_size);
        err = result_write(slot, 1U - bank, s_result_current);
        goto done;
    }
done:
    xSemaphoreGive(s_result_lock);
    return err;
}

esp_err_t storage_mgr_result_next(unified_action_response_t *out_response,
                                  char *out_payload, size_t payload_len) {
    esp_err_t err = ESP_ERR_NOT_FOUND;
    if (!out_response || !out_payload || payload_len < CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN || !s_result_lock) {
        return ESP_ERR_INVALID_ARG;
    }
    if (xSemaphoreTake(s_result_lock, pdMS_TO_TICKS(2000)) != pdTRUE) return ESP_ERR_TIMEOUT;
    if (!s_result_available) {
        err = ESP_ERR_INVALID_STATE;
        goto done;
    }
    for (unsigned offset = 0U; offset < RESULT_JOURNAL_SLOTS; ++offset) {
        unsigned slot = (s_result_scan_cursor + offset) % RESULT_JOURNAL_SLOTS;
        unsigned bank = 0U;
        if (result_load_slot(slot, s_result_current, &bank) && s_result_current->state == RESULT_TERMINAL) {
            *out_response = s_result_current->response;
            memcpy(out_payload, s_result_current->payload, sizeof(s_result_current->payload));
            out_payload[payload_len - 1U] = '\0';
            s_result_scan_cursor = (slot + 1U) % RESULT_JOURNAL_SLOTS;
            err = ESP_OK;
            break;
        }
    }
done:
    xSemaphoreGive(s_result_lock);
    return err;
}

esp_err_t storage_mgr_result_get(const unified_action_envelope_t *action,
                                 unified_action_response_t *out_response,
                                 char *out_payload, size_t payload_len) {
    esp_err_t err = ESP_ERR_NOT_FOUND;
    if (!action || !out_response || !out_payload ||
        payload_len < CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN || !s_result_lock) {
        return ESP_ERR_INVALID_ARG;
    }
    if (xSemaphoreTake(s_result_lock, pdMS_TO_TICKS(2000)) != pdTRUE) return ESP_ERR_TIMEOUT;
    if (!s_result_available) {
        err = ESP_ERR_INVALID_STATE;
        goto done;
    }
    for (unsigned slot = 0U; slot < RESULT_JOURNAL_SLOTS; ++slot) {
        unsigned bank = 0U;
        if (result_load_slot(slot, s_result_current, &bank) &&
            s_result_current->state == RESULT_TERMINAL &&
            result_same_action(s_result_current, action)) {
            *out_response = s_result_current->response;
            memcpy(out_payload, s_result_current->payload, sizeof(s_result_current->payload));
            out_payload[payload_len - 1U] = '\0';
            err = ESP_OK;
            break;
        }
    }
done:
    xSemaphoreGive(s_result_lock);
    return err;
}

esp_err_t storage_mgr_result_ack(const char *device_id, const char *action_id,
                                 unified_action_command_t command) {
    esp_err_t err = ESP_ERR_NOT_FOUND;
    if (!device_id || !device_id[0] || !action_id || !action_id[0] || !s_result_lock) {
        return ESP_ERR_INVALID_ARG;
    }
    if (xSemaphoreTake(s_result_lock, pdMS_TO_TICKS(2000)) != pdTRUE) return ESP_ERR_TIMEOUT;
    if (!s_result_available) {
        err = ESP_ERR_INVALID_STATE;
        goto done;
    }
    for (unsigned slot = 0U; slot < RESULT_JOURNAL_SLOTS; ++slot) {
        unsigned bank = 0U;
        if (!result_load_slot(slot, s_result_current, &bank) ||
            s_result_current->state != RESULT_TERMINAL ||
            strcmp(device_id, s_result_current->response.action.correlation.device_id) != 0 ||
            strcmp(action_id, s_result_current->response.action.correlation.correlation_id) != 0 ||
            command != s_result_current->response.action.command) continue;
        s_result_current->generation++;
        s_result_current->state = RESULT_ACKED;
        err = result_write(slot, 1U - bank, s_result_current);
        break;
    }
done:
    xSemaphoreGive(s_result_lock);
    return err;
}
