#pragma once
// SD card file-system layer (SD_MMC 1-bit mode).
// Verified on this board with vendor pins:
//   CLK=5 CMD=4 D0=6 CD=46

#include <Arduino.h>
#include <SD_MMC.h>
#include "config.h"

static bool _sdPresent = false;
static char _storageLastError[96] = "";
static unsigned long _sdLastInitAttemptMs = 0;
static unsigned long _sdLastFailureLogMs = 0;

inline void _storageSetError(const char* message) {
    if (!message) {
        _storageLastError[0] = '\0';
        return;
    }
    strncpy(_storageLastError, message, sizeof(_storageLastError) - 1);
    _storageLastError[sizeof(_storageLastError) - 1] = '\0';
}

inline const char* storageLastError() {
    return _storageLastError[0] ? _storageLastError : nullptr;
}

inline uint8_t storageCardType() {
    return _sdPresent ? SD_MMC.cardType() : CARD_NONE;
}

inline uint64_t storageCardSizeBytes() {
    return _sdPresent ? SD_MMC.cardSize() : 0ULL;
}

inline bool storageInit() {
    _sdLastInitAttemptMs = millis();
    SD_MMC.end();

    bool pinsOk = SD_MMC.setPins(SDMMC_CLK_PIN, SDMMC_CMD_PIN, SDMMC_D0_PIN);
    _sdPresent = pinsOk && SD_MMC.begin("/sdcard", true, false);
    if (!_sdPresent && pinsOk) {
        SD_MMC.end();
        _sdPresent = SD_MMC.begin("/sdcard", true, true);
    }

    if (_sdPresent) {
        _storageSetError(nullptr);
        _sdLastFailureLogMs = 0;
        Serial.printf("[SD] Card OK  Type=%d  Size=%lluMB  Bus=SD_MMC  Pins clk=%d cmd=%d d0=%d\n",
                      SD_MMC.cardType(),
                      SD_MMC.cardSize() / (1024ULL * 1024ULL),
                      SDMMC_CLK_PIN, SDMMC_CMD_PIN, SDMMC_D0_PIN);
    } else {
        _storageSetError(pinsOk ? "sdmmc mount failed or no card" : "sdmmc pin setup failed");
        const unsigned long now = millis();
        if (_sdLastFailureLogMs == 0 || now - _sdLastFailureLogMs >= 30000UL) {
            Serial.println("[SD] No card or SD_MMC init failed - storage commands disabled");
            _sdLastFailureLogMs = now;
        }
    }
    return _sdPresent;
}

inline bool storageTryMount(bool force = false) {
    if (_sdPresent) return true;
    if (!force) {
        unsigned long now = millis();
        if (now - _sdLastInitAttemptMs < 10000UL) {
            return false;
        }
    }

    SD_MMC.end();
    return storageInit();
}

inline bool storagePresent() {
    storageTryMount(false);
    return _sdPresent;
}

static void _sdNormPath(const char* in, char* out, int outLen) {
    if (!in || !in[0]) { strncpy(out, "/", outLen); return; }
    if (in[0] == '/') { strncpy(out, in, outLen); }
    else              { snprintf(out, outLen, "/%s", in); }
    out[outLen - 1] = '\0';
}

static bool _sdIsSafePath(const char* path) {
    if (!path || !path[0]) return false;
    if (strstr(path, "..")) return false;
    if (strchr(path, ':')) return false;
    return true;
}

static void _sdParentPath(const char* path, char* out, int outLen) {
    strncpy(out, path && path[0] ? path : "/", outLen - 1);
    out[outLen - 1] = '\0';
    char* slash = strrchr(out, '/');
    if (!slash || slash == out) {
        strncpy(out, "/", outLen - 1);
        out[outLen - 1] = '\0';
        return;
    }
    *slash = '\0';
}

static bool _sdEnsureDirRecursive(const char* path) {
    if (!path || !path[0] || strcmp(path, "/") == 0) return true;
    if (SD_MMC.exists(path)) return true;

    char parent[160];
    _sdParentPath(path, parent, sizeof(parent));
    if (!_sdEnsureDirRecursive(parent)) return false;
    return SD_MMC.mkdir(path);
}

