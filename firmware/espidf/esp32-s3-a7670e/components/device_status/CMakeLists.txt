idf_component_register(
    SRCS "src/device_status.c"
    INCLUDE_DIRS "include"
    REQUIRES
        battery_monitor
        board_bsp
        config_mgr
        diagnostics
        modem_a7670
        mqtt_mgr
        shared_models
        state_mgr
        storage_mgr
        wifi_mgr
        esp_system
)
