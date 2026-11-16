/*
 * TEST 02 - DHT11 nhiệt độ / độ ẩm không khí (v1.2: đổi từ DHT22 theo linh kiện đã mua)
 * DHT11: 0-50 °C (±2 °C), 20-90 %RH (±5 %), đọc tối đa 1 lần/giây
 * Board: ESP32 Dev Module | Nối: VCC(+)->3V3, GND(-)->GND, DATA(OUT)->GPIO4
 * (module 3 chân đã có trở kéo lên 10k; loại 4 chân rời cần thêm trở 10k từ DATA lên 3V3)
 * Thư viện: DHT sensor library + Adafruit Unified Sensor
 * Đạt khi: đọc liên tục 5 phút không lỗi; nhiệt độ lệch < 1°C so với nhiệt kế tham chiếu;
 *          hà hơi vào cảm biến -> độ ẩm tăng rõ trong vài giây.
 */
#include <DHT.h>
#define PIN_DHT 4
DHT dht(PIN_DHT, DHT11);   // đổi DHT22 nếu thay cảm biến
uint32_t ok = 0, fail = 0;

void setup() {
  Serial.begin(115200);
  dht.begin();
  Serial.println("TEST 02 - DHT11 (doc moi 2.5 giay)");
}

void loop() {
  uint32_t t0 = micros();
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  uint32_t dt = micros() - t0;
  if (isnan(t) || isnan(h)) {
    fail++;
    Serial.printf("LOI doc DHT11! (ok=%lu, loi=%lu) -> kiem tra day DATA / nguon / tro keo len\n", (unsigned long)ok, (unsigned long)fail);
  } else {
    ok++;
    Serial.printf("T = %.1f C | H = %.1f %% | Heat index = %.1f C | thoi gian doc %lu us | ok=%lu loi=%lu\n",
                  t, h, dht.computeHeatIndex(t, h, false), (unsigned long)dt, (unsigned long)ok, (unsigned long)fail);
  }
  delay(2500);   // DHT11 cần >= 1 giây, DHT22 >= 2 giây giữa 2 lần đọc
}
