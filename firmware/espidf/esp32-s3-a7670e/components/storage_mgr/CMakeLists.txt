idf_component_register(
    SRCS "src/storage_mgr.c" "src/storage_sd.c" "src/storage_result_journal.c"
    INCLUDE_DIRS "include"
    REQUIRES board_bsp config_mgr diagnostics driver fatfs health_monitor heap nvs_flash sdmmc shared_models state_mgr wear_levelling
)
