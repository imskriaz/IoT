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
#define BUF_SIZE 1024

#define APN "ctnet"

#define LINK_ID 0
#define SERVER_IP "tcpbin.net"
#define SERVER_PORT 47231

#define PAYLOAD "Hello,7670!"

static void init_uart(void)
{
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

static void send_line(const char *s)
{
    printf("\n>>> %s\n", s);
    uart_write_bytes(UART_NUM, s, (int)strlen(s));
    uart_write_bytes(UART_NUM, "\r\n", 2);
}

static bool read_until_any(uint32_t timeout_ms,
                           const char *hit1,
                           const char *hit2,
                           const char *hit3)
{
    uint8_t buf[BUF_SIZE];
    int used = 0;
    uint32_t start = xTaskGetTickCount() * portTICK_PERIOD_MS;

    while ((xTaskGetTickCount() * portTICK_PERIOD_MS - start) < timeout_ms) {
        int n = uart_read_bytes(UART_NUM, buf + used, (BUF_SIZE - 1) - used, 100 / portTICK_PERIOD_MS);
        if (n > 0) {
            used += n;
            buf[used] = 0;
            printf("<<< %s", (char*)buf);

            if (hit1 && strstr((char*)buf, hit1)) return true;
            if (hit2 && strstr((char*)buf, hit2)) return true;
            if (hit3 && strstr((char*)buf, hit3)) return true;

            // keep buffer from growing too large
            if (used > (BUF_SIZE * 3 / 4)) used = 0;
        }
    }
    return false;
}

static void read_dump(uint32_t ms)
{
    (void)read_until_any(ms, NULL, NULL, NULL);
}

static void tcp_flow_once(void)
{
    char cmd[128];

    // Basic
    send_line("AT");
    read_dump(1500);

    // APN
    snprintf(cmd, sizeof(cmd), "AT+CGDCONT=1,\"IP\",\"%s\"", APN);
    send_line(cmd);
    read_until_any(5000, "OK", "ERROR", "+CME ERROR");

    // Optional: signal + register
    send_line("AT+CSQ");
    read_dump(2000);

    send_line("AT+CGREG?");
    read_dump(2000);

    // NETOPEN (ignore "already opened")
    send_line("AT+NETOPEN");
    // accept OK or "+NETOPEN: 0" or "already opened" or even ERROR (some firmwares print error after URC)
    read_until_any(12000, "+NETOPEN: 0", "OK", "already opened");
    read_dump(1000);

    // TCP open
    snprintf(cmd, sizeof(cmd), "AT+CIPOPEN=%d,\"TCP\",\"%s\",%d", LINK_ID, SERVER_IP, SERVER_PORT);
    send_line(cmd);
    // expect OK then URC +CIPOPEN: 0,0
    read_until_any(10000, "OK", "+CIPOPEN:", "ERROR");
    read_until_any(15000, "+CIPOPEN:", "ERROR", "+CME ERROR");

    // Send
    int plen = (int)strlen(PAYLOAD);
    snprintf(cmd, sizeof(cmd), "AT+CIPSEND=%d,%d", LINK_ID, plen);
    send_line(cmd);
    // wait prompt ">"
    if (!read_until_any(5000, ">", "ERROR", "+CME ERROR")) return;

    // send raw payload (NO \r\n)
    uart_write_bytes(UART_NUM, PAYLOAD, plen);

    // many firmwares: "OK" and "+CIPSEND: ..."
    read_until_any(10000, "+CIPSEND:", "SEND OK", "ERROR");
    read_dump(1500);

    // Wait server reply (+IPD)
    printf("\n=== Waiting server reply (e.g. +IPD,...) ===\n");
    read_until_any(12000, "+IPD", "CLOSED", "ERROR");
    read_dump(800);

    // Close TCP
    snprintf(cmd, sizeof(cmd), "AT+CIPCLOSE=%d", LINK_ID);
    send_line(cmd);
    read_dump(6000);

    // Optional: keep network open, or close it
    // send_line("AT+NETCLOSE");
    // read_dump(8000);

    printf("\nTCP flow finished.\n");
}

void app_main(void)
{
    init_uart();
    vTaskDelay(pdMS_TO_TICKS(1500));

    printf("\nAPN is fixed to: %s\n", APN);

    while (1) {
        printf("\n================ TCP TEST ================\n");
        tcp_flow_once();
        vTaskDelay(pdMS_TO_TICKS(15000));
    }
}
