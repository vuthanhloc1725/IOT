# Camera HTTP upload + Cloudinary + AI result

## Luồng

1. Admin đăng ký Camera qua `POST /api/camera` với `{"name":"Camera điện thoại Nhà kính A","location":"Nhà kính A","captureIntervalSeconds":60,"heartbeatIntervalSeconds":60}`. Server sinh `cameraId` dạng `CAM-001`.
2. Admin gọi `POST /api/camera/tokens/CAM-001` bằng JWT Admin. Server tạo credential ngẫu nhiên, chỉ trả token thô một lần; DB chỉ lưu SHA-256 hash. Có thể gửi `{"expiresInDays":90}` để đặt hạn dùng; bỏ trống thì token không tự hết hạn.
3. Cấu hình trên Camera/Agent:
   - `camera_id`: `CAM-001`
   - `upload.url`: `https://<backend-host>/api/camera/media`
   - `upload.token`: token vừa nhận
4. Agent gửi `multipart/form-data`:
   - `metadata`: JSON string, tối thiểu `{"cameraId":"CAM-001","eventId":"<stable-unique-id>","capturedAt":"2026-11-15T12:00:00+07:00"}`
   - `file`: ảnh JPEG/PNG/WebP, tối đa 10 MB
   - Header: `Authorization: Bearer <camera-token>`
5. Backend kiểm tra token, Camera, metadata, định dạng thật của ảnh, dung lượng; kiểm tra `eventId` để chống gửi trùng.
6. Backend gửi ảnh sang `AI_API_URL/predict` bằng multipart field `file`, header `X-API-Key`.
7. Khi AI trả kết quả hợp lệ, Backend upload ảnh lên Cloudinary, sau đó lưu `eventId`, `deviceId`, `capturedAt`, `diseaseId`, `confidence`, `predictions`, `aiResult` (JSON kết quả AI đã chuẩn hóa), `modelVersion`, `inferenceMs`, `imageUrl`, `cloudinaryPublicId`, `imageSha256` vào `leafAnalyses`. Tạo Alert nếu AI phát hiện bệnh và confidence đạt ngưỡng.
8. Trả `201` với `status: stored`; nếu eventId đã được nhận từ cùng Camera, trả `200` với `status: duplicate`. Agent chỉ xóa bản ảnh local sau khi nhận được một trong hai response thành công.

## Chế độ fallback (chưa cấu hình AI + Cloudinary)

