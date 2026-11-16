/*
 * net.cpp - Task mạng
 *
 *  1. WiFiManager: lần đầu (hoặc khi giữ nút BOOT 3s) ESP32 phát WiFi "SF-TELE-xxxx",
 *     người dùng kết nối bằng điện thoại -> nhập SSID/mật khẩu + thông tin MQTT.
 *     Cấu hình được lưu NVS Flash -> KHÔNG hardcode WiFi trong code.
 *  2. MQTT: kết nối kèm LWT (Last Will) -> broker tự báo "offline" khi node mất kết nối.
 *  3. Heartbeat định kỳ: server phát hiện offline nếu quá 3 chu kỳ không nhận được.
 *  4. Tự động reconnect WiFi/MQTT với backoff tăng dần (1s -> 60s).
 *     Đã có WiFi lưu sẵn mà khởi động lúc router chưa lên (mất điện cả khu) -> KHÔNG mở
 *     cổng cấu hình, chỉ thử kết nối lại (v1.0 mở cổng 5 phút và ngừng thử kết nối).
 *  5. Mất mạng: bản tin lưu Flash; có mạng lại -> gửi bù theo lô
 *
 *  v1.4 - GIAO THỨC THEO BACKEND 02/11/2026 (Backend/docs/FIRMWARE_V12_INTEGRATION.md)
 *   sf/<nodeCode>/..., <nodeCode> = "Node code" nhập ở cổng cấu hình (trùng mã Node trên web, vd NODE-01)
 *   Node -> Backend : telemetry          {"seq","bc","up","ts","soilMoisture","temperature","humidity","pumpOn","fanOn","backfilled":false}
 *                     telemetry/backfill  cùng dạng, "backfilled":true (1 bản ghi / bản tin)
 *                     heartbeat          {"firmwareVersion","bc","up","faults":[...],"pumpOn","fanOn",...}
 *                     status             {"status":"online",...} (retained) / LWT {"status":"offline"} (retained)
 *                                        {"event":"sensor_fault"|"pump_locked"|...} ; {"deviceCode","deviceStatus":"FAULT"}
 *                     cmd/ack            {"commandUuid","commandId","deviceCode","success","ok","message"}
 *                     config/ack         {"deviceCode","version","success","message"}
 *   Backend -> Node : cmd                {"action":"pump"|"fan"|"config"|"lifecycle"|...}
 *   CHỈ dùng topic có trong ACL Dynamic Security của Backend (topic khác sẽ bị broker chặn).
 *
 *  v1.5 - CLAIM TOKEN (provisioning.h): KHÔNG cần nhập tay Node code / MQTT user / password nữa.
 *   Cổng cấu hình có thêm ô "Backend URL" + "Claim token" (hoặc Serial: "api <url>", "claim <token>").
 *   Có token -> task này gọi claim (tạm dừng thử MQTT), nhận tài khoản MQTT riêng rồi kết nối lại broker.
 *   Broker từ chối user/pass (rc=4/5) PROV_AUTH_FAIL_MAX lần liên tiếp (node bị thu hồi / mật khẩu đã đổi)
 *   -> in hướng dẫn, mở cổng cấu hình 1 lần để nhập token mới, vẫn thử lại MQTT chậm (KHÔNG xóa cấu hình).
 *   Broker mqtts:// (Backend báo tls=true hoặc cổng 8883) -> dùng WiFiClientSecure + CA trong tls_ca.h.
 *   Nhập tay MQTT user/password ở cổng cấu hình vẫn dùng được (khi không nhập token).
 *
 *  Đây là task DUY NHẤT gọi thư viện PubSubClient (thư viện không thread-safe).
 */
#include "net.h"
#include "config.h"
#include "app_state.h"
#include "offline_store.h"
#include "control.h"
#include "devices.h"
#include "provisioning.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <time.h>

static WiFiManager  wm;
static WiFiClient   wifiClient;
static WiFiClientSecure tlsClient;          // v1.5: broker mqtts://
static PubSubClient mqtt(wifiClient);

