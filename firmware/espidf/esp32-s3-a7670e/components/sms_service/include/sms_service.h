#pragma once

#include "esp_err.h"

#include "action_models.h"
#include "common_models.h"
#include "payload_models.h"

typedef struct {
    unified_service_runtime_t runtime;
    bool ready;
    uint32_t poll_count;
    uint32_t sent_count;
    uint32_t received_count;
    uint32_t failure_count;
    unified_sms_payload_t last_incoming;
    unified_sms_payload_t last_outgoing;
    char last_destination[UNIFIED_TEXT_SHORT_LEN];
    char last_detail[UNIFIED_TEXT_MEDIUM_LEN];
} sms_service_status_t;

typedef struct {
    bool force_multipart;
    bool use_ucs2_present;
    bool use_ucs2;
    uint16_t expected_parts;
    const char *pdu_hex;
    uint16_t pdu_length;
} sms_service_send_options_t;

esp_err_t sms_service_init(void);
unified_action_response_t sms_service_send(const char *number, const char *text, uint32_t timeout_ms);
unified_action_response_t sms_service_send_multipart(const char *number, const char *text, uint32_t timeout_ms);
unified_action_response_t sms_service_send_with_options(
    const char *number,
    const char *text,
    uint32_t timeout_ms,
    const sms_service_send_options_t *options
);
void sms_service_get_status(sms_service_status_t *out_status);
