#include "battery_monitor.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "driver/i2c.h"
#include "esp_err.h"
#include "esp_log.h"

#include "health_monitor.h"
#include "task_registry.h"
#include "unified_runtime.h"

#define BATTERY_MONITOR_TAG "battery_monitor"

#define BATTERY_MONITOR_I2C_PORT             I2C_NUM_0
#define BATTERY_MONITOR_I2C_SDA_PIN          15
#define BATTERY_MONITOR_I2C_SCL_PIN          16
#define BATTERY_MONITOR_I2C_FREQ_HZ          100000

#define MAX17048_ADDR                        0x36
#define MAX17048_REG_VCELL                   0x02
#define MAX17048_REG_SOC                     0x04

#define BATTERY_MONITOR_ACTIVE_SAMPLE_INTERVAL_MS   5000
#define BATTERY_MONITOR_IDLE_SAMPLE_INTERVAL_MS     15000
#define BATTERY_MONITOR_MISSING_SAMPLE_INTERVAL_MS  30000
#define BATTERY_MONITOR_TASK_STACK_SIZE      3072
#define BATTERY_TREND_SAMPLES                12
#define BATTERY_TREND_THRESHOLD_MV           15
#define BATTERY_FULL_MV                      4180

static SemaphoreHandle_t s_lock;
static battery_monitor_status_t s_status;
static bool s_ready;
static bool s_i2c_ready;

static int16_t s_voltage_history[BATTERY_TREND_SAMPLES];
static size_t s_voltage_history_index;
static size_t s_voltage_history_count;

static esp_err_t battery_monitor_read_register(uint8_t reg, uint16_t *out_value) {
    uint8_t raw[2] = {0};

    if (!out_value || !s_i2c_ready) {
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t err = i2c_master_write_read_device(
        BATTERY_MONITOR_I2C_PORT,
        MAX17048_ADDR,
        &reg,
        1,
        raw,
        sizeof(raw),
        pdMS_TO_TICKS(1000)
    );
    if (err != ESP_OK) {
        return err;
    }

    *out_value = (uint16_t)((raw[0] << 8) | raw[1]);
    return ESP_OK;
}

static int battery_monitor_soc_from_raw(uint16_t raw) {
    int percent = (int)(raw >> 8);
    if (percent < 0) {
        return -1;
    }
    if (percent > 100) {
        return 100;
    }
    return percent;
}

static int32_t battery_monitor_voltage_from_raw(uint16_t raw) {
    return (int32_t)(((raw >> 4) * 125) / 100);
}

static int battery_monitor_compute_charging_state(void) {
    if (s_voltage_history_count < 6U) {
        return -1;
    }

    const int half = (int)(s_voltage_history_count / 2U);
    long sum_new = 0;
    long sum_old = 0;

    for (int i = 0; i < half; ++i) {
        const int newest_index =
            (int)((s_voltage_history_index + BATTERY_TREND_SAMPLES - 1U - (size_t)i) % BATTERY_TREND_SAMPLES);
        const int oldest_index =
            (int)((s_voltage_history_index + BATTERY_TREND_SAMPLES - 1U - (size_t)half - (size_t)i)
                  % BATTERY_TREND_SAMPLES);

        sum_new += s_voltage_history[newest_index];
        sum_old += s_voltage_history[oldest_index];
    }

    const int avg_new = (int)(sum_new / half);
    const int avg_old = (int)(sum_old / half);
    const int delta_mv = avg_new - avg_old;

    if (avg_new >= BATTERY_FULL_MV && delta_mv >= 0) {
        return -1;
    }
    if (delta_mv >= BATTERY_TREND_THRESHOLD_MV) {
        return 1;
    }
    if (delta_mv <= -BATTERY_TREND_THRESHOLD_MV) {
        return 0;
    }
    return -1;
}

static void battery_monitor_record_sample_locked(int32_t voltage_mv) {
    if (voltage_mv <= 0 || voltage_mv > 5000) {
        return;
    }

    s_voltage_history[s_voltage_history_index] = (int16_t)voltage_mv;
    s_voltage_history_index = (s_voltage_history_index + 1U) % BATTERY_TREND_SAMPLES;
    if (s_voltage_history_count < BATTERY_TREND_SAMPLES) {
        s_voltage_history_count++;
    }
}

static void battery_monitor_set_health(bool present) {
    health_monitor_set_module_state(
        "battery_monitor",
        present ? HEALTH_MODULE_STATE_OK : HEALTH_MODULE_STATE_DEGRADED,
        present ? "running" : "gauge_not_detected"
    );
}

static TickType_t battery_monitor_next_delay_ticks_locked(void) {
    uint32_t delay_ms = BATTERY_MONITOR_ACTIVE_SAMPLE_INTERVAL_MS;

    if (!s_status.present) {
        delay_ms = BATTERY_MONITOR_MISSING_SAMPLE_INTERVAL_MS;
    } else if (s_voltage_history_count >= BATTERY_TREND_SAMPLES && s_status.charging_state != 1) {
        delay_ms = BATTERY_MONITOR_IDLE_SAMPLE_INTERVAL_MS;
    }

    return pdMS_TO_TICKS(delay_ms);
}

static void battery_monitor_task(void *arg) {
    TickType_t delay_ticks = pdMS_TO_TICKS(BATTERY_MONITOR_ACTIVE_SAMPLE_INTERVAL_MS);
    bool health_present = false;

    (void)arg;

    ESP_ERROR_CHECK(task_registry_register_expected("battery_task"));
    ESP_ERROR_CHECK(task_registry_mark_running("battery_task", true));
    ESP_ERROR_CHECK(health_monitor_register_module("battery_monitor"));
    battery_monitor_set_health(false);

    while (true) {
        uint16_t soc_raw = 0U;
        uint16_t voltage_raw = 0U;
        const esp_err_t soc_err = battery_monitor_read_register(MAX17048_REG_SOC, &soc_raw);
        const esp_err_t voltage_err = battery_monitor_read_register(MAX17048_REG_VCELL, &voltage_raw);
        const bool present = (soc_err == ESP_OK && voltage_err == ESP_OK);

        if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) == pdTRUE) {
            s_status.initialized = true;
            if (present) {
                s_status.present = true;
                s_status.battery_percent = battery_monitor_soc_from_raw(soc_raw);
                s_status.voltage_mv = battery_monitor_voltage_from_raw(voltage_raw);
                battery_monitor_record_sample_locked(s_status.voltage_mv);
                s_status.charging_state = battery_monitor_compute_charging_state();
                s_status.sample_count++;
                s_status.last_update_ms = unified_tick_now_ms();
            } else if (s_status.present ||
                       s_status.battery_percent != -1 ||
                       s_status.voltage_mv != -1 ||
                       s_status.charging_state != -1) {
                s_status.present = false;
                s_status.battery_percent = -1;
                s_status.voltage_mv = -1;
                s_status.charging_state = -1;
            }
            delay_ticks = battery_monitor_next_delay_ticks_locked();
            xSemaphoreGive(s_lock);
        }

        if (present != health_present) {
            battery_monitor_set_health(present);
            health_present = present;
        }
        ESP_ERROR_CHECK(task_registry_heartbeat("battery_task"));
        vTaskDelay(delay_ticks);
    }
}