static WiFiManagerParameter* pDevId;
static WiFiManagerParameter* pHost;
static WiFiManagerParameter* pPort;
static WiFiManagerParameter* pUser;
static WiFiManagerParameter* pPass;
static WiFiManagerParameter* pApi;          // v1.5
static WiFiManagerParameter* pToken;        // v1.5
static char sPortStr[8];
static char sApName[32];
static volatile bool sPortalReq = false;    // netRequestPortal() từ task khác
static bool     sAuthPortalOpened = false;  // mở cổng vì broker từ chối tài khoản: tối đa 1 lần / lần khởi động

static char     sBase[64];                 // "sf/<nodeCode>"
static uint32_t sMqttBackoff = RECONNECT_MIN_MS;
static uint32_t sNextMqttTry = 0;
static uint32_t sWifiBackoff = RECONNECT_MIN_MS;
static uint32_t sNextWifiTry = 0;
static uint32_t sLastHeartbeat = 0;
static uint32_t sLastBackfill = 0;
static uint32_t sOfflineCounter = 0;
static bool     sNtpStarted = false;
static bool     sWasWifi = false;
static bool     sEverConnected = false;    // đã từng kết nối WiFi trong lần chạy này chưa
static char     sBatchBuf[(BACKFILL_BATCH + 1) * 240];   // 1 lượt đọc bản ghi gọn từ Flash
static char     sPubBuf[512];                             // 1 bản tin telemetry phẳng

// ---------------------------------------------------------------------------
static void topicOf(char* out, size_t len, const char* sub) {
  snprintf(out, len, "%s/%s", sBase, sub);
}

static void rebuildBase() {
  stateLock();
  snprintf(sBase, sizeof(sBase), "%s/%s", MQTT_TOPIC_ROOT, gConfig.deviceId);
  stateUnlock();
}

void netResetWifiSettings() {
  wm.resetSettings();
  Serial.println(F("[NET] Da xoa WiFi da luu"));
}

void netRequestPortal() { sPortalReq = true; }

// Gọi khi người dùng bấm Save trên cổng cấu hình WiFiManager (chạy trong task mạng, trong wm.process())
static void onSaveParams() {
  if (strlen(pApi->getValue()) > 0) provSetApi(pApi->getValue());
  if (strlen(pToken->getValue()) > 0) {
    // Có token -> claim sẽ tự đặt Node code + MQTT, bỏ qua các ô nhập tay (tránh ghi đè bằng giá trị cũ)
    provSetToken(pToken->getValue());
    pToken->setValue("", 47);
    return;
  }
  stateLock();
  if (strlen(pDevId->getValue()) > 0) strlcpy(gConfig.deviceId, pDevId->getValue(), sizeof(gConfig.deviceId));
  if (strlen(pHost->getValue()) > 0)  strlcpy(gConfig.mqttHost, pHost->getValue(), sizeof(gConfig.mqttHost));
  int port = atoi(pPort->getValue());
  if (port > 0 && port < 65536) gConfig.mqttPort = port;
  strlcpy(gConfig.mqttUser, pUser->getValue(), sizeof(gConfig.mqttUser));
  if (strlen(pPass->getValue()) > 0)  // v1.5: ô mật khẩu không hiện giá trị cũ -> để trống = giữ nguyên
    strlcpy(gConfig.mqttPass, pPass->getValue(), sizeof(gConfig.mqttPass));
  if (gConfig.lifecycle == LC_REGISTERED) gConfig.lifecycle = LC_PROVISIONED;
  stateUnlock();
  configSave();
  rebuildBase();
  Serial.println(F("[NET] Da luu cau hinh MQTT tu cong cau hinh"));
}

// ---------------------------------------------------------------------------
static void onMqttMessage(char* topic, byte* payload, unsigned int len) {
  // Topic -> loại lệnh (xem CmdKind trong app_state.h)
  static const struct { const char* sub; CmdKind kind; } kRoutes[] = {
    { "cmd",          CMD_LEGACY },   // v1.4: kênh lệnh duy nhất của Backend
#if ENABLE_DEVICE_PROBE
    { "device/probe", CMD_PROBE  },
#endif
  };
  char t[96];
  for (auto& r : kRoutes) {
    topicOf(t, sizeof(t), r.sub);
    if (strcmp(topic, t) != 0) continue;
    if (len >= sizeof(CmdMsg::json)) {
      Serial.printf("[NET] Ban tin %s qua dai (%u byte), bo qua\n", r.sub, len);
      return;
    }
    static char buf[sizeof(CmdMsg::json)];   // chỉ task mạng gọi callback này
    memcpy(buf, payload, len);
    buf[len] = 0;
    if (!commandPush(buf, r.kind)) Serial.println(F("[NET] Hang doi lenh day, bo lenh"));
    return;
  }
}

