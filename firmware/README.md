# Firmware - Công việc 1 (Hardware & Firmware)

Hệ thống Nông nghiệp Thông minh - 1 node ESP32 (telemetry) giao tiếp MQTT. Ảnh lá chụp bằng **camera điện thoại**, không qua firmware.
Chi tiết đầy đủ: xem file Word `Tai_lieu_CV1_Hardware_Firmware.docx`.

| Thư mục | Nội dung | Board |
|---|---|---|
| `node_telemetry/` | Cảm biến độ ẩm đất (điện trở) + DHT11 + relay bơm 12V/quạt, tưới tự động | ESP32 Dev Module |
| `bin/` | File firmware dựng sẵn bản 1.4.0 của node telemetry, nạp thẳng không cần build | ESP32 Dev Module |
| `tests/` | 5 sketch test độc lập từng linh kiện (test_07 phao nước: tùy chọn) | ESP32 Dev Module |
| `_luu_tru_esp32cam/` | Lưu trữ phần ESP32-CAM đã bỏ (node_camera 1.3.1, test_04 còi/LED, test_05 camera) | - |
| `tools/` | mosquitto.conf, acl, lệnh MQTT mẫu, `sim_backend.py` (giả lập Backend) | - |

## Nạp nhanh
**Arduino IDE 2.x**: cài core "esp32 by Espressif", thư viện WiFiManager (tzapu), PubSubClient,
ArduinoJson (v7), DHT sensor library + Adafruit Unified Sensor. Mở file `.ino` trong thư mục con cùng tên.
- Telemetry: board "ESP32 Dev Module", partition "Default 4MB with spiffs".

**PlatformIO**: mở thư mục `node_telemetry` trong VS Code -> Build/Upload
(platformio.ini đã khai báo sẵn thư viện).

Bản 1.4.0 (03/11, node telemetry): biên dịch thành công trên ESP32 Arduino core **2.0.17** và **3.3.12**
(code của nhóm 0 cảnh báo; cảnh báo còn lại nằm trong thư viện WiFiManager). Chưa nạp thử phần cứng thật.

**File dựng sẵn (`bin/`, build 09/11 trên core 2.0.17, partition Default 4MB):**
- `farmcare_node_telemetry_v1.4.0_full.bin`: nạp tại địa chỉ **0x0** (gồm bootloader + bảng phân vùng + app).
  Ví dụ: `esptool.py --chip esp32 --baud 460800 write_flash 0x0 farmcare_node_telemetry_v1.4.0_full.bin`
  hoặc trang https://espressif.github.io/esptool-js/ (Flash Address = 0x0).
- `farmcare_node_telemetry_v1.4.0_app.bin`: chỉ phần app, nạp tại **0x10000** khi mạch đã có bootloader.
- Nạp file này **không xóa** cấu hình WiFi/MQTT và ngưỡng đã lưu. Muốn xóa: lệnh `factory_reset` hoặc `esptool.py erase_flash` trước khi nạp.
- Thư mục `node_telemetry/.pio/` (bản build cũ v1.3 ngày 25/10) đã xóa ngày 09/11; PlatformIO tự tạo lại khi bấm Build.

## Lần chạy đầu
1. Mở Serial Monitor 115200: dòng `[BOOT] FW 1.5.0 | MAC (khai bao khi tao Node tren web): xx:xx:...` cho biết
   **MAC Wi-Fi STA** của bo (gõ `prov` để xem lại). Trên web (Admin): tạo Node với đúng MAC này và đăng ký đủ
   3 thiết bị bắt buộc (bước 3) -> web hiện **claim token** (43 ký tự, hạn 30 phút, chỉ hiện 1 lần).
