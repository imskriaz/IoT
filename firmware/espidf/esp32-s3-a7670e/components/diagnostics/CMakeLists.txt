idf_component_register(
    SRCS
        "src/diagnostics.c"
        "src/task_registry.c"
    INCLUDE_DIRS "include"
    REQUIRES freertos heap log nvs_flash esp_timer esp_system shared_models
)
