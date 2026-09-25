#pragma once

#include <stdbool.h>
#include "esp_err.h"

esp_err_t storage_result_journal_init(void);
/* Serializes private journal I/O against flash filesystem unmount. */
void storage_result_journal_set_available(bool available);