static void publishStatusOnline() {
  char t[96], buf[260];
  topicOf(t, sizeof(t), "status");
  snprintf(buf, sizeof(buf),
           "{\"status\":\"online\",\"firmwareVersion\":\"%s\",\"nodeType\":\"%s\",\"ip\":\"%s\","
           "\"bootCount\":%lu,\"resetReason\":\"%s\"}",
           FW_VERSION, NODE_TYPE, WiFi.localIP().toString().c_str(),
           (unsigned long)gBootCount, resetReasonName());
  mqtt.publish(t, buf, true);   // retained: Backend subscribe sau vẫn biết node online
}

static void sendHeartbeat() {
  if (!mqtt.connected()) return;
  DeviceConfig c;
  RuntimeState s;
  stateLock(); c = gConfig; s = gState; stateUnlock();

  JsonDocument doc;
  doc["firmwareVersion"] = FW_VERSION;       // trường Backend dùng
  doc["bc"]              = gBootCount;       // v1.4: Backend dùng bc + up để suy ra giờ bản ghi chưa có NTP
  doc["up"]              = millis();
  doc["uptimeSec"]       = millis() / 1000;  // các trường sau để chẩn đoán
  doc["rssi"]            = WiFi.RSSI();
  doc["freeHeap"]        = ESP.getFreeHeap();
  doc["mode"]            = c.mode == MODE_AUTO ? "AUTO" : "MANUAL";
  doc["nodeLifecycle"]   = lifecycleName(c.lifecycle);
  JsonArray faults = doc["faults"].to<JsonArray>();
  if (s.soilFault)  faults.add("soil");
  if (s.dhtFault)   faults.add("dht");     // cảm biến thật là DHT11
  if (s.pumpLocked) faults.add("pump");    // nghi bơm chạy khô -> cần kiểm tra + pump_unlock
  if (s.waterLow)   faults.add("water");   // phao báo bồn hết nước
  doc["pumpOn"]       = s.pumpOn;
  doc["fanOn"]        = s.fanOn;
  doc["backlogBytes"] = storeBytes();
  doc["dropped"]      = s.droppedRecords;
  doc["reconnects"]   = s.reconnects;

  char buf[480], t[96];
  serializeJson(doc, buf, sizeof(buf));
  topicOf(t, sizeof(t), "heartbeat");
  mqtt.publish(t, buf);
  sLastHeartbeat = millis();
}

// ---------------------------------------------------------------------------
// v1.4: đổi bản ghi gọn {"q","e","bc","up","s","t","h","p","f"} -> bản tin PHẲNG của Backend.
// Backend tự ánh xạ soilMoisture/temperature/humidity vào SENSOR theo config.metrics (không cần deviceCode).
// ---------------------------------------------------------------------------
static bool nodeSendsTelemetry() {
  uint8_t lc;
  stateLock(); lc = gConfig.lifecycle; stateUnlock();
  return lc != LC_DECOMMISSIONED;
}

// Giờ đo của bản ghi. Chưa có NTP lúc đo nhưng nay đã có và vẫn CÙNG lần khởi động -> tính lùi từ millis().
// Trả 0 nếu không xác định được -> bỏ "ts", Backend tự suy ra từ bc + up (nếu cùng lần khởi động với heartbeat).
static uint32_t recordEpoch(JsonObjectConst r) {
  uint32_t e = r["e"] | 0UL;
  if (e) return e;
  uint32_t now = nowEpoch();
  uint32_t bc = r["bc"] | 0UL, up = r["up"] | 0UL;
  if (now && bc == gBootCount && millis() >= up) return now - (millis() - up) / 1000UL;
  return 0;
}

