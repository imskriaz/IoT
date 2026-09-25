/* Compile the actual TLS setup helpers with a deterministic serialized AT peer. */
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdarg.h>
#include "../components/modem_a7670/src/modem_mqtt_result.h"
#include "modem_tls_config.inc"

typedef int esp_err_t;
enum { ESP_OK, ESP_FAIL, ESP_ERR_INVALID_STATE, ESP_ERR_NOT_FOUND,
       ESP_ERR_INVALID_SIZE, ESP_ERR_TIMEOUT, ESP_ERR_INVALID_ARG };
/* Use the exact production member declaration without importing ESP-IDF. */
#define s_runtime_scratch scratch_ptr
/* Named typedef keeps the harness compatible with both MSVC and standard C. */
typedef struct { TLS_CERTIFICATE_MEMBER } tls_scratch_t;
static tls_scratch_t storage;
static tls_scratch_t *scratch_ptr = &storage;

typedef struct { const char *command; const char *reply; esp_err_t error; } step_t;
static step_t steps[16];
static size_t step_count, step_index;

static void add(const char *command, const char *reply, esp_err_t error) {
    assert(step_count < sizeof(steps) / sizeof(steps[0]));
    steps[step_count++] = (step_t){command, reply, error};
}

static esp_err_t exchange(const char *command, char *response, size_t length) {
    step_t *step;
    assert(step_index < step_count);
    step = &steps[step_index++];
    assert(strcmp(command, step->command) == 0);
    assert(length > 0);
    snprintf(response, length, "%s", step->reply);
    if (step->error != ESP_OK) return step->error;
    return strlen(step->reply) >= length ? ESP_ERR_INVALID_SIZE : ESP_OK;
}

static esp_err_t modem_a7670_send_command_locked(const char *command, char *response,
        size_t length, uint32_t timeout_ms, bool unused) {
    assert(timeout_ms == 45000U);
    assert(!unused);
    return exchange(command, response, length);
}

static esp_err_t modem_a7670_read_response_until_phrase_locked(char *response,
        size_t length, uint32_t timeout_ms, const char *phrase) {
    assert(timeout_ms == 45000U);
    assert(strcmp(phrase, "+CNTP: 0") == 0);
    return exchange("WAIT_CNTP", response, length);
}

static bool modem_a7670_response_has_phrase(const char *response, const char *phrase) {
    return response && phrase && strstr(response, phrase) != NULL;
}

static esp_err_t modem_a7670_format_command(char *out, size_t length, const char *format, ...) {
    va_list args;
    int written;
    va_start(args, format);
    written = vsnprintf(out, length, format, args);
    va_end(args);
    return written < 0 || (size_t)written >= length ? ESP_ERR_INVALID_SIZE : ESP_OK;
}

#include "modem_tls_functions.inc"

typedef int uart_port_t;
#define CONFIG_UNIFIED_MODEM_UART_PORT 1
#define pdMS_TO_TICKS(ms) (ms)
typedef struct { const char *data; size_t length; } uart_chunk_t;
static uart_chunk_t uart_chunks[12];
static size_t uart_chunk_count, uart_chunk_index, parsed_chunk_count;
static int64_t fake_clock_us;
static bool uart_blocked;

static void reset_uart(void) {
    uart_chunk_count = uart_chunk_index = parsed_chunk_count = 0U;
    fake_clock_us = 0;
    uart_blocked = false;
}

static void add_uart_chunk(const char *data, size_t length) {
    assert(uart_chunk_count < sizeof(uart_chunks) / sizeof(uart_chunks[0]));
    uart_chunks[uart_chunk_count++] = (uart_chunk_t){ data, length };
}

static int64_t esp_timer_get_time(void) { return fake_clock_us; }
static bool modem_a7670_uart_control_blocked_locked(void) { return uart_blocked; }
static void modem_a7670_parse_response_locked(const char *data, size_t length) {
    assert(data != NULL && length > 0U);
    parsed_chunk_count++;
}
static bool modem_a7670_response_has_error(const char *response) {
    return response && strstr(response, "\r\nERROR\r\n") != NULL;
}
static int uart_read_bytes(uart_port_t port, char *buffer, size_t capacity, uint32_t ticks) {
    uart_chunk_t chunk;
    assert(port == CONFIG_UNIFIED_MODEM_UART_PORT && ticks == 100U);
    if (uart_chunk_index >= uart_chunk_count) {
        fake_clock_us += 100000;
        return 0;
    }
    chunk = uart_chunks[uart_chunk_index++];
    assert(chunk.length <= capacity);
    memcpy(buffer, chunk.data, chunk.length);
    fake_clock_us += 1000;
    return (int)chunk.length;
}

