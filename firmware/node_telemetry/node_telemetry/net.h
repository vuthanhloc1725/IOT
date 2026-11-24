/*
 * net.h - WiFi (WiFiManager) + MQTT + heartbeat + gửi bù dữ liệu
 */
#pragma once
#include <Arduino.h>

void taskNet(void* arg);          // FreeRTOS task: toàn bộ việc mạng chạy ở đây
void netResetWifiSettings();      // xóa WiFi đã lưu (lần khởi động sau sẽ mở cổng cấu hình)
void netRequestPortal();          // v1.5: mở cổng cấu hình (192.168.4.1) mà không xóa WiFi - gọi được từ task khác
