#include "modem_a7670.h"
#include "modem_a7670_internal.h"
#include "modem_a7670_ppp_connect.h"

#include <stdio.h>
#include <stdatomic.h>
#include <string.h>

#include "driver/uart.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_netif_ppp.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "board_bsp.h"
#include "config_mgr.h"
#include "state_mgr.h"
#include "unified_runtime.h"

#if CONFIG_UNIFIED_MODEM_PPP_UART_TRIAL

#define MODEM_A7670_PPP_DIAL_COMMAND       "ATD*99***1#"
#define MODEM_A7670_PPP_RX_CHUNK           2048U
#define MODEM_A7670_PPP_WAIT_SLICE_MS      100U

static esp_netif_t *s_ppp_netif;
static uint8_t s_ppp_driver_handle;
static bool s_ppp_event_handlers_registered;
static atomic_bool s_ppp_reserved;
static atomic_bool s_ppp_starting;
static atomic_bool s_ppp_active;
static atomic_bool s_ppp_stopping;
/* A timed-out dial may already have switched the modem into binary mode.
 * Never release the lease based solely on the absence of a CONNECT response. */
static atomic_bool s_ppp_mode_uncertain;
static _Atomic(TaskHandle_t) s_ppp_owner;

static bool modem_a7670_ppp_owned_snapshot(void) {
    return __atomic_load_n(&s_ppp_reserved, __ATOMIC_ACQUIRE) ||
        __atomic_load_n(&s_ppp_starting, __ATOMIC_ACQUIRE) ||
        __atomic_load_n(&s_ppp_active, __ATOMIC_ACQUIRE) ||
        __atomic_load_n(&s_ppp_stopping, __ATOMIC_ACQUIRE) ||
        __atomic_load_n(&s_ppp_mode_uncertain, __ATOMIC_ACQUIRE);
}

bool modem_a7670_ppp_uart_owned(void) {
    return modem_a7670_ppp_owned_snapshot();
}

bool modem_a7670_ppp_at_allowed(void) {
    if (!modem_a7670_ppp_uart_owned()) return true;
    return s_ppp_owner == xTaskGetCurrentTaskHandle() && s_ppp_reserved &&
        !s_ppp_mode_uncertain && !s_ppp_starting && !s_ppp_active && !s_ppp_stopping;
}

static void modem_a7670_ppp_set_error_locked(const char *detail) {
    if (!detail) {
        detail = "ppp_error";
    }
    s_status.runtime.last_error = ESP_FAIL;
    snprintf(s_status.runtime.last_error_text, sizeof(s_status.runtime.last_error_text), "%s", detail);
    snprintf(s_status.last_response, sizeof(s_status.last_response), "%s", detail);
}

static esp_err_t modem_a7670_ppp_transmit(void *handle, void *buffer, size_t len) {
    int written;

    (void)handle;
    if (!buffer || len == 0U || !s_lock ||
        (!__atomic_load_n(&s_ppp_starting, __ATOMIC_ACQUIRE) &&
         !__atomic_load_n(&s_ppp_active, __ATOMIC_ACQUIRE))) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(250)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    if ((!s_ppp_starting && !s_ppp_active) || !s_uart_control_ready) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_STATE;
    }
    written = uart_write_bytes((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, buffer, len);
    xSemaphoreGive(s_lock);
    return written == (int)len ? ESP_OK : ESP_FAIL;
}

