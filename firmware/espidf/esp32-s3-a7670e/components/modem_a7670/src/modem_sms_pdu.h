#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

/* SMS-DELIVER only, TS 23.040/23.038. Caller owns output storage. Unsupported
 * binary/compressed/national-language messages stay on the modem for recovery. */
typedef struct {
    uint8_t first_octet, pid, dcs;
    char scts[24];
    bool has_concat;
    uint16_t concat_reference;
    uint8_t concat_reference_bits, part_index, part_count;
} modem_sms_pdu_t;

static inline int sms_pdu_nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

static inline bool sms_pdu_utf8(uint32_t cp, char *out, size_t cap, size_t *used) {
    size_t n = cp < 0x80U ? 1U : cp < 0x800U ? 2U : cp < 0x10000U ? 3U : 4U;
    if (cp == 0U || cp > 0x10FFFFU || (cp >= 0xD800U && cp <= 0xDFFFU) || *used + n >= cap) return false;
    if (n == 1U) out[(*used)++] = (char)cp;
    else {
        out[(*used)++] = (char)((n == 2U ? 0xC0U : n == 3U ? 0xE0U : 0xF0U) | (cp >> (6U * (n - 1U))));
        for (size_t i = n - 1U; i > 0U; --i) out[(*used)++] = (char)(0x80U | ((cp >> (6U * (i - 1U))) & 0x3FU));
    }
    out[*used] = '\0';
    return true;
}

static inline uint32_t sms_pdu_gsm_cp(uint8_t c, bool extension) {
    static const uint16_t low[32] = {
        0x40,0xA3,0x24,0xA5,0xE8,0xE9,0xF9,0xEC,0xF2,0xC7,0x0A,0xD8,0xF8,0x0D,0xC5,0xE5,
        0x394,0x5F,0x3A6,0x393,0x39B,0x3A9,0x3A0,0x3A8,0x3A3,0x398,0x39E,0,0xC6,0xE6,0xDF,0xC9
    };
    if (extension) {
        switch (c) {
            case 10: return 12; case 20: return '^'; case 40: return '{'; case 41: return '}';
            case 47: return '\\'; case 60: return '['; case 61: return '~'; case 62: return ']';
            case 64: return '|'; case 101: return 0x20AC; default: return 0;
        }
    }
    if (c < 32U) return low[c];
    switch (c) {
        case 36: return 0xA4; case 64: return 0xA1;
        case 91: return 0xC4; case 92: return 0xD6; case 93: return 0xD1; case 94: return 0xDC; case 95: return 0xA7;
        case 96: return 0xBF; case 123: return 0xE4; case 124: return 0xF6; case 125: return 0xF1; case 126: return 0xFC; case 127: return 0xE0;
        default: return c;
    }
}

static inline bool sms_pdu_gsm(const uint8_t *data, size_t bytes, size_t start,
        size_t count, char *out, size_t cap) {
    size_t used = 0;
    bool escaped = false;
    if (!cap || start + count * 7U > bytes * 8U) return false;
    out[0] = '\0';
    for (size_t i = 0; i < count; ++i) {
        size_t bit = start + i * 7U, pos = bit / 8U;
        unsigned value = (unsigned)data[pos] >> (bit % 8U);
        if (bit % 8U > 1U && pos + 1U < bytes) value |= (unsigned)data[pos + 1U] << (8U - bit % 8U);
        uint8_t c = (uint8_t)(value & 127U);
        if (!escaped && c == 27U) { escaped = true; continue; }
        if (!sms_pdu_utf8(sms_pdu_gsm_cp(c, escaped), out, cap, &used)) return false;
        escaped = false;
    }
    return !escaped;
}

static inline int sms_pdu_bcd(uint8_t b) {
    return (b & 15U) > 9U || (b >> 4U) > 9U ? -1 : (int)((b & 15U) * 10U + (b >> 4U));
}

