#pragma once
#include <stdlib.h>
typedef void *SemaphoreHandle_t;
static inline SemaphoreHandle_t xSemaphoreCreateMutex(void) { return malloc(1); }
static inline int xSemaphoreTake(SemaphoreHandle_t handle, unsigned ticks) { (void)ticks; return handle ? 1 : 0; }
static inline void xSemaphoreGive(SemaphoreHandle_t handle) { (void)handle; }
static inline void vSemaphoreDelete(SemaphoreHandle_t handle) { free(handle); }
