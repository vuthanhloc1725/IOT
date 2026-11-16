#include "sensors.h"

#include "driver/gpio.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define DHT_PIN GPIO_NUM_4
#define SOIL_CHANNEL ADC_CHANNEL_6 /* ADC1, GPIO34; works while Wi-Fi is active. */

static adc_oneshot_unit_handle_t adc;

void sensors_init(void)
{
    adc_oneshot_unit_init_cfg_t unit = { .unit_id = ADC_UNIT_1 };
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&unit, &adc));
    adc_oneshot_chan_cfg_t channel = { .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12 };
    ESP_ERROR_CHECK(adc_oneshot_config_channel(adc, SOIL_CHANNEL, &channel));
    gpio_set_direction(DHT_PIN, GPIO_MODE_INPUT);
    gpio_pullup_en(DHT_PIN);
}

bool soil_read_raw(int *raw)
{
    int sum = 0, sample;
    for (int i = 0; i < 8; i++) {
        if (adc_oneshot_read(adc, SOIL_CHANNEL, &sample) != ESP_OK) return false;
        sum += sample;
    }
    *raw = sum / 8;
    return true;
}

static bool wait_level(int level, int timeout_us)
{
    int64_t deadline = esp_timer_get_time() + timeout_us;
    while (gpio_get_level(DHT_PIN) != level) {
        if (esp_timer_get_time() >= deadline) return false;
    }
    return true;
}

static bool read_once(float *temp, float *humidity)
{
    uint8_t bytes[5] = {0};
    gpio_set_direction(DHT_PIN, GPIO_MODE_OUTPUT_OD);
    gpio_set_level(DHT_PIN, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(DHT_PIN, 1);
    esp_rom_delay_us(30);
    gpio_set_direction(DHT_PIN, GPIO_MODE_INPUT);

    // A DHT transaction is about 4 ms; keep timing-sensitive pulses together.
    bool ok = wait_level(0, 100) && wait_level(1, 100) && wait_level(0, 100);
    for (int i = 0; ok && i < 40; i++) {
        ok = wait_level(1, 100);
        if (!ok) break;
        int64_t start = esp_timer_get_time();
        ok = wait_level(0, 100);
        if (!ok) break;
        bytes[i / 8] = (uint8_t)((bytes[i / 8] << 1) | ((esp_timer_get_time() - start) > 48));
    }
    if (!ok || (uint8_t)(bytes[0] + bytes[1] + bytes[2] + bytes[3]) != bytes[4]) return false;
    *humidity = bytes[0] + bytes[1] / 10.0f;
    *temp = (bytes[2] & 0x7f) + bytes[3] / 10.0f;
    if (bytes[2] & 0x80) *temp = -*temp;
    return *humidity >= 0 && *humidity <= 100 && *temp >= -20 && *temp <= 80;
}

bool dht11_read(float *temperature_c, float *humidity_pct)
{
    for (int attempt = 0; attempt < 3; attempt++) {
        if (read_once(temperature_c, humidity_pct)) return true;
        vTaskDelay(pdMS_TO_TICKS(1100));
    }
    return false;
}
