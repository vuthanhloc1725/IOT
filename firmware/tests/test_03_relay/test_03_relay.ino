/*
 * TEST 03 - Module relay 2 kênh + bơm 12V RS385 + quạt (v1.2: bơm/nguồn 12V theo linh kiện đã mua)
 * Board: ESP32 Dev Module (cấp nguồn qua cổng USB)
 * Nối: relay VCC->VIN(5V của USB), GND->GND, IN1->GPIO26 (bơm), IN2->GPIO27 (quạt)
 *      Jumper chọn mức kích: H (kích mức cao) -> RELAY_ON_LEVEL HIGH
 * Tải: adapter 12V(+) -> COM; NO -> (+) bơm/quạt; (-) bơm/quạt -> GND adapter 12V
 *      Quạt 12V thì dùng chung adapter; quạt 5V thì lấy nguồn 5V riêng, KHÔNG nối vào 12V.
 *      KHÔNG nối 12V vào bất kỳ chân nào của ESP32.
 *
 * Lệnh Serial: 1 = bật/tắt bơm, 2 = bật/tắt quạt, a = tự chạy chu kỳ, s = dừng tất cả
 * Đạt khi: nghe tiếng "tách" và LED relay sáng đúng kênh; bơm đẩy nước, quạt quay;
 *          ESP32 KHÔNG bị reset khi bơm/quạt khởi động (nếu reset -> xem mục nguồn trong tài liệu).
 */
#define PIN_PUMP 26
#define PIN_FAN  27
#define RELAY_ON_LEVEL HIGH
bool pump = false, fan = false, autoRun = false;

void setRelay(int pin, bool on) { digitalWrite(pin, on ? RELAY_ON_LEVEL : !RELAY_ON_LEVEL); }

void setup() {
  Serial.begin(115200);
  digitalWrite(PIN_PUMP, !RELAY_ON_LEVEL); digitalWrite(PIN_FAN, !RELAY_ON_LEVEL);
  pinMode(PIN_PUMP, OUTPUT); pinMode(PIN_FAN, OUTPUT);
  Serial.println("TEST 03 - Relay. Lenh: 1=bom 2=quat a=auto s=stop");
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    if (c == '1') pump = !pump;
    if (c == '2') fan = !fan;
    if (c == 'a') autoRun = true;
    if (c == 's') { autoRun = false; pump = fan = false; }
    setRelay(PIN_PUMP, pump); setRelay(PIN_FAN, fan);
    Serial.printf("Bom: %s | Quat: %s\n", pump ? "BAT" : "tat", fan ? "BAT" : "tat");
  }
  if (autoRun) {   // bơm 3s - nghỉ 3s - quạt 3s - nghỉ 3s
    static uint32_t t0 = millis();
    uint32_t p = (millis() - t0) % 12000;
    pump = p < 3000; fan = p >= 6000 && p < 9000;
    setRelay(PIN_PUMP, pump); setRelay(PIN_FAN, fan);
  }
  delay(20);
}
