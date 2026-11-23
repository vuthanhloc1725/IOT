/*
 * provisioning.h - v1.5: ESP32 tự lấy MQTT credentials bằng claim token
 *
 *  Quy trình (Backend/docs/DEVICE_CLAIM_LIFECYCLE.md):
 *   1. Admin tạo Node trên web với MAC của ESP32 (gõ "prov" trên Serial để xem MAC) + khai báo thiết bị.
 *   2. Web "Cấp claim token" -> token 43 ký tự, hạn 30 phút, chỉ hiện 1 lần.
 *   3. Nhập token vào cổng cấu hình (ô "Claim token") hoặc gõ "claim <token>" trên Serial.
 *   4. Task mạng gọi POST <api>/api/provisioning/claim {macAddress, claimToken}
 *      -> nhận nodeCode + MQTT user/pass riêng + danh sách thiết bị, lưu NVS, xóa token, kết nối broker.
 *  Thu hồi / cấp lại trên web: chỉ cần cấp token mới rồi nhập lại (KHÔNG cần xóa Flash, KHÔNG cần đối soát).
 */
#pragma once
#include <Arduino.h>
#include <WiFiClientSecure.h>   // core 3.x: WiFiClientSecure là typedef của NetworkClientSecure -> không forward-declare được

// ---- Gọi được từ mọi task (Serial console, callback cổng cấu hình) ----
bool provSetToken(const char* token);   // lưu token, claim ngay khi có WiFi. false = sai định dạng
bool provSetApi(const char* url);       // lưu URL Backend (http:// hoặc https://). false = sai định dạng
void provClearToken();
void provRetryNow();                    // bỏ thời gian chờ / trạng thái dừng, claim lại ngay
void provPrint();                       // MAC, Backend URL, trạng thái claim, lỗi gần nhất (không in token)

// ---- CHỈ task mạng gọi ----
bool provWantsClaim();                  // có token đang chờ claim -> tạm không thử MQTT bằng tài khoản cũ
bool provTick();                        // gọi khi có WiFi; true = vừa nhận MQTT credentials mới
bool provOnMqttConnect(int rc);         // rc = PubSubClient::state(); true = vừa chạm ngưỡng broker từ chối
bool provAuthBlocked();                 // broker đã từ chối user/pass >= PROV_AUTH_FAIL_MAX lần liên tiếp
bool provConfigureTls(WiFiClientSecure& client);   // nạp CA (tls_ca.h); false = không được phép TLS
