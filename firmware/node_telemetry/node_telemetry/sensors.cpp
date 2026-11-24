/*
 * sensors.cpp - Task đọc cảm biến
 *  - Đọc độ ẩm đất: lấy trung bình 16 mẫu ADC, quy đổi % theo 2 điểm hiệu chuẩn
 *  - Đọc DHT11 (v1.2, trước là DHT22): nhiệt độ + độ ẩm không khí (tối thiểu 1-2 giây/lần)
 *  - Phát hiện lỗi cảm biến (đọc lỗi SENSOR_FAULT_COUNT lần liên tiếp -> FAULT)
 *  - (Tùy chọn) đọc phao mực nước bồn chứa -> báo water_low / water_ok
 *  - Đóng gói bản ghi telemetry đẩy vào qOutbox
 *    Bản ghi GỌN nội bộ {"q":seq,"e":epoch,"bc","up","s":đất,"t":nhiệt,"h":ẩm,"p","f"}; giá trị lỗi/chưa có
 *    thì BỎ trường (không gửi null). v1.4: task mạng đổi sang dạng PHẲNG của Backend
 *    {"seq","bc","up","ts","soilMoisture","temperature","humidity","pumpOn","fanOn"}.
 *    Mất mạng thì bản ghi gọn được lưu Flash (nhỏ hơn -> lưu được lâu hơn).
 *  - v1.4: Cảm biến lỗi/phục hồi, phao nước -> {"event":...} lên status cho Backend
 *  - Đọc dòng bơm ACS712 (tùy chọn, USE_PUMP_CURRENT)
 */
#include "sensors.h"
#include "config.h"
#include "app_state.h"
#include "devices.h"
#include <DHT.h>
#include <ArduinoJson.h>

static DHT dht(PIN_DHT, DHT_TYPE);

void sensorsInit() {
  analogReadResolution(12);
  pinMode(PIN_SOIL_ADC, INPUT);
#if USE_PUMP_CURRENT
  pinMode(PIN_PUMP_CURRENT, INPUT);
  analogSetPinAttenuation(PIN_PUMP_CURRENT, ADC_11db);   // đo tới ~3,1 V
#endif
  dht.begin();
#if USE_WATER_LEVEL
  pinMode(PIN_WATER_LEVEL, INPUT_PULLUP);
#endif
}

// Phao mực nước: đọc 5 lần cách 2 ms, đa số quyết định (chống rung tiếp điểm, sóng nước)
static bool waterIsLow() {
#if USE_WATER_LEVEL
  int ok = 0;
  for (int i = 0; i < 5; i++) { if (digitalRead(PIN_WATER_LEVEL) == WATER_OK_LEVEL) ok++; delay(2); }
  return ok < 3;
#else
  return false;
#endif
}

int soilReadRaw() {
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) {
    sum += analogRead(PIN_SOIL_ADC);
    delayMicroseconds(200);
  }
  return (int)(sum / 16);
}

