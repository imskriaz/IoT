idf_component_register(
    SRCS
        "src/action_models.c"
        "src/state_models.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_system esp_timer freertos
)
