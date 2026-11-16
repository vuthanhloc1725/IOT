# Tự động sinh `nodeCode` và `deviceCode`

## Nguyên tắc

- Backend là nơi duy nhất sinh `nodeCode` và `deviceCode`.
- Mã có dạng `NODE-<16 ký tự hex>` và `DEV-<16 ký tự hex>`, tạo từ `crypto.randomBytes(8)`.
- Mã được kiểm tra chưa tồn tại trước khi ghi. Nếu va chạm unique do hai yêu cầu đồng thời, backend thử sinh lại; unique index MySQL vẫn là hàng rào cuối cùng.
- Mã định danh không phải MQTT credential. Mosquitto username/password hoặc chứng thư phải được cấp riêng.

## Tạo Node

Request `POST /api/nodes` không cần `nodeCode`:

```json
{
  "name": "Node nhà kính A",
  "firmwareVersion": "1.0.0",
  "hardwareVersion": "ESP32-WROOM",
  "heartbeatTimeoutSec": 60
}
```

Response gồm `data.nodeCode`, ví dụ `NODE-5C23A91F0D7B4E12`, và `meta.nodeCodeGenerated: true`.
Admin bàn giao mã này cho thành viên firmware để cấu hình đúng MQTT topic; cập nhật ACL Mosquitto theo mã đã cấp trước khi Node kết nối. Việc tạo row không tự tạo MQTT credential hoặc chứng minh Node đã online.

## Probe và tạo thiết bị

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

## Hướng dẫn bàn giao firmware/broker

1. Tạo Node trong giao diện Admin.
2. Sao chép `nodeCode` do Backend trả về vào cấu hình firmware.
3. Tạo/cấp credential riêng trên Mosquitto; thay placeholder `NODE-01` trong ACL mẫu bằng `nodeCode` thật, không lấy mã làm mật khẩu.
4. Kết nối Node và chờ heartbeat để Backend đánh dấu online.
5. Tạo thiết bị bằng tên, type, Node và GPIO. Firmware xử lý probe không cần `deviceCode`.
6. Sau probe thành công, lấy `deviceCode` trả về trong API hoặc xem trên giao diện; firmware sẽ nhận mã này ở payload config sau khi Admin bấm cấp phát.
