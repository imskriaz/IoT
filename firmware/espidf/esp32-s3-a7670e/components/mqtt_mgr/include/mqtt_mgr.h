#pragma once

#include "esp_err.h"

#include "action_models.h"
#include "common_models.h"
#include "config_mgr.h"
#include "payload_models.h"

typedef struct {
    unified_service_runtime_t runtime;
    bool configured;
    bool connected;
    bool subscribed;
    uint32_t reconnect_count;
    uint32_t published_count;
    uint32_t publish_failures;
    uint32_t subscribed_count;
    uint32_t command_messages;
    uint32_t command_rejects;
    uint32_t action_results_published;
    uint32_t action_result_failures;
    char broker[CONFIG_MGR_MQTT_URI_LEN];
} mqtt_mgr_status_t;

typedef void (*mqtt_mgr_status_listener_t)(void);

esp_err_t mqtt_mgr_init(void);
esp_err_t mqtt_mgr_publish_json(const char *suffix, const char *json);
esp_err_t mqtt_mgr_publish_sms_incoming(const unified_sms_payload_t *payload);
esp_err_t mqtt_mgr_publish_sms_delivery(const unified_sms_delivery_payload_t *payload);
esp_err_t mqtt_mgr_publish_call_event(const unified_call_payload_t *payload);
esp_err_t mqtt_mgr_publish_ussd_result(const unified_ussd_payload_t *payload);
esp_err_t mqtt_mgr_publish_action_result(const unified_action_response_t *response, const char *payload_json);
void mqtt_mgr_get_status(mqtt_mgr_status_t *out_status);
void mqtt_mgr_set_status_listener(mqtt_mgr_status_listener_t listener);
