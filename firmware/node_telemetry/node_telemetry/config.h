/*
 * ============================================================================
 *  NODE TELEMETRY - Cảm biến & Tưới tiêu tự động
 *  Hệ thống Nông nghiệp Thông minh (Công việc 1 - Hardware & Firmware)
 * ----------------------------------------------------------------------------
 *  config.h : TOÀN BỘ hằng số cấu hình phần cứng / thời gian / MQTT.
 *  Muốn đổi chân nối hoặc thông số mặc định -> chỉ sửa file này.
 * ============================================================================
 */
#pragma once
#include <Arduino.h>

// ---------------------------------------------------------------------------
// 1. Thông tin firmware
// ---------------------------------------------------------------------------
#define FW_VERSION          "1.5.0"   // v1.5: tự claim MQTT credentials qua POST /api/provisioning/claim (provisioning.cpp)
                                      // v1.4: giao thức MQTT theo Backend 02/11/2026 (sf/{nodeCode}/..., FIRMWARE_V12_INTEGRATION.md)
#define NODE_TYPE           "telemetry"

// ---------------------------------------------------------------------------
// 2. Sơ đồ chân (ESP32 DevKit V1 - 30 chân)
//    LƯU Ý: cảm biến độ ẩm đất PHẢI nối vào chân ADC1 (GPIO32..39) vì ADC2
//    không dùng được khi WiFi đang bật.
// ---------------------------------------------------------------------------
#define PIN_SOIL_ADC        34      // chân AO module cảm biến độ ẩm đất loại điện trở (ADC1_CH6)
                                    // v1.2: module 2 que + mạch so sánh (bán kèm "5V không relay").
                                    // CẤP VCC MODULE TỪ 3V3, KHÔNG cấp 5V: AO có thể lên gần 5V làm hỏng ADC ESP32.
#define PIN_DHT             4       // DATA module DHT11 (v1.2: đổi từ DHT22 theo linh kiện đã mua)
#define PIN_RELAY_PUMP      26      // IN1 module relay -> máy bơm
#define PIN_RELAY_FAN       27      // IN2 module relay -> quạt
#define PIN_LED_STATUS      2       // LED xanh on-board (báo trạng thái mạng)
#define PIN_BTN_CONFIG      0       // Nút BOOT: giữ 3 giây -> xóa WiFi, mở cổng cấu hình

// Mức tích cực của relay. Module relay 2 kênh có jumper chọn H/L:
//  - Gạt jumper sang H (kích mức cao)  -> RELAY_ON_LEVEL = HIGH  (KHUYẾN NGHỊ với ESP32 3.3V)
//  - Gạt jumper sang L (kích mức thấp) -> RELAY_ON_LEVEL = LOW
#define RELAY_ON_LEVEL      HIGH

#define DHT_TYPE            DHT11   // module đã mua; đổi lại DHT22 nếu thay cảm biến

// Cảm biến mực nước bồn chứa (phao/float switch) - TÙY CHỌN, chống bơm chạy khô.
//  Đấu: 1 chân phao -> GPIO25, chân còn lại -> GND (dùng điện trở kéo lên nội).
//  Lắp phao sao cho tiếp điểm ĐÓNG khi còn nước -> WATER_OK_LEVEL = LOW.
//  (lắp ngược - tiếp điểm MỞ khi còn nước -> đổi WATER_OK_LEVEL = HIGH)
//  Chưa lắp phao -> để USE_WATER_LEVEL = 0 (firmware bỏ qua chân này).
#ifndef USE_WATER_LEVEL
#define USE_WATER_LEVEL     0
#endif
#define PIN_WATER_LEVEL     25
#define WATER_OK_LEVEL      LOW