Bước 6–7 chỉ chạy khi đủ cả 5 biến `AI_API_URL`, `AI_API_KEY`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`. Thiếu bất kỳ biến nào, Backend vẫn nhận upload với cùng token/metadata nhưng:

- Lưu file trên đĩa (`CAMERA_IMAGE_STORAGE_DIR`, mặc định `storage/camera-media`) và ghi bảng `camera_media` (migration `20261115_camera_media.sql`). Chấp nhận thêm `video/mp4`.
- Response có `storage: "local-disk"`; chế độ AI trả `storage: "ai-cloudinary"`. `GET /api/camera` trả `meta.storage` cho biết chế độ hiện tại.
- Xem lại: `GET /api/camera/media`, `GET /api/camera/media/:eventId/file` (JWT); xoá: `DELETE /api/camera/media/:eventId` (Admin).
- `eventId` được kiểm tra trùng ở cả `leafAnalyses` và `camera_media`, nên đổi chế độ giữa chừng không làm lưu một ảnh hai nơi.

Mã lỗi cho Agent: 400/409/413/415/422 = từ chối vĩnh viễn (không retry); 401/403/404/408/429/5xx = thử lại sau.

## Vòng đời, heartbeat và online/offline

Camera là `Device` loại `CAMERA`, không gắn Node ESP32 (`nodeId`/`gpioPin` = null). Vòng đời dùng chung cột `lifecycle` nhưng có bảng chuyển riêng (`src/services/camera-lifecycle.service.js`):

| Trạng thái | Cách vào | Upload ảnh |
|---|---|---|
| `REGISTERED` | Admin tạo Camera; hoặc thu hồi token khi đang PROVISIONED/ACTIVE | – (chưa có token) |
| `PROVISIONED` | Admin cấp token | Nhận |
| `ACTIVE` | Tự động ở request hợp lệ đầu tiên (heartbeat hoặc upload) | Nhận |
| `FAULT` / `MAINTENANCE` | Admin chuyển tay (`POST /api/devices/:id/lifecycle`) | 403 `CAMERA_NOT_ACCEPTING`, agent giữ file và thử lại |
| `DECOMMISSIONED` | Admin; token bị thu hồi luôn | 403 mọi request |

- Chuyển về `ACTIVE` bằng tay chỉ được khi Camera đang online. Chỉ Admin được đổi lifecycle Camera.
- Chuyển `FAULT` tạo Alert `fault`; kích hoạt lại sẽ tự đóng Alert đó.
- **Heartbeat**: `POST /api/camera/heartbeat` (Bearer camera token, 30 request/phút). Body tuỳ chọn `{"cameraId","at","agentVersion","queuedMedia","lastUploadError"}`. Trả `{status:"ok", cameraId, lifecycle, acceptingUploads, heartbeatIntervalSeconds, captureIntervalSeconds, serverTime}`; agent dùng `acceptingUploads` để tạm dừng/tiếp tục gửi ảnh và tự áp dụng `heartbeatIntervalSeconds` của server.
- **Online** = token còn hiệu lực và `cameraTokens.lastUsedAt` (cập nhật ở mọi request hợp lệ) trong vòng `max(90s, 3 × heartbeatIntervalSeconds)`. `heartbeatIntervalSeconds` lưu ở `devices.config`, mặc định 60, khoảng 10–3600. Không cần migration.
- Vòng sweep của server tạo **một** Alert `offline` cho mỗi Camera ACTIVE quá hạn heartbeat; Camera gửi lại request hợp lệ sẽ tự đóng Alert và phát socket `device:update`.

## Phân quyền xem

- `GET /api/camera`: Admin thấy tất cả; người dùng thường chỉ thấy Camera được gán qua `user_devices`. Mỗi Camera trả kèm `isOnline`, `lastSeenAt`, `offlineAfterSec`, `token.status` (`NONE`/`ACTIVE`/`EXPIRED`/`REVOKED`), `lastMediaAt`, `mediaCount`, `analysisCount`. Không bao giờ trả token hay hash.
- `GET /api/camera/media` và `GET /api/camera/media/:eventId/file`: người dùng thường chỉ thấy media của Camera được gán; media ngoài quyền trả 404.
- `GET /api/analyses?deviceId=<id>` vốn đã lọc theo thiết bị được gán.
- Tạo Camera, cấp/thu hồi token, đổi lifecycle, xoá media: chỉ Admin.

## API

### Tải ảnh trực tiếp từ giao diện người dùng

Người dùng đã đăng nhập có thể tải một ảnh lên `POST /api/analyses/predict`. Backend kiểm tra ảnh rồi gửi `multipart/form-data` đến `AI_API_URL/predict` với header `X-API-Key`, sau đó trả JSON dự đoán cho giao diện. Trường `AI_API_URL` là URL gốc của AI server, không thêm `/predict`.

```bash
curl -X POST "http://localhost:3000/api/analyses/predict" \
  -H "Authorization: Bearer <user-jwt>" \
  -F "file=@leaf.jpg;type=image/jpeg"
