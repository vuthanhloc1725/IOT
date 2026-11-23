/*
 * control.cpp - Task điều khiển
 *
 *  TỰ ĐỘNG (chế độ AUTO; v1.4: theo lifecycle TỪNG THIẾT BỊ do Admin kích hoạt trên web):
 *   - Bơm : chạy khi BƠM và CẢM BIẾN ĐẤT đều ACTIVE, pumpAutoEnabled = true.
 *           soil < soilLow  -> BẬT ; soil >= soilHigh -> TẮT   (vùng trễ chống bật/tắt liên tục)
 *           chạy tối đa pumpMaxOnS giây / lần, nghỉ tối thiểu pumpMinOffS giây giữa 2 lần
 *           cảm biến đất lỗi -> TẮT bơm (fail-safe)
 *           BẢO VỆ CHẠY KHÔ: sau mỗi lần bơm hết giờ, chờ nước ngấm (pumpMinOffS) rồi
 *           so độ ẩm với lúc bắt đầu bơm; tăng < PUMP_EFFECT_MIN_PCT -> event pump_no_effect.
 *           PUMP_NOEFFECT_LOCK lần liên tiếp -> KHÓA bơm tự động (event pump_locked,
 *           heartbeat faults = ["pump"]) cho tới khi nhận lệnh pump_unlock.
 *           Có phao mực nước (USE_WATER_LEVEL) báo hết nước -> không bơm.
 *   - Quạt: chạy khi QUẠT ACTIVE, fanAutoEnabled = true, DHT11 không bị Bảo trì/Lỗi.
 *           temp >= tempFanOn hoặc hum >= humFanOn -> BẬT ;
 *           temp <= tempFanOff và hum < humFanOff -> TẮT
 *
 *  LỆNH (v1.4: MỘT topic sf/<nodeCode>/cmd, phản hồi trên sf/<nodeCode>/cmd/ack):
 *   pump      {"commandUuid","deviceCode","action":"pump","on"/"turnOn","seconds"}
 *   fan       {"commandUuid","deviceCode","action":"fan","on"/"turnOn"}
 *   lifecycle {"commandUuid"?,"deviceCode","type","gpioPin","action":"lifecycle","lifecycle":"ACTIVE"|...}
 *   config    {"action":"config","deviceCode","type","gpioPin","lifecycle","config":{...},"version"} -> config/ack
 *   pump_unlock / mode / get_status / reboot / reset_wifi / factory_reset
 *   ACK: {"commandUuid","commandId","deviceCode","action","success","ok","message"}
 *        (lệnh từ Serial/sim_backend dùng "req_id" thay cho commandUuid)
 *  Lệnh từ web KHÔNG vượt được giới hạn an toàn bơm (tối đa 30 s, nghỉ 60 s, khóa chạy khô, phao nước).
 */
#include "control.h"
#include "config.h"
#include "app_state.h"
#include "net.h"
#include "devices.h"
#include "sensors.h"
#include <ArduinoJson.h>
#include <LittleFS.h>

static uint32_t sPumpOnAt = 0;          // millis() lúc bật bơm
static uint32_t sPumpOffAt = 0;         // millis() lúc tắt bơm gần nhất
static uint32_t sPumpDeadline = 0;      // thời hạn tắt bơm (ms, 0 = không có)
static bool     sPumpManual = false;    // bơm đang chạy do lệnh tay -> tự động hóa không can thiệp tới khi hết thời gian
static uint32_t sFanManualUntil = 0;    // lệnh tay quạt được giữ FAN_MANUAL_HOLD_S trước khi tự động hóa quản lý lại
static float    sSoilAtPumpOn = NAN;    // độ ẩm lúc bắt đầu lần bơm tự động gần nhất
static bool     sPendingEval = false;   // lần bơm tự động trước kết thúc do HẾT GIỜ -> cần đánh giá hiệu quả
static uint8_t  sNoEffectCount = 0;     // số lần bơm liên tiếp không hiệu quả

static inline void relayWrite(int pin, bool on) {
  digitalWrite(pin, on ? RELAY_ON_LEVEL : !RELAY_ON_LEVEL);
}

void actuatorsInit() {
  // Ghi mức TẮT trước khi đặt OUTPUT để relay không bị nháy lúc khởi động
  digitalWrite(PIN_RELAY_PUMP, !RELAY_ON_LEVEL);
  digitalWrite(PIN_RELAY_FAN, !RELAY_ON_LEVEL);
  pinMode(PIN_RELAY_PUMP, OUTPUT);
  pinMode(PIN_RELAY_FAN, OUTPUT);
}

// ---------------------------------------------------------------------------
// Sự kiện gửi Backend trên sf/<node>/status: {"event":"pump_locked","message":...}
static void publishEvent(const char* event, const char* message, float soilNow = NAN, float gain = NAN) {
  JsonDocument d;
  d["event"] = event;
  if (message && message[0]) d["message"] = message;
  if (!isnan(soilNow)) d["soil"] = roundf(soilNow * 10) / 10.0f;
  if (!isnan(gain))    d["gain"] = roundf(gain * 10) / 10.0f;
  d["count"] = sNoEffectCount;
  d["pumpOn"] = false;              // các sự kiện bơm đều xảy ra khi bơm đã tắt
  d["seq"] = nextSeq();
  d["bc"]  = gBootCount;
  d["up"]  = millis();
  uint32_t e = nowEpoch();
  if (e) d["ts"] = e;
  char buf[300];
  serializeJson(d, buf, sizeof(buf));
  outboxPush(OUT_EVENT, buf, false);
  Serial.printf("[CTRL] Su kien %s: %s\n", event, message ? message : "");
}

static void setPump(bool on, const char* reason, uint32_t durationS = 0) {
  sPumpManual = on && !strcmp(reason, "manual");
  bool changed;
  stateLock();
  changed = (gState.pumpOn != on);
  gState.pumpOn = on;
  stateUnlock();
  relayWrite(PIN_RELAY_PUMP, on);
  uint32_t now = millis();
  if (on) {
    uint16_t maxOn;
    stateLock(); maxOn = gConfig.pumpMaxOnS; stateUnlock();
    if (changed) {
      sPumpOnAt = now;
      stateLock(); sSoilAtPumpOn = gState.soilPct; stateUnlock();
    }
    uint32_t d = durationS ? min<uint32_t>(durationS, maxOn) : maxOn;
    sPumpDeadline = now + d * 1000UL;
    if (sPumpDeadline == 0) sPumpDeadline = 1;
  } else {
    if (changed) { sPumpOffAt = now ? now : 1; }
    sPumpDeadline = 0;
  }
  // v1.4: trạng thái bơm tới Backend qua "pumpOn" trong telemetry (5 s/lần), không gửi bản tin riêng
  if (changed) Serial.printf("[CTRL] BOM %s (%s)\n", on ? "BAT" : "TAT", reason);
}

