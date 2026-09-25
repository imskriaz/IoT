#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "common_models.h"

typedef struct {
    bool sd_mounted;
    bool telephony_enabled;
    bool data_mode_enabled;
    char ota_slot[17];
    char ota_state[24];
    uint32_t ota_address;
    uint32_t state_version;
} unified_reported_state_t;

uint32_t unified_state_next_version(uint32_t current_version);
void unified_reported_state_reset(unified_reported_state_t *state);