2. Node phát WiFi `SF-TELE-xxxx` (mật khẩu `12345678`). Kết nối bằng điện thoại -> chọn WiFi, nhập
   **Backend URL** (vd `http://192.168.1.10:3000`) và dán **Claim token** -> Save. Hoặc trên Serial:
   `api http://192.168.1.10:3000` rồi `claim <token>`. ESP32 tự gọi `POST /api/provisioning/claim`, nhận
   nodeCode + MQTT user/password riêng, lưu Flash và kết nối broker. **Không cần nhập MQTT tay**, không xóa Flash.
   - Lỗi claim in ra Serial dạng `[PROV] HTTP 409 MA_LOI: thông báo` (bảng mã: `Backend/docs/DEVICE_CLAIM_LIFECYCLE.md` mục 3).
     Lỗi mạng/broker thì firmware tự thử lại; lỗi token/MAC thì dừng chờ token mới (`claim retry` để thử lại ngay).
   - Thu hồi / cấp lại trên web: bấm **Cấp lại claim token** rồi nhập token mới như trên.
   - Broker từ chối user/pass nhiều lần liên tiếp -> Node tự mở lại cổng cấu hình (gõ `portal` để mở tay).
   - Broker `mqtts://` (cổng 8883): nạp CA vào `tls_ca.h`. Test một mình không Backend: nhập MQTT tay như v1.4.
3. Trên web: đăng ký thiết bị theo đúng GPIO - cảm biến đất GPIO34 (metric `SOIL_MOISTURE`),
   DHT11 GPIO4 (`AIR_TEMPERATURE` + `AIR_HUMIDITY`), bơm GPIO26, quạt GPIO27 -> cấu hình, gán người quản lý
   -> PROVISIONED -> bấm **Kích hoạt** từng thiết bị. Node trả ACK, thiết bị mới thành ACTIVE.
4. Mở Serial Monitor 115200 (Newline), gõ `help`, `dev` (xem bảng mã thiết bị). Chưa có Backend:
   chạy `tools/sim_backend.py --setup NODE-01`, hoặc gõ `lc active` để bật tự động hóa khi test một mình.

## Thông số cần chỉnh
Tất cả nằm trong `config.h` của từng node (chân GPIO, ngưỡng, chu kỳ, mức kích relay/còi).
Giá trị hiệu chuẩn cảm biến đất lấy từ `tests/test_01_soil_calibration`.

## Topic MQTT (v1.4, theo Backend 02/11/2026 - `Backend/docs/FIRMWARE_V12_INTEGRATION.md`)
Tiền tố `sf/<nodeCode>/` (= `MQTT_FIRMWARE_TOPIC_PREFIX` của Backend). Chỉ dùng topic có trong ACL của Backend:
- Node -> Backend: `telemetry` (dạng phẳng `seq, bc, up, ts, soilMoisture, temperature, humidity, pumpOn, fanOn`),
  `telemetry/backfill` (gửi bù, mỗi bản ghi 1 bản tin), `heartbeat` (`firmwareVersion, bc, up, faults`...),
  `status` (`{"status":"online"}` retained, LWT `{"status":"offline"}`, sự kiện `{"event":...}`,
  trạng thái thiết bị `{"deviceCode","deviceStatus":"FAULT"}`), `cmd/ack`, `config/ack`.
- Backend -> Node: `cmd` với `action` = `pump`, `fan`, `config`, `lifecycle`, `pump_unlock`, `get_status`,
  `reboot`, `reset_wifi`, `factory_reset`.
- Ảnh lá: chụp bằng camera điện thoại -> dịch vụ AI -> Backend qua `iot/ai/result` (luồng của Backend/AI, không qua firmware).

## Thay đổi v1.5.0 (11/11/2026) - ESP32 tự claim, bỏ đối soát broker
- Mới `provisioning.h/.cpp`: ESP32 tự claim bằng token (ô cổng cấu hình hoặc lệnh Serial), lưu blob NVS riêng
  `prov` -> **không đổi** cấu hình v1.4 (WiFi/MQTT/ngưỡng giữ nguyên khi nạp đè).
