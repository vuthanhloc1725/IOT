#include <Arduino.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <MQTT.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_timer.h>
#include <time.h>

#include "device_config.h"

#ifndef EXPECTED_WIFI_MAC
#define EXPECTED_WIFI_MAC "" // Compatibility with boards configured before MAC registration.
#endif

static constexpr uint8_t SOIL_PIN = 34;
static constexpr uint8_t DHT_PIN = 4;
static constexpr uint8_t PUMP_PIN = 26;
static constexpr uint32_t SAMPLE_INTERVAL_MS = 20000;
static constexpr uint32_t HEARTBEAT_INTERVAL_MS = 20000;
static constexpr uint32_t CONNECT_RETRY_MS = 5000;
static constexpr size_t BACKLOG_CAPACITY = 32;
static constexpr size_t TELEMETRY_BYTES = 768;
static constexpr const char *FIRMWARE_VERSION = "arduino-1.0.0";

struct Policy {
  bool autoEnabled = false;
  int onPct = 35;
  int offPct = 60;
  int maxRunSec = 30;
  int cooldownSec = 60;
  int version = 0;
};

struct CommandResult {
  String uuid;
  String device;
  String message;
  bool success = false;
  bool wasOn = false;
};

struct StoredPumpResult {
  char uuid[37];
  char device[21];
  char message[64];
  uint8_t success;
  uint8_t wasOn;
};

WiFiClientSecure tls;
MQTTClient mqtt(2048);
Preferences prefs;
DHT dht(DHT_PIN, DHT11);
Policy policy;
CommandResult recent[16];
size_t recentNext = 0;
String topicRoot;
String commandTopic;
String statusTopic;
String pendingCommands[8];
size_t pendingHead = 0;
size_t pendingCount = 0;
char backlog[BACKLOG_CAPACITY][TELEMETRY_BYTES];
size_t backlogHead = 0;
size_t backlogCount = 0;
uint32_t dropped = 0;
uint32_t bootCount = 0;
uint32_t sequenceNumber = 0;
uint32_t lastSampleMs = 0;
uint32_t lastHeartbeatMs = 0;
uint32_t lastConnectAttemptMs = 0;
uint32_t runStartedMs = 0;
uint32_t runLimitMs = 0;
uint32_t lastStopMs = 0;
bool stoppedBefore = false;
bool pumpRunning = false;
bool autoRun = false;
bool autoDemand = false;
bool soilValid = false;
bool dhtValid = false;
bool soilKnown = false;
bool dhtKnown = false;
bool soilActive = false;
bool dhtActive = false;
bool pumpActive = false;
bool clockRequested = false;
int soilPct = 0;
float airTemp = NAN;
float airHumidity = NAN;

uint64_t uptimeMs() { return static_cast<uint64_t>(esp_timer_get_time()) / 1000ULL; }

uint64_t timestampMs() {
  const time_t now = time(nullptr);
  return now > 1700000000 ? static_cast<uint64_t>(now) * 1000ULL : 0ULL;
}

bool connected() { return WiFi.status() == WL_CONNECTED && mqtt.connected(); }

bool validCode(const char *value, const char *prefix) {
  const size_t prefixLength = strlen(prefix);
  if (strlen(value) != prefixLength + 16 || strncmp(value, prefix, prefixLength)) return false;
  for (size_t i = prefixLength; i < prefixLength + 16; ++i) {
    if (!isxdigit(static_cast<unsigned char>(value[i]))) return false;
  }
  return true;
}