static void setFan(bool on, const char* reason) {
  bool changed;
  stateLock();
  changed = (gState.fanOn != on);
  gState.fanOn = on;
  stateUnlock();
  relayWrite(PIN_RELAY_FAN, on);
  if (changed) Serial.printf("[CTRL] QUAT %s (%s)\n", on ? "BAT" : "TAT", reason);
}

static void pumpUnlock(const char* why) {
  bool was;
  stateLock(); was = gState.pumpLocked; gState.pumpLocked = false; stateUnlock();
  pumpLockSave(false);
  sNoEffectCount = 0;
  sPendingEval = false;
  if (was) {
    char m[64]; snprintf(m, sizeof(m), "Da mo khoa bom (%s)", why);
    publishEvent("pump_unlocked", m);
  }
}

// ---------------------------------------------------------------------------
void buildConfigJson(char* out, size_t len) {
  DeviceConfig c;
  stateLock(); c = gConfig; stateUnlock();
  JsonDocument doc;
  doc["device_id"]    = c.deviceId;
  doc["fw"]           = FW_VERSION;
  doc["mode"]         = c.mode == MODE_AUTO ? "auto" : "manual";
  doc["lifecycle"]    = lifecycleName(c.lifecycle);
  doc["pump_auto"]    = c.pumpAuto != 0;
  doc["fan_auto"]     = c.fanAuto != 0;
  doc["soil_low"]     = c.soilLow;
  doc["soil_high"]    = c.soilHigh;
  doc["temp_fan_on"]  = c.tempFanOn;
  doc["temp_fan_off"] = c.tempFanOff;
  doc["hum_fan_on"]   = c.humFanOn;
  doc["hum_fan_off"]  = c.humFanOff;
  doc["soil_raw_dry"] = c.soilRawDry;
  doc["soil_raw_wet"] = c.soilRawWet;
  doc["pump_max_on"]  = c.pumpMaxOnS;
  doc["pump_min_off"] = c.pumpMinOffS;
  doc["sample_ms"]    = c.sampleMs;
  doc["heartbeat_ms"] = c.heartbeatMs;
  serializeJson(doc, out, len);
}

static bool parseOnOff(JsonVariantConst v, bool& out) {
  if (v.is<bool>()) { out = v.as<bool>(); return true; }
  if (v.is<int>())  { out = v.as<int>() != 0; return true; }
  if (v.is<const char*>()) {
    const char* s = v.as<const char*>();
    if (!strcasecmp(s, "on") || !strcmp(s, "1") || !strcasecmp(s, "true"))   { out = true;  return true; }
    if (!strcasecmp(s, "off") || !strcmp(s, "0") || !strcasecmp(s, "false")) { out = false; return true; }
  }
  return false;
}

// Áp dụng thay đổi cấu hình (chỉ trường nào có trong JSON), kiểm tra hợp lệ. Sai -> giữ cấu hình cũ.
static bool applyConfig(JsonDocument& d, char* err, size_t errLen) {
  DeviceConfig c;
  stateLock(); c = gConfig; stateUnlock();

  if (d["soil_low"].is<float>())     c.soilLow     = d["soil_low"];
  if (d["soil_high"].is<float>())    c.soilHigh    = d["soil_high"];
  if (d["temp_fan_on"].is<float>())  c.tempFanOn   = d["temp_fan_on"];
  if (d["temp_fan_off"].is<float>()) c.tempFanOff  = d["temp_fan_off"];
  if (d["hum_fan_on"].is<float>())   c.humFanOn    = d["hum_fan_on"];
  if (d["hum_fan_off"].is<float>())  c.humFanOff   = d["hum_fan_off"];
  if (d["soil_raw_dry"].is<int>())   c.soilRawDry  = d["soil_raw_dry"];
  if (d["soil_raw_wet"].is<int>())   c.soilRawWet  = d["soil_raw_wet"];
  if (d["pump_max_on"].is<int>())    c.pumpMaxOnS  = d["pump_max_on"];
  if (d["pump_min_off"].is<int>())   c.pumpMinOffS = d["pump_min_off"];
  if (d["sample_ms"].is<int>())      c.sampleMs    = d["sample_ms"];
  if (d["heartbeat_ms"].is<int>())   c.heartbeatMs = d["heartbeat_ms"];
  if (d["pump_auto"].is<bool>())     c.pumpAuto    = d["pump_auto"].as<bool>() ? 1 : 0;
  if (d["fan_auto"].is<bool>())      c.fanAuto     = d["fan_auto"].as<bool>() ? 1 : 0;

  if (c.soilLow < 0 || c.soilHigh > 100 || c.soilLow >= c.soilHigh) {
    strlcpy(err, "soil_low phai < soil_high, trong khoang 0..100", errLen); return false;
  }
  if (c.tempFanOff >= c.tempFanOn) { strlcpy(err, "temp_fan_off phai < temp_fan_on", errLen); return false; }
  if (c.soilRawWet >= c.soilRawDry) { strlcpy(err, "soil_raw_wet phai < soil_raw_dry", errLen); return false; }
  // v1.4: giới hạn an toàn bơm KHÔNG nới được từ xa (tối đa DEF_PUMP_MAX_ON_S, nghỉ ít nhất DEF_PUMP_MIN_OFF_S)
  if (c.pumpMaxOnS < 1 || c.pumpMaxOnS > DEF_PUMP_MAX_ON_S) {
    snprintf(err, errLen, "pump_max_on 1..%d giay (gioi han an toan)", DEF_PUMP_MAX_ON_S); return false;
  }
  if (c.pumpMinOffS < DEF_PUMP_MIN_OFF_S || c.pumpMinOffS > 3600) {
    snprintf(err, errLen, "pump_min_off %d..3600 giay (gioi han an toan)", DEF_PUMP_MIN_OFF_S); return false;
  }
  if (c.soilRawDry > 4095 || c.soilRawDry - c.soilRawWet < 300) {
    strlcpy(err, "soil_raw_dry <= 4095 va lon hon soil_raw_wet it nhat 300", errLen); return false;
  }
  if (c.humFanOn < 50 || c.humFanOn > 100) { strlcpy(err, "hum_fan_on 50..100", errLen); return false; }
  if (c.humFanOff < 30 || c.humFanOff >= c.humFanOn) { strlcpy(err, "hum_fan_off 30..(hum_fan_on - 1)", errLen); return false; }
  if (c.sampleMs < 2000 || c.sampleMs > 3600000UL) { strlcpy(err, "sample_ms 2000..3600000", errLen); return false; }
  if (c.heartbeatMs < 5000 || c.heartbeatMs > 600000UL) { strlcpy(err, "heartbeat_ms 5000..600000", errLen); return false; }

  stateLock(); gConfig = c; stateUnlock();
  configSave();
  return true;
}

