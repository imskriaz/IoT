#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#include "state_models.h"

typedef unified_reported_state_t state_mgr_snapshot_t;

esp_err_t state_mgr_init(void);
/* Immutable after init; safe for status readers on external stacks. */
const char *state_mgr_boot_id(void);
const char *state_mgr_firmware_version(void);
const char *state_mgr_firmware_elf_sha256(void);
void state_mgr_get_snapshot(state_mgr_snapshot_t *out_snapshot);
esp_err_t state_mgr_set_storage(bool sd_mounted);
esp_err_t state_mgr_set_modem_runtime(bool telephony_enabled, bool data_mode_enabled);
esp_err_t state_mgr_set_ota_runtime(const char *slot, const char *image_state, uint32_t address);
esp_err_t state_mgr_set_ota_image_state(const char *image_state);
esp_err_t state_mgr_request_ota_validation(void);
bool state_mgr_wait_for_ota_validation(uint32_t timeout_ms);
