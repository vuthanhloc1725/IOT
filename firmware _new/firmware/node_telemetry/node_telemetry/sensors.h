/*
 * sensors.h - Đọc cảm biến độ ẩm đất (điện trở, analog), DHT11 và (v1.3) dòng bơm ACS712
 */
#pragma once
#include <Arduino.h>

void sensorsInit();
void taskSensor(void* arg);     // FreeRTOS task: đọc cảm biến định kỳ -> cập nhật gState + gửi telemetry

int   soilReadRaw();            // ADC trung bình (0..4095)
float soilRawToPercent(int raw, int rawDry, int rawWet);

// v1.3: cảm biến dòng ACS712 qua bơm (USE_PUMP_CURRENT = 1). Chưa lắp -> trả NAN.
void  pumpCurrentZero();        // đo mức 0 A (gọi khi bơm ĐANG TẮT)
float pumpCurrentA();           // dòng hiện tại (A), NAN nếu không có cảm biến
