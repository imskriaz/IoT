idf_component_register(
    SRCS "src/automation_bridge.c"
    INCLUDE_DIRS "include"
    REQUIRES api_bridge board_bsp json config_mgr diagnostics freertos health_monitor heap shared_models
)
