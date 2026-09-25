#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <string.h>

/* cJSON exposes decoded strings as C strings without their decoded lengths.
 * Reject both wire NUL and decoded U+0000 before parsing can hide a suffix in
 * an identity, object key or payload value. This is not a JSON syntax check;
 * callers must still parse the complete text and reject trailing content.
 * length excludes any caller-added terminator and must be the wire length at
 * ingress. The walk is bounded, allocation-free and preserves literal \\u0000
 * text: an escaped backslash consumes its partner, not the following 'u'. */
static inline bool unified_json_text_is_cstring_safe(const char *text, size_t length) {
    bool in_string = false;
    if (!text || length == 0U || memchr(text, '\0', length)) {
        return false;
    }
    for (size_t i = 0U; i < length; ++i) {
        if (text[i] == '"') {
            in_string = !in_string;
        } else if (in_string && text[i] == '\\' && length - i >= 2U) {
            if (length - i >= 6U && text[i + 1U] == 'u' &&
                text[i + 2U] == '0' && text[i + 3U] == '0' &&
                text[i + 4U] == '0' && text[i + 5U] == '0') {
                return false;
            }
            ++i;
        }
    }
    return true;
}
