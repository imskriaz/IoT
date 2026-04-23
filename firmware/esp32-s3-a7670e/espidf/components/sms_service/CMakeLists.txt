idf_component_register(
    SRCS "src/sms_service.c"
    INCLUDE_DIRS "include"
    REQUIRES shared_models health_monitor modem_a7670 diagnostics esp_timer heap storage_mgr mqtt_mgr
)
