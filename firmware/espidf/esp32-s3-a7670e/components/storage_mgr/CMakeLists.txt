idf_component_register(
    SRCS "src/storage_mgr.c"
    INCLUDE_DIRS "include"
    REQUIRES config_mgr diagnostics fatfs health_monitor heap nvs_flash shared_models state_mgr wear_levelling
)