```

Ảnh hỗ trợ JPEG/PNG/WebP, tối đa 10 MB. Backend lưu ảnh vào `AI_IMAGE_STORAGE_DIR` (mặc định `Backend/storage/analysis-images`), ghi kết quả vào `leafAnalyses`, và chỉ cho người tải lên xem lịch sử/ảnh đó (Admin xem được tất cả). Ảnh được phục vụ qua API có JWT, không phải thư mục public.

Với database đã tồn tại, chạy `database/migrations/20261117_user_upload_analysis_history.sql` một lần trước khi thử; migration thêm quyền sở hữu lịch sử và ba nhãn AI của model Malabar. Database mới dùng schema và dữ liệu trong `database/smart_agri_mysql_demo.sql`.

#### Kiểm tra luồng tải ảnh

1. Cấu hình `AI_API_URL` bằng URL tunnel AI hiện tại (không kèm `/predict`) và `AI_API_KEY` bằng key cấu hình trên AI server; khởi động lại Backend.
2. Đăng nhập frontend, mở **AI Chẩn Đoán**, chọn ảnh hợp lệ và bấm **Gửi ảnh phân tích**.
3. Kết quả xuất hiện trên trang và trong lịch sử; chọn dòng vừa tạo để mở ảnh đã lưu.
4. Kiểm tra DB bằng `SELECT id, eventId, uploadedBy, diseaseId, imagePath FROM leafAnalyses ORDER BY id DESC LIMIT 5;`.

### Đăng ký Camera

`POST /api/camera` (JWT Admin):

```bash
curl -X POST "https://<host>/api/camera" \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Camera điện thoại Nhà kính A","location":"Nhà kính A","captureIntervalSeconds":60}'
```

### Cấp token

`POST /api/camera/tokens/:cameraId`

JWT Admin, ví dụ:

```bash
curl -X POST "https://<host>/api/camera/tokens/CAM-001" \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"expiresInDays":90,"serverUrl":"https://<host>"}'
```

`serverUrl` (tuỳ chọn) là địa chỉ điện thoại sẽ gọi tới; bỏ trống thì dùng host của request. Response có `uploadUrl`, `heartbeatUrl` và `agentConfig` (JSON dán thẳng vào `config.json` của agent, cũng là nội dung mã QR trên trang Camera). Cấp token cho Camera `REGISTERED` sẽ chuyển nó sang `PROVISIONED`.

Lưu token ngay; API không có endpoint đọc lại token. Cấp token mới sẽ thay thế token cũ. Thu hồi:

`DELETE /api/camera/tokens/:cameraId` (JWT Admin).

### Gửi ảnh từ Camera

```bash
curl -X POST "https://<host>/api/camera/media" \
  -H "Authorization: Bearer <camera-token>" \
  -F 'metadata={"cameraId":"CAM-001","eventId":"CAM-001-20261115T120000Z-0001","capturedAt":"2026-11-15T19:00:00+07:00"}' \
  -F "file=@leaf.jpg;type=image/jpeg"
```

### Xem lịch sử

Các API quản trị hiện có:
- `GET /api/analyses`
- `GET /api/analyses/:id`

Ảnh mới trả qua trường `imageUrl` (Cloudinary secure URL). Ảnh cũ có `imagePath` local vẫn được hỗ trợ qua `GET /api/analyses/:id/image`.

## Environment

```env
AI_API_URL=https://<ai-service>
AI_API_KEY=<ai-api-key>
AI_REQUEST_TIMEOUT_MS=60000
CLOUDINARY_CLOUD_NAME=<cloud-name>
CLOUDINARY_API_KEY=<api-key>
CLOUDINARY_API_SECRET=<api-secret>
CLOUDINARY_FOLDER=smart-agri/camera-media
```

Không đưa Cloudinary API Secret hoặc Camera token vào Frontend, firmware repository công khai hay log.

## Database

- Chạy `database/migrations/20261115_camera_http_cloudinary.sql` trên database cũ.
- Database mới: chạy `database/smart_agri_mysql_demo.sql`.
- Sau khi schema sẵn sàng, chạy `npm run seed`.
- Script seed không gọi `sequelize.sync()`; nó không tự tạo hoặc alter schema.
