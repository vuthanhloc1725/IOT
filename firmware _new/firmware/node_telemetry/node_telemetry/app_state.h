/*
 * app_state.h - Dữ liệu dùng chung giữa các task FreeRTOS
 *  - DeviceConfig : cấu hình lưu trong NVS Flash
 *  - RuntimeState : trạng thái hiện tại (giá trị cảm biến, relay, mạng...)
 *  - Hàng đợi (queue) trao đổi dữ liệu giữa các task
 *  Mọi truy cập vào gConfig / gState phải nằm trong cặp stateLock()/stateUnlock().
 */
#pragma once
#include <Arduino.h>
#include "config.h"

// ----------------------------- Vòng đời thiết bị -----------------------------
// 6 trạng thái theo đề bài: Registered -> Provisioned -> Active -> Offline/Fault
// -> Maintenance -> Decommissioned.
//  * Registered/Provisioned/Active/Maintenance/Decommissioned: lưu ở thiết bị
//    (server gửi lệnh "lifecycle" để chuyển).
//  * Offline: server tự suy ra (LWT hoặc mất heartbeat).
//  * Fault  : thiết bị tự phát hiện (cảm biến lỗi) và báo trong heartbeat.
enum Lifecycle : uint8_t {
  LC_REGISTERED = 0,     // mới nạp firmware, chưa có cấu hình WiFi/MQTT
  LC_PROVISIONED = 1,    // đã có cấu hình, kết nối được, chờ Admin kích hoạt
  LC_ACTIVE = 2,         // hoạt động đầy đủ (tự động hóa bật)
  LC_MAINTENANCE = 3,    // bảo trì: tắt tự động hóa, chỉ cho điều khiển tay
  LC_DECOMMISSIONED = 4, // ngừng sử dụng: tắt hết, không gửi telemetry
  LC_FAULT = 5,          // v1.3: chỉ dùng cho lifecycle từng thiết bị do Backend báo (devices.h)
  LC_UNKNOWN = 0xFF      // v1.3: Backend chưa báo lifecycle cho thiết bị này
};
const char* lifecycleName(uint8_t lc);
int lifecycleFromName(const char* s);   // -1 nếu không hợp lệ

enum CtrlMode : uint8_t { MODE_AUTO = 0, MODE_MANUAL = 1 };

// ----------------------------- Cấu hình (NVS) --------------------------------
struct DeviceConfig {
  char deviceId[32];
  char mqttHost[64];
  uint16_t mqttPort;
  char mqttUser[32];
  char mqttPass[64];

  float soilLow, soilHigh;
  float tempFanOn, tempFanOff, humFanOn;
  uint16_t soilRawDry, soilRawWet;
  uint16_t pumpMaxOnS, pumpMinOffS;
  uint32_t sampleMs, heartbeatMs;

  uint8_t mode;        // CtrlMode
  uint8_t lifecycle;   // Lifecycle
  // ---- v1.4: thêm ở CUỐI struct để nạp được cấu hình v1.3 cũ (giữ WiFi/MQTT đã nhập) ----
  float   humFanOff;   // %RH - tắt quạt khi độ ẩm < ngưỡng này (và nhiệt <= tempFanOff)
  uint8_t pumpAuto;    // 1 = cho phép tưới tự động (Backend: pumpAutoEnabled)
  uint8_t fanAuto;     // 1 = cho phép quạt tự động (Backend: fanAutoEnabled)
};

// v1.5: dữ liệu claim (provisioning.h) - blob NVS riêng "prov", KHÔNG đổi DeviceConfig/CFG_VERSION.
struct ProvConfig {
  char    apiUrl[96];      // gốc Backend, vd "http://192.168.1.10:3000" (có/không "/api" đều được)
  char    claimToken[48];  // token 43 ký tự từ web; rỗng = không chờ claim
  uint8_t mqttTls;         // 1 = Backend báo broker dùng mqtts:// (MQTT_DEVICE_URL)
};