// ===========================================================================
//  v1.4 - XỬ LÝ LỆNH TRÊN sf/<nodeCode>/cmd (Backend + Serial + sim_backend)
// ===========================================================================

// Ngữ cảnh 1 lệnh: để gửi ACK đúng định dạng (Backend: commandUuid; Serial/sim: req_id)
struct CmdCtx {
  char uuid[48];      // commandUuid / commandId của Backend ("" nếu không có)
  char reqId[40];     // req_id kiểu cũ
  char code[DEV_CODE_LEN];
  char action[20];
};

// QoS 1 có thể giao lặp -> nhớ 4 lệnh có UUID gần nhất, lệnh trùng chỉ gửi lại ACK cũ, KHÔNG làm lại.
struct RecentCmd { char uuid[48]; char ack[300]; };
static RecentCmd sRecent[4];
static uint8_t   sRecentIdx = 0;

static void sendAck(const CmdCtx& x, bool ok, const char* msg) {
  JsonDocument d;
  if (x.uuid[0]) { d["commandUuid"] = x.uuid; d["commandId"] = x.uuid; }
  if (x.reqId[0]) d["req_id"] = x.reqId;
  if (x.code[0]) d["deviceCode"] = x.code;       // Backend so khớp deviceCode nếu có
  d["action"]  = x.action;
  d["success"] = ok;                              // Backend: Boolean
  d["ok"]      = ok;
  d["message"] = msg ? msg : "";
  char buf[300];
  serializeJson(d, buf, sizeof(buf));
  if (x.uuid[0]) {
    RecentCmd& r = sRecent[sRecentIdx];
    sRecentIdx = (sRecentIdx + 1) % 4;
    strlcpy(r.uuid, x.uuid, sizeof(r.uuid));
    strlcpy(r.ack, buf, sizeof(r.ack));
  }
  Serial.printf("[ACK] %s\n", buf);
  // Lệnh không có commandUuid/req_id (vd Backend gửi lifecycle MAINTENANCE/PROVISIONED không chờ ACK):
  // KHÔNG gửi ACK, tránh Backend ghi nhật ký "ACK không hợp lệ".
  if (x.uuid[0] || x.reqId[0]) outboxPush(OUT_ACK, buf, false);
}

static void sendConfigAck(const char* code, uint32_t ver, bool ok, const char* msg) {
  JsonDocument d;
  d["deviceCode"] = code;
  d["version"]    = ver;
  d["success"]    = ok;
  if (msg && msg[0]) d["message"] = msg;
  char buf[300];
  serializeJson(d, buf, sizeof(buf));
  Serial.printf("[ACK] config %s\n", buf);
  outboxPush(OUT_CONFIG_ACK, buf, false);
}

// Tìm ô phần cứng cho deviceCode trong lệnh (gán mã nếu là lần đầu). wantSlot = ô bắt buộc (DEV_NONE = bất kỳ).
static int resolveSlot(JsonDocument& d, const char* code, int wantSlot, char* err, size_t errLen) {
  const char* type = d["type"] | "";
  int gpio = d["gpioPin"].is<int>() ? d["gpioPin"].as<int>() : -1;
  if (!code[0]) {                                   // lệnh Serial/sim không có mã -> dùng thẳng ô yêu cầu
    if (wantSlot != DEV_NONE) return wantSlot;
    strlcpy(err, "thieu deviceCode", errLen);
    return DEV_NONE;
  }
  if (!type[0] && wantSlot != DEV_NONE) type = devType(wantSlot);
  JsonVariantConst mv = d["config"]["metrics"][0];
  const char* metricHint = mv.is<const char*>() ? mv.as<const char*>() : (d["metric"] | "");
  int slot = devResolve(code, type, gpio, metricHint, err, errLen);
  if (slot == DEV_NONE) return DEV_NONE;
  if (wantSlot != DEV_NONE && slot != wantSlot) {
    snprintf(err, errLen, "%s la %s, khong phai %s", code, devType(slot), devType(wantSlot));
    return DEV_NONE;
  }
  if (gpio >= 0 && gpio != devGpio(slot)) {
    snprintf(err, errLen, "gpioPin %d khong khop phan cung (%s o GPIO%d)", gpio, devSlotName(slot), devGpio(slot));
    return DEV_NONE;
  }
  devAssign(slot, code);                            // không đổi gì nếu mã đã gán đúng ô
  return slot;
}

// Lifecycle node: ACTIVE khi có ít nhất 1 thiết bị ACTIVE (giữ MAINTENANCE/DECOMMISSIONED đặt tay ở cấp node)
static void refreshNodeLifecycle() {
  bool anyActive = false;
  for (int i = 0; i < DEV_COUNT; i++) if (devActive(i)) anyActive = true;
  bool changed = false;
  stateLock();
  uint8_t lc = gConfig.lifecycle;
  if (lc != LC_MAINTENANCE && lc != LC_DECOMMISSIONED) {
    uint8_t want = anyActive ? LC_ACTIVE : (lc == LC_REGISTERED ? LC_REGISTERED : LC_PROVISIONED);
    if (want != lc) { gConfig.lifecycle = want; changed = true; }
  }
  stateUnlock();
  if (changed) configSave();
}

