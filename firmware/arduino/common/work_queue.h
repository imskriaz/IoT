#pragma once

#include <Arduino.h>

enum FwWorkType {
    FW_WORK_NONE = 0,
    FW_WORK_PUBLISH_USSD,
    FW_WORK_PUBLISH_STATUS,
    FW_WORK_PUBLISH_GPS_STATUS,
    FW_WORK_PUBLISH_GPIO_STATUS,
    FW_WORK_PROCESS_DEFERRED_EVENTS
};

struct FwWorkItem {
    bool active;
    FwWorkType type;
    unsigned long queuedAt;
    unsigned long dueAt;
    uint8_t attempts;
    char messageId[64];
};

#ifndef FW_WORK_QUEUE_MAX
#define FW_WORK_QUEUE_MAX 12
#endif

static FwWorkItem _fwWorkQueue[FW_WORK_QUEUE_MAX];

static inline const char* fwWorkTypeName(FwWorkType type) {
    switch (type) {
        case FW_WORK_PUBLISH_USSD:           return "ussd-publish";
        case FW_WORK_PUBLISH_STATUS:         return "status-publish";
        case FW_WORK_PUBLISH_GPS_STATUS:     return "gps-status-publish";
        case FW_WORK_PUBLISH_GPIO_STATUS:    return "gpio-status-publish";
        case FW_WORK_PROCESS_DEFERRED_EVENTS:return "deferred-events";
        case FW_WORK_NONE:
        default:                             return "none";
    }
}

static inline int fwWorkQueueDepth() {
    int count = 0;
    for (int i = 0; i < FW_WORK_QUEUE_MAX; i++) {
        if (_fwWorkQueue[i].active) count++;
    }
    return count;
}

static inline bool fwWorkQueueHasPending() {
    return fwWorkQueueDepth() > 0;
}

static inline bool _fwWorkDue(unsigned long now, unsigned long dueAt) {
    return (long)(now - dueAt) >= 0;
}

static inline bool fwWorkQueueSchedule(FwWorkType type, unsigned long delayMs = 0,
                                       const char* messageId = nullptr,
                                       bool replaceExisting = true) {
    unsigned long now = millis();
    unsigned long dueAt = now + delayMs;

    if (replaceExisting) {
        for (int i = 0; i < FW_WORK_QUEUE_MAX; i++) {
            FwWorkItem& item = _fwWorkQueue[i];
            if (!item.active || item.type != type) continue;
            item.queuedAt = now;
            item.dueAt = dueAt;
            if (messageId) {
                strncpy(item.messageId, messageId, sizeof(item.messageId) - 1);
                item.messageId[sizeof(item.messageId) - 1] = '\0';
            }
            return true;
        }
    }

    for (int i = 0; i < FW_WORK_QUEUE_MAX; i++) {
        FwWorkItem& item = _fwWorkQueue[i];
        if (item.active) continue;
        memset(&item, 0, sizeof(item));
        item.active = true;
        item.type = type;
        item.queuedAt = now;
        item.dueAt = dueAt;
        if (messageId) {
            strncpy(item.messageId, messageId, sizeof(item.messageId) - 1);
            item.messageId[sizeof(item.messageId) - 1] = '\0';
        }
        return true;
    }

    return false;
}

static inline bool fwWorkQueueClaimDue(unsigned long now, FwWorkItem& out) {
    int bestIndex = -1;
    unsigned long bestDueAt = 0;

    for (int i = 0; i < FW_WORK_QUEUE_MAX; i++) {
        const FwWorkItem& item = _fwWorkQueue[i];
        if (!item.active) continue;
        if (!_fwWorkDue(now, item.dueAt)) continue;
        if (bestIndex < 0 || (long)(item.dueAt - bestDueAt) < 0) {
            bestIndex = i;
            bestDueAt = item.dueAt;
        }
    }

    if (bestIndex < 0) return false;

    out = _fwWorkQueue[bestIndex];
    memset(&_fwWorkQueue[bestIndex], 0, sizeof(_fwWorkQueue[bestIndex]));
    return true;
}

static inline bool fwWorkQueueReschedule(const FwWorkItem& source, unsigned long delayMs) {
    FwWorkItem next = source;
    next.active = true;
    next.queuedAt = millis();
    next.dueAt = next.queuedAt + delayMs;
    if (next.attempts < 255) next.attempts++;

    for (int i = 0; i < FW_WORK_QUEUE_MAX; i++) {
        FwWorkItem& item = _fwWorkQueue[i];
        if (item.active) continue;
        item = next;
        return true;
    }

    return false;
}