// ----------------------------- Trạng thái chạy -------------------------------
struct RuntimeState {
  // cảm biến
  int   soilRaw;
  float soilPct;
  float tempC;
  float humPct;
  bool  soilFault;
  bool  dhtFault;
  bool  hasReading;
  bool  waterLow;        // phao báo hết nước (chỉ khi USE_WATER_LEVEL = 1)
  // cơ cấu chấp hành
  bool  pumpOn;
  bool  fanOn;
  bool  pumpLocked;      // bơm bị khóa do nghi chạy khô (bơm nhiều lần không hiệu quả)
  // mạng
  bool  wifiOk;
  bool  mqttOk;
  bool  portalActive;
  bool  timeSynced;
  // offline store
  uint32_t backlogBytes;
  uint32_t droppedRecords;
  uint32_t reconnects;
};

extern DeviceConfig gConfig;
extern ProvConfig   gProv;       // v1.5: cũng truy cập trong stateLock()/stateUnlock()
extern RuntimeState gState;
extern uint32_t     gBootCount;

void stateInit();
void stateLock();
void stateUnlock();

// NVS
void configLoad();
void configSave();
void configFactoryReset();       // xóa cả namespace -> gồm cả dữ liệu claim "prov"
void provSave();                 // lưu gProv (configLoad() đã tự nạp)
const char* resetReasonName();   // ly do khoi dong lai: power_on, brownout, watchdog, software...
void pumpLockSave(bool locked);   // luu co khoa bom vao NVS (chi ghi khi doi trang thai)
uint32_t nextSeq();            // số thứ tự bản tin tăng dần, không lặp lại qua các lần khởi động

// ----------------------------- Hàng đợi --------------------------------------
// Bản tin gửi ra ngoài: các task chỉ đẩy vào qOutbox, CHỈ task mạng mới gọi MQTT
// (thư viện PubSubClient không an toàn đa luồng).
//  v1.4 - topic tương ứng (sf/<nodeCode>/...):
//   OUT_TELEMETRY   -> telemetry      (payload là bản ghi gọn nội bộ, task mạng đổi sang dạng phẳng của Backend)
//   OUT_ACK         -> cmd/ack        OUT_CONFIG_ACK -> config/ack
//   OUT_DEV_STATUS  -> status         (trạng thái 1 thiết bị {"deviceCode","deviceStatus":"FAULT"})
//   OUT_EVENT       -> status         (sự kiện {"event":"sensor_fault"|"pump_locked"|...})
//   OUT_PROBE_ACK   -> device/probe/ack (chỉ khi ENABLE_DEVICE_PROBE = 1)
enum OutKind : uint8_t { OUT_TELEMETRY, OUT_EVENT, OUT_ACK, OUT_HEARTBEAT_NOW,
                         OUT_CONFIG_ACK, OUT_PROBE_ACK, OUT_DEV_STATUS };
struct OutMsg {
  OutKind kind;
  bool    storeIfOffline;   // true -> nếu mất mạng thì ghi vào Flash để gửi bù (chỉ telemetry)
  char    payload[420];
};

// Lệnh nhận từ MQTT (hoặc từ Serial console) -> task điều khiển xử lý
enum CmdKind : uint8_t {
  CMD_LEGACY  = 0,   // sf/<id>/cmd  {"action":...}  (Backend + Serial console + sim_backend) - v1.4: kênh lệnh DUY NHẤT
  CMD_PROBE   = 3    // sf/<id>/device/probe (chỉ khi ENABLE_DEVICE_PROBE = 1)
};
struct CmdMsg {
  CmdKind kind;
  char    json[1024];
};

extern QueueHandle_t qOutbox;
extern QueueHandle_t qCommand;

bool outboxPush(OutKind kind, const char* payload, bool storeIfOffline);
bool commandPush(const char* json, CmdKind kind = CMD_LEGACY);

// ----------------------------- Tiện ích --------------------------------------
uint32_t nowEpoch();           // giây UNIX; 0 nếu chưa đồng bộ NTP
// v1.3: "2026-10-27T04:30:00.000Z" (UTC, ISO 8601 - định dạng Backend yêu cầu). false nếu epoch = 0
bool     isoTime(uint32_t epoch, char* out, size_t len);
void     wdtInit();
void     wdtAddThisTask();
void     wdtFeed();