// Tắt cơ cấu chấp hành liên quan khi 1 thiết bị chuyển sang trạng thái bị chặn
static void applyBlockedOutputs(int slot) {
  if (!devBlocked(slot)) return;
  if (slot == DEV_PUMP || slot == DEV_SOIL) setPump(false, "lifecycle");
  if (slot == DEV_FAN || slot == DEV_AIR_T || slot == DEV_AIR_H) setFan(false, "lifecycle");
}

// ---------------------------------------------------------------------------
// pump: {"action":"pump","deviceCode","on"/"turnOn"/"value","seconds"/"duration"}
static void cmdPump(JsonDocument& d, CmdCtx& x) {
  bool on;
  JsonVariantConst v = d["turnOn"].isNull() ? (d["on"].isNull() ? d["value"] : d["on"]) : d["turnOn"];
  if (!parseOnOff(v, on)) { sendAck(x, false, "thieu on/turnOn (true/false)"); return; }
  char err[96] = "";
  if (resolveSlot(d, x.code, DEV_PUMP, err, sizeof(err)) == DEV_NONE) { sendAck(x, false, err); return; }

  if (!on) {                                       // TẮT luôn được phép
    setPump(false, "remote");
    sendAck(x, true, "Pump turned off");
    return;
  }
  uint8_t nodeLc;
  bool waterLow, soilFault, locked, pumpOn;
  stateLock();
  nodeLc = gConfig.lifecycle; waterLow = gState.waterLow; soilFault = gState.soilFault;
  locked = gState.pumpLocked; pumpOn = gState.pumpOn;
  stateUnlock();
  if (nodeLc == LC_DECOMMISSIONED || devBlocked(DEV_PUMP)) {
    sendAck(x, false, "bom dang Bao tri/Ngung dung/Loi - khong cho bat"); return;
  }
  if (waterLow) { sendAck(x, false, "bon het nuoc - khong bat bom (chong chay kho)"); return; }

  uint32_t sec = d["seconds"] | (d["duration"] | (uint32_t)DEF_MANUAL_PUMP_S);
  if (sec == 0) sec = DEF_MANUAL_PUMP_S;
  uint16_t maxOn;
  stateLock(); maxOn = gConfig.pumpMaxOnS; stateUnlock();
  uint32_t runS = min<uint32_t>(sec, maxOn);       // giới hạn an toàn của firmware luôn thắng

  if (!pumpOn) pumpCurrentZero();
  sPendingEval = false;                            // bơm tay/từ xa không dùng để đánh giá chạy khô
  setPump(true, "manual", runS);

#if USE_PUMP_CURRENT
  // Có ACS712: chỉ ACK thành công khi đo được dòng thật qua bơm
  vTaskDelay(pdMS_TO_TICKS(600));
  float a = pumpCurrentA();
  if (isnan(a) || a < PUMP_CURRENT_MIN_A) {
    setPump(false, "no_current");
    char m[96]; snprintf(m, sizeof(m), "relay da dong nhung khong co dong qua bom (%.2f A) - da tat", isnan(a) ? 0.0f : a);
    sendAck(x, false, m);
    devPublishStatus(DEV_PUMP, "FAULT", m);
    return;
  }
#endif
  char m[160];
  snprintf(m, sizeof(m), "Pump turned on, tu tat sau %lu s (an toan)%s%s",
           (unsigned long)runS,
           soilFault ? "; canh bao: cam bien dat dang loi" : "",
           locked ? "; canh bao: bom dang bi khoa tu dong (nghi chay kho)" : "");
  sendAck(x, true, m);
}

// fan: {"action":"fan","deviceCode","on"/"turnOn"/"value"}
static void cmdFan(JsonDocument& d, CmdCtx& x) {
  bool on;
  JsonVariantConst v = d["turnOn"].isNull() ? (d["on"].isNull() ? d["value"] : d["on"]) : d["turnOn"];
  if (!parseOnOff(v, on)) { sendAck(x, false, "thieu on/turnOn (true/false)"); return; }
  char err[96] = "";
  if (resolveSlot(d, x.code, DEV_FAN, err, sizeof(err)) == DEV_NONE) { sendAck(x, false, err); return; }
  uint8_t nodeLc;
  stateLock(); nodeLc = gConfig.lifecycle; stateUnlock();
  if (on && (nodeLc == LC_DECOMMISSIONED || devBlocked(DEV_FAN))) {
    sendAck(x, false, "quat dang Bao tri/Ngung dung/Loi - khong cho bat"); return;
  }
  setFan(on, "manual");
  sFanManualUntil = millis() + FAN_MANUAL_HOLD_S * 1000UL;   // giữ lệnh tay 5 phút rồi tự động hóa quản lý lại
  if (sFanManualUntil == 0) sFanManualUntil = 1;
  sendAck(x, true, on ? "Fan turned on" : "Fan turned off");
}

// lifecycle: Backend {"deviceCode","type","gpioPin","lifecycle"/"state"} ; Serial/sim {"value"} (áp cho cả node)
static void cmdLifecycle(JsonDocument& d, CmdCtx& x) {
  const char* name = d["lifecycle"] | (d["state"] | (d["value"] | ""));
  int lc = lifecycleFromName(name);
  if (lc < 0) { sendAck(x, false, "trang thai lifecycle khong hop le"); return; }

  if (!x.code[0]) {
    // Kiểu cũ (Serial "lc active", sim_backend): đặt cho node VÀ mọi ô -> tiện test một mình
    stateLock(); gConfig.lifecycle = (uint8_t)lc; stateUnlock();
    configSave();
    for (int i = 0; i < DEV_COUNT; i++) { devSetLifecycle(i, (uint8_t)lc); applyBlockedOutputs(i); }
    if (lc == LC_MAINTENANCE || lc == LC_DECOMMISSIONED || lc == LC_REGISTERED) {
      setPump(false, "lifecycle");
      setFan(false, "lifecycle");
    }
    Serial.printf("[CMD] Lifecycle node + moi thiet bi -> %s\n", lifecycleName(lc));
    sendAck(x, true, lifecycleName(lc));
    outboxPush(OUT_HEARTBEAT_NOW, "", false);
    return;
  }

  char err[96] = "";
  int slot = resolveSlot(d, x.code, DEV_NONE, err, sizeof(err));
  if (slot == DEV_NONE) { sendAck(x, false, err); return; }
  devSetLifecycle(slot, (uint8_t)lc);
  // DHT11: Backend thường đăng ký 1 thiết bị cho cả nhiệt độ + độ ẩm -> ô còn lại đi theo nếu chưa có mã riêng
  if (slot == DEV_AIR_T || slot == DEV_AIR_H) {
    int other = (slot == DEV_AIR_T) ? DEV_AIR_H : DEV_AIR_T;
    char oc[DEV_CODE_LEN];
    if (!devGetCode(other, oc, sizeof(oc))) devSetLifecycle(other, (uint8_t)lc);
  }
  applyBlockedOutputs(slot);
  refreshNodeLifecycle();
  Serial.printf("[CMD] %s (o %s) -> %s\n", x.code, devSlotName(slot), lifecycleName(lc));
  char m[64]; snprintf(m, sizeof(m), "%s -> %s", devSlotName(slot), lifecycleName(lc));
  sendAck(x, true, m);
  outboxPush(OUT_HEARTBEAT_NOW, "", false);
}