// Cảm biến dòng ACS712 đo dòng qua bơm - TÙY CHỌN (v1.4: Backend KHÔNG còn bắt buộc).
//  Backend 02/11 dùng "inventory": Admin khai báo thiết bị + GPIO, không probe, không đòi bằng chứng dòng.
//  Khi lắp ACS712 và đặt USE_PUMP_CURRENT = 1: lệnh bật bơm từ web chỉ ACK thành công khi đo được dòng thật.
//  Đấu (loại ACS712-5A): IP+/IP- mắc NỐI TIẾP dây + 12V vào bơm (sau tiếp điểm relay),
//  VCC 5V, GND chung. OUT ra 2,5V lúc 0A -> PHẢI qua cầu chia áp 10k (trên) / 20k (dưới) rồi mới vào
//  GPIO35 (ADC1). Không nối thẳng OUT vào ESP32 (có thể lên 3,4V > 3,3V).
#ifndef USE_PUMP_CURRENT
#define USE_PUMP_CURRENT    0
#endif
#define PIN_PUMP_CURRENT    35      // ADC1_CH7, chỉ vào (input only)
#define ACS_MV_PER_A        185.0f  // ACS712-5A: 185 mV/A (20A: 100, 30A: 66)
#define ACS_DIVIDER         (20.0f / 30.0f)  // hệ số cầu chia áp 10k/20k
#define PUMP_CURRENT_MIN_A  0.15f   // dòng tối thiểu coi là bơm đang chạy thật
#define PUMP_TEST_MS        500     // thời gian tự kiểm tra bơm (chỉ dùng cho probe đời cũ)

// device/probe (giao thức v1.3, Backend đời cũ). Backend 02/11 không dùng -> tắt cho nhẹ flash.
#ifndef ENABLE_DEVICE_PROBE
#define ENABLE_DEVICE_PROBE 0
#endif

// ---------------------------------------------------------------------------
// 3. Ngưỡng điều khiển mặc định (có thể đổi từ xa bằng lệnh MQTT "config",
//    giá trị mới được lưu vào NVS Flash, khởi động lại vẫn giữ nguyên).
// ---------------------------------------------------------------------------
#define DEF_SOIL_LOW        35.0f   // % - độ ẩm đất < ngưỡng này -> BẬT bơm
#define DEF_SOIL_HIGH       60.0f   // % - độ ẩm đất >= ngưỡng này -> TẮT bơm (trễ/hysteresis)
#define DEF_TEMP_FAN_ON     32.0f   // °C - nhiệt độ >= -> BẬT quạt
#define DEF_TEMP_FAN_OFF    30.0f   // °C - nhiệt độ <= -> TẮT quạt
#define DEF_HUM_FAN_ON      85.0f   // %RH - độ ẩm không khí >= -> BẬT quạt (giảm nguy cơ nấm)
                                    // v1.2: hạ 90 -> 85 vì DHT11 chỉ đo tới ~90 %RH (sai số ±5 %)
#define DEF_HUM_FAN_OFF     80.0f   // %RH - v1.4: TẮT quạt khi nhiệt <= DEF_TEMP_FAN_OFF VÀ độ ẩm < ngưỡng này
#define DEF_PUMP_MAX_ON_S   30      // giây - bơm chạy tối đa 1 lần (an toàn, chống tràn / bơm khô)
#define DEF_PUMP_MIN_OFF_S  60      // giây - nghỉ tối thiểu giữa 2 lần bơm (chờ nước ngấm)
#define DEF_MANUAL_PUMP_S   10      // giây - thời gian bơm mặc định khi bật tay không ghi "seconds"
#define FAN_MANUAL_HOLD_S   300     // giây - lệnh tay quạt (web) được giữ trước khi tự động hóa quản lý lại
// Bảo vệ bơm chạy khô: bơm hết thời gian tối đa mà độ ẩm KHÔNG tăng đủ PUMP_EFFECT_MIN_PCT
// liên tiếp PUMP_NOEFFECT_LOCK lần -> KHÓA bơm tự động (fault "pump"), chờ người kiểm tra
// rồi gửi lệnh {"action":"pump_unlock"} trên sf/<node>/cmd (hoặc gõ "pump unlock" trên Serial).
#define PUMP_NOEFFECT_LOCK  3
#define PUMP_EFFECT_MIN_PCT 2.0f    // % - độ ẩm phải tăng ít nhất chừng này sau 1 lần bơm

