# Smartphone camera node for Termux (HTTPS upload)

Biến một điện thoại Android thành camera node: chụp ảnh bằng `termux-camera-photo`
(Termux:API), lưu tạm vào hàng chờ SQLite và **upload lên server qua HTTPS**.
Trạng thái online được báo bằng **heartbeat HTTPS** (`POST /api/camera/heartbeat`, cùng token).
MQTT là tuỳ chọn, chỉ dùng cho lệnh chụp theo yêu cầu và status — ảnh không bao giờ đi qua MQTT.

## Vòng đời Camera trên server

| Lifecycle | Khi nào | Upload |
|---|---|---|
| `REGISTERED` | Admin tạo Camera (trang **Camera** trên web) | — (chưa có token) |
| `PROVISIONED` | Admin cấp token | Nhận |
| `ACTIVE` | Tự động ở heartbeat/upload hợp lệ đầu tiên | Nhận |
| `FAULT` / `MAINTENANCE` | Admin chuyển tay | **Tạm dừng**: server trả `403 CAMERA_NOT_ACCEPTING`, agent giữ ảnh trong hàng chờ |
| `DECOMMISSIONED` | Admin ngừng sử dụng (token bị thu hồi) | Chặn |

Online/offline: server coi Camera online nếu nhận request hợp lệ trong
`max(90s, 3 × heartbeat_interval_seconds)`. Camera `ACTIVE` mất heartbeat sẽ sinh cảnh báo
`offline`, tự đóng khi Camera kết nối lại. Thu hồi token → Camera quay về `REGISTERED`.

## Tính năng

- Chụp định kỳ (`capture.interval_seconds`), thu nhỏ ảnh bằng ffmpeg (`capture.resize_max_width`).
- Upload HTTPS multipart, `Authorization: Bearer <token>`, xác thực chứng chỉ TLS
  (hỗ trợ CA tự ký qua `upload.ca_file`), không tự follow redirect.
- Mất mạng → ảnh nằm trong hàng chờ, retry với exponential backoff (5s → 300s),
  tôn trọng `Retry-After`. Ảnh chỉ bị xoá khi server xác nhận `stored`/`duplicate`.
- Giới hạn hàng chờ (`storage.max_queue_items`) để không đầy bộ nhớ khi offline lâu.
- Heartbeat HTTPS mỗi `heartbeat_interval_seconds` (server có thể ghi đè), gửi kèm số ảnh
  đang chờ và lỗi upload gần nhất; khi server báo `acceptingUploads: false` thì tạm dừng upload.
- (Tuỳ chọn, MQTT) lệnh `capture` / `record_video` (timelapse MP4).

## Contract HTTPS mà backend phải triển khai

```
POST {upload.url}                      ví dụ https://api.example.org/api/camera/media
Authorization: Bearer {upload.token}
Idempotency-Key: {eventId}
X-Camera-Id: {cameraId}
X-Content-SHA256: {sha256 hex}
Content-Type: multipart/form-data
  part "metadata" (application/json):
    {"schemaVersion":2,"cameraId":"CAM-001","eventId":"CAM-001-1794640413-41e355003cc2",
     "requestId":null,"mediaType":"image","mimeType":"image/jpeg",
     "capturedAt":"2026-11-14T07:13:33.120Z","sizeBytes":812345,"sha256":"…","agentVersion":"0.3.0"}
  part "file" (image/jpeg | video/mp4): nội dung ảnh/video
```

Phản hồi server và cách agent xử lý:

| Server trả về | Agent làm gì |
|---|---|
| `2xx` `{"status":"stored"}` hoặc `{"status":"duplicate"}` (có thể kèm `sha256`) | Xoá file local |
| `2xx` có `sha256` khác với file | Gửi lại |
| `400`, `409`, `413`, `415`, `422` (`{"reason":"…"}`) | Đánh dấu `rejected`, giữ file, không gửi lại |
| `401`, `403`, `404`, `408`, `429`, `5xx`, lỗi mạng/TLS, `3xx` | Giữ trong hàng chờ, retry có backoff |

