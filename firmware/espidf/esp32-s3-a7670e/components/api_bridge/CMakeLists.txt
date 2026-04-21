idf_component_register(
    SRCS "src/api_bridge.c"
    INCLUDE_DIRS "include"
    REQUIRES board_bsp config_mgr device_status health_monitor shared_models sms_service status_watch
)
