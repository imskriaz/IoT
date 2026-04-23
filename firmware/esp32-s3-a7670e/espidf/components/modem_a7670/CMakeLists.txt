set(MODEM_A7670_REQUIRES
    board_bsp
    config_mgr
    diagnostics
    heap
    health_monitor
    freertos
    log
    esp_timer
    esp_driver_gpio
    esp_driver_uart
    shared_models
    state_mgr
)

set(MODEM_A7670_SRCS
    "src/modem_a7670.c"
    "src/modem_a7670_telephony.c"
)

idf_component_register(
    SRCS ${MODEM_A7670_SRCS}
    INCLUDE_DIRS "include"
    REQUIRES ${MODEM_A7670_REQUIRES}
)