// Trả số trường đo đã thêm (0 = bản ghi không có số đo hợp lệ)
static int buildFlat(JsonDocument& out, JsonObjectConst r, bool backfilled) {
  int n = 0;
  if (r["q"].is<uint32_t>()) out["seq"] = r["q"].as<uint32_t>();
  out["bc"] = r["bc"] | 0UL;
  out["up"] = r["up"] | 0UL;
  char iso[32];
  if (isoTime(recordEpoch(r), iso, sizeof(iso))) out["ts"] = iso;
  if (r["s"].is<float>()) { out["soilMoisture"] = r["s"].as<float>(); n++; }
  if (r["t"].is<float>()) { out["temperature"]  = r["t"].as<float>(); n++; }
  if (r["h"].is<float>()) { out["humidity"]     = r["h"].as<float>(); n++; }
  if (!backfilled) {                 // trạng thái relay chỉ có nghĩa với bản tin hiện tại
    out["pumpOn"] = (r["p"] | 0) != 0;
    out["fanOn"]  = (r["f"] | 0) != 0;
  }
  out["backfilled"] = backfilled;
  return n;
}

// Bản tin telemetry trực tiếp. Trả: 1 = đã gửi, 0 = không gửi (bỏ), -1 = gửi lỗi (lưu Flash)
static int publishLiveTelemetry(const char* record) {
  if (!nodeSendsTelemetry()) return 0;
  JsonDocument in;
  if (deserializeJson(in, record)) return 0;
  JsonDocument out;
  buildFlat(out, in.as<JsonObjectConst>(), false);   // vẫn gửi khi cảm biến lỗi: pumpOn/fanOn cho web
  if (measureJson(out) >= sizeof(sPubBuf)) return 0;
  serializeJson(out, sPubBuf, sizeof(sPubBuf));
  char t[96];
  topicOf(t, sizeof(t), "telemetry");
  return mqtt.publish(t, sPubBuf) ? 1 : -1;
}

// Nạp giá trị hiện tại vào các ô của cổng cấu hình (trước khi mở cổng theo yêu cầu)
static void refreshPortalValues() {
  DeviceConfig c;
  char api[sizeof(gProv.apiUrl)];
  stateLock(); c = gConfig; strlcpy(api, gProv.apiUrl, sizeof(api)); stateUnlock();
  snprintf(sPortStr, sizeof(sPortStr), "%u", c.mqttPort);
  pDevId->setValue(c.deviceId, 31);
  pHost->setValue(c.mqttHost, 63);
  pPort->setValue(sPortStr, 6);
  pUser->setValue(c.mqttUser, 31);
  pPass->setValue("", 63);
  pApi->setValue(api, 95);
  pToken->setValue("", 47);
}

static void openPortal(const char* why) {
  if (wm.getConfigPortalActive()) return;
  refreshPortalValues();
  Serial.printf("[WIFI] Mo cong cau hinh (%s): ket noi WiFi '%s' (mk %s) roi vao 192.168.4.1, "
                "chon WiFi + mat khau va dan Claim token\n", why, sApName, WM_AP_PASSWORD);
  wm.startConfigPortal(sApName, WM_AP_PASSWORD);   // không chặn (setConfigPortalBlocking(false)), tự đóng sau timeout
}

// Claim vừa cấp tài khoản MQTT mới -> bỏ phiên cũ, kết nối lại ngay
static void applyNewCredentials() {
  if (mqtt.connected()) mqtt.disconnect();
  rebuildBase();
  sMqttBackoff = RECONNECT_MIN_MS;
  sNextMqttTry = millis();
}

