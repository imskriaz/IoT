idf_component_register(SRCS "usb_ppp_compat.c" INCLUDE_DIRS "."
    REQUIRES iot_usbh_modem iot_usbh_cdc modem_at esp_http_client mbedtls esp_netif)
