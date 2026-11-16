#pragma once

#include <stdbool.h>

void sensors_init(void);
bool soil_read_raw(int *raw);
bool dht11_read(float *temperature_c, float *humidity_pct);
