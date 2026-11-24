/*
 * TEST 01 - Cảm biến độ ẩm đất LOẠI ĐIỆN TRỞ (module 2 que + mạch so sánh) + HIỆU CHUẨN
 * Board: ESP32 Dev Module | Nối: VCC->3V3 (KHÔNG cấp 5V), GND->GND, AO->GPIO34 (chân DO bỏ trống)
 *
 * Cách làm:
 *  1. Nạp code, mở Serial Monitor 115200.
 *  2. Để que ngoài không khí (khô) 30 giây  -> ghi lại giá trị "raw TB" = SOIL_RAW_DRY (thường gần 4095)
 *  3. Nhúng 2 que vào cốc nước (KHÔNG nhúng mạch) -> ghi "raw TB" = SOIL_RAW_WET
 *  4. Cắm vào đất khô / đất vừa tưới để xem % có hợp lý không.
 *  5. Điền 2 giá trị vào config.h (DEF_SOIL_RAW_DRY / DEF_SOIL_RAW_WET) của node_telemetry
 *     hoặc gửi lệnh MQTT {"action":"config","soil_raw_dry":...,"soil_raw_wet":...}
 * Đạt khi: raw khô > raw ướt rõ rệt (chênh > 1000), dao động khi đứng yên < ±50.
 *
 * LƯU Ý loại điện trở (v1.2):
 *  - Cấp 5V thì AO có thể lên gần 5V -> vượt giới hạn 3,3V của ADC ESP32. Luôn cấp 3V3.
 *  - Que bị ăn mòn dần (điện phân) khi cấp điện liên tục -> số đo trôi theo thời gian.
 *    Đo lại hiệu chuẩn trước buổi demo; nếu que đã đen/rỉ thì thay que.
 *  - Cột "mV" phải nằm trong 0-3,3 V. Gần 0 khi để khô = sai dây.
 */
#define PIN_SOIL 34
int rawDry = 4095, rawWet = 1500;   // ước lượng, sửa sau khi đo

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  Serial.println("TEST 01 - Soil moisture. Go 'd' = lay gia tri hien tai lam KHO, 'w' = lam UOT");
}

void loop() {
  static int minV = 4095, maxV = 0;
  uint32_t sum = 0;
  for (int i = 0; i < 32; i++) { sum += analogRead(PIN_SOIL); delay(2); }
  int raw = sum / 32;
  minV = min(minV, raw); maxV = max(maxV, raw);
  float pct = constrain((rawDry - raw) * 100.0f / (rawDry - rawWet), 0, 100);
  Serial.printf("raw TB=%4d  (%4d mV) | min=%4d max=%4d | do am ~ %5.1f %%  [kho=%d uot=%d]\n",
                raw, analogReadMilliVolts(PIN_SOIL), minV, maxV, pct, rawDry, rawWet);
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 'd') { rawDry = raw; Serial.printf(">> SOIL_RAW_DRY = %d\n", raw); }
    if (c == 'w') { rawWet = raw; Serial.printf(">> SOIL_RAW_WET = %d\n", raw); }
    if (c == 'r') { minV = 4095; maxV = 0; }
  }
  delay(1000);
}
