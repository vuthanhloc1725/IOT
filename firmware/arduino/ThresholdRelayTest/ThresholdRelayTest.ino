// Firmware test doc lap: dieu khien relay theo nguong do am dat (soil) + DHT11.
// Khong WiFi, khong MQTT. Chi doc sensor -> quyet dinh bat/ngat relay -> log Serial.
// Pin va hieu chuan giu giong SoilPumpNode de ket qua test dung voi board that.

#include <Arduino.h>
#include <DHT.h>

static constexpr uint8_t SOIL_PIN = 34;   // ADC1_CH6, doc duoc khi Wi-Fi bat
static constexpr uint8_t DHT_PIN = 4;
static constexpr uint8_t PUMP_PIN = 26;
static constexpr uint8_t PUMP_ACTIVE_LEVEL = LOW; // doi thanh HIGH neu module relay active HIGH

// Hieu chuan ADC dat: raw cao = kho, raw thap = uot.
static constexpr int SOIL_DRY_ADC = 3000;
static constexpr int SOIL_WET_ADC = 1000;

// Nguong dieu khien.
static constexpr int SOIL_ON_PCT = 35;    // dat kho hon muc nay -> bat bom
static constexpr int SOIL_OFF_PCT = 60;   // dat du am -> ngat bom
static constexpr float TEMP_MAX_C = 40.0f;  // qua nong -> ngat (bao ve bom)
static constexpr float TEMP_MIN_C = 5.0f;   // qua lanh -> khong tuoi
static constexpr float HUMIDITY_MAX_PCT = 90.0f; // khong khi qua am -> khong tuoi

// Gioi han thoi gian chay.
static constexpr uint32_t MAX_RUN_MS = 30000;   // chay lien tuc toi da
static constexpr uint32_t COOLDOWN_MS = 60000;  // nghi sau khi ngat
static constexpr uint32_t SAMPLE_MS = 2000;     // chu ky doc sensor

DHT dht(DHT_PIN, DHT11);

bool relayOn = false;
bool autoEnabled = true;
uint32_t lastSampleMs = 0;
uint32_t runStartedMs = 0;
uint32_t lastStopMs = 0;
bool stoppedBefore = false;

int soilRaw = -1;
int soilPct = -1;
bool soilValid = false;
float airTemp = NAN;
float airHumidity = NAN;
bool dhtValid = false;

// Gia tri gia lap qua Serial de test khi chua cam sensor that.
int forcedSoilPct = -1;
float forcedTemp = NAN;
float forcedHumidity = NAN;

static int soilPercent(int raw) {
  if (SOIL_DRY_ADC == SOIL_WET_ADC) return -1;
  long pct = (long)(SOIL_DRY_ADC - raw) * 100 / (SOIL_DRY_ADC - SOIL_WET_ADC);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return (int)pct;
}

static void applyRelay(bool on, const char *reason) {
  if (on == relayOn) return;
  relayOn = on;
  digitalWrite(PUMP_PIN, on ? PUMP_ACTIVE_LEVEL : !PUMP_ACTIVE_LEVEL);
  if (on) {
    runStartedMs = millis();
  } else {
    lastStopMs = millis();
    stoppedBefore = true;
  }
  Serial.printf("[RELAY] %s (%s)\n", on ? "ON" : "OFF", reason);
}

static void readSensors() {
  if (forcedSoilPct >= 0) {
    soilRaw = -1;
    soilPct = forcedSoilPct;
    soilValid = true;
  } else {
    long sum = 0;
    for (int i = 0; i < 8; i++) sum += analogRead(SOIL_PIN);
    soilRaw = (int)(sum / 8);
    soilPct = soilPercent(soilRaw);
    // ADC chet thuong tra 0 hoac 4095 lien tuc -> coi la khong tin cay.
    soilValid = (soilPct >= 0) && (soilRaw > 10) && (soilRaw < 4085);
  }

  if (!isnan(forcedTemp) || !isnan(forcedHumidity)) {
    airTemp = isnan(forcedTemp) ? 25.0f : forcedTemp;
    airHumidity = isnan(forcedHumidity) ? 50.0f : forcedHumidity;
    dhtValid = true;
  } else {
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    dhtValid = !isnan(t) && !isnan(h) && t > -20 && t < 80 && h >= 0 && h <= 100;
    if (dhtValid) {
      airTemp = t;
      airHumidity = h;
    }
  }
}

// Ly do phai ngat relay ngay lap tuc; NULL = khong co loi.
static const char *shutdownReason() {
  if (!soilValid) return "soil sensor loi";
  if (!dhtValid) return "DHT loi";
  if (airTemp >= TEMP_MAX_C) return "nhiet do qua cao";
  if (airTemp <= TEMP_MIN_C) return "nhiet do qua thap";
  if (airHumidity >= HUMIDITY_MAX_PCT) return "do am khong khi qua cao";
  if (soilPct >= SOIL_OFF_PCT) return "dat da du am";
  return nullptr;
}

