/*
 * app_state.cpp - Cấu hình NVS, trạng thái dùng chung, hàng đợi, watchdog
 */
#include "app_state.h"
#include <Preferences.h>
#include <WiFi.h>
#include <esp_task_wdt.h>
#include <esp_system.h>
#include <time.h>
#include <stddef.h>

DeviceConfig gConfig;
ProvConfig   gProv;
RuntimeState gState;
uint32_t     gBootCount = 0;

QueueHandle_t qOutbox  = nullptr;
QueueHandle_t qCommand = nullptr;

static SemaphoreHandle_t sMutex = nullptr;
static SemaphoreHandle_t sCmdMutex = nullptr;   // bảo vệ bộ đệm tĩnh của commandPush()
static Preferences       sPrefs;
static uint32_t          sSeq = 0;

static const uint16_t CFG_VERSION = 4;   // tăng khi đổi cấu trúc DeviceConfig (v1.4: 3 -> 4, có nâng cấp từ 3)

// ---------------------------------------------------------------------------
const char* lifecycleName(uint8_t lc) {
  switch (lc) {
    case LC_REGISTERED:     return "registered";
    case LC_PROVISIONED:    return "provisioned";
    case LC_ACTIVE:         return "active";
    case LC_MAINTENANCE:    return "maintenance";
    case LC_DECOMMISSIONED: return "decommissioned";
    case LC_FAULT:          return "fault";
  }
  return "unknown";
}

int lifecycleFromName(const char* s) {
  if (!s) return -1;
  for (uint8_t i = 0; i <= LC_FAULT; i++)   // không phân biệt hoa/thường: "ACTIVE" của Backend = "active"
    if (strcasecmp(s, lifecycleName(i)) == 0) return i;
  return -1;
}

// ---------------------------------------------------------------------------
void stateInit() {
  sMutex   = xSemaphoreCreateMutex();
  sCmdMutex = xSemaphoreCreateMutex();
  qOutbox  = xQueueCreate(24, sizeof(OutMsg));
  qCommand = xQueueCreate(5, sizeof(CmdMsg));   // v1.3: 5 x ~1 KB
  memset(&gState, 0, sizeof(gState));
  gState.tempC = NAN;
  gState.humPct = NAN;
}

void stateLock()   { xSemaphoreTake(sMutex, portMAX_DELAY); }
void stateUnlock() { xSemaphoreGive(sMutex); }

// ---------------------------------------------------------------------------
static void configDefaults() {
  memset(&gConfig, 0, sizeof(gConfig));
  uint8_t mac[6];
  WiFi.macAddress(mac);
  snprintf(gConfig.deviceId, sizeof(gConfig.deviceId), "tele-%02x%02x%02x", mac[3], mac[4], mac[5]);
  strlcpy(gConfig.mqttHost, DEF_MQTT_HOST, sizeof(gConfig.mqttHost));
  gConfig.mqttPort    = DEF_MQTT_PORT;
  gConfig.soilLow     = DEF_SOIL_LOW;
  gConfig.soilHigh    = DEF_SOIL_HIGH;
  gConfig.tempFanOn   = DEF_TEMP_FAN_ON;
  gConfig.tempFanOff  = DEF_TEMP_FAN_OFF;
  gConfig.humFanOn    = DEF_HUM_FAN_ON;
  gConfig.soilRawDry  = DEF_SOIL_RAW_DRY;
  gConfig.soilRawWet  = DEF_SOIL_RAW_WET;
  gConfig.pumpMaxOnS  = DEF_PUMP_MAX_ON_S;
  gConfig.pumpMinOffS = DEF_PUMP_MIN_OFF_S;
  gConfig.sampleMs    = DEF_SAMPLE_MS;
  gConfig.heartbeatMs = DEF_HEARTBEAT_MS;
  gConfig.mode        = MODE_AUTO;
  gConfig.lifecycle   = LC_REGISTERED;
  gConfig.humFanOff   = DEF_HUM_FAN_OFF;
  gConfig.pumpAuto    = 1;
  gConfig.fanAuto     = 1;
}

