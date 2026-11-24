/*
 * devices.h - Bảng ánh xạ "mã thiết bị của Backend" <-> phần cứng trên node (v1.3, v1.4 thêm quạt)
 *
 *  Backend quản lý từng THIẾT BỊ (deviceCode, vd SOIL-01, PUMP-01) thuộc 1 NODE (nodeCode, vd NODE-01).
 *  Node telemetry có 5 "ô" phần cứng cố định:
 *     DEV_SOIL  : cảm biến độ ẩm đất  - SENSOR, GPIO34, metric SOIL_MOISTURE
 *     DEV_AIR_T : DHT11 nhiệt độ       - SENSOR, GPIO4,  metric AIR_TEMPERATURE
 *     DEV_AIR_H : DHT11 độ ẩm KK       - SENSOR, GPIO4,  metric AIR_HUMIDITY
 *     DEV_PUMP  : bơm qua relay kênh 1 - PUMP,   GPIO26
 *     DEV_FAN   : quạt qua relay kênh 2 - FAN,   GPIO27   (v1.4)
 *
 *  v1.4: mã thiết bị được gán khi Backend gửi lệnh config / lifecycle / pump / fan trên sf/<node>/cmd
 *  (có deviceCode + type + gpioPin), lưu NVS -> mất điện vẫn còn.
 *  Có thể gán tay trên Serial: "map soil SOIL-01".
 *  Mỗi ô lưu thêm lifecycle Backend báo (trong config) và version cấu hình đã áp dụng.
 *  Mọi hàm đều tự khóa stateLock() -> gọi được từ mọi task.
 */
#pragma once
#include <Arduino.h>

enum DevSlot : int8_t { DEV_NONE = -1, DEV_SOIL = 0, DEV_AIR_T = 1, DEV_AIR_H = 2, DEV_PUMP = 3, DEV_FAN = 4, DEV_COUNT = 5 };

#define DEV_CODE_LEN 32

void        devInit();                                  // nạp từ NVS (gọi trong setup)
const char* devSlotName(int slot);                      // "soil", "temp", "hum", "pump", "fan"
int         devSlotFromName(const char* s);
const char* devType(int slot);                          // "SENSOR" / "PUMP" / "FAN"
const char* devMetric(int slot);                        // "SOIL_MOISTURE"... ("" với bơm)
int         devGpio(int slot);                          // chân phần cứng của ô

bool        devGetCode(int slot, char* out, size_t len); // false nếu ô chưa có mã
int         devFindByCode(const char* code);            // DEV_NONE nếu không có
// Tìm ô cho 1 thiết bị Backend: theo mã đã gán; chưa có thì theo type + gpio (+ gợi ý metric).
// Trả DEV_NONE và ghi lý do vào err nếu không ô nào phù hợp.
int         devResolve(const char* code, const char* type, int gpio, const char* metricHint,
                       char* err, size_t errLen);
void        devAssign(int slot, const char* code);      // gán + lưu NVS (bỏ mã này khỏi ô khác)
void        devClear(int slot);                         // xóa 1 ô (slot = DEV_NONE -> xóa hết)

uint8_t     devLifecycle(int slot);                     // LC_xxx, LC_UNKNOWN nếu Backend chưa báo
void        devSetLifecycle(int slot, uint8_t lc);
bool        devBlocked(int slot);                       // MAINTENANCE / DECOMMISSIONED / FAULT
bool        devActive(int slot);                        // v1.4: Backend đã kích hoạt (ACTIVE)
uint32_t    devConfigVersion(int slot);
void        devSetConfigVersion(int slot, uint32_t v);

void        devPrint();                                 // in bảng ra Serial

// Gửi {"deviceCode","deviceStatus","message"} lên sf/<nodeCode>/status. false nếu ô chưa có mã.
bool        devPublishStatus(int slot, const char* status, const char* message);