// Hiệu chuẩn cảm biến độ ẩm đất (giá trị ADC thô 0..4095).
// Chạy sketch tests/test_01_soil_calibration để đo lại cho cảm biến thực tế!
// v1.2: cảm biến loại điện trở - khô (que ngoài không khí) đọc gần 4095, ướt đọc thấp hơn.
// 2 giá trị dưới là ƯỚC LƯỢNG, bắt buộc đo lại bằng test_01 khi đã lắp.
#define DEF_SOIL_RAW_DRY    4095    // để ngoài không khí (khô hoàn toàn)
#define DEF_SOIL_RAW_WET    1500    // nhúng nước (ướt hoàn toàn)
// Ngưỡng coi là "cảm biến lỗi / tuột dây". Loại điện trở khi rất khô đọc 4095 giống hệt lúc tuột
// que, nên KHÔNG dùng ngưỡng trên (để 4095 = tắt). Chỉ bắt lỗi phía dưới (đứt dây AO, chập GND).
#define SOIL_RAW_FAULT_MIN  100
#define SOIL_RAW_FAULT_MAX  4095

// ---------------------------------------------------------------------------
// 4. Chu kỳ thời gian
// ---------------------------------------------------------------------------
#define DEF_SAMPLE_MS       5000UL  // chu kỳ đọc cảm biến + gửi telemetry
#define DEF_HEARTBEAT_MS    30000UL // chu kỳ heartbeat (server coi Offline nếu mất > 3 chu kỳ)
#define CONTROL_PERIOD_MS   500UL   // chu kỳ vòng điều khiển
#define SENSOR_FAULT_COUNT  3       // số lần đọc lỗi liên tiếp -> báo FAULT

// Kích thước stack các task (byte). Gõ "status" trên Serial để xem stack còn trống.
#define STACK_NET           12288   // đóng gói JSON + gửi bù + v1.5: HTTPS claim / MQTT TLS (mbedTLS ăn stack)
#define STACK_SENSOR        6144    // printf số thực + JsonDocument cần > 4 KB cho an toàn
#define STACK_CONTROL       8192    // xử lý lệnh/config của Backend

// Reconnect với backoff tăng dần: 1s, 2s, 4s ... tối đa 60s
#define RECONNECT_MIN_MS    1000UL
#define RECONNECT_MAX_MS    60000UL

// ---------------------------------------------------------------------------
// 5. WiFiManager (cổng cấu hình WiFi - không hardcode SSID/mật khẩu)
// ---------------------------------------------------------------------------
#define WM_AP_PREFIX        "SF-TELE-"     // tên WiFi phát ra khi cấu hình: SF-TELE-xxxx
#define WM_AP_PASSWORD      "12345678"     // mật khẩu AP cấu hình (>= 8 ký tự)
#define WM_PORTAL_TIMEOUT_S 300            // hết thời gian -> chạy chế độ offline, vẫn tưới tự động
// Đã có WiFi lưu sẵn nhưng lúc khởi động không kết nối được (vd: vừa có điện lại, router
// khởi động chậm hơn ESP32) -> KHÔNG mở cổng cấu hình mà tiếp tục thử kết nối lại.
// Muốn đổi WiFi: giữ nút BOOT 3 giây (hoặc lệnh reset_wifi).

// ---------------------------------------------------------------------------
// 6. MQTT
// ---------------------------------------------------------------------------
#define DEF_MQTT_HOST       "192.168.1.100"
#define DEF_MQTT_PORT       1883
#define MQTT_TOPIC_ROOT     "sf"           // v1.4: sf/<nodeCode>/<sub-topic>, trùng MQTT_FIRMWARE_TOPIC_PREFIX của Backend
                                           // <nodeCode> = "Node code" nhập ở cổng cấu hình, phải TRÙNG mã Node trên web
// Topic theo Backend (FIRMWARE_V12_INTEGRATION.md) - CHỈ dùng các topic có trong ACL Dynamic Security:
//   Node -> Backend : telemetry, telemetry/backfill, heartbeat, status, cmd/ack, config/ack
//   Backend -> Node : cmd   (action pump / fan / config / lifecycle / pump_unlock / get_status / reboot ...)
#define MQTT_BUFFER_SIZE    2048           // v1.4: telemetry phẳng, mỗi bản tin 1 bản ghi
#define MQTT_KEEPALIVE_S    15
#define MQTT_SOCKET_TO_S    5

