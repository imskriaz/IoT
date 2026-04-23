idf_component_register(
    SRCS "src/telemetry_service.c"
    INCLUDE_DIRS "include"
    REQUIRES config_mgr device_status health_monitor mqtt_mgr shared_models status_watch
)
