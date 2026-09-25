idf_component_register(
    SRCS "src/serial_config.c"
    INCLUDE_DIRS "include"
    REQUIRES
        config_mgr
        device_status
        esp_driver_uart
        esp_system
        freertos
        log
        mbedtls
)
