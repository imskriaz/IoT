idf_component_register(
    SRCS "src/health_monitor.c"
    INCLUDE_DIRS "include"
    REQUIRES freertos config_mgr diagnostics esp_timer log shared_models
)
