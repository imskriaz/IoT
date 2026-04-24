#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#include "action_models.h"
#include "common_models.h"

#ifndef CONFIG_UNIFIED_API_BRIDGE_HISTORY_DEPTH
#define CONFIG_UNIFIED_API_BRIDGE_HISTORY_DEPTH  8
#endif

#ifndef CONFIG_UNIFIED_API_BRIDGE_MAX_LIST_ENTRIES
#define CONFIG_UNIFIED_API_BRIDGE_MAX_LIST_ENTRIES  8
#endif

#ifndef CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN
#define CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN  2048
#endif

#ifndef CONFIG_UNIFIED_API_BRIDGE_PATH_LEN
#define CONFIG_UNIFIED_API_BRIDGE_PATH_LEN  96
#endif

#ifndef CONFIG_UNIFIED_API_BRIDGE_CONFIG_KEY_LEN
#define CONFIG_UNIFIED_API_BRIDGE_CONFIG_KEY_LEN  48
#endif

#ifndef CONFIG_UNIFIED_API_BRIDGE_CONFIG_VALUE_LEN
#define CONFIG_UNIFIED_API_BRIDGE_CONFIG_VALUE_LEN  128
#endif

#ifndef CONFIG_UNIFIED_API_BRIDGE_URL_LEN
#define CONFIG_UNIFIED_API_BRIDGE_URL_LEN  512
#endif

#ifndef CONFIG_UNIFIED_API_BRIDGE_SMS_PDU_LEN
#define CONFIG_UNIFIED_API_BRIDGE_SMS_PDU_LEN  2816
#endif

typedef struct {
    char path[CONFIG_UNIFIED_API_BRIDGE_PATH_LEN];
    char number[UNIFIED_TEXT_SHORT_LEN];
    char text[UNIFIED_SMS_TEXT_MAX_LEN];
    char sms_encoding[16];
    char sms_transport_encoding[16];
    char sms_pdu[CONFIG_UNIFIED_API_BRIDGE_SMS_PDU_LEN];
    char sms_pdu_encoding[16];
    char code[UNIFIED_TEXT_SHORT_LEN];
    char key[CONFIG_UNIFIED_API_BRIDGE_CONFIG_KEY_LEN];
    char value[CONFIG_UNIFIED_API_BRIDGE_CONFIG_VALUE_LEN];
    char apn[64];
    char username[64];
    char password[64];
    char auth[16];
    char url[CONFIG_UNIFIED_API_BRIDGE_URL_LEN];
    bool enabled_present;
    bool enabled;
    bool failover_present;
    bool failover;
    bool load_balancing_present;
    bool load_balancing;
    bool nat_present;
    bool nat;
    bool firewall_present;
    bool firewall;
    uint32_t ttl_ms;
    uint32_t interval_ms;
    uint16_t sms_parts;
    uint16_t sms_units;
    uint16_t sms_utf8_bytes;
    uint16_t sms_characters;
    uint16_t sms_pdu_length;
    bool sms_multipart_present;
    bool sms_multipart;
    uint16_t max_entries;
} api_bridge_request_t;

typedef struct {
    uint32_t sequence;
    unified_action_response_t response;
    char payload[CONFIG_UNIFIED_API_BRIDGE_PAYLOAD_LEN];
} api_bridge_action_record_t;

typedef void (*api_bridge_result_listener_t)(const api_bridge_action_record_t *record);

esp_err_t api_bridge_init(void);
esp_err_t api_bridge_execute_action(
    const unified_action_envelope_t *action,
    const api_bridge_request_t *request,
    unified_action_response_t *out_response,
    char *out_payload,
    size_t out_payload_len
);
esp_err_t api_bridge_record_external_response(
    const unified_action_response_t *response,
    const char *payload
);
esp_err_t api_bridge_set_result_listener(api_bridge_result_listener_t listener);
size_t api_bridge_snapshot_recent_records(api_bridge_action_record_t *out_entries, size_t max_entries);
