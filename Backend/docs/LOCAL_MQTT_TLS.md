# MQTT TLS cho đăng ký và claim node

Đăng ký có `macAddress` tạo claim token và yêu cầu `MQTT_URL=mqtts://...`.
Broker phải hỗ trợ Mosquitto Dynamic Security để backend tạo tài khoản và ACL riêng cho node khi claim.
Broker thử nghiệm công cộng không cung cấp quyền quản trị này.

## Thiết lập development

Máy cần có `mosquitto` phiên bản 2.x, `mosquitto_ctrl`, plugin Dynamic Security và `openssl`.
Chạy từ thư mục Backend:

```sh
npm run mqtt:setup
```

Lệnh này:

- Tạo CA cục bộ và chứng chỉ server với SAN tương ứng IP LAN của máy.
- Chạy broker riêng trên cổng TLS 8883, tắt đăng nhập ẩn danh.
- Đặt mặc định ACL thành deny; tạo tài khoản backend giới hạn topic và tài khoản quản trị riêng.
- Kiểm tra TLS, quyền quản trị và đăng nhập backend trước khi cập nhật `.env`.
- Lưu chứng chỉ, khóa, tài khoản và trạng thái broker trong `.mqtt/` (đã được ignore).
- Lưu bản `.env` cũ trong `.mqtt/env.before-local-mqtt`.

Lần khởi tạo đầu truyền mật khẩu quản trị ngẫu nhiên cho `mosquitto_ctrl dynsec init` qua
tham số tiến trình trong thời gian ngắn. Chỉ chạy bootstrap trên máy development tin cậy,
không dùng script này trên máy nhiều người dùng hoặc broker production.

Khởi động lại backend để nạp cấu hình mới:

```sh
npm run dev
```

Nếu backend đang chạy, dừng tiến trình đó trước rồi khởi động lại.
Sau khi khởi động lại máy, chạy broker trước backend:

```sh
npm run mqtt:start
npm run dev
```

`mqtt:start` chạy broker nền; bỏ qua bước này nếu broker đã chạy.
Có thể chạy lại `mqtt:setup` với cùng địa chỉ/cổng để kiểm tra cấu hình.
Để chọn địa chỉ và cổng ngay từ lần thiết lập đầu:

```sh
MQTT_DEV_HOST=192.168.1.10 MQTT_DEV_PORT=8883 npm run mqtt:setup
```

Địa chỉ phải truy cập được từ cả backend và ESP32. Khi IP LAN thay đổi, chứng chỉ và cấu hình
cần được cấp lại cho địa chỉ mới. Dùng IP cố định hoặc DHCP reservation khi có thể.
Plugin ở vị trí khác có thể chọn bằng `MQTT_DYNSEC_PLUGIN=/absolute/path/to/plugin.so`.

## Tin cậy CA

Backend dùng `MQTT_CA_FILE=.mqtt/ca.crt`. Đường dẫn tương đối được tính từ thư mục Backend,
kể cả khi khởi động Node từ thư mục khác. Cả MQTT telemetry và Dynamic Security dùng cùng CA;
kiểm tra chứng chỉ và hostname vẫn được bật.
Với broker có chứng chỉ được CA công cộng tin cậy, có thể để `MQTT_CA_FILE` trống.

Cấp chứng chỉ **CA công khai** `.mqtt/ca.crt` cho công cụ Arduino bằng tùy chọn `--broker-ca`.
Giữ các khóa `.key`, mật khẩu và `dynamic-security.json` trên máy quản trị.
Luồng claim qua USB vẫn yêu cầu API HTTPS theo `DEVICE_CLAIM_LIFECYCLE.md`.

Cấu hình này phục vụ development. Broker production cần địa chỉ ổn định, chứng chỉ và quy trình
vận hành riêng. Giữ `MQTT_URL` dùng TLS và cấu hình tài khoản quản trị Dynamic Security hợp lệ.