- Lệnh Serial mới: `prov`, `prov clear`, `claim <token>`, `claim retry`, `api <url>`, `portal`.
- Tự dùng TLS khi Backend báo `tls` hoặc cổng 8883 (CA trong `tls_ca.h`); token không bao giờ in ra Serial.
- Broker từ chối user/pass (rc 4/5) liên tiếp -> mở cổng cấu hình một lần, không xóa cấu hình.
- Đi kèm Backend: replay claim an toàn 10 phút, cấp lại token cho Node đã thu hồi / claim kẹt / đã claim
  (`reprovision`) - hết lỗi 409 "cần đối soát broker".
- File `bin/` vẫn là bản v1.4.0; cần build lại để có v1.5.0.

## Thay đổi 09/11 (lần 2) - bỏ ESP32-CAM, dùng camera điện thoại
- Nhóm chốt chụp ảnh lá bằng camera điện thoại, nên firmware chỉ còn node telemetry.
- Chuyển `node_camera/`, `tests/test_04_buzzer_led/`, `tests/test_05_camera/` vào `_luu_tru_esp32cam/` (không xóa).
- `tools/`: bỏ phần camera trong `sim_backend.py` (nhận ảnh, `--fake-ai`, `--out`), `acl`, `mqtt_test_commands.md`, `mosquitto.conf`.

## Thay đổi 09/11 - node camera v1.3.1, file .bin dựng sẵn
- Node camera: tiền tố topic `iot/` -> `sf/` (FW_VERSION 1.3.1), các phần khác giữ nguyên. Bản cũ lưu ở
  `_backup/20261109_camera_v130/`.
- Thêm thư mục `bin/` với firmware node telemetry 1.4.0 dựng sẵn; xóa bản build cũ `node_telemetry/.pio/`.

## Thay đổi v1.4.0 (03/11) - khớp Backend bản 02/11 (giao thức sf/, Firmware v1.2 integration)
Bản cũ trước khi sửa nằm trong `_backup/20261103_v13`. Chỉ sửa node telemetry.
- Tiền tố topic `iot/` -> **`sf/`**. Một topic lệnh duy nhất `cmd`, ACK trên `cmd/ack` có `commandUuid`,
  `commandId`, `deviceCode`, `success` và `ok` (Boolean), `message`. Lệnh lặp (QoS 1) chỉ ACK lại, không làm lại.
- Telemetry đổi sang **dạng phẳng** - Backend tự ánh xạ vào cảm biến theo `config.metrics`, node không cần biết mã
  cảm biến. Mỗi bản ghi có `seq` + `bc` để Backend chống trùng. Gửi bù lên `telemetry/backfill`; bản ghi chưa có
  giờ NTP vẫn gửi được (Backend suy giờ từ `bc` + `up`).
- **Lifecycle từng thiết bị**: Admin bấm Kích hoạt -> `action:"lifecycle"`, `ACTIVE` -> node ACK đúng UUID.
  Tưới tự động chạy khi **bơm và cảm biến đất cùng ACTIVE** (và `pumpAutoEnabled`); quạt tự động khi **quạt ACTIVE**
  (và `fanAutoEnabled`). MAINTENANCE / DECOMMISSIONED / FAULT -> tắt ngay bơm/quạt liên quan.
- **Quạt** có ô riêng (FAN, GPIO27): nhận lệnh bật/tắt từ web (giữ 5 phút rồi tự động hóa quản lý lại),
  trạng thái gửi qua `fanOn`. Thêm ngưỡng tắt quạt theo độ ẩm `fanOffHumidityPct` (mặc định 80 %RH).
- `config` đọc đúng tên khóa Backend: `pumpAutoEnabled, soilOnPct, soilOffPct, pumpMaxRunSec, pumpCooldownSec,
  fanAutoEnabled, fanOnTempC, fanOffTempC, fanOnHumidityPct, fanOffHumidityPct` -> `config/ack` theo `version`.
  **Giới hạn an toàn bơm không nới được từ xa**: `pumpMaxRunSec` tối đa 30 s, `pumpCooldownSec` tối thiểu 60 s.
- Sự kiện gửi lên `status` đúng dạng Backend xử lý: `sensor_fault, sensor_recovered, pump_no_effect, pump_locked,
  pump_unlocked, water_low, water_ok`. Bỏ topic `event`, `info` (nằm ngoài ACL, broker sẽ chặn).
