idf_component_register(
    SRCS "src/storage_mgr.c"
    INCLUDE_DIRS "include"
    REQUIRES board_bsp config_mgr diagnostics esp_driver_gpio fatfs health_monitor nvs_flash sdmmc shared_models state_mgr
)
