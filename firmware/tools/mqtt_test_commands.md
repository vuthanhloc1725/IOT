# Lệnh MQTT mẫu để test firmware v1.4 (giao thức sf/ theo Backend 02/11/2026)

Thay `BROKER`, mật khẩu và `NODE-01` (Node code nhập ở cổng cấu hình WiFi, phải TRÙNG mã Node trên web).
Trên Windows PowerShell, chuỗi JSON đặt trong dấu nháy đơn: `-m '{"action":"get_status"}'`.

> **Cách nhanh nhất:** `python sim_backend.py --host BROKER -u admin -P MATKHAU --setup NODE-01`
> (cần `pip install paho-mqtt`). Script gửi config cho PUMP-01/FAN-01, rồi kích hoạt (lifecycle ACTIVE) 4 thiết bị
> SOIL-01, DHT-01, PUMP-01, FAN-01; in mọi bản tin và kiểm tra ACK giống Backend (UUID, success Boolean, ≤ 15 s).
> Gõ thêm: `NODE-01 pump PUMP-01 on`, `NODE-01 fan FAN-01 off`, `NODE-01 lc PUMP-01 MAINTENANCE`,
> `NODE-01 cmd {"action":"pump_unlock"}`.

## Theo dõi
```
mosquitto_sub -h BROKER -u admin -P MATKHAU -t "sf/#" -v
```

## Node Telemetry (NODE-01) - mọi lệnh đi trên sf/NODE-01/cmd, phản hồi trên sf/NODE-01/cmd/ack
```
# 1. Config bơm / quạt (version tăng dần) -> sf/NODE-01/config/ack
mosquitto_pub -h BROKER -u admin -P MATKHAU -t sf/NODE-01/cmd -m '{"action":"config","deviceCode":"PUMP-01","type":"PUMP","gpioPin":26,"lifecycle":"PROVISIONED","config":{"pumpAutoEnabled":true,"soilOnPct":35,"soilOffPct":60,"pumpMaxRunSec":30,"pumpCooldownSec":60},"version":1}'
mosquitto_pub -h BROKER -u admin -P MATKHAU -t sf/NODE-01/cmd -m '{"action":"config","deviceCode":"FAN-01","type":"FAN","gpioPin":27,"lifecycle":"PROVISIONED","config":{"fanAutoEnabled":true,"fanOnTempC":32,"fanOffTempC":30,"fanOnHumidityPct":85,"fanOffHumidityPct":80},"version":1}'

# 2. Kích hoạt từng thiết bị (Admin bấm Kích hoạt) -> cmd/ack phải echo đúng commandUuid
mosquitto_pub -h BROKER -u admin -P MATKHAU -t sf/NODE-01/cmd -m '{"commandUuid":"3f1c2a4e-1b2c-4d5e-8f90-0a1b2c3d4e01","action":"lifecycle","deviceCode":"SOIL-01","type":"SENSOR","gpioPin":34,"lifecycle":"ACTIVE"}'
mosquitto_pub -h BROKER -u admin -P MATKHAU -t sf/NODE-01/cmd -m '{"commandUuid":"3f1c2a4e-1b2c-4d5e-8f90-0a1b2c3d4e02","action":"lifecycle","deviceCode":"DHT-01","type":"SENSOR","gpioPin":4,"lifecycle":"ACTIVE"}'
mosquitto_pub -h BROKER -u admin -P MATKHAU -t sf/NODE-01/cmd -m '{"commandUuid":"3f1c2a4e-1b2c-4d5e-8f90-0a1b2c3d4e03","action":"lifecycle","deviceCode":"PUMP-01","type":"PUMP","gpioPin":26,"lifecycle":"ACTIVE"}'
mosquitto_pub -h BROKER -u admin -P MATKHAU -t sf/NODE-01/cmd -m '{"commandUuid":"3f1c2a4e-1b2c-4d5e-8f90-0a1b2c3d4e04","action":"lifecycle","deviceCode":"FAN-01","type":"FAN","gpioPin":27,"lifecycle":"ACTIVE"}'
# Tưới tự động chạy khi SOIL-01 và PUMP-01 cùng ACTIVE; quạt tự động khi FAN-01 ACTIVE.

# 3. Bật/tắt bơm, quạt (bơm tự tắt sau "seconds", tối đa 30 s; nghỉ ≥ 60 s; bơm bị khóa/hết nước thì từ chối)
mosquitto_pub -h BROKER -u admin -P MATKHAU -t sf/NODE-01/cmd -m '{"commandUuid":"7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c01","deviceCode":"PUMP-01","action":"pump","on":true,"turnOn":true,"seconds":10}'
mosquitto_pub -h BROKER -u admin -P MATKHAU -t sf/NODE-01/cmd -m '{"commandUuid":"7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c02","deviceCode":"PUMP-01","action":"pump","on":false,"turnOn":false}'
mosquitto_pub -h BROKER -u admin -P MATKHAU -t sf/NODE-01/cmd -m '{"commandUuid":"7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c03","deviceCode":"FAN-01","action":"fan","on":true,"turnOn":true}'

# 4. Bảo trì / ngừng dùng (Backend không chờ ACK) -> node tắt ngay cơ cấu chấp hành liên quan
mosquitto_pub -h BROKER -u admin -P MATKHAU -t sf/NODE-01/cmd -m '{"action":"lifecycle","deviceCode":"PUMP-01","type":"PUMP","gpioPin":26,"lifecycle":"MAINTENANCE"}'
```

## Lệnh khác trên sf/NODE-01/cmd (Serial, kỹ thuật viên)
```
mosquitto_pub -h BROKER -u admin -P MATKHAU -t sf/NODE-01/cmd -m '{"req_id":"t5","action":"pump_unlock"}'
mosquitto_pub -h BROKER -u admin -P MATKHAU -t sf/NODE-01/cmd -m '{"req_id":"t6","action":"get_status"}'
mosquitto_pub -h BROKER -u admin -P MATKHAU -t sf/NODE-01/cmd -m '{"req_id":"t7","action":"lifecycle","value":"active"}'
```
Lệnh `lifecycle` không có `deviceCode` (kiểu cũ) áp cho node VÀ mọi thiết bị - tiện test một mình, không dùng với web.

## Node Camera
Đã bỏ (09/11): ảnh lá chụp bằng camera điện thoại, không qua firmware.
