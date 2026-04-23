idf_component_register(
    SRCS "src/mqtt_mgr.c"
    INCLUDE_DIRS "include"
    REQUIRES api_bridge automation_bridge board_bsp config_mgr diagnostics health_monitor modem_a7670 mqtt freertos heap log shared_models storage_mgr wifi_mgr
)