#include "modem_mqtt_result_wait_production.inc"

static bool suback(const char *response) {
    modem_mqtt_result_t result = modem_mqtt_result_parse(response, response ? strlen(response) + 1U : 0U, "+CMQTTSUB:");
    return result.state == MODEM_MQTT_RESULT_COMPLETE && result.code == 0;
}

#define CERT_LIST "+CCERTLIST: \"old-ca-certificate-before-active.pem\"\r\n" \
    "+CCERTLIST: \"" MODEM_A7670_MQTT_TLS_CA_CERT_NAME "\"\r\nOK\r\n"
#define CLOCK_VALID "+CCLK: \"26/09/21,17:10:00+00\"\r\nOK\r\n"
#define CLOCK_1970 "+CCLK: \"70/01/01,00:00:00+00\"\r\nOK\r\n"

static void reset(void) {
    step_count = step_index = 0;
    memset(&storage, 0, sizeof(storage));
    scratch_ptr = &storage;
}

static void context(void) {
    add("AT+CSSLCFG=\"sslversion\",0,4", "OK", ESP_OK);
    add("AT+CSSLCFG=\"authmode\",0,1", "OK", ESP_OK);
    add("AT+CSSLCFG=\"cacert\",0,\"" MODEM_A7670_MQTT_TLS_CA_CERT_NAME "\"", "OK", ESP_OK);
    add("AT+CSSLCFG=\"ignorelocaltime\",0,0", "OK", ESP_OK);
}

static void run(esp_err_t expected, const char *detail) {
    struct { unsigned char before; char response[48]; unsigned char after; } bounded;
    memset(&bounded, 0xA5, sizeof(bounded));
    assert(modem_a7670_configure_mqtt_tls_locked(bounded.response,
        sizeof(bounded.response), 45000U) == expected);
    assert(bounded.before == 0xA5 && bounded.after == 0xA5);
    assert(memchr(bounded.response, '\0', sizeof(bounded.response)) != NULL);
    assert(strcmp(bounded.response, detail) == 0);
    assert(step_index == step_count);
}