inline bool _storageDeleteRecursive(const char* path) {
    File node = SD_MMC.open(path);
    if (!node) return false;

    if (!node.isDirectory()) {
        node.close();
        return SD_MMC.remove(path);
    }

    while (true) {
        File entry = node.openNextFile();
        if (!entry) break;

        char childPath[192];
        if (strcmp(path, "/") == 0) snprintf(childPath, sizeof(childPath), "/%s", entry.name());
        else snprintf(childPath, sizeof(childPath), "%s/%s", path, entry.name());

        bool childOk = false;
        if (entry.isDirectory()) {
            entry.close();
            childOk = _storageDeleteRecursive(childPath);
        } else {
            entry.close();
            childOk = SD_MMC.remove(childPath);
        }

        if (!childOk) {
            node.close();
            return false;
        }
    }

    node.close();
    if (strcmp(path, "/") == 0) return true;
    return SD_MMC.rmdir(path);
}

static bool _sdCopyRecursive(const char* source, const char* destination) {
    File node = SD_MMC.open(source);
    if (!node) return false;

    if (!node.isDirectory()) {
        char parent[160];
        _sdParentPath(destination, parent, sizeof(parent));
        if (!_sdEnsureDirRecursive(parent)) {
            node.close();
            return false;
        }

        if (SD_MMC.exists(destination) && !SD_MMC.remove(destination)) {
            node.close();
            return false;
        }

        File target = SD_MMC.open(destination, FILE_WRITE);
        if (!target) {
            node.close();
            return false;
        }

        uint8_t buffer[256];
        while (node.available()) {
            int readLen = node.read(buffer, sizeof(buffer));
            if (readLen <= 0) break;
            if (target.write(buffer, readLen) != readLen) {
                target.close();
                node.close();
                return false;
            }
        }

        target.close();
        node.close();
        return true;
    }

    node.close();
    if (!_sdEnsureDirRecursive(destination)) return false;

    File dir = SD_MMC.open(source);
    if (!dir || !dir.isDirectory()) return false;

    while (true) {
        File entry = dir.openNextFile();
        if (!entry) break;

        char srcChild[192];
        char dstChild[192];
        if (strcmp(source, "/") == 0) snprintf(srcChild, sizeof(srcChild), "/%s", entry.name());
        else snprintf(srcChild, sizeof(srcChild), "%s/%s", source, entry.name());

        if (strcmp(destination, "/") == 0) snprintf(dstChild, sizeof(dstChild), "/%s", entry.name());
        else snprintf(dstChild, sizeof(dstChild), "%s/%s", destination, entry.name());

        entry.close();
        if (!_sdCopyRecursive(srcChild, dstChild)) {
            dir.close();
            return false;
        }
    }

    dir.close();
    return true;
}

inline void storageInfo(const char* deviceId, const char* msgId) {
    char topic[TOPIC_BUF_SIZE];
    snprintf(topic, sizeof(topic), "device/%s/storage/info", deviceId);

    storageTryMount(false);

    if (!_sdPresent) {
        char payload[320];
        const char* lastError = storageLastError();
        snprintf(payload, sizeof(payload),
                 "{\"mounted\":false,\"cardDetected\":false,\"total\":0,\"used\":0,\"free\":0,"
                 "\"filesystem\":null,\"type\":\"SD Card\",\"lastError\":\"%s\",\"messageId\":\"%s\"}",
                 lastError ? lastError : "no sd card", msgId ? msgId : "");
        mqttPublish(topic, payload, 1);
        return;
    }

    const uint64_t totalBytes = SD_MMC.totalBytes();
    const uint64_t usedBytes = SD_MMC.usedBytes();
    const uint64_t freeBytes = totalBytes > usedBytes ? (totalBytes - usedBytes) : 0;
    const uint8_t cardType = SD_MMC.cardType();
    const char* cardTypeName = "Unknown";
    switch (cardType) {
        case CARD_MMC:  cardTypeName = "MMC"; break;
        case CARD_SD:   cardTypeName = "SDSC"; break;
        case CARD_SDHC: cardTypeName = "SDHC/SDXC"; break;
        default: break;
    }

    char payload[512];
    snprintf(payload, sizeof(payload),
             "{\"mounted\":true,\"cardDetected\":true,\"total\":%llu,\"used\":%llu,\"free\":%llu,"
             "\"filesystem\":\"FAT32\",\"type\":\"SD Card\",\"cardType\":\"%s\",\"bus\":\"SD_MMC\","
             "\"pins\":{\"clk\":%d,\"cmd\":%d,\"d0\":%d,\"cd\":%d},\"lastError\":null,\"messageId\":\"%s\"}",
             totalBytes, usedBytes, freeBytes, cardTypeName,
             SDMMC_CLK_PIN, SDMMC_CMD_PIN, SDMMC_D0_PIN, SDMMC_CD_PIN, msgId ? msgId : "");
    _storageSetError(nullptr);
    mqttPublish(topic, payload, 1);
}

