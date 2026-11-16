idf_component_register(SRCS "main.c" "sensors.c" "logic.c"
    INCLUDE_DIRS "."
    REQUIRES esp_wifi esp_event esp_netif mqtt nvs_flash json driver esp_adc esp_timer mbedtls lwip)