Heartbeat:

```
POST {upload.heartbeat_url}            mặc định = upload.url thay "/media" bằng "/heartbeat"
Authorization: Bearer {upload.token}
Content-Type: application/json
  {"cameraId":"CAM-001","at":"…","agentVersion":"0.3.0","queuedMedia":3,"lastUploadError":null}
→ 200 {"status":"ok","cameraId":"CAM-001","lifecycle":"ACTIVE","acceptingUploads":true,
       "heartbeatIntervalSeconds":60,"captureIntervalSeconds":900,"serverTime":"…"}
```

Backend phải **idempotent theo `eventId`**: nhận lại cùng `eventId` + cùng sha256
thì trả `200 {"status":"duplicate"}`; cùng `eventId` nhưng sha256 khác thì trả `409`.

## Chạy nhanh từ đầu đến cuối

Tóm tắt toàn bộ quy trình; chi tiết từng bước ở mục "Cài đặt trên Termux" bên dưới.

**A. Trên máy tính (server)**

```sh
cd Backend && npm install && npm run dev      # API lắng nghe 0.0.0.0:3000
cd Frontend && npm install && npm run dev     # web quản trị (Vite, proxy /api → :3000)
ip -4 addr | grep inet                        # lấy IP LAN của máy, ví dụ 192.168.1.10
```

- Điện thoại và máy tính phải cùng mạng Wi-Fi. Mở cổng 3000 nếu có firewall
  (ví dụ `sudo ufw allow 3000/tcp`).
- Kiểm tra kết nối từ Termux: `curl -i -X POST http://192.168.1.10:3000/api/camera/heartbeat`.
  Nhận về `401` (thiếu token) là **đúng** — nghĩa là điện thoại đã tới được server. Nếu treo hoặc
  `Connection refused` thì kiểm tra lại Wi-Fi/IP/firewall trước khi làm tiếp.

**B. Trên web (đăng nhập Admin) → menu Camera**

1. **Thêm Camera**: nhập tên, vị trí, chu kỳ chụp, chu kỳ heartbeat. Server sinh mã `CAM-001`.
   Trạng thái: *Đã đăng ký*.
2. Chọn Camera → **Cấp token**:
   - Ô "Địa chỉ server": điền `http://<IP-LAN>:3000` (cổng Backend). **Không** dùng `localhost`
     và không dùng cổng 5173 của Vite.
   - Bấm **Cấp token** → **Tải config.json** (hoặc **Sao chép JSON**). Token chỉ hiện một lần.
   - Trạng thái chuyển *Đã cấp token*.

**C. Trên điện thoại (Termux)**

```sh
cd ~/phone-camera
bash scripts/install_termux.sh                # lần đầu: cài gói, tạo config.json từ config.example.json
cp ~/storage/downloads/config.json ~/phone-camera/server.json   # file vừa tải từ web
python - <<'EOF'
import json
base = json.load(open('config.json'))
new = json.load(open('server.json'))
for k, v in new.items():
    base[k] = {**base.get(k, {}), **v} if isinstance(v, dict) else v
json.dump(base, open('config.json', 'w'), indent=2, ensure_ascii=False)
print('Đã gộp', ', '.join(new))
EOF
rm server.json
python camera_agent.py --check-heartbeat      # web: Camera chuyển "Hoạt động" + "Trực tuyến"
python camera_agent.py --check-upload         # chụp 1 ảnh, gửi lên server
./scripts/run_camera.sh                       # chạy liên tục
```