void configLoad() {
  configDefaults();
  sPrefs.begin(NVS_NAMESPACE, false);
  uint16_t ver = sPrefs.getUShort("ver", 0);
  size_t len = sPrefs.getBytesLength("cfg");
  if (ver == CFG_VERSION && len == sizeof(DeviceConfig)) {
    sPrefs.getBytes("cfg", &gConfig, sizeof(DeviceConfig));
    Serial.println(F("[NVS] Da nap cau hinh tu Flash"));
  } else if (ver == 3 && len == offsetof(DeviceConfig, humFanOff)) {
    // v1.4: cấu hình v1.3 là phần đầu của struct mới -> nạp phần đó, các trường mới giữ mặc định.
    // Nhờ vậy nạp firmware mới KHÔNG mất WiFi/MQTT/Node code đã nhập.
    sPrefs.getBytes("cfg", &gConfig, len);
    Serial.println(F("[NVS] Da nap cau hinh v1.3 va nang cap len v1.4"));
  } else {
    Serial.println(F("[NVS] Chua co cau hinh -> dung gia tri mac dinh"));
  }
  // v1.5: dữ liệu claim (thiếu hoặc khác kích thước -> rỗng, node chạy như v1.4)
  memset(&gProv, 0, sizeof(gProv));
  if (sPrefs.getBytesLength("prov") == sizeof(ProvConfig)) sPrefs.getBytes("prov", &gProv, sizeof(ProvConfig));
  gProv.apiUrl[sizeof(gProv.apiUrl) - 1] = 0;
  gProv.claimToken[sizeof(gProv.claimToken) - 1] = 0;
  if (!gProv.apiUrl[0]) strlcpy(gProv.apiUrl, DEF_API_URL, sizeof(gProv.apiUrl));
  // Số lần khởi động (giúp server ghép dữ liệu offline khi chưa có NTP)
  gBootCount = sPrefs.getUInt("boot", 0) + 1;
  sPrefs.putUInt("boot", gBootCount);
  // seq: nhảy cóc SEQ_SAVE_STEP để chắc chắn không trùng với lần chạy trước
  sSeq = sPrefs.getUInt("seq", 0) + SEQ_SAVE_STEP;
  sPrefs.putUInt("seq", sSeq);
  // Khôi phục cờ khóa bơm: nghi bơm chạy khô thì mất điện/khởi động lại cũng KHÔNG tự mở khóa
  if (sPrefs.getUChar("plock", 0)) {
    gState.pumpLocked = true;
    Serial.println(F("[NVS] Bom dang bi KHOA tu truoc khi tat nguon -> can pump_unlock sau khi kiem tra"));
  }
}

void pumpLockSave(bool locked) {
  if ((sPrefs.getUChar("plock", 0) != 0) == locked) return;   // khong doi -> khong ghi, do hao mon Flash
  sPrefs.putUChar("plock", locked ? 1 : 0);
}

// Lý do khởi động lại lần này (giúp phân biệt mất điện / sụt áp / watchdog / lệnh reboot)
const char* resetReasonName() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:   return "power_on";
    case ESP_RST_BROWNOUT:  return "brownout";
    case ESP_RST_SW:        return "software";
    case ESP_RST_PANIC:     return "panic";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:       return "watchdog";
    case ESP_RST_EXT:       return "external_reset";
    case ESP_RST_DEEPSLEEP: return "deep_sleep";
    default:                return "unknown";
  }
}

void configSave() {
  DeviceConfig copy;
  stateLock();
  copy = gConfig;
  stateUnlock();
  sPrefs.putUShort("ver", CFG_VERSION);
  sPrefs.putBytes("cfg", &copy, sizeof(copy));
  Serial.println(F("[NVS] Da luu cau hinh"));
}

void provSave() {
  ProvConfig copy;
  stateLock();
  copy = gProv;
  stateUnlock();
  sPrefs.putBytes("prov", &copy, sizeof(copy));
}

void configFactoryReset() {
  sPrefs.clear();
  Serial.println(F("[NVS] Da xoa toan bo cau hinh"));
}

uint32_t nextSeq() {
  stateLock();
  uint32_t s = ++sSeq;
  stateUnlock();
  if (s % SEQ_SAVE_STEP == 0) sPrefs.putUInt("seq", s);
  return s;
}

// ---------------------------------------------------------------------------
bool outboxPush(OutKind kind, const char* payload, bool storeIfOffline) {
  OutMsg m;
  m.kind = kind;
  m.storeIfOffline = storeIfOffline;
  strlcpy(m.payload, payload ? payload : "", sizeof(m.payload));
  return xQueueSend(qOutbox, &m, pdMS_TO_TICKS(50)) == pdTRUE;
}

bool commandPush(const char* json, CmdKind kind) {
  static CmdMsg c;            // ~1 KB: để static cho đỡ tốn stack task gọi (chỉ dùng trong lúc giữ khóa)
  xSemaphoreTake(sCmdMutex, portMAX_DELAY);
  c.kind = kind;
  strlcpy(c.json, json, sizeof(c.json));
  bool ok = xQueueSend(qCommand, &c, pdMS_TO_TICKS(50)) == pdTRUE;
  xSemaphoreGive(sCmdMutex);
  return ok;
}

// ---------------------------------------------------------------------------
uint32_t nowEpoch() {
  time_t t = time(nullptr);
  return (t > 1704067200) ? (uint32_t)t : 0;   // > 01/01/2024 mới coi là hợp lệ
}

bool isoTime(uint32_t epoch, char* out, size_t len) {
  if (!epoch) { if (len) out[0] = 0; return false; }
  time_t t = (time_t)epoch;
  struct tm tmv;
  gmtime_r(&t, &tmv);
  strftime(out, len, "%Y-%m-%dT%H:%M:%S.000Z", &tmv);
  return true;
}

// Watchdog: API khác nhau giữa ESP32 Arduino core 2.x và 3.x
void wdtInit() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t cfg = {
    .timeout_ms = WDT_TIMEOUT_S * 1000,
    .idle_core_mask = 0,
    .trigger_panic = true
  };
  if (esp_task_wdt_reconfigure(&cfg) != ESP_OK) esp_task_wdt_init(&cfg);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
}

void wdtAddThisTask() { esp_task_wdt_add(NULL); }
void wdtFeed()        { esp_task_wdt_reset(); }
