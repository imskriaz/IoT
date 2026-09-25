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
    char multipart_ref[UNIFIED_TEXT_SHORT_LEN];
    uint16_t multipart_part_index;
    uint16_t multipart_part_count;
    uint8_t sim_slot;
    /* Exact modem slot used for a received record. -1 means that the SMS did
     * not originate from modem storage (for example, a locally sent SMS).
     * Kept beside sim_slot so the structure retains its existing alignment. */
    int16_t storage_index;
    uint32_t timestamp_ms;
    bool outgoing;
} unified_sms_payload_t;

typedef struct {
    char to[UNIFIED_TEXT_SHORT_LEN];
    char raw[UNIFIED_TEXT_LONG_LEN];
    uint16_t message_reference;
    uint16_t status_report_status;
    /* Positive for reports retained in modem storage; zero for direct +CDS. */
    int storage_index;
    uint8_t sim_slot;
    uint32_t timestamp_ms;
} unified_sms_delivery_payload_t;

typedef struct {
    char number[UNIFIED_TEXT_SHORT_LEN];
    char state[UNIFIED_TEXT_SHORT_LEN];
    uint8_t sim_slot;
    uint32_t timestamp_ms;
} unified_call_payload_t;

typedef struct {
    char code[UNIFIED_TEXT_SHORT_LEN];
    char response[UNIFIED_TEXT_LONG_LEN];
    char status[UNIFIED_TEXT_SHORT_LEN];
    uint8_t sim_slot;
    bool session_active;
    uint32_t timestamp_ms;
} unified_ussd_payload_t;