// config Backend: {"deviceCode","type","gpioPin","lifecycle","config":{...},"version"} -> config/ack
//  PUMP: pumpAutoEnabled, soilOnPct, soilOffPct, pumpMaxRunSec, pumpCooldownSec
//  FAN : fanAutoEnabled, fanOnTempC, fanOffTempC, fanOnHumidityPct, fanOffHumidityPct
//  Áp dụng idempotent theo version. Sai giá trị -> success=false kèm lý do, giữ cấu hình cũ.
static void cmdBackendConfig(JsonDocument& d, CmdCtx& x) {
  const char* code = x.code;
  if (!code[0]) { Serial.println(F("[CFG] config thieu deviceCode, bo qua")); return; }
  if (!d["version"].is<uint32_t>()) { sendConfigAck(code, 0, false, "thieu version (so nguyen)"); return; }
  uint32_t ver = d["version"];
  const char* lcName = d["lifecycle"] | "";
  int lc = lcName[0] ? lifecycleFromName(lcName) : -1;
  if (lcName[0] && lc < 0) { sendConfigAck(code, ver, false, "lifecycle khong hop le"); return; }

  char err[96] = "";
  int slot = resolveSlot(d, code, DEV_NONE, err, sizeof(err));
  if (slot == DEV_NONE) { sendConfigAck(code, ver, false, err); return; }

  uint32_t applied = devConfigVersion(slot);
  if (ver == applied && applied != 0) {
    Serial.printf("[CFG] %s version %lu da ap dung -> ACK lai\n", code, (unsigned long)ver);
    sendConfigAck(code, ver, true, "da ap dung truoc do");
    return;
  }
  if (ver < applied) {
    snprintf(err, sizeof(err), "version %lu cu hon version da ap dung %lu", (unsigned long)ver, (unsigned long)applied);
    sendConfigAck(code, ver, false, err); return;
  }

  // ---- Đổi sang khóa cấu hình nội bộ rồi dùng chung bộ kiểm tra hợp lệ ----
  JsonObjectConst cfg = d["config"];
  JsonDocument local;
  if (slot == DEV_PUMP) {
    if (cfg["pumpAutoEnabled"].is<bool>()) local["pump_auto"]    = cfg["pumpAutoEnabled"].as<bool>();
    if (cfg["soilOnPct"].is<float>())      local["soil_low"]     = cfg["soilOnPct"].as<float>();
    if (cfg["soilOffPct"].is<float>())     local["soil_high"]    = cfg["soilOffPct"].as<float>();
    if (cfg["pumpMaxRunSec"].is<int>())    local["pump_max_on"]  = cfg["pumpMaxRunSec"].as<int>();
    if (cfg["pumpCooldownSec"].is<int>())  local["pump_min_off"] = cfg["pumpCooldownSec"].as<int>();
  } else if (slot == DEV_FAN) {
    if (cfg["fanAutoEnabled"].is<bool>())     local["fan_auto"]     = cfg["fanAutoEnabled"].as<bool>();
    if (cfg["fanOnTempC"].is<float>())        local["temp_fan_on"]  = cfg["fanOnTempC"].as<float>();
    if (cfg["fanOffTempC"].is<float>())       local["temp_fan_off"] = cfg["fanOffTempC"].as<float>();
    if (cfg["fanOnHumidityPct"].is<float>())  local["hum_fan_on"]   = cfg["fanOnHumidityPct"].as<float>();
    if (cfg["fanOffHumidityPct"].is<float>()) local["hum_fan_off"]  = cfg["fanOffHumidityPct"].as<float>();
  }
  // SENSOR: ngưỡng cảnh báo do Backend xử lý, node không cần gì thêm
  if (local.size() > 0 && !applyConfig(local, err, sizeof(err))) { sendConfigAck(code, ver, false, err); return; }

  if (lc >= 0) devSetLifecycle(slot, (uint8_t)lc);
  devSetConfigVersion(slot, ver);
  applyBlockedOutputs(slot);
  refreshNodeLifecycle();
  Serial.printf("[CFG] %s -> o %s, lifecycle %s, version %lu\n", code, devSlotName(slot),
                lc >= 0 ? lifecycleName(lc) : "-", (unsigned long)ver);
  sendConfigAck(code, ver, true, "");
}

// config kiểu cũ (Serial "set soil_low 40", sim_backend): các khóa nội bộ soil_low, pump_max_on...
static void cmdLocalConfig(JsonDocument& d, CmdCtx& x) {
  char err[80] = "";
  bool ok = applyConfig(d, err, sizeof(err));
  sendAck(x, ok, ok ? "da luu" : err);
}

