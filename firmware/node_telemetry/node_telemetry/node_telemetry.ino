/*
 * ============================================================================
 *  NODE TELEMETRY - ESP32 + Cảm biến độ ẩm đất (điện trở) + DHT11 + Relay x2 (bơm 12V, quạt)
 *  Hệ thống Nông nghiệp Thông minh - Công việc 1: Hardware & Firmware
 * ----------------------------------------------------------------------------
 *  Kiến trúc FreeRTOS (3 task chạy song song + loop()):
 *
 *   taskSensor  (core 1, ưu tiên 2) : đọc cảm biến mỗi 5s -> gState + qOutbox
 *   taskControl (core 1, ưu tiên 3) : nhận lệnh (qCommand) + tự động bơm/quạt
 *   taskNet     (core 0, ưu tiên 2) : WiFiManager, MQTT, heartbeat, lưu/gửi bù
 *   loop()      (core 1, ưu tiên 1) : LED trạng thái, nút BOOT, Serial console
 *
 *  Tự động hóa chạy ĐỘC LẬP với mạng: mất WiFi cây vẫn được tưới.
 *
 *  v1.4: giao tiếp MQTT theo Backend 02/11/2026 (Backend/docs/FIRMWARE_V12_INTEGRATION.md):
 *   sf/<nodeCode>/telemetry | telemetry/backfill | heartbeat | status | cmd/ack | config/ack  (Node -> Backend)
 *   sf/<nodeCode>/cmd                                                                (Backend -> Node)
 *   Mã thiết bị Backend được gán vào phần cứng khi Backend gửi config/lifecycle/pump/fan
 *   (xem devices.h), hoặc gán tay bằng lệnh Serial "map".
 *   Tự động hóa chạy theo lifecycle TỪNG thiết bị: Admin kích hoạt (ACTIVE) trên web.
 *
 *  v1.5: CLAIM TOKEN (provisioning.h) - node tự lấy Node code + tài khoản MQTT từ Backend:
 *   web tạo Node bằng MAC (in lúc khởi động / lệnh "prov") -> "Cấp claim token" -> dán vào cổng cấu hình
 *   hoặc gõ "claim <token>". Thu hồi / cấp lại trên web: chỉ cần token mới, không xóa Flash.
 *
 *  Thư viện cần cài (Arduino IDE > Library Manager):
 *   - WiFiManager (tzapu) >= 2.0.17
 *   - PubSubClient (Nick O'Leary) 2.8
 *   - ArduinoJson (Benoit Blanchon) >= 7.0
 *   - DHT sensor library (Adafruit) + Adafruit Unified Sensor
 *  Board: "ESP32 Dev Module", Partition: "Default 4MB with spiffs"
 * ============================================================================
 */
#include <WiFi.h>
#include "config.h"
#include "app_state.h"
#include "sensors.h"
#include "control.h"
#include "net.h"
#include "offline_store.h"
#include "devices.h"
#include "provisioning.h"

static TaskHandle_t hNet = nullptr, hSensor = nullptr, hControl = nullptr;

static void serialConsole();
static void statusLed();
static void bootButton();

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println(F("=========================================="));
  Serial.printf(" SMART FARM - NODE TELEMETRY  fw %s\n", FW_VERSION);
  Serial.println(F("=========================================="));

  pinMode(PIN_LED_STATUS, OUTPUT);
  pinMode(PIN_BTN_CONFIG, INPUT_PULLUP);

  stateInit();
  WiFi.mode(WIFI_STA);          // cần bật WiFi trước để đọc MAC làm device_id mặc định
  configLoad();
  devInit();
  actuatorsInit();
  sensorsInit();
  storeInit();
  wdtInit();

  Serial.printf("[BOOT] device_id=%s lifecycle=%s mode=%s boot#%lu reset=%s\n",
                gConfig.deviceId, lifecycleName(gConfig.lifecycle),
                gConfig.mode == MODE_AUTO ? "auto" : "manual", (unsigned long)gBootCount, resetReasonName());
  Serial.printf("[BOOT] FW %s | MAC (khai bao khi tao Node tren web): %s\n", FW_VERSION, WiFi.macAddress().c_str());
  devPrint();
#if REQUIRE_ACTIVATION
  if (gConfig.lifecycle != LC_ACTIVE)
    Serial.println(F("[BOOT] Chua co thiet bi ACTIVE -> tu dong hoa tat, cho Admin kich hoat tren web (test mot minh: go 'lc active')"));
