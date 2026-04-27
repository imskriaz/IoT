idf_component_register(
    SRCS
        "src/config_mgr.c"
    INCLUDE_DIRS "include"
    REQUIRES freertos log nvs_flash
)
