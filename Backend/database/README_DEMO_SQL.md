# Khởi tạo MySQL và dữ liệu demo

## Cách chạy nhanh

1. Mở MySQL Workbench, chọn tab SQL hoặc dùng terminal.
2. Chạy toàn bộ file `database/smart_agri_mysql_demo.sql`.
3. File tạo database `iot`, schema theo các Sequelize model hiện tại, rồi chèn dữ liệu demo cho các màn hình.
4. Tạo `Backend/.env` từ `.env.example`, bảo đảm các biến MySQL đúng với database vừa tạo:

```env
DB_HOST=localhost
DB_PORT=3306
DB_NAME=iot
DB_USER=root
DB_PASSWORD=mat_khau_mysql_cua_ban
JWT_SECRET=thay_bang_chuoi_ngau_nhien_dai
MQTT_ENABLED=false
MQTT_TOPIC_PREFIX=iot
MQTT_FIRMWARE_TOPIC_PREFIX=sf
```

Để kiểm tra giao diện chỉ bằng dữ liệu demo, có thể tạm đặt `MQTT_ENABLED=false`; khi muốn chạy ESP32/AI thực tế thì cấu hình lại broker và bật MQTT.

Terminal tại thư mục `Backend`:

```bash
npm install
npm run test:security
npm run dev
```

Terminal thứ hai tại thư mục `Frontend`:

```bash
npm install
npm run dev
```

Mở URL Vite hiện ra (thường là `http://localhost:5173`).

## Tài khoản demo

Tất cả tài khoản mẫu dùng mật khẩu `Demo@12345678`:

| Username | Vai trò | Email |
|---|---|---|
| `admin` | Admin | admin@iot.vn |
| `operator1` | Operator | operator1@iot.vn |
| `operator2` | Operator | operator2@iot.vn |
| `viewer1` | Viewer | viewer1@iot.vn |
| `viewer2` | Viewer | viewer2@iot.vn |

Đây là mật khẩu demo dùng chung, chỉ dùng local. Đổi mật khẩu / xóa tài khoản demo trước khi triển khai thật. Vì đã có tài khoản Admin trong seed SQL, không cần chạy `npm run seed:admin` để tạo tài khoản đó.

## Ảnh demo cho lịch sử AI

SQL gán `leafAnalyses.imagePath = 'demo-late-blight.jpg'`. Sau khi giải nén gói demo, ảnh đã ở đúng đường dẫn mặc định:

`Backend/storage/analysis-images/demo-late-blight.jpg`

Nếu chỉ chạy riêng file SQL mà không lấy ảnh kèm theo, bản ghi AI vẫn có trong giao diện nhưng API xem ảnh sẽ báo không tìm thấy file.

## MQTT riêng cho từng Node và kích hoạt Device

- SQL demo chỉ tạo các bản ghi Node trong MySQL; SQL không thể tự tạo principal trên Mosquitto Dynamic Security. Các Node demo ban đầu có `mqttAccountEnabled = 0`.
- Khi muốn kết nối ESP32 thật, cài Mosquitto Dynamic Security theo `docs/mosquitto-acl.example`, cấu hình tài khoản quản trị Dynamic Security và tài khoản MQTT riêng của Backend trong `Backend/.env`, sau đó đặt `MQTT_DYNSEC_ENABLED=true`.
- Vào **Quản lý Node**, nhấn biểu tượng chìa khóa ở từng Node demo để tạo/cấp tài khoản MQTT. Mật khẩu chỉ hiện một lần; lưu username/password vào captive portal ESP32. Mỗi Node có ACL giới hạn trong `sf/{nodeCode}/...`.
- Thiết bị mới được tạo ở `REGISTERED`. Sau khi đã cấu hình, gán Node và gán ít nhất một người quản lý, Admin chuyển sang `PROVISIONED`. Chỉ nút **Admin kích hoạt** mới gửi lệnh `lifecycle ACTIVE`; Backend chờ Firmware ACK đúng UUID rồi mới ghi `ACTIVE`.
- Firmware phải đặt `REQUIRE_ACTIVATION = 1` trong `config.h`; Heartbeat đầu tiên chỉ cập nhật Online/Offline, không tự kích hoạt Device.
- Nếu chỉ xem giao diện bằng dữ liệu demo, có thể giữ `MQTT_ENABLED=false` và `MQTT_DYNSEC_ENABLED=false`. Dữ liệu demo có thể chứa Device ở `ACTIVE` để minh họa màn hình; đó là dữ liệu seed, không phải bằng chứng đã kích hoạt phần cứng thật qua ACK.

## Ghi chú quan trọng

- Chỉ dùng script này trên database mới/trống. Script không xóa bảng, nhưng dữ liệu demo dùng ID cố định và `ON DUPLICATE KEY UPDATE` để dễ chạy lại.
- Tên database trong `.env` phải trùng `DB_NAME` trong backend. Nếu đổi tên database, đổi dòng `USE iot;` trong SQL tương ứng.
- Các bản ghi treatment, telemetry, cảnh báo, lệnh và audit là dữ liệu giả lập để kiểm tra UI. Nội dung điều trị được đánh dấu DEMO, không dùng làm chỉ dẫn canh tác thực tế.
- SQL chèn được history/alerts nhưng không phát Socket.IO; khi tải lại trang, frontend đọc dữ liệu từ API. Realtime chỉ xuất hiện với sự kiện mới kể từ khi backend đang chạy.
- Trường `imagePath` chỉ là tên file. Ảnh được lưu trong filesystem, không lưu nhị phân vào MySQL.

## Firmware v1.2, FAN và migration

Schema demo mới đã có `FAN`, boot counter/uptime của Node và trường sequence của telemetry. Nếu database đã tồn tại từ phiên bản trước, backup trước rồi chạy migration mới đúng một lần:

```bash
mysql -u root -p iot < database/migrations/20261027_firmware_v12_fan_node_restore.sql
mysql -u root -p iot < database/migrations/20261102_node_mqtt_accounts_explicit_activation.sql
```

Chỉ chạy migration còn thiếu và mỗi file đúng một lần. Migration ngày 02/11 bổ sung tài khoản MQTT riêng ở cấp Node và các trường đối chiếu ACK khi Admin kích hoạt Device; cần bảo đảm migration lifecycle timestamp (`20261027_device_lifecycle_timestamp.sql` hoặc `20261027_simplify_device_evidence.sql`) đã được áp dụng trước đó vì migration mới đặt các cột ACK cạnh `lifecycleChangedAt`. Luôn backup database trước khi thay đổi schema.

Màn hình Thiết bị đăng ký theo inventory phần cứng đã lắp, không yêu cầu firmware `device/probe`. Cấu hình GPIO/metric cần đối chiếu `Backend/docs/FIRMWARE_V12_INTEGRATION.md`. Node Camera/AI chưa được điều chỉnh trong phạm vi tích hợp này; còi/LED không có trong danh sách thiết bị. Node đã thu hồi có thể khôi phục trong giao diện Quản lý Node; tài khoản MQTT của Node được bật lại trên Broker và hệ thống chờ heartbeat mới.


## Đăng nhập và đăng xuất JWT

Schema người dùng không cần bộ đếm phiên đăng nhập. JWT được xác thực bằng chữ ký, hạn sử dụng và trạng thái `isActive` của người dùng. Frontend lưu JWT trong `localStorage`, gửi qua header `Authorization: Bearer ...` và xóa token khỏi `localStorage` khi đăng xuất. JWT đã bị sao chép có thể dùng đến khi hết hạn; hãy đặt `JWT_EXPIRES_IN` phù hợp và bảo vệ `JWT_SECRET`.