static void evaluate() {
  const char *stop = shutdownReason();

  if (relayOn) {
    if (stop) {
      applyRelay(false, stop);
      return;
    }
    if (millis() - runStartedMs >= MAX_RUN_MS) {
      applyRelay(false, "het thoi gian chay toi da");
    }
    return;
  }

  if (!autoEnabled || stop) return;
  if (stoppedBefore && millis() - lastStopMs < COOLDOWN_MS) return;
  if (soilPct <= SOIL_ON_PCT) applyRelay(true, "dat kho duoi nguong");
}

static void printStatus() {
  Serial.printf("soil=%d%%", soilPct);
  if (soilRaw >= 0) Serial.printf(" (raw %d)", soilRaw);
  if (!soilValid) Serial.print(" [INVALID]");
  if (dhtValid) {
    Serial.printf("  temp=%.1fC  hum=%.1f%%", airTemp, airHumidity);
  } else {
    Serial.print("  temp=?  hum=? [INVALID]");
  }
  Serial.printf("  relay=%s  auto=%s", relayOn ? "ON" : "OFF", autoEnabled ? "on" : "off");
  if (relayOn) Serial.printf("  run=%lus", (millis() - runStartedMs) / 1000);
  else if (stoppedBefore) {
    uint32_t since = millis() - lastStopMs;
    if (since < COOLDOWN_MS) Serial.printf("  cooldown=%lus", (COOLDOWN_MS - since) / 1000);
  }
  const char *stop = shutdownReason();
  if (stop) Serial.printf("  block: %s", stop);
  Serial.println();
}

static void printHelp() {
  Serial.println(F("Lenh Serial:"));
  Serial.println(F("  s <0-100>  gia lap do am dat (-1 = dung sensor that)"));
  Serial.println(F("  t <C>      gia lap nhiet do"));
  Serial.println(F("  h <0-100>  gia lap do am khong khi"));
  Serial.println(F("  c          xoa toan bo gia lap"));
  Serial.println(F("  a 0|1      tat/bat che do tu dong"));
  Serial.println(F("  on | off   dieu khien relay thu cong"));
  Serial.println(F("  ?          in trang thai"));
}

static void handleLine(String line) {
  line.trim();
  if (line.isEmpty()) return;
  String arg = "";
  int space = line.indexOf(' ');
  String cmd = line;
  if (space > 0) {
    cmd = line.substring(0, space);
    arg = line.substring(space + 1);
    arg.trim();
  }
  cmd.toLowerCase();

  if (cmd == "s") {
    int v = arg.toInt();
    forcedSoilPct = (v < 0 || v > 100) ? -1 : v;
    Serial.printf("[SET] soil gia lap = %d\n", forcedSoilPct);
  } else if (cmd == "t") {
    forcedTemp = arg.isEmpty() ? NAN : arg.toFloat();
    Serial.printf("[SET] temp gia lap = %.1f\n", forcedTemp);
  } else if (cmd == "h") {
    forcedHumidity = arg.isEmpty() ? NAN : arg.toFloat();
    Serial.printf("[SET] hum gia lap = %.1f\n", forcedHumidity);
  } else if (cmd == "c") {
    forcedSoilPct = -1;
    forcedTemp = NAN;
    forcedHumidity = NAN;
    Serial.println(F("[SET] da xoa gia lap, dung sensor that"));
  } else if (cmd == "a") {
    autoEnabled = arg.toInt() != 0;
    Serial.printf("[SET] auto = %s\n", autoEnabled ? "on" : "off");
    if (!autoEnabled && relayOn) applyRelay(false, "tat che do tu dong");
  } else if (cmd == "on") {
    autoEnabled = false;
    applyRelay(true, "lenh thu cong");
  } else if (cmd == "off") {
    applyRelay(false, "lenh thu cong");
  } else if (cmd == "?") {
    printStatus();
  } else {
    printHelp();
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);

  pinMode(PUMP_PIN, OUTPUT);
  digitalWrite(PUMP_PIN, !PUMP_ACTIVE_LEVEL); // fail-safe: relay OFF ngay khi boot
  analogReadResolution(12);
  dht.begin();

  Serial.println();
  Serial.println(F("=== Test nguong soil + DHT -> ngat relay (khong MQTT) ==="));
  Serial.printf("soil ON <= %d%%, OFF >= %d%%; temp %.0f..%.0fC; hum < %.0f%%\n",
                SOIL_ON_PCT, SOIL_OFF_PCT, TEMP_MIN_C, TEMP_MAX_C, HUMIDITY_MAX_PCT);
  Serial.printf("max run %lus, cooldown %lus\n", MAX_RUN_MS / 1000, COOLDOWN_MS / 1000);
  printHelp();
}

void loop() {
  static String input;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      handleLine(input);
      input = "";
    } else if (input.length() < 32) {
      input += c;
    }
  }

  if (millis() - lastSampleMs >= SAMPLE_MS) {
    lastSampleMs = millis();
    readSensors();
    evaluate();
    printStatus();
  }
}