- `pump_unlock` gửi được từ Backend trên `cmd` (web hiện chưa có nút).
- `device/probe` và READY của bơm tắt bằng `ENABLE_DEVICE_PROBE 0` (Backend mới không dùng). ACS712 vẫn tùy chọn:
  `USE_PUMP_CURRENT 1` thì lệnh bật bơm chỉ ACK thành công khi đo được dòng.
- Nâng cấp không mất cấu hình: WiFi, Node code, MQTT user/pass và bảng mã thiết bị của v1.3 được giữ lại.
- `tools/sim_backend.py`, `tools/acl`, `tools/mqtt_test_commands.md` viết lại theo giao thức `sf/`.

## Thay đổi v1.3.0 (27/10) - khớp giao thức MQTT của Backend (tài liệu v1.0, nay đã thay bằng v1.4)
Bản cũ trước khi sửa nằm trong `_backup/20261027_mqtt`.
- Tiền tố topic `sf/` -> `iot/`. Device ID nay là **Node code** của Backend (vd `NODE-01`).
- Telemetry đổi sang `{"ts","backfilled","readings":[{"deviceCode","metric","value","ts"}]}`;
  giá trị lỗi bị **bỏ khỏi readings** (không gửi `null`). Giờ dạng ISO 8601 UTC.
  Gửi bù chung topic `telemetry`, `backfilled:true`; bản ghi không xác định được giờ đo thì bỏ (đếm `dropped`).
- Mới `devices.cpp`: bảng gán mã thiết bị Backend (SOIL-01, TEMP-01, HUM-01, PUMP-01) cho phần cứng,
  lưu NVS. Gán khi Backend gửi `device/probe`/`config`, hoặc gõ `map` trên Serial.
- Nhận `command` (`commandUuid`, `turnOn`) -> `command/ack`; lệnh lặp do QoS 1 chỉ ACK lại, không làm lại.
  Giới hạn an toàn bơm **giữ nguyên** (tự tắt sau 10 s, tối đa 30 s, khóa khi chạy khô, phao).
- Nhận `config` (lifecycle + version) -> `config/ack`, áp dụng idempotent theo version.
  Cảm biến đất được Backend cho **ACTIVE** -> node bật tưới tự động. Thiết bị chuyển Bảo trì/Ngừng/Lỗi
  -> node dừng tự động hóa tương ứng.
- Nhận `device/probe` -> `device/probe/ack` với số đọc thật. **Bơm cần cảm biến dòng ACS712** (GPIO35,
  `USE_PUMP_CURRENT 1`) mới trả `present:true` và gửi `READY`. Chưa lắp -> trả `present:false` kèm lý do,
  **không giả số đo**; Backend giữ bơm ở PROVISIONED (web không bật bơm được, tưới tự động tại node vẫn chạy).
- Cảm biến lỗi, bơm bị khóa, phao hết nước -> gửi `{"deviceCode","deviceStatus":"FAULT","message"}`.
- Quạt chưa có trong Backend -> chạy tự động tại node như cũ.
- Mã lỗi heartbeat `"dht22"` -> `"dht"`.
- Node camera: chỉ đổi tiền tố `iot/`, status/LWT/heartbeat theo tài liệu. Đường ảnh tới AI chờ nhóm chốt.
- `tools/sim_backend.py` viết lại theo giao thức mới (`--setup NODE-01`), `tools/acl`, lệnh test cập nhật.

## Thay đổi v1.2.0 (27/10) - khớp linh kiện đã mua
**Linh kiện thực tế** (bản cũ trước khi sửa nằm trong `_backup/20261027_linhkien`):
- DHT22 -> **DHT11** (`DHT_TYPE DHT11`). Ngưỡng độ ẩm bật quạt mặc định hạ 90 -> **85 %RH**
  vì DHT11 chỉ đo tới ~90 %RH. Mã lỗi heartbeat vẫn là `"dht22"` để Backend không phải sửa.
