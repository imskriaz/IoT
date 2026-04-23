idf_component_register(
    SRCS "src/board_bsp.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_hw_support esp_psram esp_system log shared_models spi_flash
)