static bool mqttConnect() {
  DeviceConfig c;
  uint8_t tlsFlag;
  stateLock(); c = gConfig; tlsFlag = gProv.mqttTls; stateUnlock();
  rebuildBase();
  if (tlsFlag || c.mqttPort == 8883) {
    if (!provConfigureTls(tlsClient)) return false;
    mqtt.setClient(tlsClient);
  } else {
    mqtt.setClient(wifiClient);
  }
  mqtt.setServer(c.mqttHost, c.mqttPort);

  char willTopic[96];
  topicOf(willTopic, sizeof(willTopic), "status");
  const char* will = "{\"status\":\"offline\"}";
  Serial.printf("[MQTT] Ket noi %s:%u (client id %s)...\n", c.mqttHost, c.mqttPort, c.deviceId);

  bool ok = mqtt.connect(c.deviceId,
                         c.mqttUser[0] ? c.mqttUser : nullptr,
                         c.mqttUser[0] ? c.mqttPass : nullptr,
                         willTopic, 1, true, will, true);
  if (!ok) {
    int rc = mqtt.state();
    Serial.printf("[MQTT] That bai, rc=%d%s\n", rc,
                  (rc == 4 || rc == 5) ? " (broker tu choi user/pass - go \"prov\" de xem huong dan)" : "");
    if (provOnMqttConnect(rc) && !sAuthPortalOpened) {
      sAuthPortalOpened = true;
      openPortal("broker tu choi tai khoan, can claim token moi");
    }
    return false;
  }
  provOnMqttConnect(0);
  Serial.println(F("[MQTT] Da ket noi"));

  char t[96];
  topicOf(t, sizeof(t), "cmd");          mqtt.subscribe(t, 1);   // v1.4: chỉ 1 topic lệnh
#if ENABLE_DEVICE_PROBE
  topicOf(t, sizeof(t), "device/probe"); mqtt.subscribe(t, 1);
#endif

  // Vòng đời: lần đầu kết nối được -> chắc chắn đã Provisioned
  bool changed = false;
  stateLock();
  if (gConfig.lifecycle == LC_REGISTERED) { gConfig.lifecycle = LC_PROVISIONED; changed = true; }
#if !REQUIRE_ACTIVATION
  if (gConfig.lifecycle == LC_PROVISIONED) { gConfig.lifecycle = LC_ACTIVE; changed = true; }
#endif
  gState.reconnects++;
  stateUnlock();
  if (changed) configSave();

  publishStatusOnline();
  sendHeartbeat();   // Backend chỉ coi Node online sau heartbeat mới
  return true;
}

// ---------------------------------------------------------------------------
static void handleOutbox() {
  OutMsg m;
  int budget = 10;                       // tối đa 10 bản tin / vòng để không chặn mqtt.loop()
  while (budget-- > 0 && xQueueReceive(qOutbox, &m, 0) == pdTRUE) {
    if (m.kind == OUT_HEARTBEAT_NOW) { sendHeartbeat(); continue; }

    if (m.kind == OUT_TELEMETRY) {
      if (mqtt.connected()) {
        int r = publishLiveTelemetry(m.payload);
        if (r >= 0) continue;            // đã gửi, hoặc không có gì Backend nhận được
      }
      // ---- Không gửi được -> lưu bản ghi gọn vào Flash để gửi bù ----
      if (!m.storeIfOffline) continue;
      if ((sOfflineCounter++ % OFFLINE_STORE_EVERY) != 0) continue;
      if (!storeAppend(m.payload)) { stateLock(); gState.droppedRecords++; stateUnlock(); }
      continue;
    }

    const char* sub = nullptr;
    switch (m.kind) {
      case OUT_ACK:        sub = "cmd/ack"; break;
      case OUT_CONFIG_ACK: sub = "config/ack"; break;
      case OUT_PROBE_ACK:  sub = "device/probe/ack"; break;
      case OUT_DEV_STATUS: sub = "status"; break;
      case OUT_EVENT:      sub = "status"; break;   // v1.4: Backend nhận sự kiện trên status
      default:             continue;
    }
    char t[96];
    topicOf(t, sizeof(t), sub);
    // ACK/trạng thái/sự kiện: mất mạng thì bỏ (Backend tự hết hạn chờ ACK; lỗi vẫn còn trong heartbeat "faults")
    if (mqtt.connected()) mqtt.publish(t, m.payload, false);
  }
}

