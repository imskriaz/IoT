#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#include "state_models.h"

typedef unified_reported_state_t state_mgr_snapshot_t;

esp_err_t state_mgr_init(void);
void state_mgr_get_snapshot(state_mgr_snapshot_t *out_snapshot);
esp_err_t state_mgr_set_storage(bool sd_mounted);
esp_err_t state_mgr_set_modem_runtime(bool telephony_enabled, bool data_mode_enabled);
