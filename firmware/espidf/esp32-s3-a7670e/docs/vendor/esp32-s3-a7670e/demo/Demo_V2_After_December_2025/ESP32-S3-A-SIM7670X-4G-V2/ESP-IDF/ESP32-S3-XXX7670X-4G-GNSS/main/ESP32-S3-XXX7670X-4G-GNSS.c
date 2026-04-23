#include <stdio.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "driver/uart.h"

#define RX_PIN 17
#define TX_PIN 18
#define BAUD_RATE 115200
#define UART_NUM UART_NUM_1
#define BUF_SIZE 1024

static SemaphoreHandle_t s_rx_mutex;
static SemaphoreHandle_t s_match_sem;
static char s_expect[64];
static volatile bool s_waiting = false;

static void init_uart(void)
{
    const uart_config_t cfg = {
        .baud_rate = BAUD_RATE,
        .data_bits = UART_DATA_8_BITS,
        .parity    = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk= UART_SCLK_DEFAULT,
    };

    ESP_ERROR_CHECK(uart_driver_install(UART_NUM, BUF_SIZE * 2, 0, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(UART_NUM, &cfg));
    ESP_ERROR_CHECK(uart_set_pin(UART_NUM, TX_PIN, RX_PIN, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));

    uart_flush_input(UART_NUM);
}

static void uart_rx_task(void *arg)
{
    (void)arg;

    uint8_t rx[256];
    char line[BUF_SIZE];
    int n = 0;

    // rolling window for matching AT responses (keeps recent bytes)
    static char win[BUF_SIZE];
    int wlen = 0;

    while (1) {
        int r = uart_read_bytes(UART_NUM, rx, sizeof(rx), pdMS_TO_TICKS(200));
        if (r <= 0) continue;

        // append to match window
        int copy = r;
        if (copy > (int)sizeof(win) - 1) copy = sizeof(win) - 1;

        if (wlen + copy >= (int)sizeof(win) - 1) {
            // keep tail
            int keep = (int)sizeof(win) / 2;
            memmove(win, win + wlen - keep, keep);
            wlen = keep;
        }
        memcpy(win + wlen, rx, copy);
        wlen += copy;
        win[wlen] = 0;

        // if someone is waiting for a substring, check here
        if (s_waiting && s_expect[0] && strstr(win, s_expect)) {
            s_waiting = false;
            xSemaphoreGive(s_match_sem);
        }

        // line printer for NMEA/URC
        for (int i = 0; i < r; i++) {
            char c = (char)rx[i];
            if (c == '\r') continue;

            if (c == '\n') {
                if (n > 0) {
                    line[n] = 0;
                    // print NMEA / URC line
                    printf("[UART] %s\n", line);
                    n = 0;
                }
            } else if (n < (int)sizeof(line) - 1) {
                line[n++] = c;
            } else {
                n = 0; // drop too long line
            }
        }
    }
}

static bool send_command(const char *cmd, const char *expect, uint32_t timeout_ms)
{
    if (!cmd) return false;

    // lock: prevent concurrent send_command
    xSemaphoreTake(s_rx_mutex, portMAX_DELAY);

    // set expectation for rx task to match
    if (expect && expect[0]) {
        strncpy(s_expect, expect, sizeof(s_expect) - 1);
        s_expect[sizeof(s_expect) - 1] = 0;
        s_waiting = true;
    } else {
        s_expect[0] = 0;
        s_waiting = false;
    }

    // send
    printf("\n>>> %s\n", cmd);
    uart_write_bytes(UART_NUM, cmd, strlen(cmd));
    uart_write_bytes(UART_NUM, "\r\n", 2);

    // wait match if needed
    bool ok = true;
    if (expect && expect[0]) {
        ok = (xSemaphoreTake(s_match_sem, pdMS_TO_TICKS(timeout_ms)) == pdTRUE);
        if (!ok) {
            s_waiting = false;
        }
    }

    xSemaphoreGive(s_rx_mutex);
    return ok;
}

void app_main(void)
{
    s_rx_mutex = xSemaphoreCreateMutex();
    s_match_sem = xSemaphoreCreateBinary();

    init_uart();
    xTaskCreate(uart_rx_task, "uart_rx", 4096, NULL, 8, NULL);

    printf("\n[NOTICE] GPS signal acquisition is unstable indoors."
    "Please place the module or antenna near a balcony or window, "
    "or perform the test outdoors with a clear view of the sky.\n\n");
    printf("[GNSS] Waiting for GNSS warm-up...\n");

    // AT handshake (now it won't be stolen by printer)
    while (!send_command("AT", "OK", 2000)) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }

    send_command("AT+CGNSSPWR=1", "OK", 5000);
    vTaskDelay(pdMS_TO_TICKS(300));

    send_command("AT+CGNSSTST=1", "OK", 5000);
    vTaskDelay(pdMS_TO_TICKS(300));

    send_command("AT+CGNSSPORTSWITCH=1,1", "OK", 5000);
    vTaskDelay(pdMS_TO_TICKS(300));

    send_command("AT+CGPSINFO", "+CGPSINFO:", 3000);
    vTaskDelay(pdMS_TO_TICKS(2000));

    while (1) {
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}
