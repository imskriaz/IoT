#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

/* CMGR has distinct DELIVER/SUBMIT and STATUS-REPORT layouts. In text mode
 * the address follows stat for a message; a numeric first octet follows stat
 * for a report. Searching for the next quote confuses a report with a message. */
static inline const char *modem_sms_cmgr_fields(const char *response) {
    const char *p = response ? strstr(response, "+CMGR:") : NULL;
    if (!p) return NULL;
    p += 6;
    while (*p == ' ') ++p;
    if (*p++ != '"') return NULL;
    p = strchr(p, '"');
    if (!p) return NULL;
    ++p;
    while (*p == ' ') ++p;
    if (*p++ != ',') return NULL;
    while (*p == ' ') ++p;
    return p;
}

static inline bool modem_sms_cmgr_is_message(const char *response) {
    const char *p = modem_sms_cmgr_fields(response);
    return p && *p == '"';
}

static inline bool modem_sms_cmgr_number(const char **cursor, unsigned max, unsigned *value) {
    const char *p = *cursor;
    while (*p == ' ') ++p;
    if (*p < '0' || *p > '9') return false;
    char *end = NULL;
    unsigned long n = strtoul(p, &end, 10);
    if (n > max) return false;
    while (*end == ' ') ++end;
    if (*end != ',') return false;
    *value = (unsigned)n;
    *cursor = end + 1;
    return true;
}

static inline bool modem_sms_cmgr_quoted(const char **cursor, char *dest, size_t capacity) {
    const char *p = *cursor;
    while (*p == ' ') ++p;
    if (*p++ != '"') return false;
    const char *end = strchr(p, '"');
    if (!end || memchr(p, '\r', (size_t)(end - p)) || memchr(p, '\n', (size_t)(end - p))) return false;
    if (dest) {
        if ((size_t)(end - p) >= capacity) return false;
        memcpy(dest, p, (size_t)(end - p));
        dest[end - p] = '\0';
    }
    ++end;
    while (*end == ' ') ++end;
    if (*end != ',') return false;
    *cursor = end + 1;
    return true;
}

static inline bool modem_sms_cmgr_parse_report(
    const char *response, char *recipient, size_t recipient_len,
    unsigned *reference, unsigned *status
) {
    const char *p = modem_sms_cmgr_fields(response);
    unsigned fo = 0, tora = 0;
    if (!p || !modem_sms_cmgr_number(&p, 255U, &fo) || (fo & 3U) != 2U ||
        !modem_sms_cmgr_number(&p, 255U, reference) ||
        !modem_sms_cmgr_quoted(&p, recipient, recipient_len) ||
        !modem_sms_cmgr_number(&p, 255U, &tora) ||
        !modem_sms_cmgr_quoted(&p, NULL, 0U) ||
        !modem_sms_cmgr_quoted(&p, NULL, 0U)) return false;
    while (*p == ' ') ++p;
    if (*p < '0' || *p > '9') return false;
    char *end = NULL;
    unsigned long st = strtoul(p, &end, 10);
    while (*end == ' ') ++end;
    if (st > 255U || (*end != '\r' && *end != '\n')) return false;
    while (*end == '\r' || *end == '\n' || *end == ' ') ++end;
    if (strncmp(end, "OK", 2U) != 0 || (end[2] != '\r' && end[2] != '\n' && end[2] != '\0')) return false;
    *status = (unsigned)st;
    return true;
}