bool validSettings() {
  const bool codes = validCode(NODE_CODE, "NODE-") &&
                     validCode(SOIL_DEVICE_CODE, "DEV-") &&
                     validCode(DHT_DEVICE_CODE, "DEV-") &&
                     validCode(PUMP_DEVICE_CODE, "DEV-") &&
                     strcmp(SOIL_DEVICE_CODE, DHT_DEVICE_CODE) &&
                     strcmp(SOIL_DEVICE_CODE, PUMP_DEVICE_CODE) &&
                     strcmp(DHT_DEVICE_CODE, PUMP_DEVICE_CODE);
  const bool credentials = strlen(WIFI_SSID) && strlen(WIFI_PASSWORD) >= 8 &&
                           strlen(MQTT_HOST) && strlen(MQTT_USERNAME) &&
                           strlen(MQTT_PASSWORD) && MQTT_PORT > 0 && MQTT_PORT <= 65535 &&
                           strlen(MQTT_TOPIC_PREFIX) && !strchr(MQTT_TOPIC_PREFIX, '/') &&
                           !strchr(MQTT_TOPIC_PREFIX, '+') && !strchr(MQTT_TOPIC_PREFIX, '#') &&
                           !strstr(WIFI_SSID, "REPLACE_") &&
                           !strstr(WIFI_PASSWORD, "REPLACE_") &&
                           !strstr(MQTT_USERNAME, "REPLACE_") &&
                           !strstr(MQTT_PASSWORD, "REPLACE_") &&
                           !strstr(MQTT_HOST, "://") &&
                           strstr(MQTT_CA_PEM, "-----BEGIN CERTIFICATE-----") &&
                           !strstr(MQTT_CA_PEM, "REPLACE_");
  return codes && credentials && SOIL_DRY_ADC > SOIL_WET_ADC + 100 &&
         SOIL_DRY_ADC <= 4095 && SOIL_WET_ADC >= 0;
}

bool publish(const char *suffix, const char *payload) {
  return connected() && mqtt.publish((topicRoot + suffix).c_str(), payload, false, 1);
}

void writePump(bool on) { digitalWrite(PUMP_PIN, on ? PUMP_ACTIVE_LEVEL : !PUMP_ACTIVE_LEVEL); }

void stopPump() {
  if (pumpRunning) {
    writePump(false);
    pumpRunning = false;
    autoRun = false;
    lastStopMs = millis();
    stoppedBefore = true;
  } else {
    writePump(false);
  }
}

void failClosed() {
  stopPump();
  soilActive = false;
  dhtActive = false;
  pumpActive = false;
  autoDemand = false;
}

void sendCommandAck(const String &uuid, const String &device, bool success, const String &message) {
  if (uuid.length() != 36) return;
  JsonDocument doc;
  doc["commandUuid"] = uuid;
  doc["deviceCode"] = device;
  doc["success"] = success;
  doc["message"] = message;
  char json[384];
  if (serializeJson(doc, json, sizeof(json)) < sizeof(json) - 1) publish("cmd/ack", json);
}

void sendConfigAck(bool success, int version) {
  JsonDocument doc;
  doc["deviceCode"] = PUMP_DEVICE_CODE;
  doc["version"] = success ? version : -1;
  doc["success"] = success;
  char json[192];
  serializeJson(doc, json, sizeof(json));
  publish("config/ack", json);
}

void sensorStatus(const char *sensor, bool healthy) {
  JsonDocument doc;
  doc["event"] = healthy ? "sensor_recovered" : "sensor_fault";
  doc["sensor"] = sensor;
  doc["message"] = healthy ? "reading_ok" : "reading_failed";
  char json[160];
  serializeJson(doc, json, sizeof(json));
  publish("status", json);
}

bool boundDevice(JsonDocument &doc, const char *code, const char *type, int pin) {
  return doc["deviceCode"].is<const char *>() &&
         doc["type"].is<const char *>() && doc["gpioPin"].is<int>() &&
         strcmp(doc["deviceCode"].as<const char *>(), code) == 0 &&
         strcmp(doc["type"].as<const char *>(), type) == 0 &&
         doc["gpioPin"].as<int>() == pin;
}

bool validPolicy(const Policy &next) {
  return next.onPct >= 0 && next.onPct < next.offPct && next.offPct <= 100 &&
         next.maxRunSec >= 1 && next.maxRunSec <= 30 &&
         next.cooldownSec >= 60 && next.cooldownSec <= 3600;
}