inline void storageList(const char* path, const char* deviceId, const char* msgId) {
    char normPath[128];
    _sdNormPath(path, normPath, sizeof(normPath));

    char topic[TOPIC_BUF_SIZE];
    snprintf(topic, sizeof(topic), "device/%s/storage/list", deviceId);

    storageTryMount(false);

    if (!_sdPresent) {
        _storageSetError("no sd card");
        char p[96];
        snprintf(p, sizeof(p), "{\"error\":\"no sd card\",\"messageId\":\"%s\"}", msgId ? msgId : "");
        mqttPublish(topic, p, 1);
        return;
    }

    File dir = SD_MMC.open(normPath);
    if (!dir || !dir.isDirectory()) {
        _storageSetError("not a directory");
        char p[128];
        snprintf(p, sizeof(p), "{\"error\":\"not a directory\",\"path\":\"%s\",\"messageId\":\"%s\"}",
                 normPath, msgId ? msgId : "");
        mqttPublish(topic, p, 1);
        if (dir) dir.close();
        return;
    }

    char buf[1024];
    int pos = snprintf(buf, sizeof(buf),
                       "{\"path\":\"%s\",\"messageId\":\"%s\",\"entries\":[", normPath, msgId ? msgId : "");
    bool first = true;
    while (true) {
        File entry = dir.openNextFile();
        if (!entry) break;
        char entryPath[180];
        if (strcmp(normPath, "/") == 0) snprintf(entryPath, sizeof(entryPath), "%s", entry.name());
        else snprintf(entryPath, sizeof(entryPath), "%s/%s", normPath + 1, entry.name());
        int used = snprintf(buf + pos, sizeof(buf) - pos,
                            "%s{\"name\":\"%s\",\"path\":\"%s\",\"size\":%lu,\"dir\":%s}",
                            first ? "" : ",",
                            entry.name(),
                            entryPath,
                            (unsigned long)entry.size(),
                            entry.isDirectory() ? "true" : "false");
        entry.close();
        if (pos + used >= (int)sizeof(buf) - 4) break;
        pos += used;
        first = false;
    }
    dir.close();
    _storageSetError(nullptr);
    snprintf(buf + pos, sizeof(buf) - pos, "]}");
    mqttPublish(topic, buf, 1);
}

