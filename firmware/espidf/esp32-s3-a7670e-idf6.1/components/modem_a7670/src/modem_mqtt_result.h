#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <string.h>

typedef enum {
    MODEM_MQTT_RESULT_PENDING = 0,
    MODEM_MQTT_RESULT_COMPLETE,
    MODEM_MQTT_RESULT_MALFORMED
} modem_mqtt_result_state_t;

typedef struct {
    modem_mqtt_result_state_t state;
    int code;
} modem_mqtt_result_t;

/* A modem MQTT result is final only after its CR/LF terminator. The UART may
 * split the prefix, client index, code, and terminator across reads. Parse
 * the latest complete matching line; never accept a substring or a partial
 * later result. START reports one service code; client operations report
 * client 0 followed by a result code. */
static inline modem_mqtt_result_t modem_mqtt_result_parse(
    const char *response,
    size_t response_len,
    const char *prefix
) {
    modem_mqtt_result_t result = {MODEM_MQTT_RESULT_PENDING, -1};
    const char *line = response;
    size_t prefix_len;
    bool service_result;

    if (!response || response_len == 0U || !prefix || prefix[0] == '\0' ||
        memchr(response, '\0', response_len) == NULL) {
        result.state = MODEM_MQTT_RESULT_MALFORMED;
        return result;
    }
    prefix_len = strlen(prefix);
    service_result = strcmp(prefix, "+CMQTTSTART:") == 0;

    while (*line != '\0') {
        const char *end = line;
        const char *value;
        int code = 0;
        while (*end != '\0' && *end != '\r' && *end != '\n') ++end;
        value = line;
        while (value < end && (*value == ' ' || *value == '\t')) ++value;
        if ((size_t)(end - value) >= prefix_len && memcmp(value, prefix, prefix_len) == 0) {
            if (*end == '\0') return (modem_mqtt_result_t){MODEM_MQTT_RESULT_PENDING, -1};
            value += prefix_len;
            while (value < end && (*value == ' ' || *value == '\t')) ++value;
            if (!service_result) {
                if (value >= end || *value++ != '0') goto malformed;
                while (value < end && (*value == ' ' || *value == '\t')) ++value;
                if (value >= end || *value++ != ',') goto malformed;
                while (value < end && (*value == ' ' || *value == '\t')) ++value;
            }
            if (value >= end || *value < '0' || *value > '9') goto malformed;
            if (*value == '0' && value + 1 < end && value[1] >= '0' && value[1] <= '9') goto malformed;
            do {
                code = code * 10 + (*value++ - '0');
                if (code > 999) goto malformed;
            } while (value < end && *value >= '0' && *value <= '9');
            while (value < end && (*value == ' ' || *value == '\t')) ++value;
            if (value != end) goto malformed;
            result = (modem_mqtt_result_t){MODEM_MQTT_RESULT_COMPLETE, code};
        }
        line = end;
        while (*line == '\r' || *line == '\n') ++line;
        continue;
malformed:
        result = (modem_mqtt_result_t){MODEM_MQTT_RESULT_MALFORMED, -1};
        line = end;
        while (*line == '\r' || *line == '\n') ++line;
    }
    return result;
}