void handleConfig(JsonDocument &doc) {
  if (!boundDevice(doc, PUMP_DEVICE_CODE, "PUMP", PUMP_PIN) || !doc["version"].is<int>()) {
    sendConfigAck(false, -1);
    return;
  }
  JsonVariantConst config = doc["config"];
  if (!config.is<JsonObjectConst>() || !config["pumpAutoEnabled"].is<bool>() ||
      !config["soilOnPct"].is<int>() || !config["soilOffPct"].is<int>() ||
      !config["pumpMaxRunSec"].is<int>() || !config["pumpCooldownSec"].is<int>()) {
    sendConfigAck(false, -1);
    return;
  }
  Policy next;
  next.version = doc["version"].as<int>();
  next.autoEnabled = config["pumpAutoEnabled"].as<bool>();
  next.onPct = config["soilOnPct"].as<int>();
  next.offPct = config["soilOffPct"].as<int>();
  next.maxRunSec = config["pumpMaxRunSec"].as<int>();
  next.cooldownSec = config["pumpCooldownSec"].as<int>();
  if (next.version < policy.version || next.version <= 0 || !validPolicy(next)) {
    sendConfigAck(false, -1);
    return;
  }
  stopPump();
  // Invalidate the policy first; a partial write must never activate the pump.
  bool saved = prefs.putInt("version", 0) == sizeof(int32_t);
  saved = saved && prefs.putInt("on_pct", next.onPct) == sizeof(int32_t);
  saved = saved && prefs.putInt("off_pct", next.offPct) == sizeof(int32_t);
  saved = saved && prefs.putInt("max_sec", next.maxRunSec) == sizeof(int32_t);
  saved = saved && prefs.putInt("cool_sec", next.cooldownSec) == sizeof(int32_t);
  saved = saved && prefs.putInt("auto", next.autoEnabled ? 1 : 0) == sizeof(int32_t);
  saved = saved && prefs.putInt("version", next.version) == sizeof(int32_t);
  if (saved) policy = next;
  else {
    policy = Policy{};
    failClosed();
  }
  sendConfigAck(saved, next.version);
}

bool validUuid(const String &uuid) { return uuid.length() == 36; }

void rememberPumpResult(const CommandResult &result) {
  recent[recentNext] = result;
  recentNext = (recentNext + 1) % 16;
  StoredPumpResult stored{};
  strlcpy(stored.uuid, result.uuid.c_str(), sizeof(stored.uuid));
  strlcpy(stored.device, result.device.c_str(), sizeof(stored.device));
  strlcpy(stored.message, result.message.c_str(), sizeof(stored.message));
  stored.success = result.success;
  stored.wasOn = result.wasOn;
  prefs.putBytes("last_result", &stored, sizeof(stored));
}

bool repeatedPumpCommand(const String &uuid, const String &device) {
  for (const CommandResult &result : recent) {
    if (result.uuid == uuid && result.device == device) {
      const bool success = result.success && (result.wasOn ? pumpRunning : !pumpRunning);
      const String message = success ? result.message :
          result.success ? (result.wasOn ? "already_stopped" : "state_changed") : result.message;
      sendCommandAck(uuid, device, success, message);
      return true;
    }
  }
  return false;
}

bool canRun(int seconds) {
  if (!connected() || !pumpActive || !soilActive || !soilValid || pumpRunning ||
      seconds < 1 || seconds > policy.maxRunSec) return false;
  return !stoppedBefore || static_cast<uint32_t>(millis() - lastStopMs) >=
                              static_cast<uint32_t>(policy.cooldownSec) * 1000UL;
}

void startPump(int seconds, bool automatic) {
  runStartedMs = millis();
  runLimitMs = static_cast<uint32_t>(seconds) * 1000UL;
  autoRun = automatic;
  pumpRunning = true;
  writePump(true);
}

void handlePump(JsonDocument &doc, const String &uuid) {
  if (!boundDevice(doc, PUMP_DEVICE_CODE, "PUMP", PUMP_PIN) || !validUuid(uuid)) return;
  if (!doc["on"].is<bool>()) {
    sendCommandAck(uuid, PUMP_DEVICE_CODE, false, "invalid_on");
    return;
  }
  if (repeatedPumpCommand(uuid, PUMP_DEVICE_CODE)) return;
  const bool on = doc["on"].as<bool>();
  int seconds = doc["seconds"].is<int>() ? doc["seconds"].as<int>() : 10;
  const bool success = !on || canRun(seconds);
  String message = on ? (success ? "on" : "inactive_sensor_cooldown_or_limit") : "off";
  if (!on) {
    stopPump();
    lastStopMs = millis();
    stoppedBefore = true;
  }
  else if (success) startPump(seconds, false);
  rememberPumpResult({uuid, PUMP_DEVICE_CODE, message, success, on});
  sendCommandAck(uuid, PUMP_DEVICE_CODE, success, message);
}