inline void storageRead(const char* path, const char* deviceId, const char* msgId,
                        int offset = 0, int maxBytes = 512) {
    char normPath[128];
    _sdNormPath(path, normPath, sizeof(normPath));

    char topic[TOPIC_BUF_SIZE];
    snprintf(topic, sizeof(topic), "device/%s/storage/read", deviceId);

    storageTryMount(false);

    if (!_sdPresent) {
        _storageSetError("no sd card");
        char p[96];
        snprintf(p, sizeof(p), "{\"error\":\"no sd card\",\"messageId\":\"%s\"}", msgId ? msgId : "");
        mqttPublish(topic, p, 1);
        return;
    }

    File f = SD_MMC.open(normPath, FILE_READ);
    if (!f) {
        _storageSetError("file not found");
        char p[160];
        snprintf(p, sizeof(p), "{\"error\":\"file not found\",\"path\":\"%s\",\"messageId\":\"%s\"}",
                 normPath, msgId ? msgId : "");
        mqttPublish(topic, p, 1);
        return;
    }

    long fileSize = f.size();
    if (offset < 0) offset = 0;
    if (offset >= fileSize) {
        f.close();
        _storageSetError("offset out of range");
        char p[160];
        snprintf(p, sizeof(p), "{\"error\":\"offset out of range\",\"path\":\"%s\",\"messageId\":\"%s\"}",
                 normPath, msgId ? msgId : "");
        mqttPublish(topic, p, 1);
        return;
    }
    if (offset > 0) f.seek(offset);

    int toRead = (maxBytes < 512) ? maxBytes : 512;
    if (toRead < 1) toRead = 1;
    long remaining = fileSize - offset;
    if (remaining < toRead) toRead = (int)remaining;

    uint8_t raw[512];
    int actual = f.read(raw, toRead);
    f.close();

    static const char b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    char encoded[700];
    int ei = 0;
    for (int i = 0; i < actual; i += 3) {
        uint32_t v = ((uint32_t)raw[i] << 16)
                   | (i + 1 < actual ? (uint32_t)raw[i + 1] << 8 : 0)
                   | (i + 2 < actual ? (uint32_t)raw[i + 2]      : 0);
        encoded[ei++] = b64[(v >> 18) & 63];
        encoded[ei++] = b64[(v >> 12) & 63];
        encoded[ei++] = (i + 1 < actual) ? b64[(v >> 6) & 63] : '=';
        encoded[ei++] = (i + 2 < actual) ? b64[v & 63]        : '=';
    }
    encoded[ei] = '\0';

    char buf[1024];
    snprintf(buf, sizeof(buf),
             "{\"path\":\"%s\",\"size\":%ld,\"offset\":%d,\"bytes\":%d,"
             "\"encoding\":\"base64\",\"data\":\"%s\",\"messageId\":\"%s\"}",
             normPath, fileSize, offset, actual, encoded, msgId ? msgId : "");
    _storageSetError(nullptr);
    mqttPublish(topic, buf, 1);
}

inline bool storageWrite(const char* path, const char* data, int dataLen,
                         bool append, const char* deviceId, const char* msgId) {
    char normPath[128];
    _sdNormPath(path, normPath, sizeof(normPath));

    char topic[TOPIC_BUF_SIZE];
    snprintf(topic, sizeof(topic), "device/%s/storage/write", deviceId);

    storageTryMount(false);

    if (!_sdPresent) {
        _storageSetError("no sd card");
        char p[96];
        snprintf(p, sizeof(p), "{\"error\":\"no sd card\",\"messageId\":\"%s\"}", msgId ? msgId : "");
        mqttPublish(topic, p, 1);
        return false;
    }

    char parent[160];
    _sdParentPath(normPath, parent, sizeof(parent));
    if (!_sdEnsureDirRecursive(parent)) {
        _storageSetError("mkdir failed");
        char p[160];
        snprintf(p, sizeof(p), "{\"error\":\"mkdir failed\",\"path\":\"%s\",\"messageId\":\"%s\"}",
                 normPath, msgId ? msgId : "");
        mqttPublish(topic, p, 1);
        return false;
    }

    if (!append && SD_MMC.exists(normPath) && !SD_MMC.remove(normPath)) {
        _storageSetError("replace failed");
        char p[160];
        snprintf(p, sizeof(p), "{\"error\":\"replace failed\",\"path\":\"%s\",\"messageId\":\"%s\"}",
                 normPath, msgId ? msgId : "");
        mqttPublish(topic, p, 1);
        return false;
    }

    File f = SD_MMC.open(normPath, append ? FILE_APPEND : FILE_WRITE);
    if (!f) {
        _storageSetError("open failed");
        char p[160];
        snprintf(p, sizeof(p), "{\"error\":\"open failed\",\"path\":\"%s\",\"messageId\":\"%s\"}",
                 normPath, msgId ? msgId : "");
        mqttPublish(topic, p, 1);
        return false;
    }

    int written = f.write((const uint8_t*)data, dataLen);
    f.close();
    if (written != dataLen) {
        _storageSetError("write incomplete");
        char p[160];
        snprintf(p, sizeof(p), "{\"error\":\"write incomplete\",\"path\":\"%s\",\"written\":%d,\"messageId\":\"%s\"}",
                 normPath, written, msgId ? msgId : "");
        mqttPublish(topic, p, 1);
        return false;
    }

    _storageSetError(nullptr);
    char p[160];
    snprintf(p, sizeof(p),
             "{\"path\":\"%s\",\"bytes\":%d,\"success\":true,\"messageId\":\"%s\"}",
             normPath, written, msgId ? msgId : "");
    mqttPublish(topic, p, 1);
    return true;
}

