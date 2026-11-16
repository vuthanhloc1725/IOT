# ThresholdRelayTest

Firmware test độc lập: đọc soil ADC + DHT11, tự động bật/ngắt relay theo ngưỡng.
**Không WiFi, không MQTT** — chỉ dùng để kiểm tra phần logic ngắt relay trên board thật.

## Phần cứng
| Chức năng | GPIO | Ghi chú |
|---|---|---|
| Soil ADC | 34 | ADC1_CH6 |
| DHT11 data | 4 | pull-up 10k |
| Relay | 26 | `PUMP_ACTIVE_LEVEL = LOW`, sửa thành `HIGH` nếu module active-HIGH |

Giống pin của `SoilPumpNode` nên kết quả test áp dụng được cho firmware chính.

## Ngưỡng (sửa trực tiếp ở đầu file .ino)
- Đất khô ≤ **35%** → bật relay
- Đất đủ ẩm ≥ **60%** → ngắt relay
- Nhiệt độ ngoài khoảng **5–40 °C** → ngắt / không cho bật
- Độ ẩm không khí ≥ **90%** → ngắt / không cho bật
- Chạy liên tục tối đa **30 s**, sau đó nghỉ **60 s** (cooldown)
- Sensor đọc lỗi (soil hoặc DHT) → **ngắt relay** (fail-safe)
- Relay OFF ngay trong `setup()` trước mọi thứ khác

Hiệu chuẩn ADC: `SOIL_DRY_ADC = 3000`, `SOIL_WET_ADC = 1000`.

## Nạp
Arduino IDE: board *ESP32 Dev Module*, cần thư viện **DHT sensor library** (Adafruit) + **Adafruit Unified Sensor**.
Serial Monitor **115200 baud**.

## Test không cần cắm sensor
Gõ lệnh vào Serial Monitor để giả lập giá trị:

```
s 20        # soil 20% -> relay phải ON
s 70        # soil 70% -> relay phải OFF ("dat da du am")
t 45        # nhiệt 45C -> relay phải OFF ("nhiet do qua cao")
h 95        # ẩm KK 95% -> relay phải OFF
c           # xoá giả lập, quay về sensor thật
a 0 / a 1   # tắt / bật chế độ tự động
on / off    # điều khiển relay thủ công
?           # in trạng thái hiện tại
```

Kịch bản kiểm tra ngắt tự động: `s 20` → chờ relay ON → `t 45` → relay phải OFF ngay ở lần đọc kế tiếp (≤ 2 s), log in rõ lý do.