void handleLifecycle(JsonDocument &doc, const String &uuid) {
  const char *device = doc["deviceCode"] | "";
  const bool soil = boundDevice(doc, SOIL_DEVICE_CODE, "SENSOR", SOIL_PIN);
  const bool dhtSensor = boundDevice(doc, DHT_DEVICE_CODE, "SENSOR", DHT_PIN);
  const bool pump = boundDevice(doc, PUMP_DEVICE_CODE, "PUMP", PUMP_PIN);
  if (!soil && !dhtSensor && !pump) return;
  const char *state = doc["lifecycle"] | (doc["state"] | "");
  if (!strcmp(state, "PROVISIONED") || !strcmp(state, "FAULT") ||
      !strcmp(state, "MAINTENANCE") || !strcmp(state, "DECOMMISSIONED")) {
    if (soil) {
      soilActive = false;
      pumpActive = false;
      stopPump();
    }
    if (dhtSensor) dhtActive = false;
    if (pump) {
      pumpActive = false;
      stopPump();
    }
    sendCommandAck(uuid, device, true, "inactive");
    return;
  }
  if (strcmp(state, "ACTIVE") != 0) {
    sendCommandAck(uuid, device, false, "invalid_state");
    return;
  }
  const bool success = connected() && (soil ? soilValid : dhtSensor ? dhtValid :
                                   policy.version > 0 && soilValid && soilActive && !pumpRunning);
  if (success) {
    if (soil) soilActive = true;
    if (dhtSensor) dhtActive = true;
    if (pump) pumpActive = true;
  }
  sendCommandAck(uuid, device, success, success ? "active" :
                 pump ? "config_or_soil_not_ready" : "sensor_not_ready");
}

void onMessage(String &topic, String &payload) {
  if (topic != commandTopic || payload.length() > 2048) return;
  if (pendingCount == 8) {
    ++dropped;
    return;
  }
  pendingCommands[(pendingHead + pendingCount) % 8] = payload;
  ++pendingCount;
}

void processCommand(const String &payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload) || !doc.is<JsonObject>()) return;
  String uuid = doc["commandUuid"].is<const char *>() ?
                doc["commandUuid"].as<String>() : (doc["commandId"] | "");
  const char *action = doc["action"] | "";
  if (!strcmp(action, "config")) handleConfig(doc);
  else if (!strcmp(action, "lifecycle")) handleLifecycle(doc, uuid);
  else if (!strcmp(action, "pump")) handlePump(doc, uuid);
}

void appendBacklog(const char *sample) {
  if (backlogCount == BACKLOG_CAPACITY) {
    backlogHead = (backlogHead + 1) % BACKLOG_CAPACITY;
    --backlogCount;
    ++dropped;
  }
  size_t end = (backlogHead + backlogCount) % BACKLOG_CAPACITY;
  strlcpy(backlog[end], sample, TELEMETRY_BYTES);
  ++backlogCount;
}

void flushBacklog() {
  // One sample per loop keeps the command callback responsive during replay.
  if (backlogCount && publish("telemetry/backfill", backlog[backlogHead])) {
    backlogHead = (backlogHead + 1) % BACKLOG_CAPACITY;
    --backlogCount;
  }
}

