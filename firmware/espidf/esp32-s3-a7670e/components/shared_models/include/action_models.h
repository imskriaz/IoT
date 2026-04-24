#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "common_models.h"

typedef enum {
    UNIFIED_ACTION_CMD_NONE = 0,
    UNIFIED_ACTION_CMD_GET_STATUS,
    UNIFIED_ACTION_CMD_CONFIG_SET,
    UNIFIED_ACTION_CMD_WIFI_RECONNECT,
    UNIFIED_ACTION_CMD_WIFI_TOGGLE,
    UNIFIED_ACTION_CMD_SEND_SMS,
    UNIFIED_ACTION_CMD_SEND_SMS_MULTIPART,
    UNIFIED_ACTION_CMD_SEND_USSD,
    UNIFIED_ACTION_CMD_CANCEL_USSD,
    UNIFIED_ACTION_CMD_DIAL_NUMBER,
    UNIFIED_ACTION_CMD_HANGUP_CALL,
    UNIFIED_ACTION_CMD_GPIO_WRITE,
    UNIFIED_ACTION_CMD_GPIO_PULSE,
    UNIFIED_ACTION_CMD_SENSOR_READ,
    UNIFIED_ACTION_CMD_FILE_LIST,
    UNIFIED_ACTION_CMD_FILE_READ_META,
    UNIFIED_ACTION_CMD_FILE_DELETE,
    UNIFIED_ACTION_CMD_FILE_EXPORT,
    UNIFIED_ACTION_CMD_REBOOT_DEVICE,
    UNIFIED_ACTION_CMD_START_CAMERA,
    UNIFIED_ACTION_CMD_STOP_CAMERA,
    UNIFIED_ACTION_CMD_TAKE_SNAPSHOT,
    UNIFIED_ACTION_CMD_START_STREAM,
    UNIFIED_ACTION_CMD_STOP_STREAM,
    UNIFIED_ACTION_CMD_CARD_SCAN_START,
    UNIFIED_ACTION_CMD_CARD_SCAN_STOP,
    UNIFIED_ACTION_CMD_CARD_READ,
    UNIFIED_ACTION_CMD_CARD_WRITE,
    UNIFIED_ACTION_CMD_WIFI_DISCONNECT,
    UNIFIED_ACTION_CMD_WIFI_SCAN,
    UNIFIED_ACTION_CMD_MOBILE_TOGGLE,
    UNIFIED_ACTION_CMD_MOBILE_APN,
    UNIFIED_ACTION_CMD_ROUTING_CONFIGURE,
    UNIFIED_ACTION_CMD_STATUS_WATCH,
    UNIFIED_ACTION_CMD_GET_SMS_HISTORY,
    UNIFIED_ACTION_CMD_OTA_UPDATE,
} unified_action_command_t;

typedef enum {
    UNIFIED_ACTION_RESULT_NONE = 0,
    UNIFIED_ACTION_RESULT_ACCEPTED,
    UNIFIED_ACTION_RESULT_REJECTED,
    UNIFIED_ACTION_RESULT_COMPLETED,
    UNIFIED_ACTION_RESULT_FAILED,
    UNIFIED_ACTION_RESULT_TIMEOUT,
} unified_action_result_t;

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

const char *unified_action_result_name(unified_action_result_t result);
const char *unified_action_command_name(unified_action_command_t command);