esp_err_t battery_monitor_init(void) {
    i2c_config_t config = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = BATTERY_MONITOR_I2C_SDA_PIN,
        .scl_io_num = BATTERY_MONITOR_I2C_SCL_PIN,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = BATTERY_MONITOR_I2C_FREQ_HZ,
        .clk_flags = 0
    };

    if (s_ready) {
        return ESP_OK;
    }

    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) {
        return ESP_ERR_NO_MEM;
    }

    memset(&s_status, 0, sizeof(s_status));
    s_status.battery_percent = -1;
    s_status.voltage_mv = -1;
    s_status.charging_state = -1;

    esp_err_t err = i2c_param_config(BATTERY_MONITOR_I2C_PORT, &config);
    if (err == ESP_OK) {
        err = i2c_driver_install(BATTERY_MONITOR_I2C_PORT, config.mode, 0, 0, 0);
    }
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(BATTERY_MONITOR_TAG, "i2c init failed: %s", esp_err_to_name(err));
    } else {
        s_i2c_ready = true;
    }

    BaseType_t task_ok = xTaskCreatePinnedToCore(
        battery_monitor_task,
        "battery_task",
        BATTERY_MONITOR_TASK_STACK_SIZE,
        NULL,
        3,
        NULL,
        1
    );
    if (task_ok != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    s_ready = true;
    return ESP_OK;
}

void battery_monitor_get_status(battery_monitor_status_t *out_status) {
    if (!out_status) {
        return;
    }

    if (!s_ready || !s_lock) {
        memset(out_status, 0, sizeof(*out_status));
        out_status->battery_percent = -1;
        out_status->voltage_mv = -1;
        out_status->charging_state = -1;
        return;
    }

    if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        memset(out_status, 0, sizeof(*out_status));
        out_status->battery_percent = -1;
        out_status->voltage_mv = -1;
        out_status->charging_state = -1;
        return;
    }

    *out_status = s_status;
    xSemaphoreGive(s_lock);
}