JSON tải từ web chỉ chứa phần kết nối (`camera_id`, `upload.url`, `upload.heartbeat_url`,
`upload.token`, `upload.allow_insecure_http`, `heartbeat_interval_seconds`,
`capture.interval_seconds`). Đoạn Python ở trên gộp nó vào `config.json` hiện có, giữ nguyên các
cấu hình khác (resize, MQTT, spool…). Không muốn dùng Python thì mở `nano config.json` và sửa tay
các trường đó.

**D. Kiểm tra trên web**

- Cột **Kết nối** hiện *Trực tuyến · vài giây trước*, **Vòng đời** là *Hoạt động*.
- Ảnh mới xuất hiện ở thư viện trong panel chi tiết (chế độ lưu đĩa) hoặc ở **AI Chẩn Đoán**
  (chế độ AI + Cloudinary; bấm link "Xem kết quả AI của Camera này").
- Tắt agent quá max(90s, 3 × chu kỳ heartbeat) → Camera hiện *Ngoại tuyến* và có cảnh báo offline;
  bật lại thì cảnh báo tự đóng.
- Chuyển Camera sang *Bảo trì*: agent vẫn gửi heartbeat nhưng giữ ảnh trong hàng đợi, kích hoạt lại thì
  tự gửi bù.

## Cài đặt trên Termux

### 1. Cài ứng dụng (trên điện thoại)

Cài **cùng một nguồn** (F-Droid hoặc GitHub releases — không trộn với bản Google Play):

- Termux
- Termux:API → mở một lần, cấp quyền **Camera**
- Termux:Boot (nếu muốn tự chạy khi khởi động máy) → mở một lần

Trong Android Settings → Apps → Termux và Termux:API: **Battery → Unrestricted**
(tắt tối ưu pin).

### 2. Chép thư mục `phone-camera` lên điện thoại

Cách A — qua SSH (từ máy tính):

```sh
# Trên Termux:
pkg install -y openssh && passwd && sshd && whoami   # sshd chạy cổng 8022
ifconfig wlan0 | grep inet                           # lấy IP điện thoại
# Trên máy tính:
scp -P 8022 -r phone-camera <user>@<ip-dien-thoai>:~/
```

Cách B — qua bộ nhớ trong: chép thư mục vào `Download/` trên điện thoại, rồi trong Termux:

```sh
termux-setup-storage
cp -r ~/storage/downloads/phone-camera ~/
```

Đường dẫn phải là `~/phone-camera` (script boot dùng đường dẫn này).

### 3. Cài gói và tạo config

```sh
cd ~/phone-camera
bash scripts/install_termux.sh
nano config.json
```

Các trường cần sửa:

- `camera_id`: mã Camera do backend sinh khi Admin đăng ký `POST /api/camera` (dạng `CAM-001`).
- `upload.url`: URL HTTPS đầy đủ của endpoint upload.
- `upload.token`: token riêng của điện thoại. Cách dễ nhất: trang **Camera** trên web → **Cấp token**
  → tải `config.json` hoặc copy đoạn JSON cấu hình rồi gộp vào `config.json` (xem mục "Chạy nhanh"). Token chỉ hiện 1 lần;
  cấp lại sẽ làm token cũ mất hiệu lực. (API: `POST /api/camera/tokens/CAM-001`, `DELETE` để thu hồi.)
- `upload.heartbeat_url`: để trống thì tự suy ra từ `upload.url`; `upload.http_heartbeat: false` để tắt.
- `heartbeat_interval_seconds`: chu kỳ heartbeat (10–3600s). Server trả giá trị cấu hình riêng của
  Camera và agent sẽ theo giá trị đó.
