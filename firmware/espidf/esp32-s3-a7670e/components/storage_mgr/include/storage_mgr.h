#pragma once

#include <stdbool.h>

#include "esp_err.h"

#include "common_models.h"
#include "payload_models.h"

typedef struct {
    unified_service_runtime_t runtime;
    bool enabled;
    bool media_available;
    bool buffered_only;
    uint64_t total_bytes;
    uint64_t used_bytes;
    uint64_t free_bytes;
    uint32_t record_count;
    uint32_t dropped_count;
    uint32_t persist_failures;
    uint32_t mount_failures;
    uint32_t sd_write_failures;
    uint32_t sd_flush_count;
} storage_mgr_status_t;

esp_err_t storage_mgr_init(void);
uint32_t storage_mgr_sms_storage_id(const unified_sms_payload_t *payload);
esp_err_t storage_mgr_append_sms(const unified_sms_payload_t *payload);
esp_err_t storage_mgr_append_call(const unified_call_payload_t *payload);
esp_err_t storage_mgr_build_sms_history_json(char *buffer, size_t buffer_len, uint16_t max_entries);
esp_err_t storage_mgr_delete_sms_by_id(uint32_t storage_id, uint32_t *out_deleted);
esp_err_t storage_mgr_delete_sms_by_scope(bool include_incoming, bool include_outgoing, uint32_t *out_deleted);
esp_err_t storage_mgr_list_files_json(const char *relative_path, uint16_t max_entries, char *buffer, size_t buffer_len);
esp_err_t storage_mgr_build_file_meta_json(const char *relative_path, char *buffer, size_t buffer_len);
esp_err_t storage_mgr_delete_file(const char *relative_path);
void storage_mgr_get_status(storage_mgr_status_t *out_status);
