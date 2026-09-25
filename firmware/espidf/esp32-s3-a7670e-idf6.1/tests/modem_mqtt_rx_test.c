/* Host regression tests for the production CMQTTRX length helpers. */
#include <assert.h>
#include <stdbool.h>
#include <stdlib.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

/* The runner extracts these two functions verbatim from modem_a7670.c. */
#define MODEM_A7670_MQTT_PAYLOAD_LEN 4096U
#include "modem_rx_functions.inc"

static void test_lengths(void) {
    size_t topic = 0U;
    size_t payload = 0U;

    assert(modem_a7670_parse_cmqttrx_length("+CMQTTRXTOPIC: 9") == 9U);
    assert(modem_a7670_parse_cmqttrx_length("+CMQTTRXPAYLOAD: 4095 \t") == 4095U);
    assert(modem_a7670_parse_cmqttrx_length("+CMQTTRXPAYLOAD: -1") == 0U);
    assert(modem_a7670_parse_cmqttrx_length("+CMQTTRXPAYLOAD: 12garbage") == 0U);
    assert(modem_a7670_parse_cmqttrx_length("+CMQTTRXPAYLOAD: 12,garbage") == 0U);
    assert(modem_a7670_parse_cmqttrx_length("+CMQTTRXPAYLOAD:") == 0U);

    assert(modem_a7670_parse_cmqttrx_start_lengths(
        "+CMQTTRXSTART: 0,20,200", &topic, &payload));
    assert(topic == 20U && payload == 200U);
    assert(!modem_a7670_parse_cmqttrx_start_lengths(
        "+CMQTTRXSTART: 1,20,200", &topic, &payload));
    assert(!modem_a7670_parse_cmqttrx_start_lengths(
        "+CMQTTRXSTART: 0,20,200garbage", &topic, &payload));
    assert(!modem_a7670_parse_cmqttrx_start_lengths(
        "+CMQTTRXSTART: 0,20,200,1", &topic, &payload));
}

#define MODEM_A7670_MQTT_TOPIC_LEN 160U
#define MODEM_A7670_UART_PARSE_LINE_LEN (4096U + 160U + 128U)
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGW(...) ((void)0)
typedef struct {
    char parse_line[MODEM_A7670_UART_PARSE_LINE_LEN];
    char parse_fragment[MODEM_A7670_UART_PARSE_LINE_LEN];
    size_t parse_fragment_used;
} modem_a7670_runtime_scratch_t;
static modem_a7670_runtime_scratch_t fixture_scratch;
static modem_a7670_runtime_scratch_t *s_runtime_scratch = &fixture_scratch;
static struct {
    unsigned timeout_count;
    struct { char last_error_text[64]; } runtime;
    char last_response[160];
} s_status;
static bool s_mqtt_rx_frame_started, s_mqtt_rx_expect_topic, s_mqtt_rx_expect_payload;
static bool s_mqtt_rx_overflow, s_mqtt_connected, s_mqtt_service_started;
static size_t s_mqtt_rx_expected_topic_len, s_mqtt_rx_expected_payload_len;
static size_t s_mqtt_rx_topic_fragment_remaining, s_mqtt_rx_payload_fragment_remaining;
static size_t s_mqtt_rx_topic_bytes, s_mqtt_rx_payload_bytes;
static char s_mqtt_rx_topic[MODEM_A7670_MQTT_TOPIC_LEN];
static char rx_payload[MODEM_A7670_MQTT_PAYLOAD_LEN];
static char *s_mqtt_rx_payload = rx_payload;
static unsigned queued;
static char queued_topic[160], queued_payload[4096];
static void modem_a7670_queue_mqtt_message_locked(const char *topic, const char *payload) {
    ++queued;
    snprintf(queued_topic, sizeof(queued_topic), "%s", topic);
    snprintf(queued_payload, sizeof(queued_payload), "%s", payload);
}
#include "modem_rx_parser.inc"

static void reset_parser(void) {
    memset(&fixture_scratch, 0, sizeof(fixture_scratch));
    memset(&s_status, 0, sizeof(s_status));
    modem_a7670_reset_mqtt_rx_locked();
    queued = 0;
    queued_topic[0] = queued_payload[0] = 0;
}
static size_t make_frame(char *out, const char *topic, size_t topic_len,
                         const char *payload, size_t payload_len) {
    size_t n = (size_t)sprintf(out, "+CMQTTRXSTART: 0,%u,%u\r\n+CMQTTRXTOPIC: 0,%u\r\n",
        (unsigned)topic_len, (unsigned)payload_len, (unsigned)topic_len);
    memcpy(out + n, topic, topic_len); n += topic_len;
    n += (size_t)sprintf(out + n, "\r\n+CMQTTRXPAYLOAD: 0,%u\r\n", (unsigned)payload_len);
    memcpy(out + n, payload, payload_len); n += payload_len;
    static const char footer[] = "\r\n+CMQTTRXEND: 0\r\n";
    memcpy(out + n, footer, sizeof(footer)-1U); n += sizeof(footer)-1U;
    return n;
}
static void test_wire_bytes(void) {
    const char topic[] = "device/device-a/command/get_status";
    const char payload[] = "{\"schema\":1}";
    const char bad_payload[] = "{\"schema\":1}\0trailing garbage";
    const char bad_topic[] = "device/device-a/command/get_status\0other";
    char frame[4600], good[4600];
    const size_t good_len = make_frame(good, topic, sizeof(topic)-1U, payload, sizeof(payload)-1U);
    unsigned split_cases = 0;
    for (unsigned kind = 0; kind < 3U; ++kind) {
        size_t n = make_frame(frame, kind == 2 ? bad_topic : topic,
            kind == 2 ? sizeof(bad_topic)-1U : sizeof(topic)-1U,
            kind == 1 ? bad_payload : payload,
            kind == 1 ? sizeof(bad_payload)-1U : sizeof(payload)-1U);
        for (size_t split = 0; split <= n; ++split) {
            reset_parser();
            modem_a7670_parse_response_locked(frame, split);
            modem_a7670_parse_response_locked(frame + split, n - split);
            assert(queued == (kind == 0 ? 1U : 0U));
            modem_a7670_parse_response_locked(good, good_len);
            assert(queued == (kind == 0 ? 2U : 1U));
            assert(strcmp(queued_topic, topic) == 0 && strcmp(queued_payload, payload) == 0);
            assert(fixture_scratch.parse_fragment_used == 0);
            ++split_cases;
        }
    }
    /* Raw NUL in a framing line cannot be accepted as its valid prefix. */
    const char bad_header[] = "+CMQTTRXSTART: 0,33,12\0suffix\r\n";
    reset_parser();
    for (size_t i = 0; i < sizeof(bad_header)-1U; ++i)
        modem_a7670_parse_response_locked(bad_header + i, 1U);
    assert(!s_mqtt_rx_frame_started && queued == 0);
    for (size_t i = 0; i < good_len; ++i)
        modem_a7670_parse_response_locked(good + i, 1U);
    assert(queued == 1 && strcmp(queued_payload, payload) == 0);
    /* Diagnostic and parser read only the declared slice, not its suffix. */
    reset_parser();
    modem_a7670_parse_response_locked("OK\r\nSENTINEL", 4U);
    assert(strcmp(s_status.last_response, "OK\r\n") == 0);
    printf("modem MQTT binary framing: %u split/recovery cases passed\n", split_cases);
}

int main(void) {
    test_lengths();
    test_wire_bytes();
    puts("modem_mqtt_rx_test: passed");
    return 0;
}
