#pragma once

#include <stddef.h>

#include "esp_err.h"

#ifndef CONFIG_UNIFIED_AUTOMATION_QUEUE_DEPTH
#define CONFIG_UNIFIED_AUTOMATION_QUEUE_DEPTH  8
#endif

#ifndef CONFIG_UNIFIED_AUTOMATION_TOPIC_LEN
#define CONFIG_UNIFIED_AUTOMATION_TOPIC_LEN  128
#endif

#ifndef CONFIG_UNIFIED_AUTOMATION_MESSAGE_LEN
#define CONFIG_UNIFIED_AUTOMATION_MESSAGE_LEN  2048
#endif

esp_err_t automation_bridge_init(void);
esp_err_t automation_bridge_submit_mqtt_command(const char *topic, size_t topic_len, const char *payload, size_t payload_len);