// Gửi bù: đọc 1 lô bản ghi gọn từ Flash, gửi MỖI bản ghi thành 1 bản tin lên telemetry/backfill.
// Chỉ đánh dấu đã gửi (commit) khi TẤT CẢ bản tin của lô gửi được; lỗi giữa chừng -> gửi lại cả lô sau,
// Backend tự bỏ bản trùng nhờ (bc, seq).
static void handleBackfill() {
  if (!mqtt.connected() || !storeHasPending()) return;
  if (millis() - sLastBackfill < BACKFILL_GAP_MS) return;
  sLastBackfill = millis();

  int n = storeReadBatch(sBatchBuf, sizeof(sBatchBuf), BACKFILL_BATCH);
  if (n <= 0) return;

  JsonDocument in;
  if (deserializeJson(in, sBatchBuf)) { storeCommitBatch(); return; }   // lô hỏng -> bỏ
  if (!nodeSendsTelemetry()) { storeCommitBatch(); return; }

  char t[96];
  topicOf(t, sizeof(t), "telemetry/backfill");
  int sent = 0, skipped = 0;
  for (JsonObjectConst r : in.as<JsonArrayConst>()) {
    JsonDocument out;
    if (buildFlat(out, r, true) == 0) { skipped++; continue; }    // không có số đo hợp lệ
    if (measureJson(out) >= sizeof(sPubBuf)) { skipped++; continue; }
    serializeJson(out, sPubBuf, sizeof(sPubBuf));
    if (!mqtt.publish(t, sPubBuf)) {
      Serial.println(F("[SYNC] Gui bu that bai, se thu lai ca lo"));
      return;
    }
    sent++;
    mqtt.loop();                      // giữ kết nối sống khi gửi nhiều bản tin liền
    wdtFeed();
  }
  storeCommitBatch();
  Serial.printf("[SYNC] Da gui bu %d ban ghi (bo %d), con lai %lu bytes\n",
                sent, skipped, (unsigned long)storeBytes());
}

