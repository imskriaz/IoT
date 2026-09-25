#pragma once
#include <stddef.h>
#include "esp_err.h"
#include "action_models.h"
esp_err_t storage_mgr_result_reserve(const unified_action_envelope_t *action);
esp_err_t storage_mgr_result_commit(const unified_action_response_t *response, const char *payload_json);
esp_err_t storage_mgr_result_get(const unified_action_envelope_t *action, unified_action_response_t *out_response, char *out_payload, size_t payload_len);
esp_err_t storage_mgr_result_next(unified_action_response_t *out_response, char *out_payload, size_t payload_len);
esp_err_t storage_mgr_result_ack(const char *device_id, const char *action_id, unified_action_command_t command);
