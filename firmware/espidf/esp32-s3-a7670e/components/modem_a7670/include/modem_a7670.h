#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#include "common_models.h"
#include "payload_models.h"

typedef enum {
    MODEM_A7670_BACKEND_UART = 0,
} modem_a7670_backend_t;

typedef struct {
    bool use_ucs2_present;
    bool use_ucs2;
    uint16_t expected_parts;
    const char *pdu_hex;
    uint16_t pdu_length;
} modem_a7670_sms_send_options_t;

typedef struct {
    unified_service_runtime_t runtime;
    modem_a7670_backend_t backend;
    bool sim_ready;
    bool network_registered;
    bool telephony_enabled;
    bool data_mode_enabled;
    bool data_session_open;
    bool ip_bearer_ready;
    uint32_t timeout_count;
    uint32_t urc_count;
    int signal_quality;
    int32_t battery_voltage_mv;
    int32_t temperature_c;
    char operator_name[24];
    char network_type[24];
    char imei[UNIFIED_TEXT_SHORT_LEN];
    char subscriber_number[UNIFIED_TEXT_SHORT_LEN];
    char data_ip_address[UNIFIED_IPV4_ADDR_LEN];
    char last_response[UNIFIED_TEXT_MEDIUM_LEN];
} modem_a7670_status_t;

esp_err_t modem_a7670_init(void);
void modem_a7670_get_status(modem_a7670_status_t *out_status);
bool modem_a7670_telephony_supported(void);
esp_err_t modem_a7670_command(const char *command, char *response, size_t response_len, uint32_t timeout_ms);
esp_err_t modem_a7670_send_sms(
    const char *number,
    const char *text,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
);
esp_err_t modem_a7670_send_sms_with_options(
    const char *number,
    const char *text,
    char *response,
    size_t response_len,
    uint32_t timeout_ms,
    const modem_a7670_sms_send_options_t *options
);
esp_err_t modem_a7670_send_sms_multipart(
    const char *number,
    const char *text,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
);
esp_err_t modem_a7670_send_sms_multipart_with_options(
    const char *number,
    const char *text,
    char *response,
    size_t response_len,
    uint32_t timeout_ms,
    const modem_a7670_sms_send_options_t *options
);
esp_err_t modem_a7670_dial(
    const char *number,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
);
esp_err_t modem_a7670_hangup(char *response, size_t response_len, uint32_t timeout_ms);
esp_err_t modem_a7670_send_ussd(
    const char *code,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
);
esp_err_t modem_a7670_cancel_ussd(char *response, size_t response_len, uint32_t timeout_ms);
esp_err_t modem_a7670_open_data_session(char *response, size_t response_len, uint32_t timeout_ms);
esp_err_t modem_a7670_close_data_session(char *response, size_t response_len, uint32_t timeout_ms);
esp_err_t modem_a7670_reset_modem(char *response, size_t response_len, uint32_t timeout_ms);
esp_err_t modem_a7670_mqtt_connect(
    const char *host,
    uint16_t port,
    const char *client_id,
    const char *username,
    const char *password,
    const char *subscribe_topic,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
);
esp_err_t modem_a7670_mqtt_subscribe(
    const char *topic,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
);
esp_err_t modem_a7670_mqtt_disconnect(char *response, size_t response_len, uint32_t timeout_ms);
esp_err_t modem_a7670_mqtt_publish(
    const char *topic,
    const char *payload,
    int qos,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
);
bool modem_a7670_mqtt_is_connected(void);
bool modem_a7670_telephony_quiet_active(void);
void modem_a7670_mark_mqtt_desynced(void);
void modem_a7670_reset_mqtt_rx_state(void);
bool modem_a7670_pop_mqtt_message(char *topic, size_t topic_len, char *payload, size_t payload_len);
void modem_a7670_set_mqtt_event_listener(void (*listener)(void));
void modem_a7670_set_sms_event_listener(void (*listener)(void));
bool modem_a7670_pop_sms_index(int *out_index);
bool modem_a7670_pop_sms_delivery(unified_sms_delivery_payload_t *out_payload);
bool modem_a7670_pop_ussd_result(unified_ussd_payload_t *out_payload);
esp_err_t modem_a7670_acknowledge_new_message(uint32_t timeout_ms);
esp_err_t modem_a7670_consume_pending_sms(unified_sms_payload_t *out_payload, uint32_t timeout_ms);
esp_err_t modem_a7670_consume_sms_index(int storage_index, unified_sms_payload_t *out_payload, uint32_t timeout_ms);
esp_err_t modem_a7670_read_sms(int storage_index, unified_sms_payload_t *out_payload, uint32_t timeout_ms);
