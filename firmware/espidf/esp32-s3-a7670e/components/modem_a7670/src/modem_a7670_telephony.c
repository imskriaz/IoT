#include "modem_a7670_internal.h"

#include <stdio.h>
#include <string.h>

#include "driver/uart.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "unified_runtime.h"

#define MODEM_A7670_SMS_SINGLE_TEXT_LEN_BYTES   160U
#define MODEM_A7670_SMS_SEGMENT_TEXT_LEN_BYTES  153U
#define MODEM_A7670_SMS_UCS2_SINGLE_TEXT_LEN     70U
#define MODEM_A7670_SMS_UCS2_SEGMENT_TEXT_LEN    67U
#define MODEM_A7670_SMS_MAX_SEGMENTS             15U
#define MODEM_A7670_SMS_READ_RESPONSE_LEN       768U
#define MODEM_A7670_SMS_COMMAND_LEN             192U
#define MODEM_A7670_SMS_UCS2_NUMBER_LEN        (UNIFIED_TEXT_SHORT_LEN * 4U + 1U)
#define MODEM_A7670_SMS_UCS2_TEXT_LEN          (UNIFIED_SMS_TEXT_MAX_LEN * 4U + 1U)
#define MODEM_A7670_SMS_TEXT_FO                  17U
#define MODEM_A7670_SMS_TEXT_VP_DEFAULT         167U
#define MODEM_A7670_SMS_TEXT_PID                  0U
#define MODEM_A7670_SMS_TEXT_DCS_GSM              0U
#define MODEM_A7670_SMS_TEXT_DCS_UCS2             8U
#define MODEM_A7670_USSD_CANCEL_URC_WAIT_MS      3000U
#define MODEM_A7670_USSD_CANCEL_POLL_QUIET_MS     250U
#define MODEM_A7670_USSD_CANCEL_IDLE_SLICE_MS     100U

typedef struct {
    bool text_mode_known;
    bool text_mode_enabled;
    bool charset_known;
    char charset[8];
    bool text_params_known;
    uint8_t fo;
    uint8_t vp;
    uint8_t pid;
    uint8_t dcs;
} modem_a7670_sms_runtime_state_t;

static modem_a7670_sms_runtime_state_t s_sms_runtime_state;

static bool modem_a7670_sms_decode_ucs2_hex(const char *input, char *output, size_t output_len);
static bool modem_a7670_sms_next_utf8_char(const char *text, size_t *out_len);
static esp_err_t modem_a7670_delete_sms_locked(
    int storage_index,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
);
static esp_err_t modem_a7670_read_sms_locked(
    int storage_index,
    unified_sms_payload_t *out_payload,
    char *response,
    size_t response_len,
    int64_t deadline_us,
    bool delete_after
);

