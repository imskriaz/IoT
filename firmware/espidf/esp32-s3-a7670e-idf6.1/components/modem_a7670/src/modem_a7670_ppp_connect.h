#ifndef MODEM_A7670_PPP_CONNECT_H
#define MODEM_A7670_PPP_CONNECT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define MODEM_A7670_PPP_CONNECT_LINE_CAPACITY 128U

typedef enum {
    MODEM_A7670_PPP_CONNECT_PENDING = 0,
    MODEM_A7670_PPP_CONNECT_CONNECTED,
    MODEM_A7670_PPP_CONNECT_REJECTED
} modem_a7670_ppp_connect_result_t;

typedef struct {
    uint8_t line[MODEM_A7670_PPP_CONNECT_LINE_CAPACITY];
    size_t used;
    bool previous_cr;
    bool discarding;
    modem_a7670_ppp_connect_result_t result;
} modem_a7670_ppp_connect_parser_t;

static inline void modem_a7670_ppp_connect_parser_init(modem_a7670_ppp_connect_parser_t *parser) {
    memset(parser, 0, sizeof(*parser));
}

static inline modem_a7670_ppp_connect_result_t modem_a7670_ppp_connect_classify(
    const uint8_t *line, size_t length
) {
    if (length == 7U && memcmp(line, "CONNECT", 7U) == 0) {
        return MODEM_A7670_PPP_CONNECT_CONNECTED;
    }
    if (length > 8U && memcmp(line, "CONNECT ", 8U) == 0) {
        size_t i;
        for (i = 8U; i < length; ++i) {
            if (line[i] < '0' || line[i] > '9') {
                return MODEM_A7670_PPP_CONNECT_PENDING;
            }
        }
        return MODEM_A7670_PPP_CONNECT_CONNECTED;
    }
    if ((length == 5U && memcmp(line, "ERROR", 5U) == 0) ||
        (length == 10U && memcmp(line, "NO CARRIER", 10U) == 0)) {
        return MODEM_A7670_PPP_CONNECT_REJECTED;
    }
    if (length > 11U && memcmp(line, "+CME ERROR:", 11U) == 0) {
        bool detail = false;
        size_t i;
        for (i = 11U; i < length; ++i) {
            if (line[i] < ' ' || line[i] > '~') {
                return MODEM_A7670_PPP_CONNECT_PENDING;
            }
            detail = detail || line[i] != ' ';
        }
        if (detail) {
            return MODEM_A7670_PPP_CONNECT_REJECTED;
        }
    }
    return MODEM_A7670_PPP_CONNECT_PENDING;
}

/* One owner feeds the parser. The caller owns the overall byte/time budget.
 * Only CRLF-terminated, complete lines are recognized. On terminal result,
 * consumed ends immediately after LF: all remaining bytes belong to the
 * caller (including binary PPP bytes). Terminal state consumes nothing more.
 * Oversize lines are discarded through CRLF, never matched by their suffix.
 * parser and consumed must be non-NULL; data may be NULL only at length zero.
 */
static inline modem_a7670_ppp_connect_result_t modem_a7670_ppp_connect_parser_feed(
    modem_a7670_ppp_connect_parser_t *parser,
    const uint8_t *data,
    size_t length,
    size_t *consumed
) {
    size_t i;
    *consumed = 0U;
    if (parser->result != MODEM_A7670_PPP_CONNECT_PENDING) {
        return parser->result;
    }
    for (i = 0U; i < length; ++i) {
        const uint8_t byte = data[i];
        *consumed = i + 1U;
        if (byte == '\n' && parser->previous_cr) {
            if (!parser->discarding) {
                parser->result = modem_a7670_ppp_connect_classify(parser->line, parser->used - 1U);
            }
            parser->used = 0U;
            parser->previous_cr = false;
            parser->discarding = false;
            if (parser->result != MODEM_A7670_PPP_CONNECT_PENDING) {
                return parser->result;
            }
            continue;
        }
        if (!parser->discarding) {
            if (parser->used < sizeof(parser->line)) {
                parser->line[parser->used++] = byte;
            } else {
                parser->discarding = true;
                parser->used = 0U;
            }
        }
        parser->previous_cr = byte == '\r';
    }
    return parser->result;
}

#endif
