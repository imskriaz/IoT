#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "common_models.h"

typedef struct {
    char from[UNIFIED_TEXT_SHORT_LEN];
    /* SMS text buffer: 160 chars for GSM 7-bit, but UCS-2 multi-part SMS can deliver
     * more bytes to the TE. 256 provides headroom for concatenated SMS without overflow. */
    char text[256];
    char detail[UNIFIED_TEXT_SHORT_LEN];
    uint32_t timestamp_ms;
    bool outgoing;
} unified_sms_payload_t;

typedef struct {
    char number[UNIFIED_TEXT_SHORT_LEN];
    char state[UNIFIED_TEXT_SHORT_LEN];
    uint32_t timestamp_ms;
} unified_call_payload_t;

typedef struct {
    char code[UNIFIED_TEXT_SHORT_LEN];
    char response[UNIFIED_TEXT_LONG_LEN];
    bool session_active;
    uint32_t timestamp_ms;
} unified_ussd_payload_t;
