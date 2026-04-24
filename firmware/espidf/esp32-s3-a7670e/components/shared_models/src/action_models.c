#include "action_models.h"

const char *unified_action_result_name(unified_action_result_t result) {
    switch (result) {
        case UNIFIED_ACTION_RESULT_ACCEPTED: return "accepted";
        case UNIFIED_ACTION_RESULT_REJECTED: return "rejected";
        case UNIFIED_ACTION_RESULT_COMPLETED: return "completed";
        case UNIFIED_ACTION_RESULT_FAILED: return "failed";
        case UNIFIED_ACTION_RESULT_TIMEOUT: return "timeout";
        case UNIFIED_ACTION_RESULT_NONE:
        default:
            return "none";
    }
}

const char *unified_action_command_name(unified_action_command_t command) {
    switch (command) {
        case UNIFIED_ACTION_CMD_GET_STATUS: return "get_status";
        case UNIFIED_ACTION_CMD_CONFIG_SET: return "config_set";
        case UNIFIED_ACTION_CMD_WIFI_RECONNECT: return "wifi_reconnect";
        case UNIFIED_ACTION_CMD_WIFI_TOGGLE: return "wifi_toggle";
        case UNIFIED_ACTION_CMD_SEND_SMS: return "send_sms";
        case UNIFIED_ACTION_CMD_SEND_SMS_MULTIPART: return "send_sms_multipart";
        case UNIFIED_ACTION_CMD_SEND_USSD: return "send_ussd";
        case UNIFIED_ACTION_CMD_CANCEL_USSD: return "cancel_ussd";
        case UNIFIED_ACTION_CMD_DIAL_NUMBER: return "dial_number";
        case UNIFIED_ACTION_CMD_HANGUP_CALL: return "hangup_call";
        case UNIFIED_ACTION_CMD_GPIO_WRITE: return "gpio_write";
        case UNIFIED_ACTION_CMD_GPIO_PULSE: return "gpio_pulse";
        case UNIFIED_ACTION_CMD_SENSOR_READ: return "sensor_read";
        case UNIFIED_ACTION_CMD_FILE_LIST: return "file_list";
        case UNIFIED_ACTION_CMD_FILE_READ_META: return "file_read_meta";
        case UNIFIED_ACTION_CMD_FILE_DELETE: return "file_delete";
        case UNIFIED_ACTION_CMD_FILE_EXPORT: return "file_export";
        case UNIFIED_ACTION_CMD_REBOOT_DEVICE: return "reboot_device";
        case UNIFIED_ACTION_CMD_START_CAMERA: return "start_camera";
        case UNIFIED_ACTION_CMD_STOP_CAMERA: return "stop_camera";
        case UNIFIED_ACTION_CMD_TAKE_SNAPSHOT: return "take_snapshot";
        case UNIFIED_ACTION_CMD_START_STREAM: return "start_stream";
        case UNIFIED_ACTION_CMD_STOP_STREAM: return "stop_stream";
        case UNIFIED_ACTION_CMD_CARD_SCAN_START: return "card_scan_start";
        case UNIFIED_ACTION_CMD_CARD_SCAN_STOP: return "card_scan_stop";
        case UNIFIED_ACTION_CMD_CARD_READ: return "card_read";
        case UNIFIED_ACTION_CMD_CARD_WRITE: return "card_write";
        case UNIFIED_ACTION_CMD_WIFI_DISCONNECT: return "wifi_disconnect";
        case UNIFIED_ACTION_CMD_WIFI_SCAN: return "wifi_scan";
        case UNIFIED_ACTION_CMD_MOBILE_TOGGLE: return "mobile_toggle";
        case UNIFIED_ACTION_CMD_MOBILE_APN: return "mobile_apn";
        case UNIFIED_ACTION_CMD_ROUTING_CONFIGURE: return "routing_configure";
        case UNIFIED_ACTION_CMD_STATUS_WATCH: return "status_watch";
        case UNIFIED_ACTION_CMD_GET_SMS_HISTORY: return "get_sms_history";
        case UNIFIED_ACTION_CMD_OTA_UPDATE: return "ota_update";
        case UNIFIED_ACTION_CMD_NONE:
        default:
            return "none";
    }
}