#endif

  xTaskCreatePinnedToCore(taskNet,     "net",     STACK_NET,     nullptr, 2, &hNet,     0);
  xTaskCreatePinnedToCore(taskSensor,  "sensor",  STACK_SENSOR,  nullptr, 2, &hSensor,  1);
  xTaskCreatePinnedToCore(taskControl, "control", STACK_CONTROL, nullptr, 3, &hControl, 1);
  Serial.println(F("[BOOT] Da khoi tao cac task. Go 'help' de xem lenh Serial."));
}

void loop() {
  statusLed();
  bootButton();
  serialConsole();
  vTaskDelay(pdMS_TO_TICKS(20));
}

// ---------------------------------------------------------------------------
// LED on-board:  nháy nhanh = đang mở cổng cấu hình WiFi
//                nháy chậm  = có WiFi nhưng chưa vào được MQTT
//                chớp ngắn 2s/lần = mất WiFi (chạy offline)
//                sáng liên tục = mọi thứ OK
// ---------------------------------------------------------------------------
static void statusLed() {
  bool portal, wifi, mq;
  stateLock(); portal = gState.portalActive; wifi = gState.wifiOk; mq = gState.mqttOk; stateUnlock();
  uint32_t t = millis();
  bool on;
  if (portal)      on = (t / 100) % 2;
  else if (mq)     on = true;
  else if (wifi)   on = (t / 500) % 2;
  else             on = (t % 2000) < 100;
  digitalWrite(PIN_LED_STATUS, on);
}

// Giữ nút BOOT 3 giây -> xóa WiFi đã lưu và khởi động lại vào cổng cấu hình
static void bootButton() {
  static uint32_t pressedAt = 0;
  if (digitalRead(PIN_BTN_CONFIG) == LOW) {
    if (pressedAt == 0) pressedAt = millis();
    if (millis() - pressedAt > 3000) {
      Serial.println(F("[BTN] Xoa WiFi, khoi dong lai vao che do cau hinh..."));
      netResetWifiSettings();
      delay(500);
      ESP.restart();
    }
  } else {
    pressedAt = 0;
  }
}