float soilRawToPercent(int raw, int rawDry, int rawWet) {
  if (rawDry == rawWet) return 0;
  // Cảm biến điện dung: càng ướt -> điện áp càng THẤP
  float pct = (float)(rawDry - raw) * 100.0f / (float)(rawDry - rawWet);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

// ---------------------------------------------------------------------------
// Cảm biến dòng ACS712 (tùy chọn: xác nhận bơm chạy thật)
// ---------------------------------------------------------------------------
#if USE_PUMP_CURRENT
static float sZeroMv = NAN;     // điện áp OUT lúc 0 A (sau khi quy đổi ngược cầu chia áp)

static float acsReadMv(int n) {
  uint32_t sum = 0;
  for (int i = 0; i < n; i++) { sum += analogReadMilliVolts(PIN_PUMP_CURRENT); delayMicroseconds(150); }
  return ((float)sum / n) / ACS_DIVIDER;
}
void pumpCurrentZero() { sZeroMv = acsReadMv(64); }
float pumpCurrentA() {
  if (isnan(sZeroMv)) return NAN;
  return fabsf(acsReadMv(32) - sZeroMv) / ACS_MV_PER_A;   // lấy trị tuyệt đối: đấu ngược chiều vẫn đo được
}
#else
void  pumpCurrentZero() {}
float pumpCurrentA() { return NAN; }
#endif

// v1.4: sự kiện gửi lên sf/<node>/status theo định dạng Backend xử lý:
//   {"event":"sensor_fault","sensor":"soil","message":"..."} ; water_low / water_ok ; sensor_recovered
static void publishStatusEvent(const char* event, const char* sensor, const char* message) {
  JsonDocument d;
  d["event"] = event;
  if (sensor && sensor[0]) d["sensor"] = sensor;
  if (message && message[0]) d["message"] = message;
  d["seq"] = nextSeq();
  d["bc"]  = gBootCount;
  d["up"]  = millis();
  uint32_t e = nowEpoch();
  if (e) d["ts"] = e;
  char buf[260];
  serializeJson(d, buf, sizeof(buf));
  outboxPush(OUT_EVENT, buf, false);
  Serial.printf("[SENSOR] Su kien: %s %s\n", event, sensor ? sensor : "");
}

void taskSensor(void* arg) {
  wdtAddThisTask();
  uint8_t soilErr = 0, dhtErr = 0;
  bool soilEverValid = false;   // da co it nhat 1 lan doc dat hop le tu luc khoi dong
  TickType_t lastWake = xTaskGetTickCount();

  for (;;) {
    wdtFeed();
    uint32_t sampleMs;
    uint16_t rawDry, rawWet;
    uint8_t lc;
    stateLock();
    sampleMs = gConfig.sampleMs;
    rawDry = gConfig.soilRawDry;
    rawWet = gConfig.soilRawWet;
    lc = gConfig.lifecycle;
    stateUnlock();

    // ---- 1. Đọc cảm biến ----
    int raw = soilReadRaw();
    float pct = soilRawToPercent(raw, rawDry, rawWet);
    // Dây AO đứt / chập GND -> ADC về ~0. (Phía trên: xem SOIL_RAW_FAULT_MAX trong config.h)
    bool soilBad = (raw < SOIL_RAW_FAULT_MIN || raw > SOIL_RAW_FAULT_MAX);
    if (!soilBad) soilEverValid = true;

    float t = dht.readTemperature();
    float h = dht.readHumidity();
    bool dhtBad = isnan(t) || isnan(h);
    bool waterLow = waterIsLow();

    soilErr = soilBad ? min<uint8_t>(soilErr + 1, 250) : 0;
    dhtErr  = dhtBad  ? min<uint8_t>(dhtErr + 1, 250)  : 0;
    bool soilFault = soilErr >= SENSOR_FAULT_COUNT;
    bool dhtFault  = dhtErr  >= SENSOR_FAULT_COUNT;

    // ---- 2. Cập nhật trạng thái dùng chung ----
    bool prevSoilFault, prevDhtFault, prevWaterLow, pump, fan;
    stateLock();
    prevSoilFault = gState.soilFault;
    prevDhtFault  = gState.dhtFault;
    prevWaterLow  = gState.waterLow;
    gState.waterLow  = waterLow;
    gState.soilRaw   = raw;
    gState.soilFault = soilFault;
    gState.dhtFault  = dhtFault;
    if (!soilBad) gState.soilPct = pct;
    if (!dhtBad) { gState.tempC = t; gState.humPct = h; }
    // Chi coi la "da co so doc" khi dat doc duoc gia tri hop le, hoac da xac nhan loi (FAULT).
    // Tranh luc khoi dong cam bien dat loi: soilPct con 0% -> tu dong bom nham truoc khi FAULT len.
    if (!soilBad || soilFault) gState.hasReading = true;
    pump = gState.pumpOn;
    fan  = gState.fanOn;
    float sendT = gState.tempC, sendH = gState.humPct, sendS = gState.soilPct;
    stateUnlock();

    // Backend tự tìm thiết bị theo "sensor" (soil -> SOIL_MOISTURE, dht -> AIR_*) và chuyển FAULT + tạo cảnh báo.
    if (soilFault != prevSoilFault)
      publishStatusEvent(soilFault ? "sensor_fault" : "sensor_recovered", "soil",
                         soilFault ? "Cam bien do am dat doc sai 3 lan lien tiep (dut day AO / chap GND)" : "Cam bien do am dat doc lai binh thuong");
    if (dhtFault != prevDhtFault)
      publishStatusEvent(dhtFault ? "sensor_fault" : "sensor_recovered", "dht",
                         dhtFault ? "DHT11 khong doc duoc 3 lan lien tiep" : "DHT11 doc lai binh thuong");
    if (waterLow != prevWaterLow)
      publishStatusEvent(waterLow ? "water_low" : "water_ok", "pump",
                         waterLow ? "Phao bao bon het nuoc - da tat bom" : "Bon da co nuoc lai");

    // ---- 3. Đóng gói telemetry (bản ghi gọn, task mạng đổi sang dạng phẳng của Backend) ----
    if (lc != LC_DECOMMISSIONED && lc != LC_REGISTERED) {
      JsonDocument doc;
      doc["q"]  = nextSeq();       // seq: Backend chống trùng theo (bc, seq) khi gửi lại/gửi bù
      doc["e"]  = nowEpoch();      // 0 nếu chưa có NTP -> task mạng tự tính lại khi có giờ (cùng lần khởi động)
      doc["bc"] = gBootCount;
      doc["up"] = millis();
      // Giá trị lỗi / chưa từng đọc đúng -> BỎ trường (Backend yêu cầu value là số hữu hạn)
      if (!soilFault && soilEverValid) doc["s"] = roundf(sendS * 10) / 10.0f;
      if (!dhtFault && !isnan(sendT))  { doc["t"] = roundf(sendT * 10) / 10.0f; doc["h"] = roundf(sendH * 10) / 10.0f; }
      doc["p"] = pump ? 1 : 0;
      doc["f"] = fan ? 1 : 0;
      char buf[220];
      serializeJson(doc, buf, sizeof(buf));
      if (!outboxPush(OUT_TELEMETRY, buf, true))
        Serial.println(F("[SENSOR] Outbox day, bo qua 1 mau"));
    }

    Serial.printf("[SENSOR] Dat: %.1f%% (raw %d)%s | T: %.1fC | H: %.1f%%%s\n",
                  sendS, raw, soilFault ? " [FAULT]" : "",
                  sendT, sendH, dhtFault ? " [FAULT]" : "");

    vTaskDelayUntil(&lastWake, pdMS_TO_TICKS(sampleMs));
  }
}
