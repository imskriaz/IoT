#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "common_models.h"

typedef struct {
    char from[UNIFIED_TEXT_SHORT_LEN];
    /* Long SMS can arrive concatenated by the modem, so keep enough room for
     * multiple text-mode segments while staying below the MQTT command budget. */
    char text[UNIFIED_SMS_TEXT_MAX_LEN];
    char detail[UNIFIED_TEXT_SHORT_LEN];
    uint8_t sim_slot;
    uint32_t timestamp_ms;
    bool outgoing;
} unified_sms_payload_t;

typedef struct {
    char number[UNIFIED_TEXT_SHORT_LEN];
    char state[UNIFIED_TEXT_SHORT_LEN];
    uint8_t sim_slot;
    uint32_t timestamp_ms;
} unified_call_payload_t;

typedef struct {
    char code[UNIFIED_TEXT_SHORT_LEN];
    char response[UNIFIED_TEXT_LONG_LEN];
    uint8_t sim_slot;
    bool session_active;
    uint32_t timestamp_ms;
} unified_ussd_payload_t;