void sampleAndPublish() {
  int raw = analogRead(SOIL_PIN);
  bool newSoilValid = raw > 0 && raw < 4095;
  if (newSoilValid) {
    soilPct = constrain((SOIL_DRY_ADC - raw) * 100 / (SOIL_DRY_ADC - SOIL_WET_ADC), 0, 100);
  }
  airHumidity = dht.readHumidity();
  airTemp = dht.readTemperature();
  bool newDhtValid = isfinite(airHumidity) && isfinite(airTemp) &&
                     airHumidity >= 0 && airHumidity <= 100 &&
                     airTemp >= -40 && airTemp <= 80;
  const bool soilChanged = soilKnown && newSoilValid != soilValid;
  const bool dhtChanged = dhtKnown && newDhtValid != dhtValid;
  soilKnown = dhtKnown = true;
  soilValid = newSoilValid;
  dhtValid = newDhtValid;
  if (!soilValid) {
    soilActive = false;
    pumpActive = false;
    stopPump();
  }
  if (!dhtValid) dhtActive = false;
  // Apply the fail-closed state before any QoS 1 status publish can block.
  if (soilChanged) sensorStatus("soil", newSoilValid);
  if (dhtChanged) sensorStatus("dht11", newDhtValid);
  Serial.printf("soil adc=%d percent=%d, dht=%s\n", raw, soilPct, dhtValid ? "ok" : "fault");

  JsonDocument doc;
  doc["seq"] = ++sequenceNumber;
  doc["bc"] = bootCount;
  doc["up"] = uptimeMs();
  doc["ts"] = timestampMs();
  doc["pumpOn"] = pumpRunning;
  JsonArray readings = doc["readings"].to<JsonArray>();
  if (soilValid) {
    JsonObject reading = readings.add<JsonObject>();
    reading["deviceCode"] = SOIL_DEVICE_CODE;
    reading["metric"] = "SOIL_MOISTURE";
    reading["value"] = soilPct;
  }
  if (dhtValid) {
    JsonObject temp = readings.add<JsonObject>();
    temp["deviceCode"] = DHT_DEVICE_CODE;
    temp["metric"] = "AIR_TEMPERATURE";
    temp["value"] = airTemp;
    JsonObject humidity = readings.add<JsonObject>();
    humidity["deviceCode"] = DHT_DEVICE_CODE;
    humidity["metric"] = "AIR_HUMIDITY";
    humidity["value"] = airHumidity;
  }
  char json[TELEMETRY_BYTES];
  const size_t size = serializeJson(doc, json, sizeof(json));
  if (size >= sizeof(json) - 1) {
    ++dropped;
    return;
  }
  if (backlogCount || !publish("telemetry", json)) appendBacklog(json);
}

void sendHeartbeat() {
  JsonDocument doc;
  doc["firmwareVersion"] = FIRMWARE_VERSION;
  doc["bc"] = bootCount;
  doc["up"] = uptimeMs();
  doc["dropped"] = dropped;
  JsonArray faults = doc["faults"].to<JsonArray>();
  if (!soilValid) faults.add("soil");
  if (!dhtValid) faults.add("dht11");
  char json[256];
  serializeJson(doc, json, sizeof(json));
  publish("heartbeat", json);
}

void enforcePumpSafety() {
  if (!connected()) {
    failClosed();
    return;
  }
  if (pumpRunning && (!soilValid || !soilActive || !pumpActive ||
      static_cast<uint32_t>(millis() - runStartedMs) >= runLimitMs ||
      (autoRun && soilPct >= policy.offPct))) stopPump();
  if (!policy.autoEnabled || !soilValid || !soilActive || !pumpActive) {
    autoDemand = false;
    return;
  }
  if (soilPct <= policy.onPct) autoDemand = true;
  else if (soilPct >= policy.offPct) autoDemand = false;
  if (autoDemand && !pumpRunning && canRun(min(10, policy.maxRunSec))) {
    startPump(min(10, policy.maxRunSec), true);
  }
}

void connectIfNeeded() {
  if (connected()) return;
  failClosed();
  if (static_cast<uint32_t>(millis() - lastConnectAttemptMs) < CONNECT_RETRY_MS) return;
  lastConnectAttemptMs = millis();
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    return;
  }
  if (!timestampMs()) {
    if (!clockRequested) {
      configTime(0, 0, NTP_SERVER);
      clockRequested = true;
    }
    Serial.println("Waiting for NTP before verified TLS");
    return;
  }
  if (mqtt.connect(NODE_CODE, MQTT_USERNAME, MQTT_PASSWORD)) {
    if (!mqtt.subscribe(commandTopic, 1)) {
      Serial.printf("MQTT subscribe failed: lastError=%d returnCode=%d topic=%s\n",
                (int)mqtt.lastError(), (int)mqtt.returnCode(), commandTopic.c_str());
      mqtt.disconnect();
      return;
    }
    mqtt.publish(statusTopic, "online", false, 1);
    Serial.println("MQTT connected; devices remain inactive until lifecycle activation");
  } else {
    char tlsErr[100] = "";
    const int tlsCode = tls.lastError(tlsErr, sizeof(tlsErr));
    Serial.printf("MQTT failed: mqttErr=%d returnCode=%d tlsCode=%d (%s) heap=%u\n",
                  (int)mqtt.lastError(), (int)mqtt.returnCode(), tlsCode, tlsErr,
                  (unsigned)ESP.getFreeHeap());
  }
}

