/* Isolated, single-shot hardware diagnostic. Not the Device Bridge runtime. */
#include <netdb.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_netif_ip_addr.h"
#include "iot_usbh_cdc.h"
#include "iot_usbh_modem.h"

#define PPP_GOT_IP_BIT BIT0
#define PPP_LOST_IP_BIT BIT1
#define PPP_WAIT_MS 120000U

static EventGroupHandle_t s_events;

static const char *TAG = "usb_ppp_compat";
static const usb_modem_id_t s_a7670e_ids[] = {
    {
        .match_id = {USB_DEVICE_ID_MATCH_VID_PID, 0x1E0E, 0x9011},
        .modem_itf_num = 5,
        .at_itf_num = -1,
        .name = "A7670E",
    },
    {.match_id = {0}},
};

static void ppp_ip_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    if (base != IP_EVENT || !s_events) {
        return;
    }
    if (id == IP_EVENT_PPP_GOT_IP && data) {
        const ip_event_got_ip_t *event = data;
        ESP_LOGI(TAG, "PPP_IP=" IPSTR, IP2STR(&event->ip_info.ip));
        xEventGroupClearBits(s_events, PPP_LOST_IP_BIT);
        xEventGroupSetBits(s_events, PPP_GOT_IP_BIT);
    } else if (id == IP_EVENT_PPP_LOST_IP) {
        ESP_LOGW(TAG, "PPP_LOST_IP");
        xEventGroupClearBits(s_events, PPP_GOT_IP_BIT);
        xEventGroupSetBits(s_events, PPP_LOST_IP_BIT);
    }
}

static bool check_dns(void)
{
    struct addrinfo hints = {.ai_family = AF_INET, .ai_socktype = SOCK_STREAM};
    struct addrinfo *answer = NULL;
    int rc = getaddrinfo("device.madebydevs.com", "443", &hints, &answer);
    if (rc != 0 || !answer) {
        ESP_LOGE(TAG, "PPP_DNS_FAIL rc=%d", rc);
        if (answer) freeaddrinfo(answer);
        return false;
    }
    const struct sockaddr_in *address = (const struct sockaddr_in *)answer->ai_addr;
    ESP_LOGI(TAG, "PPP_DNS_OK address=" IPSTR, IP2STR((const ip4_addr_t *)&address->sin_addr));
    freeaddrinfo(answer);
    return true;
}

static bool check_https(void)
{
    esp_http_client_config_t config = {
        .url = "https://device.madebydevs.com/health",
        .crt_bundle_attach = esp_crt_bundle_attach,
        .timeout_ms = 15000,
        .disable_auto_redirect = true,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) {
        ESP_LOGE(TAG, "PPP_HTTPS_INIT_FAIL");
        return false;
    }
    esp_err_t err = esp_http_client_perform(client);
    int code = err == ESP_OK ? esp_http_client_get_status_code(client) : 0;
    ESP_LOGI(TAG, "PPP_HTTPS_RESULT transport=%s http=%d", esp_err_to_name(err), code);
    esp_http_client_cleanup(client);
    return err == ESP_OK && code > 0;
}

void app_main(void)
{
    ESP_LOGW(TAG, "ISOLATED_DIAGNOSTIC; normal dashboard firmware is not running");
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    s_events = xEventGroupCreate();
    ESP_ERROR_CHECK(s_events ? ESP_OK : ESP_ERR_NO_MEM);
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_PPP_GOT_IP, ppp_ip_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_PPP_LOST_IP, ppp_ip_event, NULL));

    const usbh_cdc_driver_config_t usb_config = {
        .task_stack_size = 4096,
        .task_priority = 5,
        .task_coreid = 0,
        .skip_init_usb_host_driver = false,
    };
    esp_err_t err = usbh_cdc_driver_install(&usb_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "PPP_TRIAL_RESULT usb_host_install_failed=%s", esp_err_to_name(err));
        return;
    }
    const usbh_modem_config_t modem_config = {
        .modem_id_list = s_a7670e_ids,
        .at_tx_buffer_size = 256,
        .at_rx_buffer_size = 256,
    };
    err = usbh_modem_install(&modem_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "PPP_TRIAL_RESULT modem_install_failed=%s", esp_err_to_name(err));
        return;
    }
    ESP_LOGI(TAG, "Waiting up to %u ms for A7670E USB PPP IP", PPP_WAIT_MS);
    EventBits_t bits = xEventGroupWaitBits(s_events, PPP_GOT_IP_BIT, pdFALSE,
                                           pdFALSE, pdMS_TO_TICKS(PPP_WAIT_MS));
    if (!(bits & PPP_GOT_IP_BIT)) {
        ESP_LOGE(TAG, "PPP_TRIAL_RESULT ip_timeout; no connectivity claim");
        return;
    }
    esp_netif_t *netif = usbh_modem_get_netif();
    esp_netif_ip_info_t ip_info = {0};
    if (!netif || esp_netif_get_ip_info(netif, &ip_info) != ESP_OK ||
        ip_info.ip.addr == 0) {
        ESP_LOGE(TAG, "PPP_TRIAL_RESULT ip_not_current");
        return;
    }
    bool dns_ok = check_dns();
    if (!dns_ok) {
        ESP_LOGE(TAG, "PPP_TRIAL_RESULT ip=yes dns=no https=not_tested");
        return;
    }
    esp_sntp_config_t sntp_config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    err = esp_netif_sntp_init(&sntp_config);
    if (err != ESP_OK || esp_netif_sntp_sync_wait(pdMS_TO_TICKS(15000)) != ESP_OK) {
        ESP_LOGE(TAG, "PPP_TRIAL_RESULT ip=yes dns=yes time=no https=not_tested");
        return;
    }
    bool https_ok = check_https();
    ESP_LOGI(TAG, "PPP_TRIAL_RESULT ip=yes dns=yes time=yes https=%s",
             https_ok ? "yes" : "no");
    /* No unbounded driver stop/uninstall: leave ownership intact until reset. */
}
