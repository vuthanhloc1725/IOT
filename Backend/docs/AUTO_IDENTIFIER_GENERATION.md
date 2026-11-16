# Tự động sinh `nodeCode` và `deviceCode`

## 1. Mã định danh tuần tự

Backend là nơi duy nhất sinh mã định danh. Mã lấy từ `AUTO_INCREMENT id` của bản ghi, không dùng `COUNT(*) + 1`:

- Node: `NODE-001`, `NODE-002`, `NODE-010`, ...
- Device: `DEV-001`, `DEV-002`, `DEV-010`, ...
- Tối thiểu 3 chữ số; từ ID 1000 trở đi giữ nguyên đủ chữ số, ví dụ `NODE-1000`.
- Không tái sử dụng số khi xóa bản ghi vì ID AUTO_INCREMENT không được tính lại.
- Các mã cũ trong database đang sử dụng được giữ nguyên để không phá MQTT topic, ACL và cấu hình Firmware hiện có. Database demo mới sử dụng định dạng tuần tự ngay từ đầu.

Việc tạo bản ghi tạm và cập nhật mã cuối cùng diễn ra trong cùng transaction. Unique index trên `nodeCode`/`deviceCode` vẫn là hàng rào cuối cùng.

## 2. Tạo Node

`POST /api/nodes` (Admin) không cần gửi `nodeCode`:

```json
{
  "name": "Node nhà kính A",
  "firmwareVersion": "1.0.0",
  "hardwareVersion": "ESP32-WROOM",
  "heartbeatTimeoutSec": 60
}
```

Response gồm `data.nodeCode`, ví dụ `NODE-001`, và `meta.nodeCodeGenerated: true`. Nếu request có `macAddress`, Backend trả thêm claim token dùng một lần (chưa tạo MQTT account); MQTT account chỉ được tạo khi claim thành công tại trạm nạp. Nếu không có MAC (tương thích cũ), Backend tạo MQTT account ngay và trả password một lần. Chi tiết: `DEVICE_CLAIM_LIFECYCLE.md`.

## 3. Probe và tạo thiết bị

Request `POST /api/devices/probe` không cần `deviceCode`:

```json
{
  "name": "Cảm biến độ ẩm đất khu A",
  "type": "SENSOR",
  "location": "Khu A",
  "nodeId": 1,
  "gpioPin": 34
}
```

Backend publish `{prefix}/{nodeCode}/device/probe`:

```json
{
  "requestId": "<UUID do backend sinh>",
  "action": "PROBE",
  "type": "SENSOR",
  "gpioPin": 34,
  "hardwareFeedback": null,
  "allowActuatorTest": false
}
```

ACK từ đúng Node trên `{prefix}/{nodeCode}/device/probe/ack` không gửi `deviceCode`, vì mã chưa tồn tại. Trường payload `presenceEvidence` (nếu có) chỉ dùng tạm thời để Backend xác thực probe, không được lưu thành cột trong `devices`:

```json
{
  "requestId": "<cùng UUID>",
  "detectedType": "SENSOR",
  "gpioPin": 34,
  "present": true,
  "presenceEvidence": "SENSOR_READ:SOIL_MOISTURE",
  "selfTest": {
    "ok": true,
    "metric": "SOIL_MOISTURE",
    "value": 42.5
  }
}
```

Backend kiểm tra request ID, đúng Node, type/GPIO và self-test hợp lệ. Chỉ sau khi ACK hợp lệ backend mới sinh `deviceCode`, ghi `Device` ở trạng thái `REGISTERED`, trả mã trong `response.data.deviceCode` và audit log. Nếu timeout hoặc ACK/self-test sai, không tạo bản ghi.

Khi Admin cấp phát (`REGISTERED → PROVISIONED`), config MQTT sẽ mang `deviceCode` do Backend vừa sinh. Firmware lưu mapping mã đó với endpoint/GPIO. Config ACK, telemetry và readiness từ thời điểm này sử dụng `deviceCode` đã được cấp.

## 4. Hướng dẫn bàn giao firmware/broker

1. Tạo Node trong giao diện Admin.
2. Với Node có MAC: trạm nạp USB gọi `POST /api/provisioning/claim` bằng claim token, nhận `nodeCode` + MQTT credential và ghi vào `device_config.h` (xem `DEVICE_CLAIM_LIFECYCLE.md`). Node không có MAC: sao chép `nodeCode` do Backend trả về vào cấu hình firmware.
3. Tạo/cấp credential riêng trên Mosquitto; thay placeholder trong ACL mẫu bằng `nodeCode` thật, không lấy mã làm mật khẩu.
4. Kết nối Node và chờ heartbeat để Backend đánh dấu online.
5. Tạo thiết bị bằng tên, type, Node và GPIO. Firmware xử lý probe không cần `deviceCode`.
6. Sau probe thành công, lấy `deviceCode` trả về trong API hoặc xem trên giao diện; firmware sẽ nhận mã này ở payload config sau khi Admin bấm cấp phát.
