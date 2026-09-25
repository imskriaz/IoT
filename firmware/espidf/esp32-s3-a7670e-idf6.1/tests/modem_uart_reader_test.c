#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "esp_err.h"
#include "../components/modem_a7670/src/modem_mqtt_result.h"
#define CONFIG_UNIFIED_MODEM_UART_PORT 1
#define pdMS_TO_TICKS(x) (x)
typedef int uart_port_t;
static char input[400], parsed[400];
static size_t input_length, input_offset, parsed_length;
static int64_t clock_us;
static bool uart_blocked;
static unsigned uart_writes;
static bool modem_a7670_uart_control_blocked_locked(void) { return uart_blocked; }
static int uart_write_bytes(int port, const void *buffer, size_t length) {
    (void)port; (void)buffer; ++uart_writes; return (int)length;
}
static int64_t esp_timer_get_time(void) { clock_us += 1000; return clock_us; }
static int uart_read_bytes(int port, void *buffer, size_t length, int ticks) {
    size_t remaining = input_length - input_offset;
    size_t count = remaining < length ? remaining : length;
    (void)port; (void)ticks;
    memcpy(buffer, input + input_offset, count);
    input_offset += count;
    return (int)count;
}
static void modem_a7670_parse_response_locked(const char *chunk, size_t count) {
    assert(parsed_length + count < sizeof(parsed));
    memcpy(parsed + parsed_length, chunk, count);
    parsed_length += count;
    parsed[parsed_length] = 0;
}
static bool modem_a7670_response_has_success(const char *s) { return strstr(s, "\r\nOK\r\n") != NULL; }
static bool modem_a7670_response_has_error(const char *s) { return strstr(s, "ERROR") != NULL; }
static bool modem_a7670_response_has_prompt(const char *s) { return strchr(s, '>') != NULL; }
static esp_err_t modem_a7670_read_until_quiet_bounded_locked(char *, size_t, uint32_t, uint32_t);
#include "uart_functions.inc"
static void reset(size_t bytes) {
    memset(input, 'x', bytes); input[bytes] = 0;
    input_length = bytes;
    memset(parsed, 0, sizeof(parsed));
    input_offset = parsed_length = 0; clock_us = 0;
    uart_blocked = false; uart_writes = 0;
}
int main(void) {
    char small[48], stale[160], normal[400];
    reset(232);
    assert(modem_a7670_read_until_quiet_locked(stale, sizeof(stale), 50) == ESP_ERR_INVALID_SIZE);
    assert(input_offset == 232 && parsed_length == 232);
    assert(strcmp(input, parsed) == 0 && strlen(stale) == 159);
    reset(232);
    assert(modem_a7670_read_response_locked(small, sizeof(small), 500, false) == ESP_ERR_INVALID_SIZE);
    assert(input_offset == 95 && parsed_length == 95);
    assert(modem_a7670_read_until_quiet_locked(stale, sizeof(stale), 50) == ESP_OK);
    assert(parsed_length == 232 && strcmp(input, parsed) == 0);
    reset(232);
    assert(modem_a7670_read_response_until_phrase_locked(small, sizeof(small), 500, "DONE") == ESP_ERR_INVALID_SIZE);
    assert(parsed_length == 95);
    assert(modem_a7670_read_until_quiet_locked(stale, sizeof(stale), 50) == ESP_OK);
    assert(strcmp(input, parsed) == 0);
    reset(6); strcpy(input, "\r\nOK\r\n");
    assert(modem_a7670_read_response_locked(normal, sizeof(normal), 500, false) == ESP_OK);
    assert(strcmp(input, parsed) == 0);
    reset(1); strcpy(input, ">");
    assert(modem_a7670_read_response_locked(normal, sizeof(normal), 500, true) == ESP_OK);
    reset(6); strcpy(input, "DONE\r\n");
    assert(modem_a7670_read_response_until_phrase_locked(normal, sizeof(normal), 500, "DONE") == ESP_OK);
    /* Raw NUL at the first byte, inside a read, and either side of the
     * production 95-byte UART read boundary must not truncate parser input. */
    for (size_t nul = 0; nul < 232; ++nul) {
        reset(232); input[nul] = 0;
        (void)modem_a7670_read_until_quiet_locked(stale, sizeof(stale), 50);
        assert(input_offset == input_length && parsed_length == input_length);
        assert(memcmp(input, parsed, input_length) == 0);
        reset(232); input[nul] = 0;
        (void)modem_a7670_read_response_locked(small, sizeof(small), 500, false);
        (void)modem_a7670_read_until_quiet_locked(stale, sizeof(stale), 50);
        assert(input_offset == input_length && parsed_length == input_length);
        assert(memcmp(input, parsed, input_length) == 0);
        reset(232); input[nul] = 0;
        (void)modem_a7670_read_response_until_phrase_locked(small, sizeof(small), 500, "DONE");
        (void)modem_a7670_read_until_quiet_locked(stale, sizeof(stale), 50);
        assert(input_offset == input_length && parsed_length == input_length);
        assert(memcmp(input, parsed, input_length) == 0);
    }
    /* Ownership changed after a public preflight but before taking s_lock:
     * every production I/O boundary must reject without touching the UART. */
    reset(40); uart_blocked = true;
    assert(modem_a7670_read_until_quiet_locked(normal, sizeof(normal), 50) == ESP_ERR_INVALID_STATE);
    assert(modem_a7670_read_response_locked(normal, sizeof(normal), 500, false) == ESP_ERR_INVALID_STATE);
    assert(modem_a7670_read_response_until_phrase_locked(normal, sizeof(normal), 500, "DONE") == ESP_ERR_INVALID_STATE);
    int result_code = -1;
    assert(modem_a7670_wait_mqtt_result_locked(normal, sizeof(normal), 500, "+CMQTTSUB:", &result_code) == ESP_ERR_INVALID_STATE);
    assert(modem_a7670_send_command_locked("AT", normal, sizeof(normal), 500, false) == ESP_ERR_INVALID_STATE);
    assert(input_offset == 0 && parsed_length == 0 && uart_writes == 0);
    assert(normal[0] == '\0');
    reset(0);
    assert(modem_a7670_send_command_locked("AT", normal, sizeof(normal), 20, false) == ESP_ERR_TIMEOUT);
    assert(uart_writes == 2);
    puts("MODEM_UART_READER_PASS: clipped responses preserve every consumed byte exactly once");
    return 0;
}
