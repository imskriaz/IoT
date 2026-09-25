idf_component_register(
    SRCS "src/mqtt_mgr.c"
    INCLUDE_DIRS "include"
    REQUIRES api_bridge automation_bridge board_bsp config_mgr diagnostics health_monitor modem_a7670 mqtt freertos heap json log shared_models state_mgr storage_mgr wifi_mgr
)
