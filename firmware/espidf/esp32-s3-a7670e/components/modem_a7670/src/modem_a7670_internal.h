#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "driver/uart.h"
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "modem_a7670.h"

extern const char *TAG;

extern SemaphoreHandle_t s_lock;
extern modem_a7670_status_t s_status;
extern QueueHandle_t s_uart_event_queue;
extern bool s_ready;
extern bool s_uart_control_ready;
extern bool s_at_echo_disabled;
extern char s_last_ussd_code[UNIFIED_TEXT_SHORT_LEN];

esp_err_t modem_a7670_send_command_locked(
    const char *command,
    char *response,
    size_t response_len,
    uint32_t timeout_ms,
    bool wait_for_prompt
);
esp_err_t modem_a7670_read_until_quiet_locked(char *response, size_t response_len, uint32_t quiet_ms);
esp_err_t modem_a7670_read_response_locked(
    char *response,
    size_t response_len,
    uint32_t timeout_ms,
    bool wait_for_prompt
);
esp_err_t modem_a7670_prepare_command(char *buffer, size_t buffer_len, const char *prefix, const char *value, const char *suffix);
void modem_a7670_publish_status_locked(void);
bool modem_a7670_uart_control_blocked_locked(void);
void modem_a7670_mark_mqtt_desynced(void);
void modem_a7670_clear_ussd_request_locked(void);
void modem_a7670_arm_ussd_request_locked(uint32_t timeout_ms);
void modem_a7670_sms_invalidate_runtime_state_locked(void);
void modem_a7670_drop_sms_indexes_locked(const int *indexes, size_t count);