static void modem_a7670_ppp_ip_event_handler(
    void *arg,
    esp_event_base_t event_base,
    int32_t event_id,
    void *event_data
) {
    ip_event_got_ip_t *got_ip = (ip_event_got_ip_t *)event_data;
    char ip_text[UNIFIED_IPV4_ADDR_LEN] = {0};
    bool got_ip_address = event_base == IP_EVENT && event_id == IP_EVENT_PPP_GOT_IP && got_ip;

    (void)arg;
    if (got_ip_address) {
        (void)esp_ip4addr_ntoa(&got_ip->ip_info.ip, ip_text, sizeof(ip_text));
    }
    if (!s_lock || xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }

    if (got_ip_address) {
        s_status.ppp_ip_assigned = ip_text[0] != '\0';
        snprintf(s_status.ppp_ip_address, sizeof(s_status.ppp_ip_address), "%s", ip_text);
        s_status.data_mode_enabled = true;
        s_status.data_session_open = s_status.ppp_ip_assigned;
        s_status.ip_bearer_ready = s_status.ppp_ip_assigned;
        snprintf(s_status.data_ip_address, sizeof(s_status.data_ip_address), "%s", ip_text);
        snprintf(s_status.pdp_ip_address, sizeof(s_status.pdp_ip_address), "%s", ip_text);
        s_status.runtime.last_error = ESP_OK;
        s_status.runtime.last_error_text[0] = '\0';
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_PPP_LOST_IP) {
        s_status.ppp_ip_assigned = false;
        s_status.ppp_ip_address[0] = '\0';
        s_status.data_session_open = false;
        s_status.ip_bearer_ready = false;
        s_status.data_ip_address[0] = '\0';
        modem_a7670_ppp_set_error_locked("ppp_ip_lost");
    }
    modem_a7670_publish_status_locked();
    xSemaphoreGive(s_lock);
}

static void modem_a7670_ppp_status_event_handler(
    void *arg,
    esp_event_base_t event_base,
    int32_t event_id,
    void *event_data
) {
    (void)arg;
    (void)event_data;
    if (event_base != NETIF_PPP_STATUS || !s_lock ||
        xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }
    if (event_id == NETIF_PPP_CONNECT_FAILED || event_id == NETIF_PPP_ERRORCONNECT ||
        event_id == NETIF_PPP_ERRORPEERDEAD || event_id == NETIF_PPP_ERRORPROTOCOL) {
        s_status.ppp_ip_assigned = false;
        s_status.ppp_ip_address[0] = '\0';
        modem_a7670_ppp_set_error_locked("ppp_connect_failed");
        modem_a7670_publish_status_locked();
    }
    xSemaphoreGive(s_lock);
}

static esp_err_t modem_a7670_ppp_ensure_netif(void) {
    esp_netif_config_t netif_config = ESP_NETIF_DEFAULT_PPP();
    esp_netif_driver_ifconfig_t driver_config = {
        .handle = &s_ppp_driver_handle,
        .transmit = modem_a7670_ppp_transmit,
    };
    esp_netif_ppp_config_t ppp_config = {
        .ppp_phase_event_enabled = true,
        .ppp_error_event_enabled = true,
    };
    esp_err_t err;

    if (s_ppp_netif) {
        return ESP_OK;
    }
    s_ppp_netif = esp_netif_new(&netif_config);
    if (!s_ppp_netif) {
        return ESP_ERR_NO_MEM;
    }
    err = esp_netif_set_driver_config(s_ppp_netif, &driver_config);
    if (err != ESP_OK) {
        esp_netif_destroy(s_ppp_netif);
        s_ppp_netif = NULL;
        return err;
    }
    err = esp_netif_ppp_set_params(s_ppp_netif, &ppp_config);
    if (err != ESP_OK) {
        esp_netif_destroy(s_ppp_netif);
        s_ppp_netif = NULL;
        return err;
    }
    if (!s_ppp_event_handlers_registered) {
        err = esp_event_handler_register(IP_EVENT, IP_EVENT_PPP_GOT_IP, modem_a7670_ppp_ip_event_handler, NULL);
        if (err == ESP_OK) {
            err = esp_event_handler_register(IP_EVENT, IP_EVENT_PPP_LOST_IP, modem_a7670_ppp_ip_event_handler, NULL);
        }
        if (err == ESP_OK) {
            err = esp_event_handler_register(NETIF_PPP_STATUS, ESP_EVENT_ANY_ID, modem_a7670_ppp_status_event_handler, NULL);
        }
        if (err != ESP_OK) {
            esp_netif_destroy(s_ppp_netif);
            s_ppp_netif = NULL;
            return err;
        }
        s_ppp_event_handlers_registered = true;
    }
    return ESP_OK;
}