inline bool storageDelete(const char* path, const char* deviceId, const char* msgId) {
    char normPath[128];
    _sdNormPath(path, normPath, sizeof(normPath));

    char topic[TOPIC_BUF_SIZE];
    snprintf(topic, sizeof(topic), "device/%s/storage/delete", deviceId);

    storageTryMount(false);

    if (!_sdPresent) {
        _storageSetError("no sd card");
        char p[96];
        snprintf(p, sizeof(p), "{\"error\":\"no sd card\",\"messageId\":\"%s\"}", msgId ? msgId : "");
        mqttPublish(topic, p, 1);
        return false;
    }

    bool ok = SD_MMC.remove(normPath);
    if (!ok) ok = SD_MMC.rmdir(normPath);
    if (!ok) ok = _storageDeleteRecursive(normPath);

    _storageSetError(ok ? nullptr : "delete failed");
    char p[160];
    snprintf(p, sizeof(p),
             "{\"path\":\"%s\",\"success\":%s,\"messageId\":\"%s\"}",
             normPath, ok ? "true" : "false", msgId ? msgId : "");
    mqttPublish(topic, p, 1);
    return ok;
}

inline bool storageFormat(const char* deviceId, const char* msgId) {
    (void)deviceId;
    (void)msgId;
    storageTryMount(true);
    if (!_sdPresent) {
        _storageSetError("no sd card");
        return false;
    }

    bool ok = _storageDeleteRecursive("/");
    if (ok) {
        SD_MMC.end();
        _sdPresent = storageInit();
        ok = _sdPresent;
    }

    _storageSetError(ok ? nullptr : "format failed");
    return ok;
}

inline bool storageMkdir(const char* path) {
    char normPath[128];
    _sdNormPath(path, normPath, sizeof(normPath));
    if (!_sdPresent) {
        _storageSetError("no sd card");
        return false;
    }
    if (!_sdIsSafePath(normPath)) {
        _storageSetError("invalid path");
        return false;
    }
    bool ok = _sdEnsureDirRecursive(normPath);
    _storageSetError(ok ? nullptr : "mkdir failed");
    return ok;
}

inline bool storageRename(const char* oldPath, const char* newPath) {
    char src[128];
    char dst[128];
    _sdNormPath(oldPath, src, sizeof(src));
    _sdNormPath(newPath, dst, sizeof(dst));
    if (!_sdPresent || !_sdIsSafePath(src) || !_sdIsSafePath(dst)) {
        _storageSetError("invalid path");
        return false;
    }

    char parent[160];
    _sdParentPath(dst, parent, sizeof(parent));
    if (!_sdEnsureDirRecursive(parent)) {
        _storageSetError("mkdir failed");
        return false;
    }

    if (SD_MMC.exists(dst)) {
        bool removed = SD_MMC.remove(dst);
        if (!removed) removed = _storageDeleteRecursive(dst);
        if (!removed) {
            _storageSetError("destination exists");
            return false;
        }
    }

    bool ok = SD_MMC.rename(src, dst);
    _storageSetError(ok ? nullptr : "rename failed");
    return ok;
}

inline bool storageCopy(const char* sourcePath, const char* destinationPath) {
    char src[128];
    char dst[128];
    _sdNormPath(sourcePath, src, sizeof(src));
    _sdNormPath(destinationPath, dst, sizeof(dst));
    if (!_sdPresent) {
        _storageSetError("no sd card");
        return false;
    }
    if (!_sdIsSafePath(src) || !_sdIsSafePath(dst)) {
        _storageSetError("invalid path");
        return false;
    }

    bool ok = _sdCopyRecursive(src, dst);
    _storageSetError(ok ? nullptr : "copy failed");
    return ok;
}

inline bool storageMove(const char* sourcePath, const char* destinationPath) {
    bool ok = storageRename(sourcePath, destinationPath);
    if (!ok) {
        ok = storageCopy(sourcePath, destinationPath) && _storageDeleteRecursive(sourcePath);
        _storageSetError(ok ? nullptr : "move failed");
    }
    return ok;
}
