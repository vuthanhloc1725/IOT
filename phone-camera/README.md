# Smartphone camera node for Termux (HTTPS upload)

Biến một điện thoại Android thành camera node: chụp ảnh bằng `termux-camera-photo`
(Termux:API), lưu tạm vào hàng chờ SQLite và **upload lên server qua HTTPS**.
MQTT là tuỳ chọn, chỉ dùng cho lệnh chụp theo yêu cầu, status và heartbeat —
ảnh không bao giờ đi qua MQTT.

## Tính năng

- Chụp định kỳ (`capture.interval_seconds`), thu nhỏ ảnh bằng ffmpeg (`capture.resize_max_width`).
- Upload HTTPS multipart, `Authorization: Bearer <token>`, xác thực chứng chỉ TLS
  (hỗ trợ CA tự ký qua `upload.ca_file`), không tự follow redirect.
- Mất mạng → ảnh nằm trong hàng chờ, retry với exponential backoff (5s → 300s),
  tôn trọng `Retry-After`. Ảnh chỉ bị xoá khi server xác nhận `stored`/`duplicate`.
- Giới hạn hàng chờ (`storage.max_queue_items`) để không đầy bộ nhớ khi offline lâu.
- (Tuỳ chọn, MQTT) lệnh `capture` / `record_video` (timelapse MP4), heartbeat có
  số ảnh đang chờ và lỗi upload gần nhất.

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
     "capturedAt":"2026-11-14T07:13:33.120Z","sizeBytes":812345,"sha256":"…","agentVersion":"0.2.0"}
  part "file" (image/jpeg | video/mp4): nội dung ảnh/video
```

Phản hồi server và cách agent xử lý:

| Server trả về | Agent làm gì |
|---|---|
| `2xx` `{"status":"stored"}` hoặc `{"status":"duplicate"}` (có thể kèm `sha256`) | Xoá file local |
| `2xx` có `sha256` khác với file | Gửi lại |
| `400`, `409`, `413`, `415`, `422` (`{"reason":"…"}`) | Đánh dấu `rejected`, giữ file, không gửi lại |
| `401`, `403`, `404`, `408`, `429`, `5xx`, lỗi mạng/TLS, `3xx` | Giữ trong hàng chờ, retry có backoff |

Backend phải **idempotent theo `eventId`**: nhận lại cùng `eventId` + cùng sha256
thì trả `200 {"status":"duplicate"}`; cùng `eventId` nhưng sha256 khác thì trả `409`.

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
- `upload.token`: token riêng của điện thoại, lấy bằng `POST /api/camera/tokens/CAM-001` (JWT Admin, chỉ hiện 1 lần; gọi lại để cấp mới, `DELETE` cùng URL để thu hồi).
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
python camera_agent.py --check-upload   # chụp 1 ảnh và upload HTTPS, in kết quả
```

Lỗi thường gặp:

| Thông báo | Nguyên nhân |
|---|---|
| `camera_capture_timeout` | Chưa cài Termux:API app hoặc chưa cấp quyền Camera |
| `tls_verify_failed` | Sai/thiếu `upload.ca_file`, hoặc chứng chỉ không khớp hostname |
| `http_401` / `http_403` | Sai `upload.token` |
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
