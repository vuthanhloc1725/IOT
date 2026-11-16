/*
 * control.h - Điều khiển relay (bơm/quạt), tự động hóa theo ngưỡng, xử lý lệnh
 */
#pragma once
#include <Arduino.h>

void actuatorsInit();
void taskControl(void* arg);    // FreeRTOS task: xử lý lệnh + vòng tự động hóa
void buildConfigJson(char* out, size_t len);
