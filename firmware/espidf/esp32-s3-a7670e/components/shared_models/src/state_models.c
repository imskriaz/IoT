#include "state_models.h"

#include <string.h>

uint32_t unified_state_next_version(uint32_t current_version) {
    if (current_version == UINT32_MAX) {
        return 1;
    }
    return current_version + 1;
}

void unified_reported_state_reset(unified_reported_state_t *state) {
    if (!state) {
        return;
    }

    memset(state, 0, sizeof(*state));
    /* Runtime transport toggles are not persisted yet. Default both modem
     * telephony and data lanes to enabled on boot so Wi-Fi-primary devices
     * still keep modem fallback available after restart. */
    state->telephony_enabled = true;
    state->data_mode_enabled = true;
    state->state_version = 1;
}
