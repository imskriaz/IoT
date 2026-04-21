idf_component_register(
    SRCS "src/battery_monitor.c"
    INCLUDE_DIRS "include"
    REQUIRES board_bsp driver diagnostics esp_timer freertos health_monitor log shared_models
)