static void *modem_a7670_sms_alloc_zeroed(size_t size) {
    void *buffer = heap_caps_calloc(1U, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);

    if (!buffer) {
        buffer = heap_caps_calloc(1U, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }

    return buffer;
}

static void modem_a7670_sms_free(void *buffer) {
    if (buffer) {
        heap_caps_free(buffer);
    }
}

static int64_t modem_a7670_timeout_deadline_us(uint32_t timeout_ms) {
    return esp_timer_get_time() + ((int64_t)timeout_ms * 1000LL);
}

static uint32_t modem_a7670_timeout_remaining_ms(int64_t deadline_us) {
    const int64_t now_us = esp_timer_get_time();

    if (deadline_us <= now_us) {
        return 0U;
    }

    return (uint32_t)((deadline_us - now_us + 999LL) / 1000LL);
}

void modem_a7670_sms_invalidate_runtime_state_locked(void) {
    memset(&s_sms_runtime_state, 0, sizeof(s_sms_runtime_state));
}

static bool modem_a7670_parse_sms_payload_from_response(const char *response, unified_sms_payload_t *out_payload) {
    const char *header = NULL;
    const char *status_start = NULL;
    const char *status_end = NULL;
    const char *from_start = NULL;
    const char *from_end = NULL;
    const char *text_start = NULL;
    const char *text_end = NULL;
    const char *terminator = NULL;
    char raw_from[MODEM_A7670_SMS_UCS2_NUMBER_LEN] = {0};
    char raw_text[MODEM_A7670_SMS_READ_RESPONSE_LEN] = {0};

    if (!response || !out_payload) {
        return false;
    }

    header = strstr(response, "+CMGR:");
    if (!header) {
        return false;
    }

    memset(out_payload, 0, sizeof(*out_payload));
    status_start = strchr(header, '"');
    if (!status_start) {
        return false;
    }

    status_end = strchr(status_start + 1, '"');
    if (!status_end) {
        return false;
    }

    from_start = strchr(status_end + 1, '"');
    if (!from_start) {
        return false;
    }
    from_start += 1;

    from_end = strchr(from_start, '"');
    if (!from_end) {
        return false;
    }

    snprintf(raw_from, sizeof(raw_from), "%.*s", (int)(from_end - from_start), from_start);
    if (!modem_a7670_sms_decode_ucs2_hex(raw_from, out_payload->from, sizeof(out_payload->from))) {
        snprintf(out_payload->from, sizeof(out_payload->from), "%.*s", (int)sizeof(out_payload->from) - 1, raw_from);
    }

    text_start = strstr(from_end, "\r\n");
    if (!text_start) {
        return false;
    }
    text_start += 2;

    terminator = strstr(text_start, "\r\n\r\nOK");
    if (terminator) {
        text_end = terminator;
    } else {
        terminator = strstr(text_start, "\r\nOK");
        text_end = terminator ? terminator : (text_start + strlen(text_start));
    }

    snprintf(raw_text, sizeof(raw_text), "%.*s", (int)(text_end - text_start), text_start);
    if (!modem_a7670_sms_decode_ucs2_hex(raw_text, out_payload->text, sizeof(out_payload->text))) {
        snprintf(out_payload->text, sizeof(out_payload->text), "%.*s", (int)sizeof(out_payload->text) - 1, raw_text);
    }
    snprintf(out_payload->detail, sizeof(out_payload->detail), "%s", "incoming_sms");
    out_payload->sim_slot = 0U;
    out_payload->timestamp_ms = unified_time_now_ms();
    out_payload->outgoing = false;
    return true;
}

static uint8_t modem_a7670_sms_message_reference(void) {
    return (uint8_t)((unified_time_now_ms() % 255U) + 1U);
}

static int modem_a7670_sms_hex_value(char value) {
    if (value >= '0' && value <= '9') {
        return value - '0';
    }
    if (value >= 'A' && value <= 'F') {
        return value - 'A' + 10;
    }
    if (value >= 'a' && value <= 'f') {
        return value - 'a' + 10;
    }
    return -1;
}

static bool modem_a7670_sms_decode_ucs2_hex(const char *input, char *output, size_t output_len) {
    size_t read_index = 0U;
    size_t write_index = 0U;

    if (!input || !output || output_len == 0U) {
        return false;
    }

    output[0] = '\0';
    if (input[0] == '\0') {
        return true;
    }

    while (input[read_index] != '\0') {
        int nibble0 = 0;
        int nibble1 = 0;
        int nibble2 = 0;
        int nibble3 = 0;
        uint16_t codepoint = 0U;

        if (input[read_index + 3U] == '\0') {
            return false;
        }

        nibble0 = modem_a7670_sms_hex_value(input[read_index]);
        nibble1 = modem_a7670_sms_hex_value(input[read_index + 1U]);
        nibble2 = modem_a7670_sms_hex_value(input[read_index + 2U]);
        nibble3 = modem_a7670_sms_hex_value(input[read_index + 3U]);
        if (nibble0 < 0 || nibble1 < 0 || nibble2 < 0 || nibble3 < 0) {
            return false;
        }

        codepoint = (uint16_t)((nibble0 << 12) | (nibble1 << 8) | (nibble2 << 4) | nibble3);
        if (codepoint <= 0x7FU) {
            if ((write_index + 1U) >= output_len) {
                return false;
            }
            output[write_index++] = (char)codepoint;
        } else if (codepoint <= 0x7FFU) {
            if ((write_index + 2U) >= output_len) {
                return false;
            }
            output[write_index++] = (char)(0xC0U | ((codepoint >> 6) & 0x1FU));
            output[write_index++] = (char)(0x80U | (codepoint & 0x3FU));
        } else {
            if ((write_index + 3U) >= output_len) {
                return false;
            }
            output[write_index++] = (char)(0xE0U | ((codepoint >> 12) & 0x0FU));
            output[write_index++] = (char)(0x80U | ((codepoint >> 6) & 0x3FU));
            output[write_index++] = (char)(0x80U | (codepoint & 0x3FU));
        }

        read_index += 4U;
    }

    output[write_index] = '\0';
    return true;
}

static bool modem_a7670_sms_encode_utf8_to_ucs2_hex(const char *input, char *output, size_t output_len) {
    static const char hex_chars[] = "0123456789ABCDEF";
    size_t read_index = 0U;
    size_t write_index = 0U;

    if (!input || !output || output_len == 0U) {
        return false;
    }

    output[0] = '\0';
    while (input[read_index] != '\0') {
        uint32_t codepoint = 0U;
        unsigned char first = (unsigned char)input[read_index];

        if (first <= 0x7FU) {
            codepoint = first;
            read_index += 1U;
        } else if ((first & 0xE0U) == 0xC0U) {
            unsigned char second = (unsigned char)input[read_index + 1U];
            if ((second & 0xC0U) != 0x80U) {
                return false;
            }
            codepoint = ((uint32_t)(first & 0x1FU) << 6) | (uint32_t)(second & 0x3FU);
            read_index += 2U;
        } else if ((first & 0xF0U) == 0xE0U) {
            unsigned char second = (unsigned char)input[read_index + 1U];
            unsigned char third = (unsigned char)input[read_index + 2U];
            if ((second & 0xC0U) != 0x80U || (third & 0xC0U) != 0x80U) {
                return false;
            }
            codepoint = ((uint32_t)(first & 0x0FU) << 12) |
                        ((uint32_t)(second & 0x3FU) << 6) |
                        (uint32_t)(third & 0x3FU);
            read_index += 3U;
        } else {
            return false;
        }

        if (codepoint > 0xFFFFU || (write_index + 4U) >= output_len) {
            return false;
        }

        output[write_index++] = hex_chars[(codepoint >> 12) & 0x0FU];
        output[write_index++] = hex_chars[(codepoint >> 8) & 0x0FU];
        output[write_index++] = hex_chars[(codepoint >> 4) & 0x0FU];
        output[write_index++] = hex_chars[codepoint & 0x0FU];
    }

    output[write_index] = '\0';
    return true;
}

static bool modem_a7670_sms_requires_ucs2(const char *text) {
    if (!text) {
        return false;
    }

    for (size_t i = 0U; text[i] != '\0'; ++i) {
        if (((unsigned char)text[i]) > 0x7FU) {
            return true;
        }
    }

    return false;
}

static esp_err_t modem_a7670_sms_set_charset_locked(
    const char *charset,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
) {
    char command[32] = {0};

    if (!charset || !response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    if (s_sms_runtime_state.charset_known &&
        strcmp(s_sms_runtime_state.charset, charset) == 0) {
        response[0] = '\0';
        return ESP_OK;
    }

    if (snprintf(command, sizeof(command), "AT+CSCS=\"%s\"", charset) < 0) {
        return ESP_FAIL;
    }

    esp_err_t err = modem_a7670_send_command_locked(command, response, response_len, timeout_ms, false);
    if (err == ESP_OK) {
        s_sms_runtime_state.charset_known = true;
        unified_copy_cstr(s_sms_runtime_state.charset, sizeof(s_sms_runtime_state.charset), charset);
    } else {
        s_sms_runtime_state.charset_known = false;
        s_sms_runtime_state.charset[0] = '\0';
    }

    return err;
}

static esp_err_t modem_a7670_sms_set_text_mode_params_locked(
    uint8_t fo,
    uint8_t vp,
    uint8_t pid,
    uint8_t dcs,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
) {
    char command[40] = {0};

    if (!response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    if (s_sms_runtime_state.text_params_known &&
        s_sms_runtime_state.fo == fo &&
        s_sms_runtime_state.vp == vp &&
        s_sms_runtime_state.pid == pid &&
        s_sms_runtime_state.dcs == dcs) {
        response[0] = '\0';
        return ESP_OK;
    }

    if (snprintf(command, sizeof(command), "AT+CSMP=%u,%u,%u,%u", fo, vp, pid, dcs) < 0) {
        return ESP_FAIL;
    }

    esp_err_t err = modem_a7670_send_command_locked(command, response, response_len, timeout_ms, false);
    if (err == ESP_OK) {
        s_sms_runtime_state.text_params_known = true;
        s_sms_runtime_state.fo = fo;
        s_sms_runtime_state.vp = vp;
        s_sms_runtime_state.pid = pid;
        s_sms_runtime_state.dcs = dcs;
    } else {
        s_sms_runtime_state.text_params_known = false;
    }

    return err;
}

static esp_err_t modem_a7670_sms_set_text_mode_locked(
    char *response,
    size_t response_len,
    uint32_t timeout_ms
) {
    esp_err_t err = ESP_OK;

    if (!response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    if (s_sms_runtime_state.text_mode_known && s_sms_runtime_state.text_mode_enabled) {
        response[0] = '\0';
        return ESP_OK;
    }

    err = modem_a7670_send_command_locked("AT+CMGF=1", response, response_len, timeout_ms, false);
    if (err == ESP_OK) {
        s_sms_runtime_state.text_mode_known = true;
        s_sms_runtime_state.text_mode_enabled = true;
    } else {
        s_sms_runtime_state.text_mode_known = false;
        s_sms_runtime_state.text_mode_enabled = false;
    }

    return err;
}

static bool modem_a7670_sms_is_gsm7_extension_char(char c) {
    switch (c) {
        case '^':
        case '{':
        case '}':
        case '\\':
        case '[':
        case '~':
        case ']':
        case '|':
            return true;
        default:
            return false;
    }
}

static bool modem_a7670_sms_can_use_gsm7_units(const char *text) {
    if (!text) {
        return false;
    }

    for (size_t i = 0U; text[i] != '\0'; ++i) {
        if (((unsigned char)text[i]) > 0x7FU) {
            return false;
        }
    }

    return true;
}

static bool modem_a7670_sms_next_utf8_char(const char *text, size_t *out_len) {
    unsigned char first = 0U;

    if (!text || !out_len || text[0] == '\0') {
        return false;
    }

    first = (unsigned char)text[0];
    if ((first & 0x80U) == 0U) {
        *out_len = 1U;
        return true;
    }

    if ((first & 0xE0U) == 0xC0U) {
        const unsigned char second = (unsigned char)text[1];
        if (second == 0U || (second & 0xC0U) != 0x80U) {
            return false;
        }
        *out_len = 2U;
        return true;
    }

    if ((first & 0xF0U) == 0xE0U) {
        const unsigned char second = (unsigned char)text[1];
        const unsigned char third = (unsigned char)text[2];
        if (second == 0U || third == 0U || (second & 0xC0U) != 0x80U || (third & 0xC0U) != 0x80U) {
            return false;
        }
        *out_len = 3U;
        return true;
    }

    if ((first & 0xF8U) == 0xF0U) {
        const unsigned char second = (unsigned char)text[1];
        const unsigned char third = (unsigned char)text[2];
        const unsigned char fourth = (unsigned char)text[3];
        if (second == 0U || third == 0U || fourth == 0U ||
            (second & 0xC0U) != 0x80U || (third & 0xC0U) != 0x80U || (fourth & 0xC0U) != 0x80U) {
            return false;
        }
        *out_len = 4U;
        return true;
    }

    return false;
}

static size_t modem_a7670_sms_segment_length(const char *text, size_t unit_limit) {
    size_t used_units = 0U;
    size_t length = 0U;

    if (!text || unit_limit == 0U) {
        return 0U;
    }

    while (text[length] != '\0') {
        const size_t char_units = modem_a7670_sms_is_gsm7_extension_char(text[length]) ? 2U : 1U;

        if ((used_units + char_units) > unit_limit) {
            break;
        }

        used_units += char_units;
        length++;
    }

    return length;
}

static size_t modem_a7670_sms_unicode_segment_length(const char *text, size_t char_limit) {
    size_t used_chars = 0U;
    size_t used_bytes = 0U;

    if (!text || char_limit == 0U) {
        return 0U;
    }

    while (text[used_bytes] != '\0' && used_chars < char_limit) {
        size_t char_len = 0U;

        if (!modem_a7670_sms_next_utf8_char(text + used_bytes, &char_len)) {
            return 0U;
        }

        used_bytes += char_len;
        used_chars++;
    }

    return used_bytes;
}

static size_t modem_a7670_sms_unicode_length(const char *text) {
    size_t count = 0U;
    size_t offset = 0U;

    if (!text || text[0] == '\0') {
        return 0U;
    }

    while (text[offset] != '\0') {
        size_t char_len = 0U;

        if (!modem_a7670_sms_next_utf8_char(text + offset, &char_len)) {
            return 0U;
        }

        offset += char_len;
        count++;
    }

    return count;
}

static size_t modem_a7670_sms_segment_count(const char *text) {
    size_t total_segments = 0U;
    const char *cursor = text;

    if (!text || text[0] == '\0') {
        return 0U;
    }

    if (!modem_a7670_sms_can_use_gsm7_units(text)) {
        const size_t unicode_length = modem_a7670_sms_unicode_length(text);

        if (unicode_length == 0U) {
            return 0U;
        }

        if (unicode_length <= MODEM_A7670_SMS_UCS2_SINGLE_TEXT_LEN) {
            return 1U;
        }

        while (*cursor != '\0') {
            const size_t segment_len = modem_a7670_sms_unicode_segment_length(cursor, MODEM_A7670_SMS_UCS2_SEGMENT_TEXT_LEN);

            if (segment_len == 0U) {
                return 0U;
            }

            cursor += segment_len;
            total_segments++;
        }

        return total_segments;
    }

    while (*cursor != '\0') {
        const size_t segment_len = total_segments == 0U && modem_a7670_sms_segment_length(cursor, MODEM_A7670_SMS_SINGLE_TEXT_LEN_BYTES) == strlen(cursor)
            ? modem_a7670_sms_segment_length(cursor, MODEM_A7670_SMS_SINGLE_TEXT_LEN_BYTES)
            : modem_a7670_sms_segment_length(cursor, MODEM_A7670_SMS_SEGMENT_TEXT_LEN_BYTES);

        if (segment_len == 0U) {
            return 0U;
        }

        cursor += segment_len;
        total_segments++;
    }

    return total_segments;
}

static bool modem_a7670_parse_sms_list_index(const char *response, int *out_index) {
    const char *header = NULL;
    int index = -1;

    if (!response || !out_index) {
        return false;
    }

    *out_index = -1;
    header = strstr(response, "+CMGL:");
    if (!header) {
        return false;
    }

    if (sscanf(header, "+CMGL: %d", &index) != 1 || index < 0) {
        return false;
    }

    *out_index = index;
    return true;
}

static bool modem_a7670_parse_concat_indexes(
    const char *response,
    int *out_indexes,
    size_t max_indexes,
    size_t *out_count
) {
    const char *cursor = response;

    if (!response || !out_indexes || max_indexes == 0U || !out_count) {
        return false;
    }

    *out_count = 0U;
    while ((cursor = strstr(cursor, "+CCONCINDEX:")) != NULL) {
        const char *line_end = strpbrk(cursor, "\r\n");
        const char *numbers = strchr(cursor, ':');
        char line[128] = {0};
        long segment_total = 0;
        size_t parsed = 0U;
        char *parse_end = NULL;
        char *number_cursor = NULL;

        if (!numbers) {
            cursor += strlen("+CCONCINDEX:");
            continue;
        }
        numbers += 1;

        if (!line_end) {
            line_end = cursor + strlen(cursor);
        }
        if ((size_t)(line_end - numbers) >= sizeof(line)) {
            cursor = line_end;
            continue;
        }

        memcpy(line, numbers, (size_t)(line_end - numbers));
        line[line_end - numbers] = '\0';

        number_cursor = line;
        segment_total = strtol(number_cursor, &parse_end, 10);
        if (parse_end == number_cursor) {
            cursor = line_end;
            continue;
        }
        if (segment_total <= 0L || (size_t)segment_total > max_indexes) {
            cursor = line_end;
            continue;
        }

        number_cursor = parse_end;
        while (parsed < (size_t)segment_total) {
            while (*number_cursor == ',' || *number_cursor == ' ') {
                ++number_cursor;
            }
            if (*number_cursor == '\0') {
                break;
            }

            out_indexes[parsed] = (int)strtol(number_cursor, &parse_end, 10);
            if (parse_end == number_cursor) {
                break;
            }

            parsed++;
            number_cursor = parse_end;
        }

        if (parsed == (size_t)segment_total) {
            *out_count = parsed;
            return true;
        }

        return false;
    }

    return false;
}

static bool modem_a7670_concat_indexes_contain(const int *indexes, size_t count, int storage_index) {
    if (!indexes || count == 0U || storage_index < 0) {
        return false;
    }

    for (size_t index = 0U; index < count; ++index) {
        if (indexes[index] == storage_index) {
            return true;
        }
    }

    return false;
}

static esp_err_t modem_a7670_consume_concat_sms_indexes_locked(
    unified_sms_payload_t *out_payload,
    const int *indexes,
    size_t index_count,
    char *response,
    size_t response_len,
    int64_t deadline_us
) {
    unified_sms_payload_t segment = {0};
    esp_err_t err = ESP_OK;
    uint32_t remaining_timeout_ms = 0U;

    if (!out_payload || !indexes || index_count == 0U || !response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    memset(out_payload, 0, sizeof(*out_payload));
    for (size_t i = 0U; i < index_count; ++i) {
        memset(&segment, 0, sizeof(segment));
        err = modem_a7670_read_sms_locked(indexes[i], &segment, response, response_len, deadline_us, false);
        if (err != ESP_OK) {
            return err;
        }

        if (i == 0U) {
            *out_payload = segment;
            out_payload->text[0] = '\0';
        }
        if (strlcat(out_payload->text, segment.text, sizeof(out_payload->text)) >= sizeof(out_payload->text)) {
            return ESP_ERR_INVALID_SIZE;
        }
        out_payload->sim_slot = 0U;
        out_payload->timestamp_ms = segment.timestamp_ms;
        out_payload->outgoing = false;
        snprintf(out_payload->detail, sizeof(out_payload->detail), "%s", "incoming_sms_concat");
    }

    for (size_t i = 0U; i < index_count; ++i) {
        remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
        if (remaining_timeout_ms == 0U) {
            return ESP_ERR_TIMEOUT;
        }
        err = modem_a7670_delete_sms_locked(indexes[i], response, response_len, remaining_timeout_ms);
        if (err != ESP_OK) {
            return err;
        }
    }

    modem_a7670_drop_sms_indexes_locked(indexes, index_count);
    return ESP_OK;
}

static esp_err_t modem_a7670_delete_sms_locked(
    int storage_index,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
) {
    char command[32] = {0};
    int written = 0;

    written = snprintf(command, sizeof(command), "AT+CMGD=%d,0", storage_index);
    if (written <= 0 || (size_t)written >= sizeof(command)) {
        return ESP_ERR_INVALID_SIZE;
    }

    return modem_a7670_send_command_locked(command, response, response_len, timeout_ms, false);
}

static esp_err_t modem_a7670_read_sms_locked(
    int storage_index,
    unified_sms_payload_t *out_payload,
    char *response,
    size_t response_len,
    int64_t deadline_us,
    bool delete_after
) {
    char command[32] = {0};
    esp_err_t err = ESP_FAIL;
    int written = 0;
    uint32_t remaining_timeout_ms = 0U;

    if (storage_index < 0 || !out_payload || !response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }

    written = snprintf(command, sizeof(command), "AT+CMGR=%d", storage_index);
    if (written < 0 || (size_t)written >= sizeof(command)) {
        return ESP_ERR_INVALID_SIZE;
    }

    remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
    if (remaining_timeout_ms == 0U) {
        return ESP_ERR_TIMEOUT;
    }

    err = modem_a7670_send_command_locked(command, response, response_len, remaining_timeout_ms, false);
    if (err == ESP_OK && !modem_a7670_parse_sms_payload_from_response(response, out_payload)) {
        err = ESP_FAIL;
    }
    if (err == ESP_OK && delete_after) {
        remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
        if (remaining_timeout_ms == 0U) {
            err = ESP_ERR_TIMEOUT;
        } else {
            err = modem_a7670_delete_sms_locked(storage_index, response, response_len, remaining_timeout_ms);
        }
    }

    return err;
}

static esp_err_t modem_a7670_consume_concat_sms_locked(
    unified_sms_payload_t *out_payload,
    char *response,
    size_t response_len,
    int64_t deadline_us
) {
    int indexes[MODEM_A7670_SMS_MAX_SEGMENTS] = {0};
    size_t index_count = 0U;
    esp_err_t err = ESP_OK;
    uint32_t remaining_timeout_ms = 0U;

    response[0] = '\0';
    remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
    if (remaining_timeout_ms == 0U) {
        return ESP_ERR_TIMEOUT;
    }
    err = modem_a7670_send_command_locked("AT+CCONCINDEX", response, response_len, remaining_timeout_ms, false);
    if (err != ESP_OK || !modem_a7670_parse_concat_indexes(response, indexes, MODEM_A7670_SMS_MAX_SEGMENTS, &index_count)) {
        return err == ESP_OK ? ESP_ERR_NOT_FOUND : err;
    }

    return modem_a7670_consume_concat_sms_indexes_locked(
        out_payload,
        indexes,
        index_count,
        response,
        response_len,
        deadline_us
    );
}

static esp_err_t modem_a7670_send_sms_multipart_locked(
    const char *number,
    const char *text,
    char *response,
    size_t response_len,
    int64_t deadline_us
) {
    const uint8_t ctrl_z = 0x1AU;
    const bool use_gsm7_units = modem_a7670_sms_can_use_gsm7_units(text);
    const size_t total_segments = modem_a7670_sms_segment_count(text);
    const uint8_t message_reference = modem_a7670_sms_message_reference();
    const char *segment_cursor = text;
    esp_err_t err = ESP_OK;
    const char *destination_number = number;
    const bool use_ucs2 = modem_a7670_sms_requires_ucs2(text);
    char encoded_number[MODEM_A7670_SMS_UCS2_NUMBER_LEN] = {0};
    char *encoded_segment = NULL;
    char *segment_buffer = NULL;
    uint32_t remaining_timeout_ms = 0U;

    if (total_segments < 2U || total_segments > MODEM_A7670_SMS_MAX_SEGMENTS) {
        return ESP_ERR_INVALID_SIZE;
    }
    if (use_ucs2) {
        encoded_segment = modem_a7670_sms_alloc_zeroed(MODEM_A7670_SMS_UCS2_TEXT_LEN);
        segment_buffer = modem_a7670_sms_alloc_zeroed(UNIFIED_SMS_TEXT_MAX_LEN + 1U);
        if (!encoded_segment || !segment_buffer) {
            modem_a7670_sms_free(encoded_segment);
            modem_a7670_sms_free(segment_buffer);
            return ESP_ERR_NO_MEM;
        }
        if (!modem_a7670_sms_encode_utf8_to_ucs2_hex(number, encoded_number, sizeof(encoded_number))) {
            modem_a7670_sms_free(encoded_segment);
            modem_a7670_sms_free(segment_buffer);
            return ESP_ERR_INVALID_ARG;
        }
        destination_number = encoded_number;
    }

    remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
    if (remaining_timeout_ms == 0U) {
        err = ESP_ERR_TIMEOUT;
        goto cleanup;
    }
    err = modem_a7670_sms_set_text_mode_locked(response, response_len, remaining_timeout_ms);
    if (err == ESP_OK) {
        remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
        if (remaining_timeout_ms == 0U) {
            err = ESP_ERR_TIMEOUT;
        } else {
            err = modem_a7670_sms_set_charset_locked("IRA", response, response_len, remaining_timeout_ms);
        }
    }
    if (err == ESP_OK) {
        remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
        if (remaining_timeout_ms == 0U) {
            err = ESP_ERR_TIMEOUT;
        } else {
            err = modem_a7670_sms_set_text_mode_params_locked(
                MODEM_A7670_SMS_TEXT_FO,
                MODEM_A7670_SMS_TEXT_VP_DEFAULT,
                MODEM_A7670_SMS_TEXT_PID,
                use_ucs2 ? MODEM_A7670_SMS_TEXT_DCS_UCS2 : MODEM_A7670_SMS_TEXT_DCS_GSM,
                response,
                response_len,
                remaining_timeout_ms
            );
        }
    }
    if (err == ESP_OK && use_ucs2) {
        remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
        if (remaining_timeout_ms == 0U) {
            err = ESP_ERR_TIMEOUT;
        } else {
            err = modem_a7670_sms_set_charset_locked("UCS2", response, response_len, remaining_timeout_ms);
        }
    }
    for (size_t segment_index = 0U; err == ESP_OK && segment_index < total_segments; ++segment_index) {
        const size_t segment_len = use_gsm7_units
            ? modem_a7670_sms_segment_length(segment_cursor, MODEM_A7670_SMS_SEGMENT_TEXT_LEN_BYTES)
            : modem_a7670_sms_unicode_segment_length(segment_cursor, MODEM_A7670_SMS_UCS2_SEGMENT_TEXT_LEN);
        char command[MODEM_A7670_SMS_COMMAND_LEN] = {0};
        const char *segment_text = segment_cursor;

        if (segment_len == 0U) {
            err = ESP_ERR_INVALID_SIZE;
            break;
        }

        if (use_ucs2) {
            memset(encoded_segment, 0, MODEM_A7670_SMS_UCS2_TEXT_LEN);
            memset(segment_buffer, 0, UNIFIED_SMS_TEXT_MAX_LEN + 1U);
            memcpy(segment_buffer, segment_cursor, segment_len);
            segment_buffer[segment_len] = '\0';
            if (!modem_a7670_sms_encode_utf8_to_ucs2_hex(segment_buffer, encoded_segment, MODEM_A7670_SMS_UCS2_TEXT_LEN)) {
                err = ESP_ERR_INVALID_ARG;
                break;
            }
            segment_text = encoded_segment;
        }

        if (snprintf(
                command,
                sizeof(command),
                "AT+CMGSEX=\"%s\",%u,%u,%u",
                destination_number,
                (unsigned int)message_reference,
                (unsigned int)(segment_index + 1U),
                (unsigned int)total_segments) < 0) {
            err = ESP_FAIL;
            break;
        }

        remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
        if (remaining_timeout_ms == 0U) {
            err = ESP_ERR_TIMEOUT;
            break;
        }
        err = modem_a7670_send_command_locked(command, response, response_len, remaining_timeout_ms, true);
        if (err != ESP_OK) {
            break;
        }

        response[0] = '\0';
        if (uart_write_bytes((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, segment_text, strlen(segment_text)) < 0 ||
            uart_write_bytes((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, (const char *)&ctrl_z, 1) < 0) {
            err = ESP_FAIL;
            break;
        }

        remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
        if (remaining_timeout_ms == 0U) {
            err = ESP_ERR_TIMEOUT;
            break;
        }
        err = modem_a7670_read_response_locked(response, response_len, remaining_timeout_ms, false);
        segment_cursor += segment_len;
    }

cleanup:
    modem_a7670_sms_free(encoded_segment);
    modem_a7670_sms_free(segment_buffer);
    return err;
}

esp_err_t modem_a7670_send_sms_multipart(
    const char *number,
    const char *text,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
) {
    esp_err_t err = ESP_FAIL;
    int64_t deadline_us = 0;
    uint32_t remaining_timeout_ms = 0U;

    if (!number || !text || !response || response_len == 0U || number[0] == '\0' || text[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_uart_control_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (modem_a7670_uart_control_blocked_locked()) {
        return ESP_ERR_INVALID_STATE;
    }

    deadline_us = modem_a7670_timeout_deadline_us(timeout_ms);
    remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
    if (remaining_timeout_ms == 0U || xSemaphoreTake(s_lock, pdMS_TO_TICKS(remaining_timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    err = modem_a7670_send_sms_multipart_locked(number, text, response, response_len, deadline_us);

    xSemaphoreGive(s_lock);
    return err;
}

esp_err_t modem_a7670_send_sms(
    const char *number,
    const char *text,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
) {
    char command[MODEM_A7670_SMS_COMMAND_LEN] = {0};
    esp_err_t err = ESP_FAIL;
    const uint8_t ctrl_z = 0x1AU;
    const size_t total_segments = modem_a7670_sms_segment_count(text);
    const bool use_ucs2 = modem_a7670_sms_requires_ucs2(text);
    char *encoded_text = NULL;
    char encoded_number[MODEM_A7670_SMS_UCS2_NUMBER_LEN] = {0};
    const char *destination_number = number;
    const char *message_text = text;
    int64_t deadline_us = 0;
    uint32_t remaining_timeout_ms = 0U;

    if (!number || !text || !response || response_len == 0 || number[0] == '\0' || text[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_uart_control_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (modem_a7670_uart_control_blocked_locked()) {
        return ESP_ERR_INVALID_STATE;
    }

    deadline_us = modem_a7670_timeout_deadline_us(timeout_ms);
    remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
    if (remaining_timeout_ms == 0U || xSemaphoreTake(s_lock, pdMS_TO_TICKS(remaining_timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    if (use_ucs2) {
        /* With CSCS=UCS2, both destination address strings and message body
         * text are passed to the modem as UCS2 hex. */
        ESP_LOGI(TAG, "sms send using UCS2 text_len=%u", (unsigned)strlen(text));
        if (!modem_a7670_sms_encode_utf8_to_ucs2_hex(number, encoded_number, sizeof(encoded_number))) {
            xSemaphoreGive(s_lock);
            return ESP_ERR_INVALID_ARG;
        }
        destination_number = encoded_number;
        encoded_text = modem_a7670_sms_alloc_zeroed(MODEM_A7670_SMS_UCS2_TEXT_LEN);
        if (!encoded_text) {
            xSemaphoreGive(s_lock);
            return ESP_ERR_NO_MEM;
        }
        if (!modem_a7670_sms_encode_utf8_to_ucs2_hex(text, encoded_text, MODEM_A7670_SMS_UCS2_TEXT_LEN)) {
            modem_a7670_sms_free(encoded_text);
            xSemaphoreGive(s_lock);
            return ESP_ERR_INVALID_ARG;
        }
        message_text = encoded_text;
    }

    if (total_segments > 1U) {
        err = modem_a7670_send_sms_multipart_locked(number, text, response, response_len, deadline_us);
    } else {
        remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
        if (remaining_timeout_ms == 0U) {
            err = ESP_ERR_TIMEOUT;
        } else {
            err = modem_a7670_sms_set_text_mode_locked(response, response_len, remaining_timeout_ms);
        }
        if (err == ESP_OK) {
            remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
            if (remaining_timeout_ms == 0U) {
                err = ESP_ERR_TIMEOUT;
            } else {
                err = modem_a7670_sms_set_charset_locked("IRA", response, response_len, remaining_timeout_ms);
            }
        }
        if (err == ESP_OK) {
            remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
            if (remaining_timeout_ms == 0U) {
                err = ESP_ERR_TIMEOUT;
            } else {
                err = modem_a7670_sms_set_text_mode_params_locked(
                    MODEM_A7670_SMS_TEXT_FO,
                    MODEM_A7670_SMS_TEXT_VP_DEFAULT,
                    MODEM_A7670_SMS_TEXT_PID,
                    use_ucs2 ? MODEM_A7670_SMS_TEXT_DCS_UCS2 : MODEM_A7670_SMS_TEXT_DCS_GSM,
                    response,
                    response_len,
                    remaining_timeout_ms
                );
            }
        }
        if (err == ESP_OK && use_ucs2) {
            remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
            if (remaining_timeout_ms == 0U) {
                err = ESP_ERR_TIMEOUT;
            } else {
                err = modem_a7670_sms_set_charset_locked("UCS2", response, response_len, remaining_timeout_ms);
            }
        }
        if (err == ESP_OK) {
            err = modem_a7670_prepare_command(command, sizeof(command), "AT+CMGS=\"", destination_number, "\"");
        }
        if (err == ESP_OK) {
            remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
            if (remaining_timeout_ms == 0U) {
                err = ESP_ERR_TIMEOUT;
            } else {
                err = modem_a7670_send_command_locked(command, response, response_len, remaining_timeout_ms, true);
                if (err != ESP_OK) {
                    ESP_LOGW(TAG, "sms CMGS prompt failed err=%s response=%s", esp_err_to_name(err), response);
                }
            }
        }
        if (err == ESP_OK) {
            response[0] = '\0';
            if (uart_write_bytes((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, message_text, strlen(message_text)) < 0 ||
                uart_write_bytes((uart_port_t)CONFIG_UNIFIED_MODEM_UART_PORT, (const char *)&ctrl_z, 1) < 0) {
                err = ESP_FAIL;
            } else {
                remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
                if (remaining_timeout_ms == 0U) {
                    err = ESP_ERR_TIMEOUT;
                } else {
                    err = modem_a7670_read_response_locked(response, response_len, remaining_timeout_ms, false);
                    if (use_ucs2 || err != ESP_OK) {
                        ESP_LOGI(TAG, "sms final response err=%s response=%s", esp_err_to_name(err), response);
                    }
                }
            }
        }
    }

    xSemaphoreGive(s_lock);
    modem_a7670_sms_free(encoded_text);
    return err;
}

esp_err_t modem_a7670_dial(
    const char *number,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
) {
    char command[48] = {0};
    esp_err_t err = ESP_OK;
    size_t i = 0;

    if (!number || number[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    for (i = 0; number[i] != '\0'; i++) {
        char c = number[i];
        if ((c < '0' || c > '9') && c != '+' && c != '-' && c != '.' &&
            c != '*' && c != '#' && c != ',' && c != 'W' && c != 'P') {
            ESP_LOGW(TAG, "dial rejected invalid char '%c' in number", c);
            return ESP_ERR_INVALID_ARG;
        }
    }
    if (i >= sizeof(command) - 6) {
        return ESP_ERR_INVALID_SIZE;
    }

    err = modem_a7670_prepare_command(command, sizeof(command), "ATD", number, ";");
    if (err != ESP_OK) {
        return err;
    }
    if (modem_a7670_uart_control_blocked_locked()) {
        return ESP_ERR_INVALID_STATE;
    }

    return modem_a7670_command(command, response, response_len, timeout_ms);
}

esp_err_t modem_a7670_hangup(char *response, size_t response_len, uint32_t timeout_ms) {
    return modem_a7670_command("ATH", response, response_len, timeout_ms);
}

esp_err_t modem_a7670_send_ussd(
    const char *code,
    char *response,
    size_t response_len,
    uint32_t timeout_ms
) {
    char command[64] = {0};
    esp_err_t err = ESP_OK;
    int written = 0;
    size_t i = 0;

    if (!code || code[0] == '\0' || !response || response_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_uart_control_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    for (i = 0; code[i] != '\0'; i++) {
        char c = code[i];
        if ((c < '0' || c > '9') && c != '*' && c != '#') {
            ESP_LOGW(TAG, "ussd rejected invalid char '%c' in code", c);
            return ESP_ERR_INVALID_ARG;
        }
    }
    if (modem_a7670_uart_control_blocked_locked()) {
        return ESP_ERR_INVALID_STATE;
    }

    /* Robi chained replies require the same DCS as the root request.
     * Omitting ",15" on digit-only follow-ups leaves the session hanging. */
    written = snprintf(command, sizeof(command), "AT+CUSD=1,\"%s\",15", code);
    if (written < 0 || (size_t)written >= sizeof(command)) {
        return ESP_ERR_INVALID_SIZE;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    snprintf(s_last_ussd_code, sizeof(s_last_ussd_code), "%s", code);
    modem_a7670_clear_ussd_request_locked();
    err = modem_a7670_send_command_locked(command, response, response_len, timeout_ms, false);
    if (err == ESP_OK) {
        modem_a7670_arm_ussd_request_locked(timeout_ms);
        ESP_LOGI(TAG, "ussd accepted by modem code=%s", code);
    } else {
        modem_a7670_clear_ussd_request_locked();
        ESP_LOGW(TAG, "ussd request failed code=%s err=%s response=%s", code, esp_err_to_name(err), response);
    }

    xSemaphoreGive(s_lock);
    if (err == ESP_OK) {
        /* AT+CUSD can leave the modem CMQTT lane logically connected but unable
         * to deliver follow-up publishes. Force a reconnect after the modem
         * accepts the request so action results and later +CUSD menus publish
         * on a fresh MQTT session. */
        modem_a7670_mark_mqtt_desynced();
    }
    return err;
}

esp_err_t modem_a7670_cancel_ussd(char *response, size_t response_len, uint32_t timeout_ms) {
    char urc_buffer[UNIFIED_TEXT_MEDIUM_LEN] = {0};
    esp_err_t err = ESP_OK;

    if (!response || response_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_uart_control_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (modem_a7670_uart_control_blocked_locked()) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    response[0] = '\0';
    err = modem_a7670_send_command_locked("AT+CUSD=2", response, response_len, timeout_ms, false);
    if (err == ESP_OK) {
        const uint32_t wait_ms = timeout_ms == 0U
            ? MODEM_A7670_USSD_CANCEL_URC_WAIT_MS
            : (timeout_ms < MODEM_A7670_USSD_CANCEL_URC_WAIT_MS ? timeout_ms : MODEM_A7670_USSD_CANCEL_URC_WAIT_MS);
        const int64_t deadline_us = esp_timer_get_time() + ((int64_t)wait_ms * 1000LL);

        s_last_ussd_code[0] = '\0';
        modem_a7670_clear_ussd_request_locked();
        while (esp_timer_get_time() < deadline_us) {
            urc_buffer[0] = '\0';
            if (modem_a7670_read_until_quiet_locked(
                    urc_buffer,
                    sizeof(urc_buffer),
                    MODEM_A7670_USSD_CANCEL_POLL_QUIET_MS) == ESP_OK &&
                strstr(urc_buffer, "+CUSD:") != NULL) {
                ESP_LOGI(TAG, "ussd cancel completed");
                break;
            }

            vTaskDelay(pdMS_TO_TICKS(MODEM_A7670_USSD_CANCEL_IDLE_SLICE_MS));
        }
    }

    xSemaphoreGive(s_lock);
    return err;
}

esp_err_t modem_a7670_read_sms(int storage_index, unified_sms_payload_t *out_payload, uint32_t timeout_ms) {
    char response[MODEM_A7670_SMS_READ_RESPONSE_LEN] = {0};
    esp_err_t err = ESP_FAIL;

    if (storage_index < 0 || !out_payload) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_uart_control_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (modem_a7670_uart_control_blocked_locked()) {
        return ESP_ERR_INVALID_STATE;
    }

    int64_t deadline_us = modem_a7670_timeout_deadline_us(timeout_ms);
    uint32_t remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);

    if (remaining_timeout_ms == 0U || xSemaphoreTake(s_lock, pdMS_TO_TICKS(remaining_timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
    if (remaining_timeout_ms == 0U) {
        err = ESP_ERR_TIMEOUT;
    } else {
        err = modem_a7670_sms_set_charset_locked("UCS2", response, sizeof(response), remaining_timeout_ms);
    }
    if (err == ESP_OK) {
        remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
        if (remaining_timeout_ms == 0U) {
            err = ESP_ERR_TIMEOUT;
        } else {
            err = modem_a7670_sms_set_text_mode_locked(response, sizeof(response), remaining_timeout_ms);
        }
    }
    if (err == ESP_OK) {
        remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
        if (remaining_timeout_ms == 0U) {
            err = ESP_ERR_TIMEOUT;
        } else {
            err = modem_a7670_read_sms_locked(storage_index, out_payload, response, sizeof(response), deadline_us, true);
        }
    }

    xSemaphoreGive(s_lock);
    return err;
}

esp_err_t modem_a7670_consume_pending_sms(unified_sms_payload_t *out_payload, uint32_t timeout_ms) {
    char response[MODEM_A7670_SMS_READ_RESPONSE_LEN] = {0};
    esp_err_t err = ESP_FAIL;
    int sms_index = -1;
    int queued_sms_index = -1;

    if (!out_payload) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_uart_control_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (modem_a7670_uart_control_blocked_locked()) {
        return ESP_ERR_INVALID_STATE;
    }
    if (modem_a7670_pop_sms_index(&queued_sms_index)) {
        return modem_a7670_consume_sms_index(queued_sms_index, out_payload, timeout_ms);
    }

    int64_t deadline_us = modem_a7670_timeout_deadline_us(timeout_ms);
    uint32_t remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);

    if (remaining_timeout_ms == 0U || xSemaphoreTake(s_lock, pdMS_TO_TICKS(remaining_timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
    if (remaining_timeout_ms == 0U) {
        err = ESP_ERR_TIMEOUT;
    } else {
        err = modem_a7670_sms_set_charset_locked("UCS2", response, sizeof(response), remaining_timeout_ms);
    }
    if (err == ESP_OK) {
        remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
        if (remaining_timeout_ms == 0U) {
            err = ESP_ERR_TIMEOUT;
        } else {
            err = modem_a7670_sms_set_text_mode_locked(response, sizeof(response), remaining_timeout_ms);
        }
    }
    if (err == ESP_OK) {
        remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
        if (remaining_timeout_ms == 0U) {
            err = ESP_ERR_TIMEOUT;
        } else {
            err = modem_a7670_consume_concat_sms_locked(out_payload, response, sizeof(response), deadline_us);
        }
        if (err == ESP_ERR_NOT_FOUND) {
            response[0] = '\0';
            remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
            if (remaining_timeout_ms == 0U) {
                err = ESP_ERR_TIMEOUT;
            } else {
                err = modem_a7670_send_command_locked("AT+CMGL=\"REC UNREAD\"", response, sizeof(response), remaining_timeout_ms, false);
            }
            if (err == ESP_OK && modem_a7670_parse_sms_list_index(response, &sms_index)) {
                remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
                if (remaining_timeout_ms == 0U) {
                    err = ESP_ERR_TIMEOUT;
                } else {
                    err = modem_a7670_read_sms_locked(sms_index, out_payload, response, sizeof(response), deadline_us, true);
                }
            } else if (err == ESP_OK) {
                err = ESP_ERR_NOT_FOUND;
            }
        }
    }

    xSemaphoreGive(s_lock);
    return err;
}

esp_err_t modem_a7670_consume_sms_index(int storage_index, unified_sms_payload_t *out_payload, uint32_t timeout_ms) {
    char response[MODEM_A7670_SMS_READ_RESPONSE_LEN] = {0};
    int indexes[MODEM_A7670_SMS_MAX_SEGMENTS] = {0};
    size_t index_count = 0U;
    esp_err_t err = ESP_FAIL;

    if (storage_index < 0 || !out_payload) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_ready || !s_uart_control_ready || !s_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (modem_a7670_uart_control_blocked_locked()) {
        return ESP_ERR_INVALID_STATE;
    }

    int64_t deadline_us = modem_a7670_timeout_deadline_us(timeout_ms);
    uint32_t remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);

    if (remaining_timeout_ms == 0U || xSemaphoreTake(s_lock, pdMS_TO_TICKS(remaining_timeout_ms)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
    if (remaining_timeout_ms == 0U) {
        err = ESP_ERR_TIMEOUT;
    } else {
        err = modem_a7670_sms_set_charset_locked("UCS2", response, sizeof(response), remaining_timeout_ms);
    }
    if (err == ESP_OK) {
        remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
        if (remaining_timeout_ms == 0U) {
            err = ESP_ERR_TIMEOUT;
        } else {
            err = modem_a7670_sms_set_text_mode_locked(response, sizeof(response), remaining_timeout_ms);
        }
    }
    if (err == ESP_OK) {
        remaining_timeout_ms = modem_a7670_timeout_remaining_ms(deadline_us);
        if (remaining_timeout_ms == 0U) {
            err = ESP_ERR_TIMEOUT;
        } else {
            response[0] = '\0';
            err = modem_a7670_send_command_locked("AT+CCONCINDEX", response, sizeof(response), remaining_timeout_ms, false);
            if (err == ESP_OK &&
                modem_a7670_parse_concat_indexes(response, indexes, MODEM_A7670_SMS_MAX_SEGMENTS, &index_count) &&
                modem_a7670_concat_indexes_contain(indexes, index_count, storage_index)) {
                err = modem_a7670_consume_concat_sms_indexes_locked(
                    out_payload,
                    indexes,
                    index_count,
                    response,
                    sizeof(response),
                    deadline_us
                );
            } else {
                err = modem_a7670_read_sms_locked(storage_index, out_payload, response, sizeof(response), deadline_us, true);
            }
        }
    }

    xSemaphoreGive(s_lock);
    return err;
}
