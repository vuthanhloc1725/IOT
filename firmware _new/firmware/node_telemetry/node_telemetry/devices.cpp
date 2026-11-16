/*
 * devices.cpp - (v1.3, v1.4 thêm quạt) Bảng ánh xạ deviceCode Backend <-> phần cứng, lưu NVS namespace "sfdev"
 */
#include "devices.h"
#include "config.h"
#include "app_state.h"
#include <Preferences.h>
#include <ArduinoJson.h>

struct DevEntry {
  char     code[DEV_CODE_LEN];
  uint8_t  lc;          // LC_xxx do Backend báo trong config (LC_UNKNOWN = chưa báo)
  uint32_t cfgVer;      // version cấu hình Backend đã áp dụng
};

static DevEntry    sDev[DEV_COUNT];
static Preferences sDevPrefs;
static const uint8_t DEV_STORE_VER = 1;

static const char* const kSlotName[DEV_COUNT] = { "soil", "temp", "hum", "pump", "fan" };
static const char* const kType[DEV_COUNT]     = { "SENSOR", "SENSOR", "SENSOR", "PUMP", "FAN" };
static const char* const kMetric[DEV_COUNT]   = { "SOIL_MOISTURE", "AIR_TEMPERATURE", "AIR_HUMIDITY", "", "" };
static const int         kGpio[DEV_COUNT]     = { PIN_SOIL_ADC, PIN_DHT, PIN_DHT, PIN_RELAY_PUMP, PIN_RELAY_FAN };

static inline bool validSlot(int s) { return s >= 0 && s < DEV_COUNT; }

static void devSave() {   // gọi khi đang giữ khóa
  sDevPrefs.putUChar("ver", DEV_STORE_VER);
  sDevPrefs.putBytes("tbl", sDev, sizeof(sDev));
}

void devInit() {
  memset(sDev, 0, sizeof(sDev));
  for (int i = 0; i < DEV_COUNT; i++) sDev[i].lc = LC_UNKNOWN;
  sDevPrefs.begin(NVS_DEV_NS, false);
  size_t len = sDevPrefs.getBytesLength("tbl");
  // v1.4: bảng v1.3 có 4 ô (chưa có quạt) -> vẫn nạp 4 ô đầu, ô quạt để trống
  if (sDevPrefs.getUChar("ver", 0) == DEV_STORE_VER && (len == sizeof(sDev) || len == 4 * sizeof(DevEntry))) {
    sDevPrefs.getBytes("tbl", sDev, len);
    for (int i = 0; i < DEV_COUNT; i++) sDev[i].code[DEV_CODE_LEN - 1] = 0;
  }
}

const char* devSlotName(int s) { return validSlot(s) ? kSlotName[s] : "?"; }
const char* devType(int s)     { return validSlot(s) ? kType[s] : ""; }
const char* devMetric(int s)   { return validSlot(s) ? kMetric[s] : ""; }
int         devGpio(int s)     { return validSlot(s) ? kGpio[s] : -1; }

int devSlotFromName(const char* n) {
  if (!n) return DEV_NONE;
  for (int i = 0; i < DEV_COUNT; i++) if (!strcasecmp(n, kSlotName[i])) return i;
  return DEV_NONE;
}

bool devGetCode(int s, char* out, size_t len) {
  if (!validSlot(s)) { if (len) out[0] = 0; return false; }
  stateLock(); strlcpy(out, sDev[s].code, len); stateUnlock();
  return out[0] != 0;
}

int devFindByCode(const char* code) {
  if (!code || !code[0]) return DEV_NONE;
  int r = DEV_NONE;
  stateLock();
  for (int i = 0; i < DEV_COUNT; i++) if (!strcmp(sDev[i].code, code)) { r = i; break; }
  stateUnlock();
  return r;
}

// Đoán metric của cảm biến DHT theo tên mã khi Backend không nói rõ (vd "TEMP-01", "T1", "HUM-01", "H1")
static int guessAirSlot(const char* code, const char* hint) {
  if (hint && hint[0]) {
    if (!strcasecmp(hint, "AIR_TEMPERATURE")) return DEV_AIR_T;
    if (!strcasecmp(hint, "AIR_HUMIDITY"))    return DEV_AIR_H;
  }
  char up[DEV_CODE_LEN];
  size_t n = 0;
  for (; code[n] && n < sizeof(up) - 1; n++) up[n] = toupper((unsigned char)code[n]);
  up[n] = 0;
  if (strstr(up, "HUM") || strstr(up, "RH") || up[0] == 'H') return DEV_AIR_H;
  if (strstr(up, "TEMP") || up[0] == 'T') return DEV_AIR_T;
  return DEV_NONE;
}