- Cảm biến đất điện dung -> **loại điện trở** (2 que + mạch so sánh). VCC module nối **3V3**.
  Hiệu chuẩn mặc định khô 4095 / ướt 1500 (ước lượng, phải đo lại bằng test_01).
  Bỏ ngưỡng lỗi phía trên (rất khô cũng đọc 4095), chỉ còn bắt lỗi khi số đọc < 100.
- Bơm mini 5V -> **bơm 12V RS385 + adapter 12V**. Bơm, quạt chạy qua relay; ESP32 cấp nguồn USB riêng.
  Firmware không đổi vì relay chỉ đóng/ngắt.
- Node Camera **chưa lắp còi và LED đỏ**: `USE_LOCAL_ALARM 0` trong `node_camera/config.h`.
  Kết quả AI vẫn được nhận và in ra Serial, cảnh báo bệnh hiển thị trên web. Lệnh `alarm` trả
  `ok:false`. Lắp còi + LED thì đặt `USE_LOCAL_ALARM 1`.
- Tests: `test_02_dht22` đổi tên thành `test_02_dht11`; test_01, test_03 cập nhật cách nối;
  test_04 (còi/LED) tạm chưa dùng.

**Firmware (27/10)**
- Khóa bơm (pumpLocked) lưu vào NVS, mất điện không tự mở khóa.
- Bản tin `status` và dòng `[BOOT]` có lý do khởi động lại (`reset`: power_on, brownout, watchdog...).

**Linh kiện còn phải mua**: module relay 2 kênh (có jumper H/L), quạt (nên chọn quạt 12V để dùng
chung adapter), ESP32-CAM + đế nạp MB, diode 1N4007 x2 + tụ 100 nF x2 + tụ 470-1000 µF.
Adapter 12V-1A có thể thiếu khi bơm và quạt chạy cùng lúc, nên dùng loại 12V-2A.

## Thay đổi v1.1.0 (so với 1.0.0)
**Phần cứng (xem tài liệu Word bản 1.1, mục 3)**
- Còi (module kích mức thấp): VCC nối **3V3**, không nối 5V (5V làm còi không tắt được).
- Thêm diode dập 1N5819/1N4007 + tụ 100 nF song song bơm và quạt; tụ 470-1000 µF ở nguồn node Telemetry.
- ESP32-CAM: đế MB chỉ để nạp code; khi lắp còi/LED dùng dây cái-cái nối trực tiếp chân board.
- Cảm biến đất V1.2: kiểm tra chip TLC555 (chạy 3V3) hay NE555 (cần 5V) - xem test_01.
- (Tùy chọn) phao mực nước GPIO25 chống bơm chạy khô - test_07, `USE_WATER_LEVEL`.

**Firmware**
- Sửa: mất điện cả khu -> ESP32 khởi động trước router -> mở cổng cấu hình 5 phút và ngừng
  kết nối lại. Nay: đã lưu WiFi thì không mở cổng, tự thử lại theo backoff.
- Sửa: topic ảnh `image/<img_id>` trùng wildcard với `image/meta` -> đổi sang `image/data/<img_id>`.
  **Backend (CV2) cần subscribe `sf/+/image/meta` và `sf/+/image/data/+`.**
- Mới: khóa bơm khi bơm nhiều lần không hiệu quả (nghi hết nước) - event `pump_no_effect`,
  `pump_locked`; heartbeat `faults:["pump"]`; lệnh `pump_unlock`.
- Sửa: gửi bù lưu vị trí đã gửi vào NVS -> mất điện giữa chừng chỉ gửi lại tối đa 1 lô.
- Sửa camera: cấp bộ đệm theo UXGA (đổi framesize từ xa không tràn bộ đệm); bỏ 1 khung cũ
  trước khi chụp (ảnh có flash không bị tối).
- Sửa test_06: thêm user/pass MQTT (broker mẫu không cho kết nối ẩn danh).
- Thêm: lệnh Serial `status` in stack trống từng task; `pump unlock`; camera `factory`.
w0lTGocz3LG3kR8JeAX9rETV9JOPXZUCU9dYHMUpvLw2