// ---------------------------------------------------------------------------
static void ensureConnectivity() {
  uint32_t now = millis();
  bool wifi = WiFi.status() == WL_CONNECTED;

  if (wifi && !sWasWifi) {
    Serial.printf("[WIFI] Da ket noi, IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    sWifiBackoff = RECONNECT_MIN_MS;
    sEverConnected = true;
    if (!sNtpStarted) { configTzTime(NTP_TZ, NTP_SERVER1, NTP_SERVER2); sNtpStarted = true; }
  } else if (!wifi && sWasWifi) {
    Serial.println(F("[WIFI] Mat ket noi!"));
  }
  sWasWifi = wifi;

  // WiFi rớt và không ở chế độ cổng cấu hình -> thử kết nối lại theo backoff
  if (!wifi && !wm.getConfigPortalActive() && (int32_t)(now - sNextWifiTry) >= 0) {
    Serial.printf("[WIFI] Thu ket noi lai (cho %lus)...\n", (unsigned long)sWifiBackoff / 1000);
    // Chưa từng kết nối trong lần chạy này (router lên chậm) -> begin() dùng WiFi đã lưu
    if (sEverConnected) WiFi.reconnect(); else WiFi.begin();
    sNextWifiTry = now + sWifiBackoff;
    sWifiBackoff = min<uint32_t>(sWifiBackoff * 2, RECONNECT_MAX_MS);
  }

  // WiFi đã rớt nhưng TCP chưa kịp phát hiện -> chủ động ngắt MQTT để bản tin
  // chuyển sang lưu Flash ngay (không bị "gửi vào hư không")
  if (!wifi && mqtt.connected()) mqtt.disconnect();

  // v1.5: đang chờ claim -> không thử MQTT bằng tài khoản cũ (sắp bị thay)
  if (wifi && !mqtt.connected() && !provWantsClaim() && (int32_t)(now - sNextMqttTry) >= 0) {
    if (mqttConnect()) {
      sMqttBackoff = RECONNECT_MIN_MS;
    } else {
      sNextMqttTry = now + sMqttBackoff;
      sMqttBackoff = provAuthBlocked() ? RECONNECT_MAX_MS : min<uint32_t>(sMqttBackoff * 2, RECONNECT_MAX_MS);
    }
  }

  stateLock();
  gState.wifiOk = wifi;
  gState.mqttOk = mqtt.connected();
  gState.portalActive = wm.getConfigPortalActive();
  gState.timeSynced = nowEpoch() != 0;
  gState.backlogBytes = storeBytes();
  stateUnlock();
}

static void netInit() {
  DeviceConfig c;
  stateLock(); c = gConfig; stateUnlock();
  rebuildBase();

  // Tham số tùy biến hiển thị trên cổng cấu hình WiFiManager
  snprintf(sPortStr, sizeof(sPortStr), "%u", c.mqttPort);
  pDevId = new WiFiManagerParameter("devid", "Node code (vd NODE-01, trung ma Node tren web)", c.deviceId, 31);
  pHost  = new WiFiManagerParameter("mqtt_host", "MQTT broker (IP/host)", c.mqttHost, 63);
  pPort  = new WiFiManagerParameter("mqtt_port", "MQTT port", sPortStr, 6);
  pUser  = new WiFiManagerParameter("mqtt_user", "MQTT user (Backend cap khi tao Node)", c.mqttUser, 31);
  pPass  = new WiFiManagerParameter("mqtt_pass", "MQTT password (de trong = giu nguyen)", "", 63);
  char api[sizeof(gProv.apiUrl)];
  stateLock(); strlcpy(api, gProv.apiUrl, sizeof(api)); stateUnlock();
  pApi   = new WiFiManagerParameter("api_url", "Backend URL (vd http://192.168.1.10:3000)", api, 95);
  pToken = new WiFiManagerParameter("claim_token", "Claim token (cap tren web, han 30 phut) - co token thi bo qua cac o MQTT", "", 47);
  wm.addParameter(pApi);
  wm.addParameter(pToken);
  wm.addParameter(pDevId);
  wm.addParameter(pHost);
  wm.addParameter(pPort);
  wm.addParameter(pUser);
  wm.addParameter(pPass);
  wm.setSaveParamsCallback(onSaveParams);
  wm.setTitle("Smart Farm - Node Telemetry");
  wm.setConfigPortalBlocking(false);       // KHÔNG chặn: các task khác vẫn tưới tự động
  wm.setConfigPortalTimeout(WM_PORTAL_TIMEOUT_S);
  wm.setConnectTimeout(20);
  wm.setWiFiAutoReconnect(true);

  // Đã lưu WiFi -> không tự mở cổng cấu hình khi kết nối thất bại (router khởi động chậm
  // sau mất điện); taskNet sẽ tự thử lại theo backoff. Chưa có WiFi -> mở cổng như cũ.
  bool hasSaved = wm.getWiFiIsSaved();
  wm.setEnableConfigPortal(!hasSaved);

  uint8_t mac[6];
  WiFi.macAddress(mac);
  snprintf(sApName, sizeof(sApName), "%s%02X%02X", WM_AP_PREFIX, mac[4], mac[5]);
  const char* apName = sApName;
  if (wm.autoConnect(apName, WM_AP_PASSWORD)) {
    Serial.println(F("[WIFI] Ket noi bang cau hinh da luu"));
  } else if (hasSaved) {
    Serial.println(F("[WIFI] Chua vao duoc WiFi da luu -> chay offline (van tuoi tu dong), tu thu lai..."));
  } else {
    Serial.printf("[WIFI] Mo cong cau hinh: ket noi WiFi '%s' (mk %s) roi vao 192.168.4.1\n",
                  apName, WM_AP_PASSWORD);
  }

  mqtt.setBufferSize(MQTT_BUFFER_SIZE);
  mqtt.setKeepAlive(MQTT_KEEPALIVE_S);
  mqtt.setSocketTimeout(MQTT_SOCKET_TO_S);
  mqtt.setCallback(onMqttMessage);
}

void taskNet(void* arg) {
  netInit();
  wdtAddThisTask();
  for (;;) {
    wdtFeed();
    wm.process();                 // phục vụ cổng cấu hình (nếu đang mở)
    ensureConnectivity();
    // v1.5: claim token (HTTP, tối đa ~PROV_HTTP_TIMEOUT_MS, đã tự feed WDT)
    if (WiFi.status() == WL_CONNECTED && provWantsClaim() && provTick()) applyNewCredentials();
    if (sPortalReq) { sPortalReq = false; openPortal("lenh Serial"); }
    if (mqtt.connected()) mqtt.loop();
    handleOutbox();
    handleBackfill();

    uint32_t hb;
    stateLock(); hb = gConfig.heartbeatMs; stateUnlock();
    if (mqtt.connected() && millis() - sLastHeartbeat >= hb) sendHeartbeat();

    vTaskDelay(pdMS_TO_TICKS(10));
  }
}
