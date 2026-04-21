#include <stdio.h>
#include <string.h>
#include <stdbool.h>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/uart.h"

#define RX_PIN 17
#define TX_PIN 18
#define BAUD_RATE 115200
#define UART_NUM UART_NUM_1
#define BUF_SIZE 2048

#define APN "ctnet"
#define URL "https://www.waveshare.cloud/api/sample-test/"

// POST payload in your example
#define POST_BODY "hello"

static void init_uart(void) {
    uart_config_t cfg = {
        .baud_rate = BAUD_RATE,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_driver_install(UART_NUM, BUF_SIZE * 2, 0, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(UART_NUM, &cfg));
    ESP_ERROR_CHECK(uart_set_pin(UART_NUM, TX_PIN, RX_PIN, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
    uart_flush(UART_NUM);
}

static void send_line(const char *s) {
    printf("\n>>> %s\n", s);
    uart_write_bytes(UART_NUM, s, (int)strlen(s));
    uart_write_bytes(UART_NUM, "\r\n", 2);
}

static bool wait_any(uint32_t timeout_ms, const char *a, const char *b, const char *c, const char *d) {
    static uint8_t buf[BUF_SIZE];
    int used = 0;
    uint32_t start = xTaskGetTickCount() * portTICK_PERIOD_MS;

    while ((xTaskGetTickCount() * portTICK_PERIOD_MS - start) < timeout_ms) {
        int n = uart_read_bytes(UART_NUM, buf + used, (BUF_SIZE - 1) - used, 100 / portTICK_PERIOD_MS);
        if (n > 0) {
            used += n;
            buf[used] = 0;

            printf("<<< %s", (char*)buf);

            if (a && strstr((char*)buf, a)) return true;
            if (b && strstr((char*)buf, b)) return true;
            if (c && strstr((char*)buf, c)) return true;
            if (d && strstr((char*)buf, d)) return true;

            // keep buffer fresh
            if (used > (BUF_SIZE * 3 / 4)) used = 0;
        }
    }
    return false;
}

static void drain_ms(uint32_t ms) {
    (void)wait_any(ms, NULL, NULL, NULL, NULL);
}

// Not strict: accept OK or already-opened type messages
static void net_prepare(void) {
    char cmd[128];

    // APN
    snprintf(cmd, sizeof(cmd), "AT+CGDCONT=1,\"IP\",\"%s\"", APN);
    send_line(cmd);
    wait_any(5000, "OK", "ERROR", "+CME ERROR", NULL);

    // Attach / activate PDP (some firmwares don't need both; keep it tolerant)
    send_line("AT+CGACT=1,1");
    wait_any(8000, "OK", "ERROR", "+CME ERROR", NULL);

    // Open network (tolerate already opened)
    send_line("AT+NETOPEN");
    wait_any(15000, "+NETOPEN: 0", "OK", "already opened", "+IP ERROR");
    drain_ms(800);
}

static bool http_init_set_url(void) {
    char cmd[256];

    send_line("AT+HTTPINIT");
    if (!wait_any(5000, "OK", "ERROR", "+CME ERROR", NULL)) return false;

    snprintf(cmd, sizeof(cmd), "AT+HTTPPARA=\"URL\",%s", URL);
    send_line(cmd);
    if (!wait_any(5000, "OK", "ERROR", "+CME ERROR", NULL)) return false;

    return true;
}

static bool http_get_once(void) {
    // 0 = GET
    send_line("AT+HTTPACTION=0");
    if (!wait_any(5000, "OK", "ERROR", "+CME ERROR", NULL)) return false;

    // Wait URC: +HTTPACTION: 0,200,<len>
    if (!wait_any(15000, "+HTTPACTION:", "ERROR", "+CME ERROR", NULL)) return false;

    // Read body
    send_line("AT+HTTPREAD=0,500");
    wait_any(15000, "+HTTPREAD:", "ERROR", "+CME ERROR", NULL);
    drain_ms(800);
    return true;
}

static bool http_post_once(const char *body) {
    char cmd[64];
    int len = (int)strlen(body);

    // HTTPDATA=<len>,<timeout_ms>
    snprintf(cmd, sizeof(cmd), "AT+HTTPDATA=%d,1000", len);
    send_line(cmd);

    // Many firmwares return "DOWNLOAD"
    if (!wait_any(8000, "DOWNLOAD", "OK", "ERROR", "+CME ERROR")) return false;

    // Send raw body (NO \r\n)
    uart_write_bytes(UART_NUM, body, len);

    // After data input, usually returns OK
    wait_any(5000, "OK", "ERROR", "+CME ERROR", NULL);

    // 1 = POST
    send_line("AT+HTTPACTION=1");
    if (!wait_any(5000, "OK", "ERROR", "+CME ERROR", NULL)) return false;

    // Wait URC: +HTTPACTION: 1,200,<len>
    if (!wait_any(15000, "+HTTPACTION:", "ERROR", "+CME ERROR", NULL)) return false;

    // Read body
    send_line("AT+HTTPREAD=0,500");
    wait_any(15000, "+HTTPREAD:", "ERROR", "+CME ERROR", NULL);
    drain_ms(800);

    return true;
}

static void http_term(void) {
    send_line("AT+HTTPTERM");
    wait_any(5000, "OK", "ERROR", "+CME ERROR", NULL);
    drain_ms(500);
}

void app_main(void) {
    init_uart();
    vTaskDelay(pdMS_TO_TICKS(1200));

    // Basic AT
    send_line("AT");
    wait_any(2000, "OK", "ERROR", NULL, NULL);

    printf("\nAPN fixed to: %s\nURL: %s\n", APN, URL);

    // Prepare network (tolerant)
    net_prepare();

    while (1) {
        printf("\n================ HTTP GET ================\n");
        if (http_init_set_url()) {
            http_get_once();
            http_term();
        }

        printf("\n================ HTTP POST ================\n");
        if (http_init_set_url()) {
            http_post_once(POST_BODY);
            http_term();
        }

        vTaskDelay(pdMS_TO_TICKS(15000));
    }
}
