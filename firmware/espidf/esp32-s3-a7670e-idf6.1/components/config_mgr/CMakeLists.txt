idf_component_register(
    SRCS
        "src/config_mgr.c"
        "src/config_mgr_persistence.c"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "private_include"
    REQUIRES freertos log nvs_flash
)