// Thiết bị có cần server gửi lệnh lifecycle=active mới chạy tự động hóa?
//  1 = đúng quy trình vòng đời (Provisioned -> Admin kích hoạt -> Active). Backend YÊU CẦU = 1.
//  0 = tự chuyển Active ngay khi kết nối MQTT lần đầu (tiện khi test một mình)
#define REQUIRE_ACTIVATION  1

// ---------------------------------------------------------------------------
// 7. Lưu trữ offline & đồng bộ bù dữ liệu
// ---------------------------------------------------------------------------
#define BACKLOG_FILE        "/backlog.jsonl"   // file ghi khi mất mạng
#define SENDING_FILE        "/sending.jsonl"   // file đang được gửi bù
#define BACKLOG_MAX_BYTES   (512UL * 1024UL)   // ~2.500 bản ghi; vượt -> bỏ bản ghi mới, đếm "dropped"
#define OFFLINE_STORE_EVERY 3                  // khi offline chỉ lưu 1/3 mẫu (15s/mẫu) để kéo dài thời gian lưu
#define BACKFILL_BATCH      20                 // số bản ghi đọc / 1 lượt gửi bù (mỗi bản ghi = 1 bản tin)
#define BACKFILL_GAP_MS     500UL              // giãn cách giữa 2 lượt gửi bù (không làm nghẽn broker)

// ---------------------------------------------------------------------------
// 8. NVS / đánh số thứ tự bản tin
// ---------------------------------------------------------------------------
#define NVS_NAMESPACE       "sfcfg"
#define NVS_DEV_NS          "sfdev"     // v1.3: bảng deviceCode Backend <-> phần cứng (devices.cpp)
#define NVS_STORE_NS        "sfstore"   // lưu vị trí đã gửi bù (offset) -> mất điện không gửi lại cả file
#define SEQ_SAVE_STEP       50     // lưu seq vào Flash mỗi 50 bản tin (giảm hao mòn Flash)

// ---------------------------------------------------------------------------
// 9. Watchdog
// ---------------------------------------------------------------------------
#define WDT_TIMEOUT_S       30

// ---------------------------------------------------------------------------
// 10. Thời gian thực (NTP) - múi giờ Việt Nam
// ---------------------------------------------------------------------------
#define NTP_TZ              "ICT-7"
#define NTP_SERVER1         "pool.ntp.org"
#define NTP_SERVER2         "time.google.com"

// ---------------------------------------------------------------------------
// 11. v1.5 - Claim token (provisioning.cpp) & TLS
//   Quy trình: Admin tạo Node + MAC trên web -> "Cấp claim token" -> nhập token vào cổng cấu hình
//   (hoặc gõ "claim <token>" trên Serial) -> ESP32 gọi POST <api>/api/provisioning/claim, nhận
//   nodeCode + MQTT user/pass riêng, lưu NVS rồi tự kết nối broker. Token chỉ dùng 1 lần.
// ---------------------------------------------------------------------------
#define DEF_API_URL             ""          // gốc Backend, vd "http://192.168.1.10:3000"; để trống = nhập ở cổng cấu hình
#define PROV_HTTP_TIMEOUT_MS    10000       // timeout 1 lần gọi claim (WDT 30s vẫn an toàn)
#define PROV_RETRY_MIN_MS       10000UL     // lỗi tạm (mạng, 5xx, 429): thử lại 10s, 20s, 40s ...
#define PROV_RETRY_MAX_MS       300000UL    //   ... tối đa 5 phút (Backend giới hạn 10 lần claim / 15 phút / IP)
#define PROV_INVENTORY_RETRY_MS 120000UL    // INVENTORY_MISMATCH: chờ Admin sửa thiết bị trên web rồi thử lại
#define PROV_AUTH_FAIL_MAX      5           // broker từ chối user/pass (rc=4/5) liên tiếp -> báo cần token mới

// Kiểm tra chứng chỉ khi gọi https:// và mqtts:// - dán CA vào tls_ca.h.
//  0 = KHÔNG có CA thì từ chối kết nối TLS (an toàn, dùng khi chạy thật)
//  1 = không có CA thì bỏ qua kiểm tra chứng chỉ (CHỈ để thử nghiệm, dễ bị giả mạo server)
#ifndef TLS_ALLOW_INSECURE
#define TLS_ALLOW_INSECURE      0
#endif