void setup() {
  digitalWrite(PUMP_PIN, !PUMP_ACTIVE_LEVEL);
  pinMode(PUMP_PIN, OUTPUT);
  writePump(false);
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  delay(100);
  const String actualMac = WiFi.macAddress();
  Serial.printf("Wi-Fi MAC: %s; Node: %s\n", actualMac.c_str(), NODE_CODE);
  if (strlen(EXPECTED_WIFI_MAC) && !actualMac.equalsIgnoreCase(EXPECTED_WIFI_MAC)) {
    Serial.println("Registered MAC mismatch; pump remains OFF and MQTT is disabled");
    return;
  }
  if (!validSettings()) {
    Serial.println("Invalid device_config.h; pump remains OFF");
    return;
  }
  if (!prefs.begin("runtime", false)) {
    Serial.println("NVS unavailable; pump remains OFF");
    return;
  }
  bootCount = prefs.getUInt("boot", 0) + 1;
  if (!bootCount || prefs.putUInt("boot", bootCount) != sizeof(uint32_t)) {
    Serial.println("Failed to persist boot counter; pump remains OFF");
    return;
  }
  policy.version = prefs.getInt("version", 0);
  policy.onPct = prefs.getInt("on_pct", 35);
  policy.offPct = prefs.getInt("off_pct", 60);
  policy.maxRunSec = prefs.getInt("max_sec", 30);
  policy.cooldownSec = prefs.getInt("cool_sec", 60);
  policy.autoEnabled = prefs.getInt("auto", 0) != 0;
  if (!validPolicy(policy) || policy.version < 0) {
    policy = Policy{};
    Serial.println("Invalid stored policy; re-send configuration");
  }
  StoredPumpResult stored{};
  if (prefs.getBytesLength("last_result") == sizeof(stored) &&
      prefs.getBytes("last_result", &stored, sizeof(stored)) == sizeof(stored) &&
      stored.uuid[36] == '\0' && stored.device[20] == '\0' &&
      stored.message[63] == '\0' && validUuid(String(stored.uuid))) {
    recent[recentNext++] = {stored.uuid, stored.device, stored.message,
                            stored.success != 0, stored.wasOn != 0};
  }
  topicRoot = String(MQTT_TOPIC_PREFIX) + "/" + NODE_CODE + "/";
  commandTopic = topicRoot + "cmd";
  statusTopic = topicRoot + "status";
  analogReadResolution(12);
  analogSetPinAttenuation(SOIL_PIN, ADC_11db);
  dht.begin();
  tls.setCACert(MQTT_CA_PEM);
  mqtt.begin(MQTT_HOST, MQTT_PORT, tls);
  mqtt.onMessage(onMessage);
  mqtt.setWill(statusTopic.c_str(), "offline", false, 1);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastSampleMs = millis() - SAMPLE_INTERVAL_MS;
  lastHeartbeatMs = millis() - HEARTBEAT_INTERVAL_MS;
  lastConnectAttemptMs = millis() - CONNECT_RETRY_MS;
}

void loop() {
  if (!topicRoot.length()) {
    writePump(false);
    delay(1000);
    return;
  }
  if (connected()) mqtt.loop();
  enforcePumpSafety();
  if (!connected()) pendingCount = 0;
  if (connected() && pendingCount) {
    String command = pendingCommands[pendingHead];
    pendingCommands[pendingHead] = "";
    pendingHead = (pendingHead + 1) % 8;
    --pendingCount;
    processCommand(command);
  }
  connectIfNeeded();
  const uint32_t now = millis();
  if (static_cast<uint32_t>(now - lastSampleMs) >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    sampleAndPublish();
  }
  enforcePumpSafety();
  if (static_cast<uint32_t>(now - lastHeartbeatMs) >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMs = now;
    sendHeartbeat();
  }
  if (connected()) flushBacklog();
  delay(10);
}
