# IoT Control — Hệ thống nông nghiệp thông minh

Hệ thống giám sát và điều khiển vườn trồng gồm 4 thành phần:

- **Node ESP32**: đo độ ẩm đất và nhiệt độ/độ ẩm không khí (DHT11), điều khiển bơm và quạt qua relay, gửi dữ liệu qua MQTT.
- **Camera điện thoại**: điện thoại Android chạy Termux, chụp ảnh lá định kỳ và gửi lên server qua HTTP(S).
- **Backend**: Express + MySQL + MQTT + Socket.IO. Lưu dữ liệu, sinh cảnh báo theo ngưỡng, gửi lệnh xuống Node, gọi AI chẩn đoán bệnh lá và lưu ảnh lên Cloudinary.
- **Frontend**: React + Vite. Web quản trị có dashboard realtime, quản lý Node/thiết bị/camera, cảnh báo, AI chẩn đoán, người dùng và audit log.

Giao diện chỉ hiển thị dữ liệu thật từ API, không tự sinh số liệu giả. Database trống thì các danh sách sẽ trống cho đến khi bạn tạo Node/thiết bị và hệ thống nhận được dữ liệu.

## Mục lục

1. [Kiến trúc](#1-kiến-trúc)
2. [Cấu trúc thư mục](#2-cấu-trúc-thư-mục)
3. [Yêu cầu cài đặt](#3-yêu-cầu-cài-đặt)
4. [Chạy nhanh (chỉ xem giao diện)](#4-chạy-nhanh-chỉ-xem-giao-diện)
5. [Cài đặt đầy đủ](#5-cài-đặt-đầy-đủ)
6. [Biến môi trường](#6-biến-môi-trường)
7. [Firmware ESP32](#7-firmware-esp32)
8. [Camera điện thoại](#8-camera-điện-thoại)
9. [MQTT topics](#9-mqtt-topics)
10. [API chính](#10-api-chính)
11. [Vòng đời thiết bị và cảnh báo ngưỡng](#11-vòng-đời-thiết-bị-và-cảnh-báo-ngưỡng)
12. [Kiểm thử](#12-kiểm-thử)
13. [Xử lý sự cố](#13-xử-lý-sự-cố)
14. [Tài liệu chi tiết](#14-tài-liệu-chi-tiết)
15. [Hạn chế đã biết](#15-hạn-chế-đã-biết)

## 1. Kiến trúc

```
 ┌──────────────┐  MQTT(S) sf/{nodeCode}/...   ┌─────────────────┐
 │  Node ESP32  │ ───────────────────────────▶ │                 │
 │ DHT11, đất,  │ ◀─────────── lệnh (cmd) ──── │    Mosquitto    │
 │  bơm, quạt   │                              │ (Dynamic Sec.)  │
 └──────┬───────┘                              └────────┬────────┘
        │ HTTP claim (lần đầu)                          │ MQTT
        ▼                                               ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  Backend (Express, :3000)                                    │
 │  REST /api · Socket.IO · Sequelize ── MySQL                  │
 │                         └── AI API + Cloudinary (tuỳ chọn)   │
 └──────▲─────────────────────────────────────────▲─────────────┘
        │ HTTP(S) ảnh + heartbeat                 │ /api, /socket.io
 ┌──────┴───────┐                        ┌────────┴────────┐
 │ Camera Termux│                        │ Frontend (Vite, │
 │  (Android)   │                        │      :5173)     │
 └──────────────┘                        └─────────────────┘
```

- Mỗi Node có **tài khoản MQTT và ACL riêng**. Backend tự tạo chúng trên Mosquitto Dynamic Security khi Node được claim.
- Ảnh camera **không đi qua MQTT**. Nếu đã cấu hình AI + Cloudinary, Backend gọi AI rồi lưu ảnh lên Cloudinary. Nếu chưa, ảnh được lưu trên đĩa (chế độ fallback).

## 2. Cấu trúc thư mục

```
.
├── Backend/
│   ├── server.js, app.js
│   ├── src/                  config, controllers, middlewares, models (13), routes, services
│   ├── database/
│   │   ├── smart_agri_mysql_demo.sql   schema + dữ liệu demo
│   │   ├── migrations/                 migration cho DB đã tồn tại
│   │   ├── seeds/                      danh mục bệnh cho AI classifier
│   │   └── repairs/
│   ├── scripts/              seed, setup broker local, dynsec
│   ├── docs/                 tài liệu kỹ thuật (xem mục 14)
│   └── tests/                kiểm thử node:test
├── Frontend/                 React 19 + Vite 8
├── firmware _new/firmware/   firmware ESP32 (tên thư mục có dấu cách)
│   ├── node_telemetry/       source PlatformIO / Arduino
│   ├── bin/                  file .bin dựng sẵn (v1.4.0)
│   ├── tests/                sketch test từng linh kiện
│   └── tools/                mosquitto.conf, acl, sim_backend.py
├── phone-camera/             agent Python cho Termux
└── docs/                     thiết kế camera điện thoại, báo cáo
```

## 3. Yêu cầu cài đặt

| Thành phần | Phiên bản |
|---|---|
| Node.js | ≥ 18 |
| MySQL | 8.0+ |
| Mosquitto | 2.x, có `mosquitto_ctrl` và plugin Dynamic Security (chỉ cần khi dùng ESP32 thật) |
| OpenSSL | dùng cho `npm run mqtt:setup` |
| PlatformIO hoặc Arduino IDE 2.x | để build firmware |
| Android + Termux, Termux:API | cho camera điện thoại |

## 4. Chạy nhanh (chỉ xem giao diện)

Không cần broker hay phần cứng.

```bash
# 1. Nạp schema + dữ liệu demo (tạo database `iot`)
mysql -u root -p < Backend/database/smart_agri_mysql_demo.sql

# 2. Backend
cd Backend
cp .env.example .env        # sửa DB_PASSWORD, JWT_SECRET; đặt MQTT_ENABLED=false
npm install
npm run seed                # bảo đảm có Admin, danh mục bệnh, Camera mẫu CAM-001
npm run dev                 # http://localhost:3000

# 3. Frontend (terminal khác)
cd Frontend
cp .env.example .env
npm install
npm run dev                 # http://localhost:5173
```

**Tài khoản demo** (mật khẩu chung `Demo@12345678`):

| Username | Vai trò |
|---|---|
| `admin` | Admin |
| `operator1`, `operator2` | Operator |
| `viewer1`, `viewer2` | Viewer |

> Dữ liệu demo (telemetry 24 giờ, danh mục bệnh, phác đồ, lịch sử AI, cảnh báo…) là dữ liệu giả lập, không dùng làm khuyến cáo nông nghiệp. Hãy đổi hoặc xoá tài khoản demo trước khi deploy. Giữ file `Backend/storage/analysis-images/demo-late-blight.jpg` để ảnh của bản ghi AI mẫu hiển thị được.

## 5. Cài đặt đầy đủ

### 5.1 Database

**Database mới, không dùng dữ liệu demo:** tạo database `iot`. Lệnh `npm run seed:admin` sẽ tạo các bảng còn thiếu bằng Sequelize `sync()` an toàn.

**Database đã tồn tại từ bản cũ:** backup trước, rồi chạy **những migration chưa áp dụng**, mỗi file đúng một lần, theo thứ tự:

```bash
cd Backend
mysql -u root -p iot < database/migrations/20261026_external_ai_result_images.sql
mysql -u root -p iot < database/migrations/20261027_device_probe_lifecycle.sql
mysql -u root -p iot < database/migrations/20261027_device_lifecycle_timestamp.sql
mysql -u root -p iot < database/migrations/20261027_simplify_device_evidence.sql
mysql -u root -p iot < database/migrations/20261027_firmware_v12_fan_node_restore.sql
mysql -u root -p iot < database/migrations/20261102_node_mqtt_accounts_explicit_activation.sql
mysql -u root -p iot < database/migrations/20261103_node_claim_identity.sql
mysql -u root -p iot < database/migrations/20261115_leaf_analysis_predictions.sql
mysql -u root -p iot < database/migrations/20261115_camera_http_cloudinary.sql
mysql -u root -p iot < database/migrations/20261115_camera_media.sql
mysql -u root -p iot < database/migrations/20261117_user_upload_analysis_history.sql
```

Schema trong `smart_agri_mysql_demo.sql` đã có sẵn các cột này. Không dùng `DB_SYNC=force` với database cần giữ dữ liệu. Chi tiết xem `Backend/database/README_DEMO_SQL.md`.

### 5.2 Backend

```bash
cd Backend
cp .env.example .env
npm install
npm run seed:admin      # tạo Admin đầu tiên từ BOOTSTRAP_ADMIN_* (mật khẩu ≥ 12 ký tự)
npm run seed            # tuỳ chọn: thêm danh mục bệnh cho AI classifier + Camera CAM-001
npm run dev
```

`seed:admin` chỉ tạo Admin khi chưa có Admin nào. Hệ thống không có đăng ký công khai: Admin tạo tài khoản Operator/Viewer ở trang **Người dùng**.

| Script | Tác dụng |
|---|---|
| `npm run dev` | Chạy Backend, tự reload khi sửa code (`node --watch`) |
| `npm start` | Chạy Backend (production) |
| `npm run seed:admin` | Tạo bảng còn thiếu + Admin đầu tiên |
| `npm run seed` | Admin + danh mục bệnh + Camera mẫu |
| `npm run mqtt:setup` | Dựng broker Mosquitto TLS local trong `Backend/.mqtt/` |
| `npm run mqtt:start` | Chạy broker local ở chế độ nền |
| `npm run test:security` | Chạy bộ kiểm thử |

### 5.3 Broker MQTT (cần khi dùng ESP32 thật)

Backend cần **Mosquitto 2.x có Dynamic Security** để tạo tài khoản và ACL riêng cho từng Node. Broker công cộng hoặc broker cloud không cấp quyền quản trị này nên **không dùng được**.

**Cách 1: broker riêng cho dự án (khuyên dùng khi phát triển)**

```bash
cd Backend
npm run mqtt:setup        # tạo CA + cert theo IP LAN, broker TLS :8883, tài khoản backend/admin, cập nhật .env
npm run mqtt:start        # mỗi lần khởi động lại máy, chạy trước `npm run dev`
```

Để chọn IP/cổng: `MQTT_DEV_HOST=192.168.1.10 MQTT_DEV_PORT=8883 npm run mqtt:setup`. Khi IP LAN thay đổi, phải chạy lại để cấp lại chứng chỉ, nên đặt IP tĩnh hoặc DHCP reservation cho máy. Chi tiết: `Backend/docs/LOCAL_MQTT_TLS.md`.

**Cách 2: Mosquitto hệ thống (systemd)**

```bash
sudo bash Backend/scripts/enable-system-dynsec.sh     # bật plugin, tạo admin + tài khoản Backend từ .env
node Backend/scripts/ensure-backend-mqtt-account.js   # tạo/cập nhật lại tài khoản Backend
node Backend/scripts/diagnose-mqtt-dynsec.js          # kiểm tra kết nối và quyền dynsec
```

Sau đó đặt `MQTT_DYNSEC_ENABLED=true` trong `Backend/.env`. Mẫu cấu hình: `Backend/docs/mosquitto-dynsec.conf.example`, `Backend/docs/mosquitto-acl.example`.

> Khi `MQTT_DYNSEC_ENABLED=false`, Backend vẫn nhận và hiển thị dữ liệu, nhưng **không tạo hay claim Node mới được**.

### 5.4 Frontend

```bash
cd Frontend
cp .env.example .env
npm install
npm run dev        # dev server :5173
npm run build      # build production ra dist/
npm run lint       # oxlint
```

Khi chạy dev, Vite proxy `/api` và `/socket.io` tới `VITE_BACKEND_ORIGIN` (mặc định `http://localhost:3000`).

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `VITE_BACKEND_ORIGIN` | `http://localhost:3000` | Đích proxy của Vite dev server |
| `VITE_API_URL` | `/api` | URL API. Khi deploy khác domain, đặt URL đầy đủ, ví dụ `https://api.example.com/api` |
| `VITE_SOCKET_URL` | (trống) | Origin Socket.IO. Trống = dùng cùng origin |

## 6. Biến môi trường

Sao chép `Backend/.env.example` thành `Backend/.env`. Không commit file `.env`.

**Server, database, xác thực**

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `NODE_ENV` | `development` | `production` sẽ bật bắt buộc TLS cho claim |
| `PORT` | `3000` | Cổng Backend |
| `CORS_ORIGIN` | `*` | Origin được phép. Khi deploy, đặt domain cụ thể |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | `localhost`, `3306`, `iot`, `root` | Kết nối MySQL |
| `DB_SYNC` | `safe` | `safe` chỉ tạo bảng thiếu. Không dùng `force` |
| `JWT_SECRET` | — | **Bắt buộc đổi** thành chuỗi ngẫu nhiên dài |
| `JWT_EXPIRES_IN` | `8h` | Thời hạn token |
| `BOOTSTRAP_ADMIN_USERNAME`, `_EMAIL`, `_FULL_NAME`, `_PASSWORD` | — | Admin đầu tiên cho `seed:admin` (mật khẩu ≥ 12 ký tự) |

**MQTT**

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `MQTT_ENABLED` | `true` | `false` để chạy chỉ có UI, không cần broker |
| `MQTT_URL` | `mqtt://localhost:1883` | Broker mà Backend kết nối |
| `MQTT_DEVICE_URL` | (trống = `MQTT_URL`) | Địa chỉ broker trả về cho ESP32. ESP32 phải truy cập được, ví dụ `mqtts://192.168.1.10:8883` |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | — | Tài khoản MQTT của Backend |
| `MQTT_CA_FILE` | (trống) | CA của broker, ví dụ `.mqtt/ca.crt`. Đường dẫn tương đối tính từ thư mục `Backend` |
| `MQTT_FIRMWARE_TOPIC_PREFIX` | `sf` | Prefix topic của firmware |
| `MQTT_TOPIC_PREFIX` | `iot` | Prefix topic AI cũ (`iot/ai/result`) |
| `MQTT_DYNSEC_ENABLED` | `false` | Bật Dynamic Security (bắt buộc để tạo/claim Node) |
| `MQTT_DYNSEC_ADMIN_USERNAME`, `MQTT_DYNSEC_ADMIN_PASSWORD` | — | Tài khoản quản trị dynsec |
| `MQTT_DYNSEC_REQUEST_TIMEOUT_MS` | `8000` | Timeout lệnh dynsec |
| `CLAIM_REQUIRE_TLS` | `true` khi production | Bắt buộc HTTPS cho claim và `mqtts://` cho thiết bị. Chỉ đặt `false` trong LAN phát triển |
| `CLAIM_TRUSTED_PROXY_IPS` | (trống) | IP reverse proxy được tin là đã terminate HTTPS |
| `HEARTBEAT_SWEEP_SEC` | `10` | Chu kỳ quét Node offline |
| `COMMAND_ACK_TIMEOUT_SEC` | `15` | Thời gian chờ ACK lệnh |
| `DEVICE_PROBE_TIMEOUT_SEC` | `8` | Chỉ dùng cho firmware đời cũ |

**AI, camera, Cloudinary, cảnh báo**

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `AI_API_URL`, `AI_API_KEY` | (trống) | API chẩn đoán bệnh lá |
| `AI_REQUEST_TIMEOUT_MS` | `60000` | Timeout gọi AI |
| `AI_MIN_CONFIDENCE` | `0.5` | Ngưỡng tin cậy tối thiểu (0–1) |
| `AI_IMAGE_MAX_BYTES` | `5242880` | Kích thước ảnh tối đa khi người dùng upload để chẩn đoán |
| `AI_IMAGE_STORAGE_DIR` | `storage/analysis-images` | Thư mục ảnh AI trên đĩa |
| `CLOUDINARY_CLOUD_NAME`, `_API_KEY`, `_API_SECRET` | (trống) | Lưu ảnh camera lên Cloudinary |
| `CLOUDINARY_FOLDER` | `smart-agri/camera-media` | Thư mục trên Cloudinary |
| `CAMERA_IMAGE_MAX_BYTES` | `10485760` | Kích thước media tối đa từ điện thoại (JPEG/PNG/WebP/MP4) |
| `CAMERA_IMAGE_STORAGE_DIR` | `storage/camera-media` | Thư mục lưu media ở chế độ fallback |
| `SENSOR_THRESHOLD_RULES_JSON` | (trống) | Ghi đè ngưỡng cảnh báo (xem mục 11) |

> Nếu thiếu `AI_*` hoặc `CLOUDINARY_*`, Backend tự chuyển sang chế độ fallback: lưu ảnh/video trên đĩa vào bảng `camera_media`, không gọi AI.

## 7. Firmware ESP32

Source nằm ở `firmware _new/firmware/node_telemetry/` (FW **1.5.0**). Hướng dẫn chi tiết, lịch sử thay đổi và bài test phần cứng: `firmware _new/firmware/README.md`.

**Phần cứng và chân GPIO**

| Thiết bị | GPIO | Metric / loại trên web |
|---|---|---|
| Cảm biến độ ẩm đất (loại điện trở) | 34 | `SOIL_MOISTURE` |
| DHT11 | 4 | `AIR_TEMPERATURE`, `AIR_HUMIDITY` |
| Relay bơm 12V | 26 | `PUMP` |
| Relay quạt | 27 | `FAN` |

**Build và nạp**

```bash
cd "firmware _new/firmware/node_telemetry"
pio run -t upload        # build + nạp (board esp32dev)
pio device monitor       # Serial 115200
```

Hoặc nạp file dựng sẵn (lưu ý: bản **v1.4.0**, chưa có tính năng tự claim của 1.5.0):

```bash
esptool.py --chip esp32 --baud 460800 write_flash 0x0 "firmware _new/firmware/bin/farmcare_node_telemetry_v1.4.0_full.bin"
```

**Đưa Node vào hệ thống (claim)**

1. Mở Serial 115200. Dòng `[BOOT] FW 1.5.0 | MAC ...` cho biết địa chỉ MAC của bo mạch.
2. Trên web (Admin) → **Node**: tạo Node với đúng MAC đó, đăng ký đủ thiết bị theo bảng GPIO ở trên. Web hiện **claim token**: chỉ hiện một lần, hạn 30 phút.
3. Nhập token vào ESP32 bằng một trong hai cách:
   - Kết nối điện thoại vào WiFi `SF-TELE-xxxx` (mật khẩu `12345678`), chọn WiFi vườn, nhập **Backend URL** (ví dụ `http://192.168.1.10:3000`) và **Claim token**.
   - Hoặc gõ trên Serial: `api http://192.168.1.10:3000`, rồi `claim <token>`.
4. ESP32 gọi `POST /api/provisioning/claim` để nhận `nodeCode` và tài khoản MQTT riêng, lưu vào flash và kết nối broker.
5. Trên web: cấu hình từng thiết bị, gán người quản lý (thiết bị chuyển sang **PROVISIONED**), bấm **Kích hoạt**. Thiết bị chỉ thành **ACTIVE** sau khi Node gửi ACK.

Lệnh Serial hữu ích: `help`, `prov`, `prov clear`, `claim retry`, `portal`, `dev`, `factory_reset`.

> **Broker TLS (`mqtts://`, cổng 8883):** đặt CA của broker vào `node_telemetry/node_telemetry/tls_ca.h` rồi build lại. Hiện file chứa CA tự ký do `npm run mqtt:setup` tạo. Firmware dùng **cùng một CA** cho HTTPS claim và MQTTS.

## 8. Camera điện thoại

Agent Python chạy trên Termux, nằm trong `phone-camera/`. Hướng dẫn đầy đủ: `phone-camera/README.md`.

1. Trên web (Admin) → **Camera** → **Thêm Camera** (server sinh mã, ví dụ `CAM-001`) → **Cấp token**. Ở ô địa chỉ server, nhập `http://<IP-LAN>:3000`, không dùng `localhost` và không dùng cổng 5173.
2. Chép thư mục `phone-camera` vào `~/phone-camera` trên điện thoại, rồi:

```sh
cd ~/phone-camera
bash scripts/install_termux.sh                                   # lần đầu
bash scripts/set_server.sh http://192.168.1.10:3000 <token> CAM-001
python camera_agent.py --check-heartbeat                         # web hiện "Trực tuyến"
python camera_agent.py --check-upload                            # chụp + gửi thử 1 ảnh
./scripts/run_camera.sh                                          # chạy liên tục
```

Có thể dùng `scripts/termux-boot-camera.sh` với Termux:Boot để agent tự chạy khi điện thoại khởi động. Agent có hàng chờ offline (SQLite), tự retry với backoff và idempotent theo `eventId`.

## 9. MQTT topics

Prefix mặc định `sf` (`MQTT_FIRMWARE_TOPIC_PREFIX`). Hợp đồng đầy đủ: `Backend/docs/FIRMWARE_V12_INTEGRATION.md`.

| Hướng | Topic | Nội dung |
|---|---|---|
| Node → Backend | `sf/{nodeCode}/telemetry` | Dữ liệu dạng phẳng: `seq, bc, up, ts, soilMoisture, temperature, humidity, pumpOn, fanOn` |
| Node → Backend | `sf/{nodeCode}/telemetry/backfill` | Gửi bù dữ liệu khi mất mạng |
| Node → Backend | `sf/{nodeCode}/heartbeat` | `firmwareVersion`, `bc`, `up`, `faults`… |
| Node → Backend | `sf/{nodeCode}/status` | `online` (retained), LWT `offline`, sự kiện, lỗi thiết bị |
| Node → Backend | `sf/{nodeCode}/cmd/ack`, `config/ack` | ACK lệnh / cấu hình |
| Backend → Node | `sf/{nodeCode}/cmd` | `action`: `pump`, `fan`, `config`, `lifecycle`, `pump_unlock`, `get_status`, `reboot`, `reset_wifi`, `factory_reset` |
| AI → Backend | `iot/ai/result` | Kết quả AI qua MQTT (luồng cũ) |

Nếu đổi prefix, phải sửa ACL tương ứng.

## 10. API chính

Tất cả nằm dưới `/api`, xác thực bằng `Authorization: Bearer <JWT>` (riêng camera dùng camera token).

| Prefix | Chức năng |
|---|---|
| `/auth` | Đăng nhập (`POST /login`), thông tin phiên (`GET /me`) |
| `/users` | Quản lý người dùng, phân quyền, gán thiết bị |
| `/nodes` | Tạo Node, cấp claim token, cấp lại mật khẩu MQTT, thu hồi/khôi phục |
| `/provisioning` | `POST /claim`: ESP32 tự claim |
| `/devices` | Thiết bị, cấu hình, điều khiển bơm/quạt, vòng đời |
| `/readings` | Telemetry |
| `/alerts` | Cảnh báo: lọc, xác nhận, xử lý |
| `/analyses` | Lịch sử AI; `POST /predict` để người dùng tải ảnh lên chẩn đoán |
| `/camera` | Đăng ký camera, cấp/thu hồi token, `POST /media`, `POST /heartbeat`, lệnh chụp |
| `/dashboard` | Số liệu tổng hợp cho dashboard |
| `/audit-logs` | Nhật ký thao tác (chỉ Admin) |
| `/diseases`, `/treatments` | Danh mục bệnh và phác đồ điều trị |

Sự kiện Socket.IO: `reading`, `alert:new`, `alert:update`, `device:update`, `analysis:new`, `node:status`.

**Vai trò:** `admin` có toàn quyền; `operator` điều khiển các thiết bị được gán; `viewer` chỉ xem. Quyền luôn được kiểm tra ở Backend; việc ẩn trang ở frontend chỉ để giao diện gọn hơn.

## 11. Vòng đời thiết bị và cảnh báo ngưỡng

**Vòng đời** (`REGISTERED` → `PROVISIONED` → `ACTIVE` → `FAULT` / `MAINTENANCE` / `DECOMMISSIONED`) là trạng thái nghiệp vụ, độc lập với online/offline của Node.

- `PROVISIONED`: đã cấu hình, đã gán Node và có ít nhất một người quản lý.
- `ACTIVE`: chỉ được ghi sau khi firmware ACK lệnh kích hoạt. Heartbeat không tự kích hoạt thiết bị.
- Node offline không làm thiết bị chuyển sang `DECOMMISSIONED`.

Chi tiết: `Backend/docs/DEVICE_LIFECYCLE.md`.

**Ngưỡng cảnh báo mặc định** (có hysteresis để cảnh báo không bật/tắt liên tục):

| Metric | Thấp (phục hồi) | Cao (phục hồi) |
|---|---|---|
| `SOIL_MOISTURE` | < 25% (≥ 30%) | > 85% (≤ 80%) |
| `AIR_TEMPERATURE` | < 5°C (≥ 8°C) | > 38°C (≤ 35°C); từ 40°C là CRITICAL |
| `AIR_HUMIDITY` | < 25% (≥ 30%) | > 90% (≤ 85%) |

Ghi đè ngưỡng bằng `SENSOR_THRESHOLD_RULES_JSON`, ví dụ `{"SOIL_MOISTURE":{"low":20,"lowRecovery":28,"high":88,"highRecovery":82}}`, hoặc bằng `config.alertThresholds` của từng thiết bị. Chỉ telemetry mới của cảm biến `ACTIVE` được đánh giá; dữ liệu backfill không tạo cảnh báo hồi tố.

**Định danh:** `nodeCode` do Backend cấp khi claim; `deviceCode` có dạng `DEV-001`, `DEV-002`…; camera có dạng `CAM-001`. Backend không lưu mật khẩu MQTT dạng rõ. Xem `Backend/docs/AUTO_IDENTIFIER_GENERATION.md`.

## 12. Kiểm thử

```bash
cd Backend && npm run test:security     # 15 file test (node:test): MQTT TLS, ACL, dynsec, claim, camera, AI…
cd Frontend && npm run build && npm run lint
cd phone-camera && python -m unittest discover tests
```

Kiểm thử firmware không cần Backend: `python "firmware _new/firmware/tools/sim_backend.py" --setup NODE-01`, hoặc dùng các sketch trong `firmware _new/firmware/tests/`.

## 13. Xử lý sự cố

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Không tạo hay claim được Node | `MQTT_DYNSEC_ENABLED=false` hoặc broker không có Dynamic Security. Chạy `node Backend/scripts/diagnose-mqtt-dynsec.js` |
| ESP32 báo `[PROV] HTTP 4xx MA_LOI` | Xem bảng mã lỗi trong `Backend/docs/DEVICE_CLAIM_LIFECYCLE.md`. Token hết hạn hoặc sai MAC thì cấp lại token |
| ESP32 không kết nối được MQTTS | `tls_ca.h` không khớp CA của broker, hoặc IP LAN đã đổi nên cert không còn đúng (chạy lại `mqtt:setup`) |
| Claim qua `http://` bị từ chối | `CLAIM_REQUIRE_TLS` đang bật. Trong LAN phát triển, đặt `CLAIM_REQUIRE_TLS=false` |
| Camera curl tới `/api/camera/heartbeat` bị treo | Điện thoại không cùng WiFi với máy, sai IP, hoặc firewall chặn cổng 3000 (`sudo ufw allow 3000/tcp`) |
| Camera nhận `403 CAMERA_NOT_ACCEPTING` | Camera đang ở trạng thái `MAINTENANCE`/`FAULT`; agent giữ ảnh và sẽ gửi bù khi kích hoạt lại |
| Ảnh không có kết quả AI | Thiếu `AI_*`/`CLOUDINARY_*` nên Backend đang ở chế độ fallback lưu đĩa |
| Node demo từ SQL không kết nối được | Các Node demo chưa có tài khoản trên broker. Cấp lại claim token trong trang Node |

Khôi phục khi dynsec bị lệch: `Backend/docs/MQTT_DYNSEC_SYSTEM_RECOVERY.md`.

## 14. Tài liệu chi tiết

| Tài liệu | Nội dung |
|---|---|
| `Backend/docs/FIRMWARE_V12_INTEGRATION.md` | Hợp đồng MQTT giữa firmware và Backend |
| `Backend/docs/DEVICE_CLAIM_LIFECYCLE.md` | Luồng claim Node, mã lỗi |
| `Backend/docs/DEVICE_LIFECYCLE.md` | Vòng đời thiết bị |
| `Backend/docs/NODE_REVOKE_AND_OFFLINE_SYNC.md` | Thu hồi Node, đồng bộ offline |
| `Backend/docs/LOCAL_MQTT_TLS.md` | Dựng broker TLS local |
| `Backend/docs/MQTT_DYNSEC_SYSTEM_RECOVERY.md` | Khôi phục Dynamic Security |
| `Backend/docs/CAMERA_HTTP_CLOUDINARY_FLOW.md` | Luồng ảnh camera → AI → Cloudinary |
| `Backend/docs/AUTO_IDENTIFIER_GENERATION.md` | Quy tắc sinh mã |
| `Backend/docs/DEVICE_PROBE_FLOW.md` | Luồng probe (chỉ firmware đời cũ) |
| `Backend/database/README_DEMO_SQL.md` | Dữ liệu demo và migration camera |
| `firmware _new/firmware/README.md` | Firmware: nạp, claim, lịch sử phiên bản |
| `phone-camera/README.md` | Camera điện thoại: cài đặt, contract HTTP |
| `docs/SMARTPHONE_CAMERA_NODE_DESIGN.md` | Thiết kế camera node |

## 15. Hạn chế đã biết

- File `.bin` dựng sẵn là v1.4.0. Muốn dùng tính năng tự claim thì phải build lại để có v1.5.0.
- Chưa hỗ trợ OTA firmware.
- JWT không bị thu hồi khi đổi mật khẩu hoặc đổi vai trò; token cũ còn dùng được đến khi hết hạn, nhưng trạng thái tài khoản và quyền vẫn được kiểm tra ở Backend.
- Chỉ hỗ trợ broker Mosquitto có Dynamic Security, không dùng được broker cloud (EMQX Cloud, HiveMQ Cloud…).
- Hệ thống chưa được nghiệm thu đầu-cuối đầy đủ với broker TLS và board thật. Cần chạy thử trước khi demo.
