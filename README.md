# IoT Control — Full-stack source

Gói này gồm frontend React/Vite, backend Express/MySQL/MQTT/Socket.IO và firmware ESP32 cho DHT11, cảm biến đất, relay bơm. Giao diện sử dụng dữ liệu API thật; không tự sinh telemetry giả. Khi database trống, các danh sách sẽ rỗng cho đến khi bạn tạo thiết bị/Node/danh mục bệnh và hệ thống nhận được telemetry hoặc kết quả AI.


## MySQL schema + dữ liệu mẫu để kiểm tra giao diện

Nếu database mới/trống và bạn muốn nạp dữ liệu demo, chạy script:

```bash
mysql -u root -p < Backend/database/smart_agri_mysql_demo.sql
```

Script tạo database `iot`, tạo 12 bảng theo các model Sequelize và thêm tài khoản, Node/thiết bị, telemetry 24 giờ gần nhất, danh mục bệnh/phác đồ demo, lịch sử AI, cảnh báo, lệnh và audit log. Tài khoản mẫu dùng chung mật khẩu `Demo@12345678`: `admin`, `operator1`, `operator2`, `viewer1`, `viewer2`. Chỉ dùng local và đổi/xóa tài khoản demo trước khi deploy.

Gói demo kèm ảnh minh họa tại `Backend/storage/analysis-images/demo-late-blight.jpg`; hãy giữ file này để liên kết `imagePath` của bản ghi AI mẫu hoạt động. Trong `Backend/.env`, đặt `DB_NAME=iot`, đúng `DB_USER`/`DB_PASSWORD`; khi chỉ kiểm tra UI có thể tạm đặt `MQTT_ENABLED=false`. Dữ liệu/phác đồ là dữ liệu giả lập, không dùng làm khuyến cáo nông nghiệp thực tế.

## 1. Chuẩn bị database và Admin đầu tiên

1. Cài MySQL và tạo database, ví dụ `iot`.
2. Mở `Backend/.env.example`, sao chép thành `Backend/.env`.
3. Điền `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`; cấu hình MQTT và thay `JWT_SECRET` bằng chuỗi ngẫu nhiên dài. Nếu quản lý Node ESP32 thật, bật Mosquitto Dynamic Security trước, rồi cấu hình `MQTT_DYNSEC_ENABLED=true`, `MQTT_DYNSEC_ADMIN_USERNAME/PASSWORD` và tài khoản Backend `MQTT_USERNAME/PASSWORD` theo `Backend/docs/mosquitto-acl.example`. Đặt `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_FULL_NAME`, `BOOTSTRAP_ADMIN_PASSWORD` (mật khẩu ít nhất 12 ký tự).
4. Cài dependencies và khởi tạo schema + tài khoản Admin:

```bash
cd Backend
npm install
npm run seed:admin
npm run test:security
npm run dev
```

`seed:admin` tạo các bảng còn thiếu bằng Sequelize `sync()` an toàn và thêm một tài khoản Admin nếu chưa có Admin nào. Nếu đã có Admin, script không tạo tài khoản thứ hai. Không dùng `DB_SYNC=force` cho database cần giữ dữ liệu.

Sau khi chạy seed, đăng nhập bằng username/email và mật khẩu bạn đã đặt trong `Backend/.env`. Không có đăng ký công khai; Admin tạo Operator/Viewer qua trang Người dùng.

## 2. Chạy Frontend

Mở terminal thứ hai:

```bash
cd Frontend
npm install
npm run dev
```

Lần cài đầu hãy dùng `npm install` (không dùng `npm ci`) để đồng bộ `package-lock.json` với dependency `socket.io-client` vừa thêm. Mặc định `.env` frontend cấu hình Vite proxy các đường dẫn `/api` và `/socket.io` tới `http://localhost:3000`. Nếu backend chạy ở máy/cổng khác, sửa `VITE_BACKEND_ORIGIN` trong `Frontend/.env`. Với môi trường deploy cross-origin, đặt `VITE_API_URL` thành URL API đầy đủ (ví dụ `https://api.example.com/api`) và `VITE_SOCKET_URL` thành origin của backend.