- `upload.ca_file`: để `""` nếu server dùng chứng chỉ công khai (Let's Encrypt…);
  nếu dùng chứng chỉ tự ký thì chép CA vào `~/phone-camera/server-ca.pem` và điền
  đường dẫn `/data/data/com.termux/files/home/phone-camera/server-ca.pem`.
- `upload.max_media_bytes`: không lớn hơn giới hạn server (backend hiện dùng 5 MB
  cho ảnh AI). Ảnh 12MP gốc thường 3–8 MB, nên giữ `capture.resize_max_width: 1920`.
- `capture.interval_seconds`: chu kỳ chụp (giây), `0` = chỉ chụp theo lệnh MQTT.
- `mqtt.enabled`: `true` nếu muốn nhận lệnh chụp từ dashboard (điền host/user/password).

Chỉ thử trong mạng LAN không có TLS: dùng `http://…` và `"allow_insecure_http": true`
(không dùng cho môi trường thật).

### 4. Kiểm tra

```sh
python camera_agent.py --check-camera   # chụp 1 ảnh, không upload
python camera_agent.py --check-heartbeat  # gửi 1 heartbeat: Camera chuyển ACTIVE/online trên web
python camera_agent.py --check-upload   # chụp 1 ảnh và upload HTTPS, in kết quả
```

Lỗi thường gặp:

| Thông báo | Nguyên nhân |
|---|---|
| `camera_capture_timeout` | Chưa cài Termux:API app hoặc chưa cấp quyền Camera |
| `tls_verify_failed` | Sai/thiếu `upload.ca_file`, hoặc chứng chỉ không khớp hostname |
| `http_401` / `http_403` | Sai `upload.token`, token đã bị thu hồi/hết hạn, hoặc Camera `DECOMMISSIONED` |
| `http_403:CAMERA_NOT_ACCEPTING` | Admin đang để Camera ở `FAULT`/`MAINTENANCE`; ảnh được giữ lại, tự gửi khi kích hoạt lại |
| `http_404` | Sai `upload.url` |
| `http_301_redirect_to:…` | URL bị redirect (thường http→https hoặc thiếu `/`), sửa `upload.url` |
| `media_exceeds_max_media_bytes` | Bật/giảm `capture.resize_max_width` |

### 5. Chạy

```sh
./scripts/run_camera.sh     # chạy, tự khởi động lại nếu crash; Ctrl+C để dừng
```

Chạy nền khi khởi động máy (cần Termux:Boot):

```sh
mkdir -p ~/.termux/boot
cp scripts/termux-boot-camera.sh ~/.termux/boot/phone-camera
chmod +x ~/.termux/boot/phone-camera
tail -f ~/phone-camera/logs/camera-agent.log    # xem log
```

Dừng agent đang chạy nền: `pkill -f camera_agent.py; pkill -f run_camera.sh`.

### Lưu ý Android

- Android 9+ hạn chế camera với app chạy nền. Termux giữ thông báo foreground +
  wake lock giúp chụp được khi tắt màn hình, nhưng một số hãng (Xiaomi, Oppo,
  Samsung…) vẫn có thể chặn — hãy thử chụp định kỳ với màn hình tắt trước khi lắp đặt.
- Nên cắm sạc liên tục và tắt "Adaptive battery" cho Termux.
- Termux:API chỉ chụp ảnh đơn; `record_video` là timelapse ghép từ nhiều ảnh.

## Lệnh MQTT (tuỳ chọn)

Topic `camera/{cameraId}/command`:

```json
{"action": "capture", "requestId": "req-20261114-0001", "camera": "back"}
{"action": "record_video", "requestId": "req-20261114-0002", "durationSeconds": 10, "frameIntervalSeconds": 1}
```

Agent trả `camera/{cameraId}/command/ack` (`media_queued` + `eventId`), sau khi upload
xong publish `camera/{cameraId}/media/uploaded`. Heartbeat ở `camera/{cameraId}/heartbeat`.

## Test trên máy tính

```sh
python -m unittest discover -s tests -v
python -m py_compile camera_agent.py
```

Phần upload media theo kiểu chunk MQTT trong
[`../docs/SMARTPHONE_CAMERA_NODE_DESIGN.md`](../docs/SMARTPHONE_CAMERA_NODE_DESIGN.md)
đã được thay bằng contract HTTPS ở trên.
