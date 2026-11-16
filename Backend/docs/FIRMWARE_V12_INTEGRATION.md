# Tích hợp Backend với Firmware Telemetry v1.2

Phạm vi hiện tại: chỉ tích hợp Node Telemetry; chưa cấu hình Node Camera/AI. Không tạo thiết bị còi/LED. Các loại phần cứng trong màn hình quản lý là cảm biến, bơm và quạt.

## Định danh

- `nodeCode` mới do Backend cấp theo ID tự tăng (`NODE-001`, `NODE-002`, ...). Với luồng có MAC, trạm nạp USB nhận `nodeCode` trong response của `POST /api/provisioning/claim` và ghi vào `device_config.h`; không yêu cầu người dùng nhập thủ công. Topic ID phải khớp chính xác `nodeCode`, nếu khác Backend sẽ không tìm thấy Node.
- `deviceCode` là mã bản ghi thiết bị con do Backend sinh. Payload telemetry firmware v1.2 có thể gửi các trường phẳng nên Backend ánh xạ các metric vào SENSOR có `config.metrics`; `deviceCode` không phải MQTT topic ID của ESP32.
- GPIO theo báo cáo: cảm biến đất GPIO34; DHT11 GPIO4; relay bơm GPIO26; relay quạt GPIO27. Không đăng ký còi/LED.

## MQTT topics

| Hướng | Topic | Ý nghĩa |
|---|---|---|
| Node → Backend | `sf/{nodeCode}/telemetry` | Số đo mới, trạng thái bơm/quạt nếu có |
| Node → Backend | `sf/{nodeCode}/telemetry/backfill` | Số đo gửi bù; Backend không chạy cảnh báo/tự động hóa hồi tố |
| Node → Backend | `sf/{nodeCode}/heartbeat` | Online, firmwareVersion, faults, reset, bc/up, dropped nếu có |
| Node → Backend | `sf/{nodeCode}/status` | LWT online/offline hoặc sự kiện trạng thái |
| Node → Backend | `sf/{nodeCode}/config` | Cấu hình hiệu lực được firmware gửi lại |
| Node → Backend | `sf/{nodeCode}/cmd/ack` | Kết quả lệnh; nên echo `commandUuid` (hoặc `commandId`) và `ok` Boolean |
| Backend → Node | `sf/{nodeCode}/cmd` | Lệnh `pump`, `fan`, `config`, `lifecycle`, `get_status`, `reboot`, `reset_wifi`, `factory_reset` |

Đặt `MQTT_FIRMWARE_TOPIC_PREFIX=sf` trong Backend. Mỗi Node có username/password MQTT riêng và ACL role riêng được Backend tạo trên Mosquitto Dynamic Security; xem `Backend/docs/mosquitto-acl.example`. Không dùng một MQTT account chung cho tất cả Node.

## Payload telemetry được Backend chấp nhận

Backend hỗ trợ cả cấu trúc cũ `readings[]` lẫn các trường phẳng phổ biến:

```json
{
  "seq": 105,
  "ts": "2026-10-27T09:30:00Z",
  "bc": 3,
  "up": 120000,
  "soilMoisture": 28.4,
  "temperature": 32.1,
  "humidity": 86,
  "pumpOn": false,
  "fanOn": true,
  "backfilled": false
}
```

Tên trường phẳng được chấp nhận có alias (ví dụ `soil`, `temp`, `rh`). Mỗi SENSOR trong database cần khai báo `config.metrics`, ví dụ cảm biến đất là `SOIL_MOISTURE`, DHT11 là cả `AIR_TEMPERATURE` và `AIR_HUMIDITY`. Nếu có nhiều SENSOR cùng loại mà không khai báo `config.metrics`, Backend có thể không ánh xạ được metric; hãy khai báo rõ trong UI. Backend lưu `seq` + `bc` để chống trùng bản tin; nếu `ts` bằng 0 hoặc chưa có giờ NTP, `up` được hiểu là mili giây từ lúc boot và dùng cùng `bc` để suy ra timestamp.

## Sự kiện firmware

Backend xử lý các event của Node Telemetry trên topic `sf/{nodeCode}/status`: `sensor_fault`, `sensor_recovered`, `pump_no_effect`, `pump_locked`, `pump_unlocked`, `water_low`, `water_ok`. Ví dụ: `{ "event": "sensor_fault", "sensor": "soil", "message": "soil sensor invalid" }`. Heartbeat `faults` hỗ trợ các mã `soil`, `dht22`/`dht`, `pump`. Lỗi camera/AI không nằm trong phạm vi thay đổi lần này. Khi cảm biến phục hồi, cần telemetry mới rồi quản trị viên có thể chuyển thiết bị khỏi FAULT; Backend không tự đánh dấu ACTIVE chỉ dựa trên event recovered.

## Lệnh điều khiển và ACK

Backend publish lệnh điều khiển theo dạng tương thích mở rộng:

```json
{
  "commandUuid": "550e8400-e29b-41d4-a716-446655440000",
  "commandId": "550e8400-e29b-41d4-a716-446655440000",
  "deviceCode": "DEV-008",
  "action": "fan",
  "on": true,
  "turnOn": true
}
```