## 3. Những màn hình đã tích hợp

- **Login:** `/api/auth/login`, khôi phục session qua `/api/auth/me`, JWT gắn vào API; trang được bảo vệ khi chưa đăng nhập.
- **Dashboard:** `/api/dashboard/summary`, `/api/dashboard/telemetry`, devices/alerts/analyses APIs và Socket.IO (`reading`, `alert:new`, `alert:update`, `device:update`, `analysis:new`, `node:status`). Không còn số liệu telemetry sinh ngẫu nhiên.
- **Thiết bị:** đăng ký theo danh sách phần cứng đã lắp và báo cáo Firmware v1.2; hỗ trợ SENSOR, PUMP, FAN, cấu hình metric, hiển thị telemetry và điều khiển bơm/quạt. Không tạo cấu hình còi/LED. API probe cũ chỉ dành cho firmware đời trước.
- **Node ESP32:** mỗi Node có username/password MQTT và ACL role riêng được tạo tự động trên Mosquitto Dynamic Security; Admin xem credential một lần, cấp lại mật khẩu, thu hồi (disable + ngắt phiên hiện tại) và khôi phục (enable) tài khoản. Backend chỉ nhận telemetry/ACK và gửi lệnh khi tài khoản Node đang bật; Node chỉ Online sau heartbeat mới.
- **Người dùng:** tạo/sửa/kích hoạt/khóa tài khoản, ma trận RBAC, gán thiết bị, hai chế độ xem theo người dùng/theo thiết bị (Admin).
- **Cảnh báo:** lọc theo trạng thái/mức độ/loại, xác nhận và xử lý, cập nhật realtime. Telemetry ACTIVE mới sinh `sensor_threshold` theo ngưỡng cấu hình; hệ thống dùng hysteresis để tránh nhấp nháy và tự đóng khi số đo phục hồi.
- **AI chẩn đoán:** lịch sử kết quả MQTT, ảnh tải qua API có JWT, độ tin cậy, model và điều trị sinh học/hóa học.
- **Audit Log:** bộ lọc và phân trang theo API, chỉ Admin.

Backend vẫn là nơi thực thi quyền truy cập; ẩn trang ở frontend chỉ là tiện ích giao diện, không thay thế RBAC backend.

## 4. Dữ liệu còn cần cấu hình để chạy end-to-end

- Bật Dynamic Security cho Mosquitto và tạo tài khoản riêng cho Backend theo `Backend/docs/mosquitto-acl.example`; sau đó tạo Node trong Web Admin. Backend sẽ tự sinh một credential và ACL role riêng cho từng Node. Lưu credential một lần hiển thị và nạp riêng cho ESP32 bằng `firmware/tools/provision.py` (firmware trong repo không dùng captive portal).
- Cấp danh mục `Disease` và `Treatment` trước khi Camera gửi ảnh; backend map nhãn AI về bệnh trong danh mục (`npm run seed` nạp sẵn danh mục classifier).
- Với firmware trong repo, đăng ký cảm biến đất, DHT11 và bơm theo danh sách phần cứng đã lắp; firmware không có lệnh `device/probe`. Backend sinh `deviceCode` cho hồ sơ, còn `nodeCode` phải khớp giá trị ghi trong NVS bằng công cụ provision. Các Node có sẵn từ SQL demo chưa có principal trong Broker; vào Quản lý Node và dùng nút chìa khóa để tạo credential cho từng Node trước khi dùng ESP32 thật. Backend hỗ trợ SENSOR, PUMP, FAN; firmware này chỉ điều khiển SENSOR và PUMP, không có quạt/còi/đèn.
- Nếu database đã tồn tại từ bản trước, chạy mỗi migration còn thiếu đúng một lần. Chạy các migration còn thiếu theo thứ tự phụ thuộc: `20261027_device_probe_lifecycle.sql`, `20261027_device_lifecycle_timestamp.sql`, `20261027_simplify_device_evidence.sql`, `20261026_external_ai_result_images.sql`, `20261027_firmware_v12_fan_node_restore.sql`, rồi `20261102_node_mqtt_accounts_explicit_activation.sql`. Không chạy lại migration đã áp dụng. Migration firmware bổ sung loại `FAN`, boot counter/uptime và khóa chống trùng theo seq. Migration `20261102_node_mqtt_accounts_explicit_activation.sql` bổ sung tài khoản MQTT ở cấp Node và trường chờ ACK kích hoạt Device. Chỉ chạy mỗi migration một lần trên DB hiện có, sau khi backup. Schema demo mới đã có các cột tương ứng.
- Đăng ký thiết bị trong trang Admin theo đúng GPIO và metric trong `firmware/README.md`. `nodeCode` phải khớp giá trị ghi vào NVS. Không dùng quy trình probe cũ để đăng ký phần cứng thật.

