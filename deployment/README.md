# Docker Deployment - IoT Smart Agriculture

Thư mục này triển khai hệ thống trên một máy Docker trong mạng LAN: MySQL 8, Mosquitto 2.x + Dynamic Security, Backend Node.js/Express/Socket.IO và Frontend React/Nginx.

> **Phạm vi bảo mật:** cấu hình mặc định dùng HTTP và MQTT TCP không mã hóa (`1883`), chỉ dành cho mạng LAN đáng tin cậy. Không port-forward các cổng này ra Internet. Muốn triển khai Internet phải bổ sung HTTPS/MQTTS, chứng chỉ TLS và đặt `CLAIM_REQUIRE_TLS=true`.

## 1. Cài Docker

### Windows 10/11

1. Bật CPU virtualization trong BIOS/UEFI và cài/cập nhật WSL 2 (mở PowerShell với quyền phù hợp, chạy `wsl --install`, sau đó `wsl --update` nếu máy chưa có WSL 2).
2. Tải Docker Desktop từ [trang cài đặt chính thức cho Windows](https://docs.docker.com/desktop/setup/install/windows-install/).
3. Chạy `Docker Desktop Installer.exe`; chọn WSL 2 backend (lựa chọn mặc định được khuyến nghị cho đa số máy), hoàn tất wizard và mở Docker Desktop.
4. Chờ trạng thái Docker Engine chuyển sang Running.

### macOS

Tải bản phù hợp chip Apple Silicon hoặc Intel từ [trang cài đặt chính thức cho Mac](https://docs.docker.com/desktop/setup/install/mac-install/), mở file `.dmg`, kéo Docker vào Applications rồi mở Docker Desktop.

### Linux

Docker Desktop trên Linux yêu cầu môi trường desktop và KVM. Thực hiện theo [hướng dẫn chính thức cho Linux](https://docs.docker.com/desktop/setup/install/linux/). Với máy chủ Linux không có desktop, cài Docker Engine và Docker Compose plugin theo tài liệu Docker thay vì Docker Desktop.

### Xác minh cài đặt

Mở Terminal/PowerShell và chạy:

```bash
docker version
docker compose version
docker run --rm hello-world
```

Ba lệnh cần chạy thành công trước khi triển khai repository. Docker Desktop đã tích hợp Docker Engine, CLI, Buildx và Compose; xem [Quick install Docker Desktop](https://docs.docker.com/get-docker/desktop/).

## 2. Yêu cầu máy triển khai

- Khuyến nghị tối thiểu 4 GB RAM; Windows cần đáp ứng yêu cầu hệ thống/WSL 2 của Docker Desktop.
- Máy chạy Docker có IP LAN cố định hoặc DHCP reservation để ESP32/Camera Agent luôn tìm được Backend và MQTT Broker.
- Node.js không cần cài trên máy host để chạy hệ thống; Node/npm chỉ cần nếu phát triển hoặc build thủ công ngoài Docker.

## 3. Tạo cấu hình môi trường

Tại thư mục gốc repository:

```bash
cd deployment
cp .env.example .env
```

Mở `deployment/.env` và thay tất cả giá trị `CHANGE_ME_*` bằng secret riêng. Có thể sinh chuỗi ngẫu nhiên bằng:

```bash
openssl rand -hex 32
```

Chạy lệnh trên nhiều lần để tạo các giá trị độc lập cho `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `JWT_SECRET`, `MQTT_BACKEND_PASSWORD` và `MQTT_DYNSEC_ADMIN_PASSWORD`. Không dùng chung một mật khẩu cho nhiều dịch vụ.

Cấu hình quan trọng:

| Biến | Ý nghĩa |
|---|---|
| `MYSQL_PASSWORD` | Mật khẩu user ứng dụng MySQL `iot_app` |
| `MYSQL_ROOT_PASSWORD` | Mật khẩu root MySQL |
| `JWT_SECRET` | Secret ký JWT của Backend |
| `MQTT_BACKEND_PASSWORD` | Tài khoản MQTT dành riêng cho Backend |
| `MQTT_DYNSEC_ADMIN_PASSWORD` | Tài khoản quản trị Mosquitto Dynamic Security |
| `MQTT_DEVICE_URL` | URL broker mà ESP32/Camera Agent truy cập được, ví dụ `mqtt://192.168.1.100:1883` |
| `HTTP_PORT` | Cổng truy cập Dashboard trên máy host, mặc định `8080` |

Thay `192.168.1.100` bằng IP LAN thực tế của máy chạy Docker. Không đặt `MQTT_DEVICE_URL=mqtt://mosquitto:1883`: hostname này chỉ phân giải bên trong Docker network.

`deployment/.env` được `.gitignore` bỏ qua. Không đưa file này vào ZIP chia sẻ hoặc commit lên Git.

## 4. Khởi tạo Database và chạy hệ thống lần đầu

Từ thư mục `deployment/`:

```bash
docker compose config
docker compose up -d --build
```

Compose sẽ thực hiện theo thứ tự phụ thuộc:

1. MySQL 8 khởi tạo volume và thực thi `database/01_create_tables.sql`, sau đó `database/02_seed_data.sql`.
2. Service `mosquitto-dynsec-init` tạo `dynamic-security.json` và tài khoản quản trị lần đầu nếu volume Dynamic Security còn trống.
3. Mosquitto khởi động với plugin Dynamic Security.
4. `mqtt-bootstrap` gọi script chính thức có sẵn `Backend/scripts/ensure-backend-mqtt-account.js` để tạo/cập nhật role ACL và tài khoản MQTT Backend.
5. Backend đợi MySQL khỏe và MQTT bootstrap hoàn tất; Backend chạy với `DB_SYNC=none`, không tự ý sửa schema SQL.
6. Frontend được build bằng Vite và Nginx phục vụ giao diện, proxy REST API và Socket.IO về Backend.

Mở Dashboard:

- Trên máy chạy Docker: `http://localhost:8080`
- Từ thiết bị khác trong LAN: `http://<LAN_IP_MAY_DOCKER>:8080`
- Health qua Nginx: `http://<LAN_IP_MAY_DOCKER>:8080/health`

Backend healthcheck nội bộ: `http://backend:3000/health` trong Docker network.

### Tài khoản demo

| Vai trò | Username | Password demo |
|---|---|---|
| Admin | `admin` | `demo@12345678` |
| Operator | `  ` | `Operator@IoT-SmartAgri-2026-Local!` |
| Viewer | `viewer` | `Viewer@IoT-SmartAgri-2026-Local!` |

Password trong SQL chỉ được lưu dưới dạng BCrypt hash. Đây là tài khoản demo công khai, phải đổi password ngay sau khi đăng nhập và trước khi dùng ngoài môi trường thử nghiệm.

## 5. Lưu ý quan trọng về Node và Device demo

`02_seed_data.sql` tạo một Node mẫu `NODE-DEMO-001` với MAC placeholder `02:00:00:00:00:01`, trạng thái offline, chưa claim, không có claim token, không có MQTT username/role và không có heartbeat. Các Device demo ở lifecycle `REGISTERED`; chúng chưa được xác minh bằng phần cứng/ACK. Đây là dữ liệu minh họa giao diện và quan hệ database, **không phải cấu hình sẵn sàng điều khiển ESP32 thật**.

Inventory demo phản ánh định nghĩa trong Firmware/Backend hiện tại: SENSOR GPIO34 có metric `SOIL_MOISTURE`; SENSOR GPIO4 có `AIR_TEMPERATURE` và `AIR_HUMIDITY`; PUMP GPIO26; FAN GPIO27 là slot quạt tùy chọn được Firmware v1.4 hỗ trợ. Trước khi cấp claim cho bo mạch thật:

1. Tạo Node mới qua chức năng/API quản lý Node và nhập MAC Address thật của ESP32; không dùng MAC placeholder.
2. Khai báo inventory Device đúng theo Firmware đang nạp trên bo mạch.
3. Dùng quy trình claim/provisioning của Backend để tạo token và tài khoản MQTT riêng cho Node.
4. Chỉ coi Node/Device là sẵn sàng sau khi nhận claim, heartbeat và ACK thực tế.

Không tự ghi MQTT credentials hoặc claim token vào SQL. Không sửa trực tiếp Node demo để biến nó thành Node thật nếu chưa kiểm tra các ràng buộc unique và inventory.

## 6. Kết nối ESP32 và Camera Agent trong LAN

- Dashboard/Backend HTTP: `http://<LAN_IP_MAY_DOCKER>:8080`
- MQTT từ ESP32: `mqtt://<LAN_IP_MAY_DOCKER>:1883`
- Backend bên trong Docker: `mqtt://mosquitto:1883` (đã cấu hình sẵn, không dùng URL này ở ESP32).
- `MQTT_DEVICE_URL` trong `.env` phải trỏ tới địa chỉ broker LAN; Backend trả URL này trong quy trình cấp thông tin kết nối cho Node.
- Camera Agent chạy trên máy/điện thoại khác phải dùng URL HTTP LAN của Backend, không dùng `localhost` hoặc hostname service Docker.

Firmware hiện dùng namespace topic `sf/<nodeCode>/...`, gồm telemetry, telemetry/backfill, heartbeat, status, command ACK, config ACK và probe ACK. Broker ACL được tạo bởi script Backend hiện có; không cấp quyền wildcard toàn cục cho từng Node.

Mở firewall máy host cho TCP `8080` và `1883` từ subnet LAN cần dùng. Giữ MySQL host port `3307` chỉ bind `127.0.0.1`; không mở MySQL ra LAN nếu không có nhu cầu quản trị an toàn.

## 7. Xem trạng thái và logs

Từ `deployment/`:

```bash
docker compose ps
docker compose logs -f mysql
docker compose logs -f mosquitto
docker compose logs -f mqtt-bootstrap
docker compose logs -f backend
docker compose logs -f frontend
```

Kiểm tra trực tiếp health:

```bash
curl http://localhost:8080/health
```

Nếu MQTT bootstrap lỗi, kiểm tra `MQTT_DYNSEC_ADMIN_USERNAME`, `MQTT_DYNSEC_ADMIN_PASSWORD`, logs Mosquitto và đảm bảo plugin Dynamic Security đã nạp thành công. Không xóa `mosquitto-data` chỉ để xử lý một lỗi khởi động thông thường.

## 8. Dừng, khởi động lại và reset

Dừng container nhưng giữ dữ liệu:

```bash
docker compose down
```

Khởi động lại:

```bash
docker compose up -d
```

**Xóa toàn bộ dữ liệu database, Dynamic Security và backend storage (không thể khôi phục nếu chưa backup):**

```bash
docker compose down -v
```

Chỉ chạy `down -v` khi chủ động muốn khởi tạo lại từ đầu. Các file SQL trong `/docker-entrypoint-initdb.d/` chỉ được MySQL image thực thi tự động khi data directory của MySQL còn rỗng. Sửa SQL rồi `docker compose restart` không làm seed/schema chạy lại trên volume đã có dữ liệu.

## 9. Backup và restore MySQL

Backup:

```bash
docker compose exec -T mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers "$MYSQL_DATABASE"' > iot-backup.sql
```

Restore vào database đã được tạo:

```bash
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < iot-backup.sql
```

Giữ file backup ở nơi bảo mật. Backup SQL không bao gồm file ảnh local trong volume `backend-storage` hoặc trạng thái Dynamic Security trong `mosquitto-data`; cần backup các volume này riêng nếu muốn khôi phục toàn bộ hệ thống.

## 10. Thành phần và persistence

| Service | Image / build | Persistence |
|---|---|---|
| `mysql` | `mysql:8.0` | `mysql-data` |
| `mosquitto-dynsec-init` | `eclipse-mosquitto:2.1.2` (init one-shot) | ghi vào `mosquitto-data` |
| `mosquitto` | `eclipse-mosquitto:2.1.2` | `mosquitto-data` |
| `mqtt-bootstrap` | Backend image (one-shot) | không lưu state riêng |
| `backend` | `deployment/Dockerfile.backend` | `backend-storage` |
| `frontend` | `deployment/Dockerfile.frontend` + Nginx | static bundle trong image |

SQL schema được sinh từ Sequelize Models/Associations hiện tại. Các bảng Disease/Treatment/Deficiency không được tạo; `leafAnalyses.diseaseName` được giữ nguyên vì source Backend đang dùng nó như chuỗi nhãn đầu ra AI, không phải khóa ngoại tới danh mục bệnh.
