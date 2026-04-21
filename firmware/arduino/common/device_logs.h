#pragma once

#include <Arduino.h>
#include <FS.h>
#include <SPIFFS.h>
#include <stdarg.h>
#include "config.h"
#include "mqtt_client.h"

#ifndef DEVICE_LOG_FILE_MAX_BYTES
#  define DEVICE_LOG_FILE_MAX_BYTES 131072UL
#endif

#ifndef DEVICE_LOG_MAX_READ_BYTES
#  define DEVICE_LOG_MAX_READ_BYTES 768
#endif

static const char* DEVICE_LOG_ACTIVE_PATH = "/device.log";
static const char* DEVICE_LOG_ARCHIVE_PATH = "/device.log.1";

static bool _deviceLogMounted = false;
static char _deviceLogLastError[96] = "";

inline void _deviceLogSetError(const char* message) {
    if (!message) {
        _deviceLogLastError[0] = '\0';
        return;
    }
    strncpy(_deviceLogLastError, message, sizeof(_deviceLogLastError) - 1);
    _deviceLogLastError[sizeof(_deviceLogLastError) - 1] = '\0';
}

inline const char* deviceLogLastError() {
    return _deviceLogLastError[0] ? _deviceLogLastError : nullptr;
}

inline bool deviceLogInit() {
    if (_deviceLogMounted) return true;

    if (SPIFFS.begin(false)) {
        _deviceLogMounted = true;
        _deviceLogSetError(nullptr);
        Serial.printf("[DLOG] SPIFFS mounted total=%u used=%u free=%u\n",
                      (unsigned int)SPIFFS.totalBytes(),
                      (unsigned int)SPIFFS.usedBytes(),
                      (unsigned int)(SPIFFS.totalBytes() - SPIFFS.usedBytes()));
        return true;
    }

    Serial.println("[DLOG] SPIFFS mount failed, trying one-time format");
    if (SPIFFS.begin(true)) {
        _deviceLogMounted = true;
        _deviceLogSetError(nullptr);
        Serial.printf("[DLOG] SPIFFS formatted and mounted total=%u used=%u free=%u\n",
                      (unsigned int)SPIFFS.totalBytes(),
                      (unsigned int)SPIFFS.usedBytes(),
                      (unsigned int)(SPIFFS.totalBytes() - SPIFFS.usedBytes()));
        return true;
    }

    _deviceLogMounted = false;
    _deviceLogSetError("spiffs mount failed");
    Serial.println("[DLOG] SPIFFS mount failed");
    return false;
}

inline bool deviceLogAvailable() {
    return _deviceLogMounted || deviceLogInit();
}

inline size_t deviceLogTotalBytes() {
    if (!deviceLogAvailable()) return 0;
    return SPIFFS.totalBytes();
}

inline size_t deviceLogUsedBytes() {
    if (!deviceLogAvailable()) return 0;
    return SPIFFS.usedBytes();
}

inline size_t deviceLogFreeBytes() {
    const size_t total = deviceLogTotalBytes();
    const size_t used = deviceLogUsedBytes();
    return total > used ? (total - used) : 0;
}

inline size_t _deviceLogFileSize(const char* path) {
    if (!deviceLogAvailable()) return 0;
    File file = SPIFFS.open(path, FILE_READ);
    if (!file) return 0;
    const size_t size = file.size();
    file.close();
    return size;
}

inline void _deviceLogSanitize(const char* src, char* dst, size_t dstLen) {
    if (!dst || dstLen == 0) return;

    size_t di = 0;
    const uint8_t* cursor = reinterpret_cast<const uint8_t*>(src ? src : "");
    while (*cursor && di < dstLen - 1) {
        uint8_t c = *cursor++;
        if (c == '\r' || c == '\n' || c == '\t') {
            dst[di++] = ' ';
            continue;
        }
        if (c < 0x20) {
            dst[di++] = '?';
            continue;
        }
        dst[di++] = (char)c;
    }
    dst[di] = '\0';
}

inline bool _deviceLogRotateIfNeeded(size_t incomingBytes) {
    if (!deviceLogAvailable()) return false;

    const size_t activeSize = _deviceLogFileSize(DEVICE_LOG_ACTIVE_PATH);
    if (activeSize + incomingBytes <= DEVICE_LOG_FILE_MAX_BYTES) {
        return true;
    }

    if (SPIFFS.exists(DEVICE_LOG_ARCHIVE_PATH) && !SPIFFS.remove(DEVICE_LOG_ARCHIVE_PATH)) {
        _deviceLogSetError("archive remove failed");
        return false;
    }

    if (SPIFFS.exists(DEVICE_LOG_ACTIVE_PATH) &&
        !SPIFFS.rename(DEVICE_LOG_ACTIVE_PATH, DEVICE_LOG_ARCHIVE_PATH)) {
        _deviceLogSetError("rotate rename failed");
        return false;
    }

    _deviceLogSetError(nullptr);
    Serial.println("[DLOG] Rotated active log into archive");
    return true;
}

