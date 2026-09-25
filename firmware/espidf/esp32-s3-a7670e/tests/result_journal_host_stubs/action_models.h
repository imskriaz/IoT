#pragma once
#include <stdint.h>
#define UNIFIED_CORRELATION_ID_LEN 32
#define UNIFIED_DEVICE_ID_LEN 32
#define UNIFIED_TEXT_MEDIUM_LEN 48
typedef enum { UNIFIED_FEATURE_REASON_NONE = 0 } unified_feature_reason_t;
typedef enum {
    UNIFIED_ACTION_CMD_NONE = 0, UNIFIED_ACTION_CMD_GET_STATUS = 1,
    UNIFIED_ACTION_CMD_SEND_SMS = 6, UNIFIED_ACTION_CMD_DELETE_SMS = 39
} unified_action_command_t;
typedef enum {
    UNIFIED_ACTION_RESULT_NONE = 0, UNIFIED_ACTION_RESULT_ACCEPTED,
    UNIFIED_ACTION_RESULT_REJECTED, UNIFIED_ACTION_RESULT_COMPLETED,
    UNIFIED_ACTION_RESULT_FAILED, UNIFIED_ACTION_RESULT_TIMEOUT
} unified_action_result_t;
typedef struct {
    char correlation_id[UNIFIED_CORRELATION_ID_LEN];
    char device_id[UNIFIED_DEVICE_ID_LEN];
    uint32_t created_ms;
} unified_correlation_t;
typedef struct {
    unified_correlation_t correlation;
    unified_action_command_t command;
    uint32_t timeout_ms;
    uint16_t payload_type;
    uint16_t payload_version;
} unified_action_envelope_t;
typedef struct {
    unified_action_envelope_t action;
    unified_action_result_t result;
    unified_feature_reason_t feature_reason;
    int32_t result_code;
    char detail[UNIFIED_TEXT_MEDIUM_LEN];
} unified_action_response_t;