## 5. Cảnh báo ngưỡng và xác thực JWT

- Mặc định: `SOIL_MOISTURE` cảnh báo thấp dưới 25% (hết cảnh báo từ 30%) hoặc cao trên 85% (hết từ 80%); `AIR_TEMPERATURE` thấp dưới 5°C (hết từ 8°C) hoặc cao trên 38°C (hết từ 35°C); `AIR_HUMIDITY` thấp dưới 25% (hết từ 30%) hoặc cao trên 90% (hết từ 85%). Đây là ngưỡng demo, hãy điều chỉnh theo cây trồng/cảm biến của bạn. `AIR_TEMPERATURE` cao từ 40°C được nâng lên CRITICAL.
- Có thể ghi đè ngưỡng mặc định qua `SENSOR_THRESHOLD_RULES_JSON` trong `Backend/.env`, hoặc đặt `config.alertThresholds` khi cập nhật cấu hình của thiết bị. Hysteresis giữ cảnh báo mở cho đến khi chạm ngưỡng phục hồi. Chỉ telemetry mới của cảm biến ACTIVE mới được đánh giá; telemetry backfill không tạo cảnh báo hồi tố.
- Firmware prefix mặc định là `sf` qua `MQTT_FIRMWARE_TOPIC_PREFIX`; prefix AI hiện tại vẫn là `iot` qua `MQTT_TOPIC_PREFIX`. Topics chính: Node → Backend `sf/{nodeCode}/telemetry`, `telemetry/backfill`, `heartbeat`, `status`, `config`, `cmd/ack`; Backend → Node `sf/{nodeCode}/cmd`. Nếu đổi một trong hai prefix, phải sửa ACL tương ứng. Topic `device/probe` chỉ còn cho firmware đời cũ.
- JWT là stateless, chứa `sub` và `role`, có thời hạn theo `JWT_EXPIRES_IN`. Frontend lưu token trong `localStorage` và xóa token khi đăng xuất. Đổi mật khẩu hoặc đổi vai trò không tự vô hiệu hóa JWT đã phát; token đã bị sao chép có thể dùng đến khi hết hạn, nhưng trạng thái tài khoản và quyền truy cập vẫn được kiểm tra ở backend.

## 6. Vòng đời thiết bị

Sơ đồ đầy đủ và ví dụ từng nhánh nằm trong `Backend/docs/DEVICE_LIFECYCLE.md`. Điểm quan trọng: lifecycle (`REGISTERED`, `PROVISIONED`, `ACTIVE`, `FAULT`, `MAINTENANCE`, `DECOMMISSIONED`) là trạng thái nghiệp vụ của thiết bị; online/offline là trạng thái kết nối của Node ESP32, hai trục này độc lập. `PROVISIONED` là đã cấu hình, gán Node và ít nhất một người quản lý. Chỉ Admin chủ động gửi lệnh `lifecycle ACTIVE`; Backend chỉ ghi `ACTIVE` sau ACK thành công từ Firmware (Firmware cần `REQUIRE_ACTIVATION = 1`). Heartbeat không tự kích hoạt Device. Một Node offline không tự biến Device thành `DECOMMISSIONED`.