int main(void) {
    char oversized[2048];
    int code = -1;
    const char unterminated[] = {'+', 'C', 'M', 'Q', 'T', 'T', 'S', 'U', 'B', ':', ' ', '0', ',', '0'};
    assert(suback("OK\r\n+CMQTTSUB: 0,0\r\n"));
    assert(suback("+CMQTTSUB:\t0 , 0 \r\n"));
    assert(!suback(NULL));
    assert(!suback("OK\r\n"));
    assert(!suback("+CMQTTSUB: 0,00\r\n"));
    assert(!suback("+CMQTTSUB: 0,01\r\n"));
    assert(!suback("+CMQTTSUB: 10,0\r\n"));
    assert(!suback("+CMQTTSUB: 0,0,1\r\n"));
    assert(!suback("x+CMQTTSUB: 0,0\r\n"));
    assert(!suback("+CMQTTSUB: 0,0\r\n+CMQTTSUB: 0,3\r\n"));
    assert(!suback("+CMQTTSUB: 0,0"));
    assert(modem_mqtt_result_parse(unterminated, sizeof(unterminated), "+CMQTTSUB:").state == MODEM_MQTT_RESULT_MALFORMED);
    assert(modem_mqtt_result_parse("+CMQTTCONNECT: 0,0\r\n", sizeof("+CMQTTCONNECT: 0,0\r\n"), "+CMQTTCONNECT:").code == 0);
    assert(modem_mqtt_result_parse("+CMQTTCONNECT: 0,3\r\n", sizeof("+CMQTTCONNECT: 0,3\r\n"), "+CMQTTCONNECT:").code == 3);
    assert(modem_mqtt_result_parse("+CMQTTCONNECT: 0,00\r\n", sizeof("+CMQTTCONNECT: 0,00\r\n"), "+CMQTTCONNECT:").state == MODEM_MQTT_RESULT_MALFORMED);
    assert(modem_mqtt_result_parse("+CMQTTCONNECT: 0,0", sizeof("+CMQTTCONNECT: 0,0"), "+CMQTTCONNECT:").state == MODEM_MQTT_RESULT_PENDING);
    assert(modem_mqtt_result_parse("+CMQTTCONNECT: 0,0\r\n+CMQTTCONNECT: 0,3\r\n", sizeof("+CMQTTCONNECT: 0,0\r\n+CMQTTCONNECT: 0,3\r\n"), "+CMQTTCONNECT:").code == 3);
    assert(modem_mqtt_result_parse("+CMQTTCONNECT: 1,0\r\n", sizeof("+CMQTTCONNECT: 1,0\r\n"), "+CMQTTCONNECT:").state == MODEM_MQTT_RESULT_MALFORMED);
    assert(modem_mqtt_result_parse("+CMQTTPUB: 0,0\r\n", sizeof("+CMQTTPUB: 0,0\r\n"), "+CMQTTPUB:").code == 0);
    assert(modem_mqtt_result_parse("+CMQTTPUB: 0,2\r\n", sizeof("+CMQTTPUB: 0,2\r\n"), "+CMQTTPUB:").code == 2);
    assert(modem_mqtt_result_parse("+CMQTTPUB: 0,00\r\n", sizeof("+CMQTTPUB: 0,00\r\n"), "+CMQTTPUB:").state == MODEM_MQTT_RESULT_MALFORMED);
    assert(modem_mqtt_result_parse("+CMQTTPUB: 0,0", sizeof("+CMQTTPUB: 0,0"), "+CMQTTPUB:").state == MODEM_MQTT_RESULT_PENDING);
    assert(modem_mqtt_result_parse("OK\r\n+CMQTTSTART: 0\r\n", sizeof("OK\r\n+CMQTTSTART: 0\r\n"), "+CMQTTSTART:").code == 0);
    assert(modem_mqtt_result_parse("+CMQTTSTART: 23\r\n", sizeof("+CMQTTSTART: 23\r\n"), "+CMQTTSTART:").code == 23);
    assert(modem_mqtt_result_parse("+CMQTTSTART: 0", sizeof("+CMQTTSTART: 0"), "+CMQTTSTART:").state == MODEM_MQTT_RESULT_PENDING);
    assert(modem_mqtt_result_parse("+CMQTTSTART: 01\r\n", sizeof("+CMQTTSTART: 01\r\n"), "+CMQTTSTART:").state == MODEM_MQTT_RESULT_MALFORMED);
    assert(modem_mqtt_result_parse("+CMQTTSTART: 0,0\r\n", sizeof("+CMQTTSTART: 0,0\r\n"), "+CMQTTSTART:").state == MODEM_MQTT_RESULT_MALFORMED);
    assert(modem_mqtt_result_parse("x+CMQTTSTART: 0\r\n", sizeof("x+CMQTTSTART: 0\r\n"), "+CMQTTSTART:").state == MODEM_MQTT_RESULT_PENDING);
    assert(modem_mqtt_result_parse("+CMQTTSTART: 0\r\n+CMQTTSTART: 23\r\n", sizeof("+CMQTTSTART: 0\r\n+CMQTTSTART: 23\r\n"), "+CMQTTSTART:").code == 23);
    assert(modem_mqtt_result_parse("+CMQTTSTART: 0\r\n+CMQTTSTART: 2", sizeof("+CMQTTSTART: 0\r\n+CMQTTSTART: 2"), "+CMQTTSTART:").state == MODEM_MQTT_RESULT_PENDING);

    {
        char response[128] = "OK\r\n";
        reset_uart();
        add_uart_chunk("\r\n+CMQTT", 8U);
        add_uart_chunk("SUB: 0,", 7U);
        add_uart_chunk("0", 1U);
        add_uart_chunk("\r\n", 2U);
        assert(modem_a7670_wait_mqtt_result_locked(response, sizeof(response), 45000U, "+CMQTTSUB:", &code) == ESP_OK && code == 0);
        assert(strcmp(response, "OK\r\n\r\n+CMQTTSUB: 0,0\r\n") == 0);
        assert(parsed_chunk_count == 4U && uart_chunk_index == 4U);
    }
    {
        char response[128] = "OK\r\n+CMQTTSUB:";
        reset_uart();
        add_uart_chunk(" 0,0\r\n", 6U);
        assert(modem_a7670_wait_mqtt_result_locked(response, sizeof(response), 45000U, "+CMQTTSUB:", &code) == ESP_OK && code == 0);
        assert(parsed_chunk_count == 1U);
    }
    {
        char response[128] = "OK\r\n+CMQTTSUB: 0,0\r\n";
        reset_uart();
        assert(modem_a7670_wait_mqtt_result_locked(response, sizeof(response), 45000U, "+CMQTTSUB:", &code) == ESP_OK && code == 0);
        assert(parsed_chunk_count == 0U);
    }
    {
        char response[128] = "OK\r\n";
        reset_uart();
        add_uart_chunk("+CMQTTSUB: 0,", sizeof("+CMQTTSUB: 0,") - 1U);
        add_uart_chunk("3\r\n", 3U);
        assert(modem_a7670_wait_mqtt_result_locked(response, sizeof(response), 45000U, "+CMQTTSUB:", &code) == ESP_OK && code == 3);
    }
    {
        char response[128] = "OK\r\n";
        reset_uart();
        add_uart_chunk("+CMQTTSUB: 0,00\r\n", 17U);
        assert(modem_a7670_wait_mqtt_result_locked(response, sizeof(response), 45000U, "+CMQTTSUB:", &code) == ESP_FAIL && code == -1);
    }
    {
        char response[128] = "OK\r\n";
        reset_uart();
        add_uart_chunk("+CMQTTSUB: 0,0\r\n+CMQTTSUB: 0,3\r\n", sizeof("+CMQTTSUB: 0,0\r\n+CMQTTSUB: 0,3\r\n") - 1U);
        assert(modem_a7670_wait_mqtt_result_locked(response, sizeof(response), 45000U, "+CMQTTSUB:", &code) == ESP_OK && code == 3);
    }
    {
        char response[128] = "OK\r\n";
        reset_uart();
        assert(modem_a7670_wait_mqtt_result_locked(response, sizeof(response), 250U, "+CMQTTSUB:", &code) == ESP_ERR_TIMEOUT && code == -1);
    }
    {
        char response[5] = "OK\r\n";
        reset_uart();
        add_uart_chunk("+CMQTTSUB: 0,0\r\n", 17U);
        assert(modem_a7670_wait_mqtt_result_locked(response, sizeof(response), 250U, "+CMQTTSUB:", &code) == ESP_ERR_INVALID_SIZE && code == -1);
    }
    {
        char response[128] = "OK\r\n";
        const char malformed[] = {'+', 'C', 'M', 'Q', 'T', 'T', 'S', 'U', 'B', ':', 0, '0', ',', '0', '\r', '\n'};
        reset_uart();
        add_uart_chunk(malformed, sizeof(malformed));
        assert(modem_a7670_wait_mqtt_result_locked(response, sizeof(response), 250U, "+CMQTTSUB:", &code) == ESP_FAIL && code == -1);
    }
    {
        char response[128] = "OK\r\n";
        reset_uart();
        uart_blocked = true;
        assert(modem_a7670_wait_mqtt_result_locked(response, sizeof(response), 250U, "+CMQTTSUB:", &code) == ESP_ERR_INVALID_STATE && code == -1);
    }
    {
        char response[128] = "OK\r\n";
        reset_uart();
        add_uart_chunk("+CMQTTCON", sizeof("+CMQTTCON") - 1U);
        add_uart_chunk("NECT: 0,3\r\n", sizeof("NECT: 0,3\r\n") - 1U);
        assert(modem_a7670_wait_mqtt_result_locked(response, sizeof(response), 45000U, "+CMQTTCONNECT:", &code) == ESP_OK && code == 3);
        assert(parsed_chunk_count == 2U && uart_chunk_index == 2U);
    }
    {
        char response[128] = "OK\r\n";
        reset_uart();
        add_uart_chunk("+CMQTT", sizeof("+CMQTT") - 1U);
        add_uart_chunk("PUB: 0,0\r\n", sizeof("PUB: 0,0\r\n") - 1U);
        assert(modem_a7670_wait_mqtt_result_locked(response, sizeof(response), 45000U, "+CMQTTPUB:", &code) == ESP_OK && code == 0);
        assert(parsed_chunk_count == 2U && uart_chunk_index == 2U);
    }
    {
        char response[128] = "OK\r\n+CMQTTSTART:";
        reset_uart();
        add_uart_chunk(" 0", 2U);
        add_uart_chunk("\r\n", 2U);
        assert(modem_a7670_wait_mqtt_result_locked(response, sizeof(response), 45000U, "+CMQTTSTART:", &code) == ESP_OK && code == 0);
        assert(parsed_chunk_count == 2U && uart_chunk_index == 2U);
    }
    {
        char response[128] = "OK\r\n";
        reset_uart();
        add_uart_chunk("+CMQTTSTART: 23\r\n", sizeof("+CMQTTSTART: 23\r\n") - 1U);
        assert(modem_a7670_wait_mqtt_result_locked(response, sizeof(response), 45000U, "+CMQTTSTART:", &code) == ESP_OK && code == 23);
    }
    {
        char response[128] = "OK\r\n+CMQTTSTART:";
        reset_uart();
        assert(modem_a7670_wait_mqtt_result_locked(response, sizeof(response), 250U, "+CMQTTSTART:", &code) == ESP_ERR_TIMEOUT && code == -1);
    }
    reset();
    add("AT+CCERTLIST", CERT_LIST, ESP_OK);
    add("AT+CCLK?", CLOCK_VALID, ESP_OK);
    context();
    run(ESP_OK, "OK"); /* Active CA is beyond the caller's 48-byte buffer. */

    reset();
    add("AT+CCERTLIST", "+CCERTLIST: \"prefix-" MODEM_A7670_MQTT_TLS_CA_CERT_NAME "\"\r\nOK", ESP_OK);
    run(ESP_ERR_NOT_FOUND, "mqtt_tls_ca_missing");

    reset();
    add("AT+CCERTLIST", CERT_LIST, ESP_ERR_TIMEOUT);
    run(ESP_ERR_TIMEOUT, "mqtt_tls_ca_query_failed");

    reset();
    memset(oversized, 'x', sizeof(oversized) - 1);
    memcpy(oversized, CERT_LIST, strlen(CERT_LIST));
    oversized[sizeof(oversized) - 1] = '\0';
    add("AT+CCERTLIST", oversized, ESP_OK);
    run(ESP_ERR_INVALID_SIZE, "mqtt_tls_ca_query_failed");

    reset();
    scratch_ptr = NULL;
    run(ESP_ERR_INVALID_STATE, "mqtt_tls_scratch_unavailable");

    reset();
    add("AT+CCERTLIST", CERT_LIST, ESP_OK);
    add("AT+CCLK?", "ERROR", ESP_ERR_TIMEOUT);
    run(ESP_ERR_TIMEOUT, "mqtt_tls_clock_query_failed");

    reset();
    add("AT+CCERTLIST", CERT_LIST, ESP_OK);
    add("AT+CCLK?", CLOCK_1970, ESP_OK);
    add("AT+CNTP=\"pool.ntp.org\",0", "OK", ESP_OK);
    add("AT+CNTP", "OK", ESP_OK);
    add("WAIT_CNTP", "+CNTP: 0", ESP_OK);
    add("AT+CCLK?", CLOCK_VALID, ESP_OK);
    context();
    run(ESP_OK, "OK");

    reset();
    add("AT+CCERTLIST", CERT_LIST, ESP_OK);
    add("AT+CCLK?", CLOCK_1970, ESP_OK);
    add("AT+CNTP=\"pool.ntp.org\",0", "OK", ESP_OK);
    add("AT+CNTP", "OK", ESP_OK);
    add("WAIT_CNTP", "+CNTP: 6", ESP_ERR_TIMEOUT);
    run(ESP_ERR_TIMEOUT, "mqtt_tls_clock_sync_failed");

    reset();
    add("AT+CCERTLIST", CERT_LIST, ESP_OK);
    add("AT+CCLK?", CLOCK_1970, ESP_OK);
    add("AT+CNTP=\"pool.ntp.org\",0", "OK", ESP_OK);
    add("AT+CNTP", "+CNTP: 0", ESP_OK);
    add("AT+CCLK?", CLOCK_1970, ESP_OK);
    run(ESP_ERR_INVALID_STATE, "mqtt_tls_clock_invalid");

    reset();
    add("AT+CCERTLIST", CERT_LIST, ESP_OK);
    add("AT+CCLK?", CLOCK_VALID, ESP_OK);
    add("AT+CSSLCFG=\"sslversion\",0,4", "OK", ESP_OK);
    add("AT+CSSLCFG=\"authmode\",0,1", "ERROR", ESP_FAIL);
    run(ESP_FAIL, "mqtt_tls_context_failed");

    assert(!modem_a7670_clock_is_certificate_usable(NULL));
    assert(!modem_a7670_clock_is_certificate_usable("OK"));
    assert(!modem_a7670_clock_is_certificate_usable("+CCLK: \"23/01/01\""));
    assert(modem_a7670_clock_is_certificate_usable("+CCLK: \"24/01/01\""));
    assert(modem_a7670_clock_is_certificate_usable("+CCLK: \"69/01/01\""));
    assert(!modem_a7670_clock_is_certificate_usable(CLOCK_1970));
    puts("PASS: 10 modem MQTT TLS scenarios, 6 clock checks, 30 result parses, and 15 UART completion cases.");
    return 0;
}