inline bool deviceLogAppend(const char* category, const char* message) {
    if (!deviceLogAvailable()) return false;

    char cleanCategory[24];
    char cleanMessage[320];
    char line[384];
    _deviceLogSanitize(category && category[0] ? category : "event", cleanCategory, sizeof(cleanCategory));
    _deviceLogSanitize(message, cleanMessage, sizeof(cleanMessage));

    const int lineLen = snprintf(line, sizeof(line), "%lu|%s|%s\n",
                                 (unsigned long)millis(), cleanCategory, cleanMessage);
    if (lineLen <= 0 || (size_t)lineLen >= sizeof(line)) {
        _deviceLogSetError("line build failed");
        return false;
    }

    if (!_deviceLogRotateIfNeeded((size_t)lineLen)) {
        return false;
    }

    File file = SPIFFS.open(DEVICE_LOG_ACTIVE_PATH, FILE_APPEND);
    if (!file) {
        _deviceLogSetError("open failed");
        return false;
    }

    const size_t written = file.write(reinterpret_cast<const uint8_t*>(line), (size_t)lineLen);
    file.close();
    if (written != (size_t)lineLen) {
        _deviceLogSetError("write incomplete");
        return false;
    }

    _deviceLogSetError(nullptr);
    return true;
}

inline bool deviceLogPrintf(const char* category, const char* fmt, ...) {
    char message[320];
    va_list args;
    va_start(args, fmt);
    const int written = vsnprintf(message, sizeof(message), fmt, args);
    va_end(args);
    if (written < 0) {
        _deviceLogSetError("format failed");
        return false;
    }
    return deviceLogAppend(category, message);
}

inline bool deviceLogReadRaw(bool archive, size_t offset, size_t maxBytes,
                             char* out, size_t outLen,
                             size_t* outActual = nullptr,
                             size_t* outFileSize = nullptr) {
    if (!out || outLen == 0) return false;
    out[0] = '\0';

    if (!deviceLogAvailable()) return false;

    const char* path = archive ? DEVICE_LOG_ARCHIVE_PATH : DEVICE_LOG_ACTIVE_PATH;
    File file = SPIFFS.open(path, FILE_READ);
    if (!file) {
        _deviceLogSetError("log file missing");
        if (outActual) *outActual = 0;
        if (outFileSize) *outFileSize = 0;
        return false;
    }

    const size_t fileSize = file.size();
    if (outFileSize) *outFileSize = fileSize;
    if (offset > fileSize) offset = fileSize;

    size_t toRead = maxBytes == 0 ? 1 : maxBytes;
    if (toRead > outLen - 1) toRead = outLen - 1;
    if (offset + toRead > fileSize) {
        toRead = fileSize > offset ? (fileSize - offset) : 0;
    }

    if (offset > 0 && !file.seek(offset, SeekSet)) {
        file.close();
        _deviceLogSetError("seek failed");
        if (outActual) *outActual = 0;
        return false;
    }

    const size_t actual = toRead ? file.readBytes(out, toRead) : 0;
    file.close();
    out[actual] = '\0';

    if (outActual) *outActual = actual;
    _deviceLogSetError(nullptr);
    return true;
}

inline void _deviceLogBase64Encode(const uint8_t* src, size_t srcLen, char* out, size_t outLen) {
    static const char kBase64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t si = 0;
    size_t oi = 0;
    while (si < srcLen && oi + 4 < outLen) {
        const uint32_t v = ((uint32_t)src[si] << 16)
                         | ((si + 1 < srcLen ? (uint32_t)src[si + 1] : 0) << 8)
                         |  (si + 2 < srcLen ? (uint32_t)src[si + 2] : 0);
        out[oi++] = kBase64[(v >> 18) & 0x3F];
        out[oi++] = kBase64[(v >> 12) & 0x3F];
        out[oi++] = (si + 1 < srcLen) ? kBase64[(v >> 6) & 0x3F] : '=';
        out[oi++] = (si + 2 < srcLen) ? kBase64[v & 0x3F] : '=';
        si += 3;
    }
    out[oi] = '\0';
}