Bản cập nhật dùng `lifecycleChangedAt` để ghi nhận lần chuyển trạng thái và `pendingLifecycleCommandUuid/To/SentAt` để đối chiếu ACK kích hoạt. `stateChangedAt` chỉ dùng cho thay đổi đầu ra như bật/tắt bơm. Khi broker kết nối lại, Backend thử gửi lại cấu hình chưa được ACK (cùng version, firmware cần xử lý idempotent). Nếu ACK bật bơm đến muộn sau khi lifecycle rời `ACTIVE`, Backend ghi nhận ACK rồi phát lệnh tắt an toàn.

## 7. Phạm vi firmware và hợp đồng tích hợp

Source ESP32 nằm trong `firmware/`; cách build, nạp, provision credential riêng và các bài thử phần cứng nằm trong `firmware/README.md`. Firmware triển khai hợp đồng MQTT trong `Backend/docs/FIRMWARE_V12_INTEGRATION.md` cho đúng ba Device DHT11/soil/pump; không hỗ trợ FAN, OTA hay điện thoại gửi ảnh. Phải nghiệm thu trên board thật và broker TLS trước khi demo đầu-cuối.

## 8. Kiểm thử và giới hạn xác nhận

Sau khi giải nén, chạy `npm install` trong `Backend` và `Frontend`; trong Backend chạy `npm run test:security`, trong Frontend chạy `npm run build`. Gói không chứa `node_modules`. MQTT, MySQL và phần cứng thật chưa được nghiệm thu đầu-cuối trong tài liệu này; cần chạy kiểm thử với broker và ESP32 thật trước khi demo.

## Identifier generation

- `nodeCode` do Backend cấp khi Admin tạo Node. Nạp chính xác mã này qua `firmware/tools/provision.py` và dùng làm `{nodeCode}` trong topic MQTT `sf/{nodeCode}/...`.
- `deviceCode` mới có dạng `DEV-001`, `DEV-002`... theo ID tự tăng; các mã cũ được giữ nguyên; telemetry phẳng của firmware được ánh xạ qua `config.metrics`, không yêu cầu ESP32 publish `deviceCode` cho từng số đo.
- MQTT username/password là credential riêng của từng Node, không phải `nodeCode`; Backend không lưu password rõ trong MySQL. Xem `Backend/docs/mosquitto-acl.example`.


## Camera HTTP image ingestion (Cloudinary)

Camera/Agent gửi ảnh trực tiếp tới `POST /api/camera/media` bằng `multipart/form-data` (`metadata` JSON + `file`) và `Authorization: Bearer <camera-token>`. Admin cấp token một lần qua `POST /api/camera/tokens/:cameraId`; server chỉ lưu hash token. Backend gọi AI API, upload ảnh lên Cloudinary, rồi lưu kết quả AI cùng `imageUrl`, `cloudinaryPublicId`, `imageSha256` vào `leafAnalyses`. Xem `Backend/docs/CAMERA_HTTP_CLOUDINARY_FLOW.md`.

Cần cấu hình `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `AI_API_URL`, `AI_API_KEY`. Với database đã tồn tại, chạy `Backend/database/migrations/20261115_camera_http_cloudinary.sql`.

Nếu chưa cấu hình đủ AI + Cloudinary, Backend tự chuyển sang chế độ fallback: ảnh/video lưu trên đĩa (`CAMERA_IMAGE_STORAGE_DIR`) + bảng `camera_media` (migration `20261115_camera_media.sql`), xem qua `GET /api/camera/media`. Agent điện thoại nằm trong `phone-camera/`.
