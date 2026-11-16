/*
 * TEST 07 (TÙY CHỌN, v1.1) - Phao báo mực nước bồn chứa (float switch) chống bơm chạy khô
 * Board: ESP32 Dev Module | Nối: 1 dây phao -> GPIO25, dây còn lại -> GND (dùng pull-up nội)
 * Cách làm: nhấc phao lên/xuống bằng tay (hoặc đổ/rút nước) và xem Serial.
 * Đạt khi: trạng thái đổi đúng theo mực nước, không nhảy lung tung khi để yên 1 phút.
 * Sau khi Đạt: đặt USE_WATER_LEVEL = 1 trong node_telemetry/config.h. Nếu thấy báo ngược
 * (còn nước mà báo HẾT) thì đổi WATER_OK_LEVEL từ LOW sang HIGH (hoặc lật ngược phao).
 */
#define PIN_WATER 25
#define WATER_OK_LEVEL LOW

void setup() {
  Serial.begin(115200);
  pinMode(PIN_WATER, INPUT_PULLUP);
  Serial.println("TEST 07 - Phao muc nuoc (GPIO25)");
}

void loop() {
  static int last = -1;
  static uint32_t changes = 0;
  int ok = 0;
  for (int i = 0; i < 5; i++) { if (digitalRead(PIN_WATER) == WATER_OK_LEVEL) ok++; delay(2); }
  int water = ok >= 3;
  if (water != last) {
    if (last >= 0) changes++;
    Serial.printf("Bon nuoc: %s  (so lan doi trang thai: %lu)\n", water ? "CON NUOC" : "HET NUOC", (unsigned long)changes);
    last = water;
  }
  delay(200);
}