// ---------------------------------------------------------------------------
// Serial console: test nhanh khi chưa có Backend (Serial Monitor 115200, "Newline")
// Mỗi lệnh được đổi thành JSON giống hệt lệnh MQTT -> đi chung một đường xử lý.
// ---------------------------------------------------------------------------
static void serialConsole() {
  static char line[128];
  static size_t n = 0;
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\r') continue;
    if (ch != '\n') { if (n < sizeof(line) - 1) line[n++] = ch; continue; }
    line[n] = 0;
    n = 0;
    if (!line[0]) continue;

    char a[16] = "", b[24] = "", c[16] = "";
    sscanf(line, "%15s %23s %15s", a, b, c);
    char json[200];

    if (!strcmp(a, "help")) {
      Serial.println(F("Lenh: status | cfg | pump on|off [giay] | pump unlock | fan on|off | mode auto|manual\n"
                       "      lc registered|provisioned|active|maintenance|decommissioned  (node + moi thiet bi)\n"
                       "      set <truong> <gia tri>  (vd: set soil_low 40)\n"
                       "      dev | map soil|temp|hum|pump|fan <deviceCode> | map clear [o]\n"
                       "      prov | claim <token> | claim retry | prov clear | api <http://ip:port> | portal\n"
                       "      wifi reset | reboot | factory"));
    } else if (!strcmp(a, "status")) {
      RuntimeState s; DeviceConfig cf;
      stateLock(); s = gState; cf = gConfig; stateUnlock();
      Serial.printf("id=%s lc=%s mode=%s | wifi=%d mqtt=%d portal=%d ntp=%d\n",
                    cf.deviceId, lifecycleName(cf.lifecycle), cf.mode ? "manual" : "auto",
                    s.wifiOk, s.mqttOk, s.portalActive, s.timeSynced);
      Serial.printf("soil=%.1f%% raw=%d T=%.1f H=%.1f | pump=%d fan=%d | backlog=%luB dropped=%lu\n",
                    s.soilPct, s.soilRaw, s.tempC, s.humPct, s.pumpOn, s.fanOn,
                    (unsigned long)s.backlogBytes, (unsigned long)s.droppedRecords);
      Serial.printf("bom_khoa=%d het_nuoc=%d | heap=%lu | stack trong (byte): net=%u sensor=%u control=%u\n",
                    s.pumpLocked, s.waterLow, (unsigned long)ESP.getFreeHeap(),
                    hNet ? (unsigned)uxTaskGetStackHighWaterMark(hNet) : 0,
                    hSensor ? (unsigned)uxTaskGetStackHighWaterMark(hSensor) : 0,
                    hControl ? (unsigned)uxTaskGetStackHighWaterMark(hControl) : 0);
    } else if (!strcmp(a, "dev")) {
      devPrint();
    } else if (!strcmp(a, "map")) {
      // Gán tay mã thiết bị Backend cho phần cứng, vd: map soil DEV-1A2B3C (thường không cần: Backend tự gán qua cmd)
      if (!strcmp(b, "clear")) {
        int sl = c[0] ? devSlotFromName(c) : DEV_NONE;
        if (c[0] && sl == DEV_NONE) Serial.println(F("O khong hop le: soil|temp|hum|pump|fan"));
        else { devClear(sl); devPrint(); }
      } else {
        // đọc lại deviceCode đầy đủ (sscanf ở trên chỉ lấy 15 ký tự)
        char code[DEV_CODE_LEN] = "";
        sscanf(line, "%*s %*s %31s", code);
        int sl = devSlotFromName(b);
        if (sl == DEV_NONE || !code[0]) Serial.println(F("Cu phap: map soil|temp|hum|pump|fan <deviceCode>"));
        else { devAssign(sl, code); devPrint(); }
      }
    } else if (!strcmp(a, "prov")) {
      // v1.5: MAC, Backend URL, trạng thái claim, lỗi gần nhất
      if (!strcmp(b, "clear")) provClearToken();
      else provPrint();
    } else if (!strcmp(a, "claim")) {
      // token 43 ký tự: đọc lại từ cả dòng (b chỉ giữ 23 ký tự)
      char tok[sizeof(gProv.claimToken)] = "";
      sscanf(line, "%*s %47s", tok);
      if (!strcmp(tok, "retry")) { provRetryNow(); Serial.println(F("[PROV] Claim lai ngay")); }
      else if (!tok[0]) Serial.println(F("Cu phap: claim <token> | claim retry (token cap tren web, han 30 phut)"));
      else provSetToken(tok);   // tự in kết quả
    } else if (!strcmp(a, "api")) {
      char url[sizeof(gProv.apiUrl)] = "";
      sscanf(line, "%*s %95s", url);
      provSetApi(url);          // tự in kết quả / hướng dẫn
    } else if (!strcmp(a, "portal")) {
      netRequestPortal();   // mở cổng cấu hình mà không xóa WiFi đã lưu
    } else if (!strcmp(a, "cfg")) {
      char buf[400]; buildConfigJson(buf, sizeof(buf)); Serial.println(buf);
    } else if (!strcmp(a, "pump") && !strcmp(b, "unlock")) {
      commandPush("{\"req_id\":\"serial\",\"action\":\"pump_unlock\"}");
    } else if (!strcmp(a, "pump") || !strcmp(a, "fan")) {
      int dur = atoi(c);
      if (dur > 0) snprintf(json, sizeof(json), "{\"req_id\":\"serial\",\"action\":\"%s\",\"value\":\"%s\",\"duration\":%d}", a, b, dur);
      else snprintf(json, sizeof(json), "{\"req_id\":\"serial\",\"action\":\"%s\",\"value\":\"%s\"}", a, b);
      commandPush(json);
    } else if (!strcmp(a, "mode")) {
      snprintf(json, sizeof(json), "{\"req_id\":\"serial\",\"action\":\"mode\",\"value\":\"%s\"}", b);
      commandPush(json);
    } else if (!strcmp(a, "lc")) {
      snprintf(json, sizeof(json), "{\"req_id\":\"serial\",\"action\":\"lifecycle\",\"value\":\"%s\"}", b);
      commandPush(json);
    } else if (!strcmp(a, "set")) {
      snprintf(json, sizeof(json), "{\"req_id\":\"serial\",\"action\":\"config\",\"%s\":%s}", b, c);
      commandPush(json);
    } else if (!strcmp(a, "wifi") && !strcmp(b, "reset")) {
      commandPush("{\"req_id\":\"serial\",\"action\":\"reset_wifi\"}");
    } else if (!strcmp(a, "reboot")) {
      commandPush("{\"req_id\":\"serial\",\"action\":\"reboot\"}");
    } else if (!strcmp(a, "factory")) {
      commandPush("{\"req_id\":\"serial\",\"action\":\"factory_reset\"}");
    } else {
      Serial.println(F("Khong hieu lenh. Go 'help'."));
    }
  }
}