static void handleCommand(const char* json) {
  JsonDocument d;
  if (deserializeJson(d, json)) { Serial.println(F("[CMD] JSON khong hop le, bo qua")); return; }
  CmdCtx x;
  strlcpy(x.uuid,   d["commandUuid"] | (d["commandId"] | ""), sizeof(x.uuid));
  strlcpy(x.reqId,  d["req_id"] | "", sizeof(x.reqId));
  strlcpy(x.code,   d["deviceCode"] | "", sizeof(x.code));
  strlcpy(x.action, d["action"] | "", sizeof(x.action));
  Serial.printf("[CMD] action=%s device=%s uuid=%s\n", x.action, x.code, x.uuid[0] ? x.uuid : x.reqId);

  if (x.uuid[0]) {
    for (auto& r : sRecent) {
      if (r.uuid[0] && !strcmp(r.uuid, x.uuid)) {
        Serial.printf("[CMD] %s nhan lap (QoS1) -> gui lai ACK cu\n", x.uuid);
        outboxPush(OUT_ACK, r.ack, false);
        return;
      }
    }
  }
  const char* a = x.action;

  if (!strcmp(a, "pump")) { cmdPump(d, x); return; }
  if (!strcmp(a, "fan"))  { cmdFan(d, x);  return; }
  if (!strcmp(a, "lifecycle")) { cmdLifecycle(d, x); return; }
  if (!strcmp(a, "config")) {
    if (!d["version"].isNull() || d["config"].is<JsonObject>()) cmdBackendConfig(d, x);
    else cmdLocalConfig(d, x);
    return;
  }

  // ---- pump_unlock: kỹ thuật viên đã kiểm tra bồn nước / ống / bơm ----
  if (!strcmp(a, "pump_unlock")) {
    pumpUnlock(x.uuid[0] ? "web" : "cmd");
    sendAck(x, true, "da mo khoa bom");
    outboxPush(OUT_HEARTBEAT_NOW, "", false);
    return;
  }

  // ---- mode ----
  if (!strcmp(a, "mode")) {
    const char* v = d["value"] | "";
    if (strcasecmp(v, "auto") && strcasecmp(v, "manual")) { sendAck(x, false, "value phai la auto/manual"); return; }
    stateLock(); gConfig.mode = strcasecmp(v, "auto") == 0 ? MODE_AUTO : MODE_MANUAL; stateUnlock();
    configSave();
    sendAck(x, true, v);
    return;
  }

  // ---- get_status: gửi heartbeat ngay, ACK kèm cấu hình rút gọn ----
  if (!strcmp(a, "get_status")) {
    outboxPush(OUT_HEARTBEAT_NOW, "", false);
    DeviceConfig c;
    stateLock(); c = gConfig; stateUnlock();
    char m[200];
    snprintf(m, sizeof(m), "fw %s lc %s mode %s soil %.0f-%.0f%% fan %.0f/%.0fC %.0f/%.0f%%RH pump %us/%us",
             FW_VERSION, lifecycleName(c.lifecycle), c.mode == MODE_AUTO ? "auto" : "manual",
             c.soilLow, c.soilHigh, c.tempFanOn, c.tempFanOff, c.humFanOn, c.humFanOff,
             c.pumpMaxOnS, c.pumpMinOffS);
    sendAck(x, true, m);
    return;
  }

  // ---- reboot / reset_wifi / factory_reset ----
  if (!strcmp(a, "reboot") || !strcmp(a, "reset_wifi") || !strcmp(a, "factory_reset")) {
    sendAck(x, true, "thiet bi se khoi dong lai");
    setPump(false, a);
    setFan(false, a);
    vTaskDelay(pdMS_TO_TICKS(1500));   // chờ task mạng gửi xong ack
    if (!strcmp(a, "reset_wifi")) netResetWifiSettings();
    if (!strcmp(a, "factory_reset")) {
      netResetWifiSettings();
      configFactoryReset();
      devClear(DEV_NONE);
      LittleFS.remove(BACKLOG_FILE);
      LittleFS.remove(SENDING_FILE);
    }
    ESP.restart();
    return;
  }

  sendAck(x, false, "action khong ho tro");
}

#if ENABLE_DEVICE_PROBE
// ===========================================================================
//  device/probe - giao thức v1.3 (Backend đời cũ). Backend 02/11 không dùng; bật bằng ENABLE_DEVICE_PROBE = 1
// ===========================================================================

// Tự kiểm tra bơm có kiểm soát: bật relay trong ms mili giây, đo dòng ACS712, LUÔN tắt lại.
// Không có cảm biến dòng -> trả false kèm lý do (KHÔNG giả số đo).
static bool pumpSelfTest(uint16_t ms, float& amps, char* err, size_t errLen) {
  amps = NAN;
#if !USE_PUMP_CURRENT
  (void)ms;
  strlcpy(err, "node chua lap cam bien dong ACS712 (USE_PUMP_CURRENT=0)", errLen);
  return false;
#else
  bool pumpOn, waterLow;
  stateLock(); pumpOn = gState.pumpOn; waterLow = gState.waterLow; stateUnlock();
  if (pumpOn)   { strlcpy(err, "bom dang chay, khong tu kiem tra luc nay", errLen); return false; }
  if (waterLow) { strlcpy(err, "bon het nuoc (phao), khong chay thu bom", errLen); return false; }
  if (ms < 1) ms = 1;
  if (ms > 1000) ms = 1000;
  pumpCurrentZero();                         // mức 0 A khi bơm đang tắt
  uint32_t t0 = millis();
  relayWrite(PIN_RELAY_PUMP, true);
  vTaskDelay(pdMS_TO_TICKS(ms * 6 / 10));    // bỏ qua dòng khởi động, đo ở 40% thời gian cuối
  float best = 0;
  while (millis() - t0 < ms) {
    float a = pumpCurrentA();
    if (!isnan(a) && a > best) best = a;
    vTaskDelay(pdMS_TO_TICKS(20));
  }
  relayWrite(PIN_RELAY_PUMP, false);         // LUÔN trả đầu ra về OFF
  stateLock(); bool st = gState.pumpOn; stateUnlock();
  if (!st) relayWrite(PIN_RELAY_PUMP, false);
  amps = roundf(best * 100) / 100.0f;
  Serial.printf("[CTRL] Tu kiem tra bom %u ms: dong %.2f A\n", ms, amps);
  if (amps < PUMP_CURRENT_MIN_A) {
    snprintf(err, errLen, "khong co dong qua bom (%.2f A < %.2f A)", amps, PUMP_CURRENT_MIN_A);
    return false;
  }
  return true;
#endif
}

// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// device/probe: Backend yêu cầu xác minh thiết bị vật lý trước khi tạo bản ghi REGISTERED
//  SENSOR: đọc thật từ driver (đất: ADC; DHT11: số đọc mới nhất của task cảm biến, <= 5 s)
//  PUMP  : cần hardwareFeedback CURRENT_SENSOR đúng GPIO + allowActuatorTest=true -> chạy thử <= 1000 ms
//  Không đủ điều kiện -> present=false + lý do. KHÔNG bao giờ gửi số đo giả.
// ---------------------------------------------------------------------------
static char sLastProbeId[48] = "";
static char sLastProbeAck[420] = "";

static void handleBackendProbe(const char* json) {
  JsonDocument d;
  if (deserializeJson(d, json)) { Serial.println(F("[PROBE] JSON hong, bo qua")); return; }
  const char* reqId = d["requestId"] | "";
  const char* code  = d["deviceCode"] | "";
  const char* type  = d["type"] | "";
  int gpio = d["gpioPin"].is<int>() ? d["gpioPin"].as<int>() : -1;
  if (!reqId[0]) { Serial.println(F("[PROBE] thieu requestId, bo qua")); return; }
  if (!strcmp(reqId, sLastProbeId)) {                       // QoS1 giao lặp -> không chạy thử bơm lần 2
    outboxPush(OUT_PROBE_ACK, sLastProbeAck, false);
    return;
  }
  Serial.printf("[PROBE] %s %s GPIO%d\n", code, type, gpio);

  JsonDocument a;
  a["requestId"]       = reqId;
  a["deviceCode"]      = code;
  a["detectedType"]    = type;
  a["gpioPin"]         = gpio;
  a["present"]         = false;
  a["firmwareVersion"] = FW_VERSION;
  JsonObject st = a["selfTest"].to<JsonObject>();
  st["ok"] = false;
  char err[96] = "";
  bool present = false;

  const char* action = d["action"] | "";
  int slot = DEV_NONE;
  if (strcasecmp(action, "PROBE")) {
    strlcpy(err, "action phai la PROBE", sizeof(err));
  } else {
    slot = devResolve(code, type, gpio, d["metric"] | "", err, sizeof(err));
    if (slot != DEV_NONE && gpio != devGpio(slot)) {
      snprintf(err, sizeof(err), "GPIO%d khong khop phan cung (%s o GPIO%d)", gpio, devSlotName(slot), devGpio(slot));
      slot = DEV_NONE;
    }
  }

  if (slot == DEV_SOIL) {
    int raw = soilReadRaw();
    uint16_t dry, wet;
    stateLock(); dry = gConfig.soilRawDry; wet = gConfig.soilRawWet; stateUnlock();
    if (raw >= SOIL_RAW_FAULT_MIN && raw <= SOIL_RAW_FAULT_MAX) {
      float pct = roundf(soilRawToPercent(raw, dry, wet) * 10) / 10.0f;
      present = true;
      a["presenceEvidence"] = "SENSOR_READ:SOIL_MOISTURE";
      st["ok"] = true; st["metric"] = "SOIL_MOISTURE"; st["value"] = pct;
    } else {
      snprintf(err, sizeof(err), "ADC dat = %d (ngoai khoang hop le) - kiem tra day AO/nguon 3V3", raw);
    }
  } else if (slot == DEV_AIR_T || slot == DEV_AIR_H) {
    bool fault; float t, h;
    stateLock(); fault = gState.dhtFault; t = gState.tempC; h = gState.humPct; stateUnlock();
    float v = (slot == DEV_AIR_T) ? t : h;
    if (!fault && !isnan(v)) {
      present = true;
      char ev[40]; snprintf(ev, sizeof(ev), "SENSOR_READ:%s", devMetric(slot));
      a["presenceEvidence"] = ev;
      st["ok"] = true; st["metric"] = devMetric(slot); st["value"] = roundf(v * 10) / 10.0f;
    } else {
      strlcpy(err, "DHT11 chua doc duoc (kiem tra day DATA GPIO4)", sizeof(err));
    }
  } else if (slot == DEV_PUMP) {
    JsonObjectConst fb = d["hardwareFeedback"];
    const char* fbType = fb["type"] | "";
    int fbGpio = fb["gpioPin"].is<int>() ? fb["gpioPin"].as<int>() : -1;
    bool allow = d["allowActuatorTest"] | false;
#if !USE_PUMP_CURRENT
    (void)fbGpio; (void)allow;
    strlcpy(err, "node chua lap cam bien dong ACS712 - khong co bang chung bom", sizeof(err));
#else
    if (strcasecmp(fbType, "CURRENT_SENSOR")) {
      strlcpy(err, "node chi ho tro hardwareFeedback CURRENT_SENSOR", sizeof(err));
    } else if (fbGpio != PIN_PUMP_CURRENT) {
      snprintf(err, sizeof(err), "cam bien dong cua node o GPIO%d", PIN_PUMP_CURRENT);
    } else if (!allow) {
      strlcpy(err, "can allowActuatorTest=true moi chay thu bom", sizeof(err));
    } else {
      float amps;
      if (pumpSelfTest(PUMP_TEST_MS, amps, err, sizeof(err))) {
        present = true;
        a["presenceEvidence"] = "CURRENT_SENSOR";
        a["testDurationMs"]   = PUMP_TEST_MS;
        st["ok"] = true; st["metric"] = "CURRENT_A"; st["value"] = amps; st["evidence"] = "CURRENT_SENSOR";
      }
    }
#endif
    (void)fbType;
  }

  a["present"] = present;
  if (slot != DEV_NONE) a["detectedType"] = devType(slot);
  if (!present && err[0]) a["message"] = err;
  if (present) {
    devAssign(slot, code);
    Serial.printf("[PROBE] OK -> gan %s cho o %s\n", code, devSlotName(slot));
  } else {
    Serial.printf("[PROBE] KHONG xac minh duoc %s: %s\n", code, err);
  }
  strlcpy(sLastProbeId, reqId, sizeof(sLastProbeId));
  serializeJson(a, sLastProbeAck, sizeof(sLastProbeAck));
  outboxPush(OUT_PROBE_ACK, sLastProbeAck, false);
}

// ---------------------------------------------------------------------------
#endif  // ENABLE_DEVICE_PROBE