static esp_err_t modem_a7670_ppp_wait_for_connect_locked(char *response, size_t response_len, uint32_t timeout_ms) {
    uint8_t byte;
    modem_a7670_ppp_connect_parser_t parser;
    int64_t deadline = esp_timer_get_time() + ((int64_t)timeout_ms * 1000LL);

    modem_a7670_ppp_connect_parser_init(&parser);
    if (response && response_len > 0U) response[0] = '\0';
    while (esp_timer_get_time() < deadline) {
        /* Stop at the terminating LF. Any immediately following binary PPP
         * bytes remain in the UART ring for the data-mode owner, including NUL.
         * Diagnostic-buffer size must never determine protocol parsing. */
        int bytes = uart_read_bytes(
            (uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT,
            &byte, 1U, pdMS_TO_TICKS(20)
        );
        size_t consumed = 0U;
        if (bytes <= 0) continue;
        modem_a7670_ppp_connect_result_t result =
            modem_a7670_ppp_connect_parser_feed(&parser, &byte, 1U, &consumed);
        if (result == MODEM_A7670_PPP_CONNECT_CONNECTED) {
            snprintf(response, response_len, "%s", "CONNECT");
            return ESP_OK;
        }
        if (result == MODEM_A7670_PPP_CONNECT_REJECTED) {
            snprintf(response, response_len, "%s", "ppp_dial_rejected");
            return ESP_FAIL;
        }
    }
    return ESP_ERR_TIMEOUT;
}

esp_err_t modem_a7670_ppp_reserve(void) {
    if (!s_ready || !s_lock || !s_uart_control_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(1000)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    if (modem_a7670_ppp_uart_owned()) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_STATE;
    }
    s_ppp_owner = xTaskGetCurrentTaskHandle();
    s_ppp_reserved = true;
    s_status.ppp_reserved = true;
    modem_a7670_publish_status_locked();
    xSemaphoreGive(s_lock);
    return ESP_OK;
}

void modem_a7670_ppp_release(void) {
    if (!s_lock || xSemaphoreTake(s_lock, pdMS_TO_TICKS(1000)) != pdTRUE) {
        return;
    }
    if (s_ppp_owner == xTaskGetCurrentTaskHandle() && !s_ppp_mode_uncertain &&
        !s_ppp_active && !s_ppp_starting && !s_ppp_stopping) {
        s_ppp_owner = NULL;
        s_ppp_reserved = false;
        s_status.ppp_reserved = false;
        modem_a7670_publish_status_locked();
    }
    xSemaphoreGive(s_lock);
}

esp_err_t modem_a7670_ppp_start(char *response, size_t response_len, uint32_t timeout_ms) {
    char command[128] = {0};
    char apn[CONFIG_MGR_APN_LEN] = {0};
    uint32_t wait_ms = timeout_ms > 5000U ? timeout_ms - 5000U : timeout_ms;
    esp_err_t err;
    uint32_t deadline_ms;

    if (!response || response_len == 0U || timeout_ms == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_lock || !s_uart_control_ready || !s_ppp_reserved) {
        snprintf(response, response_len, "%s", "ppp_not_reserved");
        return ESP_ERR_INVALID_STATE;
    }
    err = modem_a7670_ppp_ensure_netif();
    if (err != ESP_OK) {
        snprintf(response, response_len, "%s", "ppp_netif_init_failed");
        return err;
    }
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    if (!modem_a7670_ppp_at_allowed() || s_mqtt_connected) {
        xSemaphoreGive(s_lock);
        snprintf(response, response_len, "%s", "ppp_mqtt_still_connected");
        return ESP_ERR_INVALID_STATE;
    }
    (void)modem_a7670_send_command_locked("AT+NETCLOSE", response, response_len, timeout_ms, false);
    (void)modem_a7670_send_command_locked("AT+CGATT=1", response, response_len, timeout_ms, false);
    config_mgr_get_modem_apn(apn, sizeof(apn));
    if (apn[0] != '\0') {
        snprintf(command, sizeof(command), "AT+CGDCONT=1,\"IP\",\"%s\"", apn);
    } else {
        snprintf(command, sizeof(command), "AT+CGDCONT=1,\"IP\"");
    }
    err = modem_a7670_send_command_locked(command, response, response_len, timeout_ms, false);
    if (err == ESP_OK) {
        s_ppp_mode_uncertain = true;
        if (uart_write_bytes((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, MODEM_A7670_PPP_DIAL_COMMAND, strlen(MODEM_A7670_PPP_DIAL_COMMAND)) < 0 ||
            uart_write_bytes((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, "\r\n", 2) < 0) {
            err = ESP_FAIL;
        }
    }
    if (err == ESP_OK) {
        err = modem_a7670_ppp_wait_for_connect_locked(response, response_len, wait_ms);
    }
    if (err != ESP_OK) {
        modem_a7670_ppp_set_error_locked("ppp_dial_failed");
        modem_a7670_publish_status_locked();
        xSemaphoreGive(s_lock);
        return err;
    }
    s_ppp_starting = true;
    s_status.ppp_reserved = true;
    s_status.ppp_active = false;
    s_status.ppp_ip_assigned = false;
    s_status.ppp_ip_address[0] = '\0';
    s_status.data_mode_enabled = true;
    (void)state_mgr_set_modem_runtime(s_status.telephony_enabled, true);
    modem_a7670_publish_status_locked();
    xSemaphoreGive(s_lock);

    esp_netif_action_start(s_ppp_netif, NULL, 0, NULL);
    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(1000)) == pdTRUE) {
        s_ppp_starting = false;
        s_ppp_active = true;
        s_status.ppp_active = true;
        modem_a7670_publish_status_locked();
        xSemaphoreGive(s_lock);
    }

    deadline_ms = unified_tick_now_ms() + timeout_ms;
    while ((int32_t)(unified_tick_now_ms() - deadline_ms) < 0) {
        if (modem_a7670_ppp_has_ip()) {
            snprintf(response, response_len, "%s", "ppp_connected");
            return ESP_OK;
        }
        vTaskDelay(pdMS_TO_TICKS(MODEM_A7670_PPP_WAIT_SLICE_MS));
    }
    snprintf(response, response_len, "%s", "ppp_ip_timeout");
    return ESP_ERR_TIMEOUT;
}

esp_err_t modem_a7670_ppp_stop(char *response, size_t response_len, uint32_t timeout_ms) {
    (void)timeout_ms;
    if (!response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_ppp_owner != xTaskGetCurrentTaskHandle()) {
        snprintf(response, response_len, "%s", "ppp_wrong_owner");
        return ESP_ERR_INVALID_STATE;
    }
    /* Fail closed until terminal-proven shutdown can quiesce PPP TX/RX,
     * observe lwIP termination, escape/hang up and confirm command mode.
     * The former draft ignored failed AT recovery and released a binary UART. */
    if (s_ppp_mode_uncertain || s_ppp_active || s_ppp_starting || s_ppp_stopping) {
        snprintf(response, response_len, "%s", "ppp_recovery_not_validated");
        return ESP_ERR_NOT_SUPPORTED;
    }
    modem_a7670_ppp_release();
    if (modem_a7670_ppp_uart_owned()) {
        snprintf(response, response_len, "%s", "ppp_release_failed");
        return ESP_ERR_TIMEOUT;
    }
    snprintf(response, response_len, "%s", "ppp_not_active");
    return ESP_OK;
}

bool modem_a7670_ppp_has_ip(void) {
    bool has_ip = false;
    if (!s_lock || xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return false;
    }
    has_ip = s_status.ppp_active && s_status.ppp_ip_assigned && s_status.ppp_ip_address[0] != '\0';
    xSemaphoreGive(s_lock);
    return has_ip;
}

void modem_a7670_ppp_process_uart_event(const uart_event_t *event) {
    uint8_t buffer[MODEM_A7670_PPP_RX_CHUNK];
    size_t available = 0U;
    int bytes;

    if (!event || !s_ppp_netif || !s_lock ||
        xSemaphoreTake(s_lock, pdMS_TO_TICKS(20)) != pdTRUE) {
        return;
    }
    if (!s_ppp_active) {
        xSemaphoreGive(s_lock);
        return;
    }
    if (event->type == UART_FIFO_OVF || event->type == UART_BUFFER_FULL) {
        uart_flush_input((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT);
        if (s_uart_event_queue) {
            xQueueReset(s_uart_event_queue);
        }
        modem_a7670_ppp_set_error_locked("ppp_uart_overflow");
        modem_a7670_publish_status_locked();
        xSemaphoreGive(s_lock);
        return;
    }
    if (event->type != UART_DATA && event->type != UART_PATTERN_DET) {
        xSemaphoreGive(s_lock);
        return;
    }
    if (uart_get_buffered_data_len((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, &available) != ESP_OK) {
        xSemaphoreGive(s_lock);
        return;
    }
    bytes = 0;
    if (available > 0U) {
        size_t request = available > sizeof(buffer) ? sizeof(buffer) : available;
        bytes = uart_read_bytes((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, buffer, request, pdMS_TO_TICKS(20));
    }
    xSemaphoreGive(s_lock);
    /* A single bounded chunk per service pass; never hold the AT/UART mutex
     * while enqueueing into lwIP, whose TX callback takes that same mutex. */
    if (bytes > 0 && esp_netif_receive(s_ppp_netif, buffer, (size_t)bytes, NULL) != ESP_OK &&
        xSemaphoreTake(s_lock, pdMS_TO_TICKS(20)) == pdTRUE) {
        modem_a7670_ppp_set_error_locked("ppp_rx_enqueue_failed");
        modem_a7670_publish_status_locked();
        xSemaphoreGive(s_lock);
    }
}

void modem_a7670_ppp_note_modem_reset_locked(void) {
    /* A reset request is not proof that lwIP has stopped or that AT control
     * recovered. Retain the lease if a data-mode transition ever began. */
    if (s_ppp_mode_uncertain || s_ppp_active || s_ppp_starting || s_ppp_stopping) {
        s_ppp_mode_uncertain = true;
        s_status.ppp_ip_assigned = false;
        s_status.ppp_ip_address[0] = '\0';
        return;
    }
    s_ppp_owner = NULL;
    s_ppp_reserved = false;
    s_ppp_starting = false;
    s_ppp_active = false;
    s_ppp_stopping = false;
    s_status.ppp_reserved = false;
    s_status.ppp_active = false;
    s_status.ppp_ip_assigned = false;
    s_status.ppp_ip_address[0] = '\0';
}

#else

bool modem_a7670_ppp_uart_owned(void) { return false; }
bool modem_a7670_ppp_at_allowed(void) { return true; }
void modem_a7670_ppp_process_uart_event(const uart_event_t *event) { (void)event; }
void modem_a7670_ppp_note_modem_reset_locked(void) {}
esp_err_t modem_a7670_ppp_reserve(void) { return ESP_ERR_NOT_SUPPORTED; }
void modem_a7670_ppp_release(void) {}
esp_err_t modem_a7670_ppp_start(char *response, size_t response_len, uint32_t timeout_ms) {
    (void)timeout_ms;
    if (response && response_len > 0U) snprintf(response, response_len, "%s", "ppp_disabled");
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t modem_a7670_ppp_stop(char *response, size_t response_len, uint32_t timeout_ms) {
    (void)timeout_ms;
    if (response && response_len > 0U) snprintf(response, response_len, "%s", "ppp_disabled");
    return ESP_ERR_NOT_SUPPORTED;
}
bool modem_a7670_ppp_has_ip(void) { return false; }

#endif