inline void deviceLogInfo(const char* deviceId, const char* msgId) {
    char topic[TOPIC_BUF_SIZE];
    snprintf(topic, sizeof(topic), "device/%s/device-log/info", deviceId);

    if (!deviceLogAvailable()) {
        char payload[320];
        snprintf(payload, sizeof(payload),
                 "{\"mounted\":false,\"filesystem\":null,\"total\":0,\"used\":0,\"free\":0,"
                 "\"activeBytes\":0,\"archiveBytes\":0,\"maxFileBytes\":%lu,"
                 "\"lastError\":\"%s\",\"messageId\":\"%s\"}",
                 (unsigned long)DEVICE_LOG_FILE_MAX_BYTES,
                 deviceLogLastError() ? deviceLogLastError() : "spiffs unavailable",
                 msgId ? msgId : "");
        mqttPublish(topic, payload, 1);
        return;
    }

    char payload[512];
    snprintf(payload, sizeof(payload),
             "{\"mounted\":true,\"filesystem\":\"SPIFFS\",\"total\":%u,\"used\":%u,\"free\":%u,"
             "\"activeBytes\":%u,\"archiveBytes\":%u,\"maxFileBytes\":%lu,\"retentionBytes\":%lu,"
             "\"lastError\":null,\"messageId\":\"%s\"}",
             (unsigned int)deviceLogTotalBytes(),
             (unsigned int)deviceLogUsedBytes(),
             (unsigned int)deviceLogFreeBytes(),
             (unsigned int)_deviceLogFileSize(DEVICE_LOG_ACTIVE_PATH),
             (unsigned int)_deviceLogFileSize(DEVICE_LOG_ARCHIVE_PATH),
             (unsigned long)DEVICE_LOG_FILE_MAX_BYTES,
             (unsigned long)(DEVICE_LOG_FILE_MAX_BYTES * 2UL),
             msgId ? msgId : "");
    mqttPublish(topic, payload, 1);
}

inline void deviceLogRead(bool archive, size_t offset, size_t maxBytes,
                          const char* deviceId, const char* msgId) {
    char topic[TOPIC_BUF_SIZE];
    snprintf(topic, sizeof(topic), "device/%s/device-log/read", deviceId);

    const size_t cappedRead = maxBytes > DEVICE_LOG_MAX_READ_BYTES ? DEVICE_LOG_MAX_READ_BYTES : maxBytes;
    char raw[DEVICE_LOG_MAX_READ_BYTES + 1];
    size_t actual = 0;
    size_t fileSize = 0;
    if (!deviceLogReadRaw(archive, offset, cappedRead ? cappedRead : DEVICE_LOG_MAX_READ_BYTES,
                          raw, sizeof(raw), &actual, &fileSize)) {
        char payload[256];
        snprintf(payload, sizeof(payload),
                 "{\"archive\":%s,\"offset\":%u,\"error\":\"%s\",\"messageId\":\"%s\"}",
                 archive ? "true" : "false",
                 (unsigned int)offset,
                 deviceLogLastError() ? deviceLogLastError() : "read failed",
                 msgId ? msgId : "");
        mqttPublish(topic, payload, 1);
        return;
    }

    char encoded[((DEVICE_LOG_MAX_READ_BYTES + 2) / 3) * 4 + 4];
    _deviceLogBase64Encode(reinterpret_cast<const uint8_t*>(raw), actual, encoded, sizeof(encoded));

    char payload[JSON_BUF_SIZE];
    snprintf(payload, sizeof(payload),
             "{\"archive\":%s,\"offset\":%u,\"bytes\":%u,\"size\":%u,"
             "\"encoding\":\"base64\",\"data\":\"%s\",\"messageId\":\"%s\"}",
             archive ? "true" : "false",
             (unsigned int)offset,
             (unsigned int)actual,
             (unsigned int)fileSize,
             encoded,
             msgId ? msgId : "");
    mqttPublish(topic, payload, 1);
}

inline bool deviceLogClearFiles() {
    if (!deviceLogAvailable()) return false;

    bool ok = true;
    if (SPIFFS.exists(DEVICE_LOG_ACTIVE_PATH)) {
        ok = SPIFFS.remove(DEVICE_LOG_ACTIVE_PATH) && ok;
    }
    if (SPIFFS.exists(DEVICE_LOG_ARCHIVE_PATH)) {
        ok = SPIFFS.remove(DEVICE_LOG_ARCHIVE_PATH) && ok;
    }

    _deviceLogSetError(ok ? nullptr : "clear failed");
    return ok;
}

inline bool deviceLogClear(const char* deviceId, const char* msgId) {
    char topic[TOPIC_BUF_SIZE];
    snprintf(topic, sizeof(topic), "device/%s/device-log/clear", deviceId);

    const bool ok = deviceLogClearFiles();
    char payload[192];
    snprintf(payload, sizeof(payload),
             "{\"success\":%s,\"messageId\":\"%s\",\"lastError\":%s}",
             ok ? "true" : "false",
             msgId ? msgId : "",
             ok ? "null" : "\"clear failed\"");
    mqttPublish(topic, payload, 1);
    return ok;
}
