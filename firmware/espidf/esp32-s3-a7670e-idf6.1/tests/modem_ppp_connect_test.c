#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "modem_a7670_ppp_connect.h"

static void assert_all_splits(const uint8_t *data, size_t length, size_t terminal,
                              modem_a7670_ppp_connect_result_t expected) {
    size_t split;
    for (split = 0U; split <= length; ++split) {
        modem_a7670_ppp_connect_parser_t parser;
        modem_a7670_ppp_connect_result_t result;
        size_t first, second;
        modem_a7670_ppp_connect_parser_init(&parser);
        result = modem_a7670_ppp_connect_parser_feed(&parser, data, split, &first);
        assert(first == (split < terminal ? split : terminal));
        assert(result == (split < terminal ? MODEM_A7670_PPP_CONNECT_PENDING : expected));
        result = modem_a7670_ppp_connect_parser_feed(&parser, data + split, length - split, &second);
        assert(first + second == terminal);
        assert(result == expected);
        result = modem_a7670_ppp_connect_parser_feed(&parser, data, length, &second);
        assert(second == 0U && result == expected);
    }
}

static void assert_pending(const char *text) {
    modem_a7670_ppp_connect_parser_t parser;
    size_t consumed;
    modem_a7670_ppp_connect_parser_init(&parser);
    assert(modem_a7670_ppp_connect_parser_feed(&parser, (const uint8_t *)text, strlen(text), &consumed) ==
           MODEM_A7670_PPP_CONNECT_PENDING);
    assert(consumed == strlen(text));
}

int main(void) {
    static const uint8_t frame[] = "\r\nATD*99***1#\r\n+CREG: 1\r\nCONNECT\r\n\x00\x7e\xff\x03\xc0\x21\x00";
    static const uint8_t speed[] = "\r\nCONNECT 115200\r\n\x7e\x00";
    static const char *errors[] = {"ERROR\r\n", "NO CARRIER\r\n", "+CME ERROR: 30\r\n", "+CME ERROR: operation not allowed\r\n"};
    static const char *false_positives[] = {
        "CONNECT", "CONNECT\r", "CONNECT\n", "DISCONNECT\r\n", "RECONNECT\r\n",
        "CONNECTING\r\n", "CONNECT \r\n", "CONNECT +115200\r\n", "CONNECT 115200 extra\r\n",
        " CONNECT\r\n", "CONNECT\t115200\r\n", "AT+CONNECT?\r\n", "+URC: CONNECT\r\n",
        "ERROR:ignored\r\n", "+URC: NO CARRIER\r\n", "+CME ERROR:\r\n", "+CME ERROR:   \r\n",
        "CONNECT\nCONNECT\r\n", "CONNECT\rCONNECT\r\n"
    };
    modem_a7670_ppp_connect_parser_t parser;
    uint8_t overflow[MODEM_A7670_PPP_CONNECT_LINE_CAPACITY + 40U];
    size_t i, consumed, used, terminal;

    terminal = sizeof(frame) - 1U - 7U;
    assert_all_splits(frame, sizeof(frame) - 1U, terminal, MODEM_A7670_PPP_CONNECT_CONNECTED);
    assert_all_splits(speed, sizeof(speed) - 1U, sizeof(speed) - 1U - 2U, MODEM_A7670_PPP_CONNECT_CONNECTED);
    for (i = 0U; i < sizeof(errors) / sizeof(errors[0]); ++i) {
        assert_all_splits((const uint8_t *)errors[i], strlen(errors[i]), strlen(errors[i]), MODEM_A7670_PPP_CONNECT_REJECTED);
    }
    for (i = 0U; i < sizeof(false_positives) / sizeof(false_positives[0]); ++i) {
        assert_pending(false_positives[i]);
    }
    modem_a7670_ppp_connect_parser_init(&parser);
    assert(modem_a7670_ppp_connect_parser_feed(&parser, NULL, 0U, &consumed) == MODEM_A7670_PPP_CONNECT_PENDING);
    assert(consumed == 0U);
    for (i = 0U; i < sizeof(frame) - 1U; ++i) {
        modem_a7670_ppp_connect_result_t result = modem_a7670_ppp_connect_parser_feed(&parser, frame + i, 1U, &consumed);
        assert(consumed == (i < terminal ? 1U : 0U));
        assert(result == (i + 1U < terminal ? MODEM_A7670_PPP_CONNECT_PENDING : MODEM_A7670_PPP_CONNECT_CONNECTED));
    }

    memset(overflow, 'X', sizeof(overflow));
    used = MODEM_A7670_PPP_CONNECT_LINE_CAPACITY + 2U;
    memcpy(overflow + used, "CONNECT\r\n", 9U);
    used += 9U;
    modem_a7670_ppp_connect_parser_init(&parser);
    assert(modem_a7670_ppp_connect_parser_feed(&parser, overflow, used, &consumed) == MODEM_A7670_PPP_CONNECT_PENDING);
    assert(consumed == used);
    memcpy(overflow + used, "CONNECT\r\n", 9U);
    used += 9U;
    assert_all_splits(overflow, used, used, MODEM_A7670_PPP_CONNECT_CONNECTED);

    /* A binary byte inside a line is never a C-string terminator or match. */
    {
        static const uint8_t embedded_nul[] = "CONNECT\x00\r\nCONNECT\r\n";
        assert_all_splits(embedded_nul, sizeof(embedded_nul) - 1U, sizeof(embedded_nul) - 1U,
                          MODEM_A7670_PPP_CONNECT_CONNECTED);
    }
    puts("modem PPP CONNECT parser tests passed");
    return 0;
}