static inline bool modem_sms_pdu_parse(const char *hex, size_t length,
        modem_sms_pdu_t *out, char *sender, size_t sender_cap, char *text, size_t text_cap) {
    uint8_t bytes[256];
    size_t n = length / 2U, p = 0U, ud_bytes, header_bytes = 0U, used = 0U;
    modem_sms_pdu_t meta = {0};
    if (out) memset(out, 0, sizeof(*out));
    if (sender && sender_cap) sender[0] = '\0';
    if (text && text_cap) text[0] = '\0';
    if (!hex || !out || !sender || !text || !sender_cap || !text_cap || !length || length % 2U || n > sizeof(bytes)) return false;
    for (size_t i = 0; i < n; ++i) {
        int hi = sms_pdu_nibble(hex[i * 2U]), lo = sms_pdu_nibble(hex[i * 2U + 1U]);
        if (hi < 0 || lo < 0) goto invalid;
        bytes[i] = (uint8_t)((hi << 4) | lo);
    }
    p = (size_t)bytes[0] + 1U;
    if (p + 3U > n) goto invalid;
    meta.first_octet = bytes[p++];
    if ((meta.first_octet & 3U) != 0U) goto invalid;
    size_t address_length = bytes[p++];
    uint8_t toa = bytes[p++];
    size_t address_bytes = (address_length + 1U) / 2U;
    if (!address_length || address_length > 20U || p + address_bytes + 10U > n || !(toa & 0x80U)) goto invalid;
    if ((toa & 0x70U) == 0x50U) {
        if (!sms_pdu_gsm(bytes + p, address_bytes, 0U, address_length * 4U / 7U, sender, sender_cap)) goto invalid;
    } else {
        if ((toa & 0x70U) == 0x10U && !sms_pdu_utf8('+', sender, sender_cap, &used)) goto invalid;
        for (size_t i = 0; i < address_length; ++i) {
            unsigned digit = ((unsigned)bytes[p + i / 2U] >> (i % 2U * 4U)) & 15U;
            if (digit > 9U || !sms_pdu_utf8('0' + digit, sender, sender_cap, &used)) goto invalid;
        }
    }
    p += address_bytes;
    meta.pid = bytes[p++]; meta.dcs = bytes[p++];
    /* General uncompressed alphabet, class coding, and message-waiting groups. */
    bool ucs2 = false;
    if ((meta.dcs & 0xC0U) == 0U) {
        if (meta.dcs & 0x20U) goto invalid;
        unsigned alphabet = (meta.dcs >> 2U) & 3U;
        if (alphabet != 0U && alphabet != 2U) goto invalid;
        ucs2 = alphabet == 2U;
    } else if ((meta.dcs & 0xF0U) == 0xF0U) {
        if (meta.dcs & 0x0CU) goto invalid;
    } else if ((meta.dcs & 0xC0U) == 0xC0U && (meta.dcs & 0x30U) != 0x30U) {
        if (meta.dcs & 4U) goto invalid;
        ucs2 = (meta.dcs & 0xF0U) == 0xE0U;
    } else goto invalid;
    int year = sms_pdu_bcd(bytes[p]), month = sms_pdu_bcd(bytes[p+1U]), day = sms_pdu_bcd(bytes[p+2U]);
    int hour = sms_pdu_bcd(bytes[p+3U]), minute = sms_pdu_bcd(bytes[p+4U]), second = sms_pdu_bcd(bytes[p+5U]);
    int zone = sms_pdu_bcd((uint8_t)(bytes[p+6U] & ~8U));
    static const int month_days[12] = {31,28,31,30,31,30,31,31,30,31,30,31};
    if (year < 0 || month < 1 || month > 12 || day < 1 || day > month_days[month-1] + (month == 2 && year % 4 == 0) || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 || zone < 0 || zone > 56) goto invalid;
    memcpy(meta.scts, "00/00/00,00:00:00+00", 21U);
    const int fields[7] = {year,month,day,hour,minute,second,zone};
    const size_t offsets[7] = {0U,3U,6U,9U,12U,15U,18U};
    for (size_t i=0U;i<7U;++i) {
        meta.scts[offsets[i]] = (char)('0' + fields[i]/10);
        meta.scts[offsets[i]+1U] = (char)('0' + fields[i]%10);
    }
    meta.scts[17] = (bytes[p+6U]&8U) ? '-' : '+';
    p += 7U;
    size_t udl = bytes[p++];
    ud_bytes = ucs2 ? udl : (udl * 7U + 7U) / 8U;
    if (ud_bytes > 140U || p + ud_bytes != n) goto invalid;
    if (meta.first_octet & 0x40U) {
        if (!ud_bytes) goto invalid;
        header_bytes = (size_t)bytes[p] + 1U;
        if (header_bytes > ud_bytes) goto invalid;
        size_t q = 1U;
        while (q < header_bytes) {
            if (q + 2U > header_bytes) goto invalid;
            uint8_t ie = bytes[p+q++], len = bytes[p+q++];
            if (q + len > header_bytes || meta.has_concat) goto invalid;
            if (ie == 0U && len == 3U) {
                meta.concat_reference = bytes[p+q]; meta.concat_reference_bits = 8U;
            } else if (ie == 8U && len == 4U) {
                meta.concat_reference = (uint16_t)((unsigned)bytes[p+q] * 256U + bytes[p+q+1U]); meta.concat_reference_bits = 16U;
            } else goto invalid;
            meta.has_concat = true;
            meta.part_count = bytes[p+q+len-2U]; meta.part_index = bytes[p+q+len-1U];
            if (!meta.part_count || !meta.part_index || meta.part_index > meta.part_count) goto invalid;
            q += len;
        }
    }
    if (ucs2) {
        if ((ud_bytes - header_bytes) % 2U) goto invalid;
        used = 0U;
        for (size_t i = header_bytes; i < ud_bytes; i += 2U) {
            uint32_t cp = (uint32_t)bytes[p+i] * 256U + bytes[p+i+1U];
            if (cp >= 0xD800U && cp <= 0xDBFFU) {
                if (i + 3U >= ud_bytes) goto invalid;
                uint32_t low = (uint32_t)bytes[p+i+2U] * 256U + bytes[p+i+3U];
                if (low < 0xDC00U || low > 0xDFFFU) goto invalid;
                cp = 0x10000U + (cp - 0xD800U) * 1024U + low - 0xDC00U; i += 2U;
            }
            if (!sms_pdu_utf8(cp, text, text_cap, &used)) goto invalid;
        }
    } else {
        size_t header_septets = (header_bytes * 8U + 6U) / 7U;
        if (header_septets > udl || !sms_pdu_gsm(bytes+p, ud_bytes, header_septets*7U, udl-header_septets, text, text_cap)) goto invalid;
    }
    *out = meta;
    return true;
invalid:
    sender[0] = '\0'; text[0] = '\0';
    return false;
}
