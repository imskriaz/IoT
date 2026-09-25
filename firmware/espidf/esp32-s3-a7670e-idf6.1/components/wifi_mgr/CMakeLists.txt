idf_component_register(
    SRCS
        "src/wifi_mgr.c"
        "src/wifi_mgr_scan.c"
        "src/wifi_mgr_profiles.c"
    INCLUDE_DIRS "include"
    REQUIRES config_mgr diagnostics health_monitor state_mgr esp_event esp_netif esp_wifi freertos heap log shared_models nvs_flash
)