int devResolve(const char* code, const char* type, int gpio, const char* metricHint, char* err, size_t errLen) {
  if (!code || !code[0]) { strlcpy(err, "thieu deviceCode", errLen); return DEV_NONE; }
  int s = devFindByCode(code);
  if (s != DEV_NONE) {
    if (type && type[0] && strcasecmp(type, kType[s])) {
      snprintf(err, errLen, "%s da gan cho %s, khong phai %s", code, kType[s], type);
      return DEV_NONE;
    }
    return s;
  }
  if (!type || !type[0]) { strlcpy(err, "thieu type", errLen); return DEV_NONE; }

  if (!strcasecmp(type, "FAN")) {
    if (gpio >= 0 && gpio != PIN_RELAY_FAN) {
      snprintf(err, errLen, "node chi co quat o GPIO%d (relay kenh 2)", PIN_RELAY_FAN);
      return DEV_NONE;
    }
    return DEV_FAN;
  }
  if (!strcasecmp(type, "PUMP")) {
    if (gpio >= 0 && gpio != PIN_RELAY_PUMP) {
      snprintf(err, errLen, "node chi co bom o GPIO%d (relay kenh 1)", PIN_RELAY_PUMP);
      return DEV_NONE;
    }
    return DEV_PUMP;
  }
  if (strcasecmp(type, "SENSOR")) { snprintf(err, errLen, "type %s khong ho tro", type); return DEV_NONE; }

  if (gpio < 0) {   // không có GPIO -> chỉ đoán được qua metric
    if (metricHint && !strcasecmp(metricHint, "SOIL_MOISTURE")) return DEV_SOIL;
    int g = guessAirSlot(code, metricHint);
    if (g != DEV_NONE) return g;
    strlcpy(err, "thieu gpioPin", errLen);
    return DEV_NONE;
  }
  if (gpio == PIN_SOIL_ADC) return DEV_SOIL;
  if (gpio == PIN_DHT) {
    int g = guessAirSlot(code, metricHint);
    if (g != DEV_NONE) return g;
    // Không đoán được: ô nhiệt độ trống thì lấy ô nhiệt độ, không thì ô độ ẩm
    char t[DEV_CODE_LEN];
    if (!devGetCode(DEV_AIR_T, t, sizeof(t))) return DEV_AIR_T;
    if (!devGetCode(DEV_AIR_H, t, sizeof(t))) return DEV_AIR_H;
    strlcpy(err, "DHT11 da gan du 2 ma (nhiet do, do am)", errLen);
    return DEV_NONE;
  }
  snprintf(err, errLen, "GPIO%d khong co cam bien (dat: GPIO%d, DHT11: GPIO%d)", gpio, PIN_SOIL_ADC, PIN_DHT);
  return DEV_NONE;
}

void devAssign(int s, const char* code) {
  if (!validSlot(s) || !code) return;
  stateLock();
  for (int i = 0; i < DEV_COUNT; i++)
    if (i != s && !strcmp(sDev[i].code, code)) { memset(&sDev[i], 0, sizeof(DevEntry)); sDev[i].lc = LC_UNKNOWN; }
  if (strcmp(sDev[s].code, code)) {        // mã mới cho ô này -> lifecycle/version cũ không còn giá trị
    strlcpy(sDev[s].code, code, DEV_CODE_LEN);
    sDev[s].lc = LC_UNKNOWN;
    sDev[s].cfgVer = 0;
  }
  devSave();
  stateUnlock();
}

void devClear(int s) {
  stateLock();
  for (int i = 0; i < DEV_COUNT; i++) {
    if (s != DEV_NONE && i != s) continue;
    memset(&sDev[i], 0, sizeof(DevEntry));
    sDev[i].lc = LC_UNKNOWN;
  }
  devSave();
  stateUnlock();
}

uint8_t devLifecycle(int s) {
  if (!validSlot(s)) return LC_UNKNOWN;
  stateLock(); uint8_t v = sDev[s].lc; stateUnlock();
  return v;
}

void devSetLifecycle(int s, uint8_t lc) {
  if (!validSlot(s)) return;
  stateLock();
  if (sDev[s].lc != lc) { sDev[s].lc = lc; devSave(); }
  stateUnlock();
}

bool devBlocked(int s) {
  uint8_t lc = devLifecycle(s);
  return lc == LC_MAINTENANCE || lc == LC_DECOMMISSIONED || lc == LC_FAULT;
}

bool devActive(int s) { return devLifecycle(s) == LC_ACTIVE; }

uint32_t devConfigVersion(int s) {
  if (!validSlot(s)) return 0;
  stateLock(); uint32_t v = sDev[s].cfgVer; stateUnlock();
  return v;
}

void devSetConfigVersion(int s, uint32_t v) {
  if (!validSlot(s)) return;
  stateLock();
  if (sDev[s].cfgVer != v) { sDev[s].cfgVer = v; devSave(); }
  stateUnlock();
}

void devPrint() {
  DevEntry copy[DEV_COUNT];
  stateLock(); memcpy(copy, sDev, sizeof(copy)); stateUnlock();
  Serial.println(F("o      type    gpio  deviceCode            lifecycle       cfgVersion"));
  for (int i = 0; i < DEV_COUNT; i++) {
    Serial.printf("%-6s %-7s %-5d %-21s %-15s %lu\n", kSlotName[i], kType[i], kGpio[i],
                  copy[i].code[0] ? copy[i].code : "(chua gan)",
                  copy[i].lc == LC_UNKNOWN ? "-" : lifecycleName(copy[i].lc), (unsigned long)copy[i].cfgVer);
  }
}

// Gửi trạng thái 1 thiết bị lên sf/<nodeCode>/status (không retained):
//   {"deviceCode":"PUMP-01","deviceStatus":"FAULT","message":"..."}
// Bỏ qua nếu ô chưa có deviceCode (Backend chưa đăng ký thiết bị đó).
bool devPublishStatus(int slot, const char* status, const char* message) {
  char code[DEV_CODE_LEN];
  if (!devGetCode(slot, code, sizeof(code))) return false;
  JsonDocument d;
  d["deviceCode"]   = code;
  d["deviceStatus"] = status;
  if (message && message[0]) d["message"] = message;
  char buf[300];
  serializeJson(d, buf, sizeof(buf));
  Serial.printf("[DEV] status %s\n", buf);
  return outboxPush(OUT_DEV_STATUS, buf, false);
}
