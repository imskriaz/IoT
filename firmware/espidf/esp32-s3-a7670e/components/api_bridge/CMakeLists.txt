idf_component_register(
    SRCS "src/api_bridge.c"
    INCLUDE_DIRS "include"
    REQUIRES app_update board_bsp config_mgr device_status esp_http_client esp_https_ota health_monitor mbedtls shared_models sms_service status_watch
)