Lệnh bật bơm thêm `seconds: 10`; firmware vẫn phải áp dụng giới hạn an toàn 30 giây/lần của chính nó. ACK có thể dùng `ok: true/false` và `reason`, nhưng cần echo UUID để Backend ghép ACK chính xác với lệnh đang chờ. Nếu firmware hiện tại không echo UUID, phải cập nhật parser/ACK trong firmware; không nên ghép ACK chỉ theo thứ tự vì có thể xác nhận nhầm lệnh. Riêng lệnh lifecycle ACTIVE, Backend chỉ đổi lifecycle sang ACTIVE sau ACK thành công đúng UUID và đúng Node/Device.

## Cấu hình từ xa

Backend gửi `action: "config"` trên topic `/cmd`. Các tên trường chuẩn hóa Backend hiện dùng là `pumpAutoEnabled`, `soilOnPct`, `soilOffPct`, `pumpMaxRunSec`, `pumpCooldownSec`, `fanAutoEnabled`, `fanOnTempC`, `fanOffTempC`, `fanOnHumidityPct`, `fanOffHumidityPct`. Báo cáo firmware mô tả hành vi/ngưỡng nhưng không liệt kê schema JSON chính xác; cần đối chiếu các key này với parser trong `config.h`/firmware trước khi coi thay đổi cấu hình từ web đã được xác minh. Khi firmware publish lại `/config`, nên gửi `version` hoặc `configVersion` để Backend đánh dấu đúng phiên bản đã áp dụng.

## Quạt và tự động hóa

- Quạt là `FAN`, mặc định GPIO27. Nút bật/tắt trên web gửi lệnh `action: "fan"`.
- Ngưỡng hiển thị theo báo cáo: bật khi nhiệt độ ≥32°C **hoặc** độ ẩm không khí ≥85%; tắt khi nhiệt độ ≤30°C **và** độ ẩm <80%.
- Tưới và quạt tự động là trách nhiệm firmware, chạy cả khi mất mạng. Các thiết bị tạo theo luồng inventory được gắn `localAutomation: true` để Backend không phát lệnh tự động trùng với logic trên ESP32.
- Bơm GPIO26; firmware phải giữ giới hạn chạy tối đa 30 giây, nghỉ ít nhất 60 giây và khóa bơm khi nghi chạy khô. Không dùng lệnh Backend để bỏ qua các bảo vệ này.

## Kích hoạt lifecycle Device

- Device mới được tạo ở `REGISTERED`. Admin cấu hình, gán Node và gán ít nhất một người quản lý trước khi chuyển sang `PROVISIONED`.
- `PROVISIONED` là đã cấu hình + gán người quản lý; không phụ thuộc probe/heartbeat đầu tiên.
- Chỉ Admin được nhấn Kích hoạt. Backend publish `action: \"lifecycle\"`, `lifecycle: \"ACTIVE\"`, `deviceCode` và UUID trên `sf/{nodeCode}/cmd`.
- Firmware phải trả ACK trên `sf/{nodeCode}/cmd/ack`, có `commandUuid` (hoặc `commandId`) và `success` (hoặc `ok`) dạng Boolean. Backend chỉ lưu `ACTIVE` sau ACK thành công. Heartbeat và telemetry không tự kích hoạt Device.
- Đặt `REQUIRE_ACTIVATION = 1` trong `config.h`. Báo cáo Firmware ghi nhận `REQUIRE_ACTIVATION = 0` cho phép tự vào ACTIVE khi MQTT kết nối; chế độ đó không phù hợp với quy trình Admin chủ động kích hoạt.

## Tài khoản MQTT và thu hồi Node

- Mỗi Node có một MQTT username/password riêng và một ACL role giới hạn vào `sf/{nodeCode}/...`. Tài khoản của các Device con không tách riêng vì chúng dùng chung kết nối vật lý MQTT của Node.
- Với luồng claim (Node có MAC), MQTT account chỉ được tạo khi trạm nạp gọi `POST /api/provisioning/claim` thành công và credential được trả một lần trong response đó. Node tạo không có MAC (tương thích cũ) nhận credential một lần qua Web Admin. Password không được lưu dạng rõ trong MySQL; Cấp lại mật khẩu sẽ vô hiệu password cũ và yêu cầu cập nhật lại firmware.
- Khi thu hồi Device, không thu hồi MQTT account của Node. Backend chỉ chặn dữ liệu/lệnh của Device đã decommission để các Device con khác tiếp tục chạy.
- Khi thu hồi toàn bộ Node, Backend gọi Dynamic Security `disableClient`, khiến Broker ngắt phiên hiện tại và từ chối kết nối mới. Khôi phục Node gọi `enableClient`; heartbeat mới xác nhận online.
- Cần bật Mosquitto Dynamic Security plugin và cấu hình tài khoản MQTT riêng của Backend. Hướng dẫn ở `Backend/docs/mosquitto-acl.example`.
