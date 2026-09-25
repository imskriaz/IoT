idf_component_register(
    SRCS "src/status_watch.c"
    INCLUDE_DIRS "include"
    REQUIRES freertos shared_models
)