static void automationStep() {
  DeviceConfig c;
  RuntimeState s;
  stateLock(); c = gConfig; s = gState; stateUnlock();
  uint32_t now = millis();

  // An toàn LUÔN áp dụng (kể cả chế độ tay): hết thời gian bơm -> tắt
  if (s.pumpOn && sPumpDeadline && (int32_t)(now - sPumpDeadline) >= 0) {
    // lần bơm TỰ ĐỘNG bị dừng vì hết giờ (đất chưa đủ ẩm) -> đánh giá hiệu quả sau khi nước ngấm
    sPendingEval = !sPumpManual && c.mode == MODE_AUTO;
    setPump(false, "timeout");
    return;
  }
  // Hết nước (phao) -> tắt bơm ngay cả khi đang bơm tay
  if (s.pumpOn && s.waterLow) { setPump(false, "water_low"); return; }

  // Backend chuyển bơm/cảm biến đất sang Bảo trì, Ngừng dùng hoặc Lỗi -> dừng tưới tự động
  bool pumpBlocked = devBlocked(DEV_PUMP) || devBlocked(DEV_SOIL);
  if (s.pumpOn && !sPumpManual && pumpBlocked) { setPump(false, "lifecycle"); return; }

  // Node đặt tay Bảo trì/Ngừng dùng -> không tự động gì cả
  if (c.lifecycle == LC_MAINTENANCE || c.lifecycle == LC_DECOMMISSIONED || c.lifecycle == LC_REGISTERED) return;
  if (c.mode != MODE_AUTO || !s.hasReading) return;

  // v1.4: tưới tự động chỉ khi Admin đã kích hoạt CẢ bơm và cảm biến đất (ACTIVE) và bật pumpAutoEnabled
  bool pumpAutoOk = c.pumpAuto && devActive(DEV_PUMP) && devActive(DEV_SOIL);
  if (s.pumpOn && !sPumpManual && !pumpAutoOk) { setPump(false, "auto_disabled"); }

  // ---- Bơm ----
  if (pumpBlocked || !pumpAutoOk) {
    // không tưới tự động
  } else if (s.pumpOn && sPumpManual) {
    // đang bơm theo lệnh tay: chờ hết duration (đã xử lý ở trên)
  } else if (s.soilFault) {
    if (s.pumpOn) setPump(false, "sensor_fault");
  } else if (!s.pumpOn) {
    // chưa bơm lần nào (sPumpOffAt = 0) hoặc đã nghỉ đủ pumpMinOffS giây
    bool restOk = (sPumpOffAt == 0) || ((now - sPumpOffAt) >= (uint32_t)c.pumpMinOffS * 1000UL);
    bool locked = s.pumpLocked;
    // Đánh giá chỉ có nghĩa ngay sau thời gian nghỉ; quá trễ (vd: vừa chuyển manual -> auto)
    // thì bỏ, tránh so với số đo cũ từ nhiều giờ trước.
    if (sPendingEval && (now - sPumpOffAt) > (uint32_t)c.pumpMinOffS * 1000UL + 30000UL) sPendingEval = false;
    if (restOk && sPendingEval) {
      // Nước đã có thời gian ngấm tới cảm biến -> lần bơm trước có làm đất ẩm lên không?
      sPendingEval = false;
      float gain = isnan(sSoilAtPumpOn) ? 0 : s.soilPct - sSoilAtPumpOn;
      if (s.soilPct < c.soilLow && gain < PUMP_EFFECT_MIN_PCT) {
        sNoEffectCount++;
        publishEvent("pump_no_effect", "Bom xong nhung do am dat khong tang (nghi het nuoc/tac ong)", s.soilPct, gain);
        if (sNoEffectCount >= PUMP_NOEFFECT_LOCK) {
          stateLock(); gState.pumpLocked = true; stateUnlock();
          pumpLockSave(true);
          locked = true;
          // Backend: pump_locked -> chuyển bơm FAULT + cảnh báo CRITICAL (không cần gửi thêm deviceStatus)
          publishEvent("pump_locked", "Bom 3 lan khong lam dat am len (nghi het nuoc/tac ong) - da khoa bom tu dong, can pump_unlock", s.soilPct, gain);
          outboxPush(OUT_HEARTBEAT_NOW, "", false);
        }
      } else {
        sNoEffectCount = 0;
      }
    }
    if (s.soilPct < c.soilLow && restOk && !s.waterLow && !locked) setPump(true, "auto");
  } else if (s.soilPct >= c.soilHigh) {
    sNoEffectCount = 0;
    setPump(false, "auto");
  }

  // ---- Quạt ----
  if (sFanManualUntil && (int32_t)(now - sFanManualUntil) < 0) return;   // đang giữ lệnh tay
  sFanManualUntil = 0;
  // v1.4: quạt tự động chỉ khi Admin đã kích hoạt quạt (ACTIVE), bật fanAutoEnabled, DHT11 không bị chặn
  if (devBlocked(DEV_FAN)) { if (s.fanOn) setFan(false, "lifecycle"); return; }
  bool fanAutoOk = c.fanAuto && devActive(DEV_FAN) && !devBlocked(DEV_AIR_T) && !devBlocked(DEV_AIR_H);
  if (!fanAutoOk) return;               // không tự động: giữ nguyên trạng thái do lệnh tay đặt
  if (!s.dhtFault && !isnan(s.tempC)) {
    bool hot   = s.tempC >= c.tempFanOn;
    bool humid = s.humPct >= c.humFanOn;
    if (!s.fanOn && (hot || humid)) setFan(true, hot ? "auto_temp" : "auto_hum");
    else if (s.fanOn && s.tempC <= c.tempFanOff && s.humPct < c.humFanOff) setFan(false, "auto");
  }
}

void taskControl(void* arg) {
  wdtAddThisTask();
  static CmdMsg cmd;   // ~1 KB: để static, không chiếm stack
  for (;;) {
    wdtFeed();
    // Chờ lệnh tối đa CONTROL_PERIOD_MS, sau đó chạy 1 bước tự động hóa
    if (xQueueReceive(qCommand, &cmd, pdMS_TO_TICKS(CONTROL_PERIOD_MS)) == pdTRUE) {
      switch (cmd.kind) {
#if ENABLE_DEVICE_PROBE
        case CMD_PROBE:   handleBackendProbe(cmd.json);   break;
#endif
        default:          handleCommand(cmd.json);        break;
      }
    }
    automationStep();
  }
}
