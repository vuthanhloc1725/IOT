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
7. Khi AI trả kết quả hợp lệ, Backend upload ảnh lên Cloudinary, sau đó lưu `eventId`, `deviceId`, `capturedAt`, `diseaseId`, `confidence`, `predictions`, `aiResult` (JSON kết quả AI đã chuẩn hóa), `modelVersion`, `inferenceMs`, `imageUrl`, `cloudinaryPublicId`, `imageSha256` vào `leafAnalyses`. Tạo Alert nếu AI phát hiện bệnh và confidence đạt ngưỡng. Lịch sử AI chỉ lưu/hiển thị kết quả nhận diện; phương pháp điều trị được quản lý riêng trong danh mục Disease/Treatment.
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

## API — lịch sử AI chỉ đọc

Trang **AI Chẩn Đoán** chỉ hiển thị kết quả đã được lưu từ luồng Camera. Trang này không tải ảnh mới, không tạo kết quả thủ công và không quản lý phương pháp điều trị.

- `GET /api/analyses`: danh sách kết quả nhận diện theo phạm vi thiết bị người dùng được phép xem.
- `GET /api/analyses/:id`: chi tiết kết quả, thông tin Disease, Camera/Device và các metadata AI. Response không chứa `recommendations` hoặc danh sách Treatment.
- `GET /api/analyses/:id/image`: tải ảnh local cũ có JWT; ảnh mới trả URL Cloudinary trong `imageUrl`.

Muốn quản lý bệnh và phương pháp điều trị, sử dụng phân hệ riêng:

- `GET /api/diseases`, `GET /api/diseases/:id`: xem danh mục bệnh cùng các phương pháp điều trị thuộc bệnh.
- `POST/PATCH/DELETE /api/diseases`: CRUD bệnh (Admin).
- `GET /api/treatments?diseaseId=:id`: lọc phương pháp theo bệnh.
- `POST/PATCH/DELETE /api/treatments`: CRUD phương pháp điều trị (Admin).

Mỗi Treatment bắt buộc thuộc về một Disease; một Disease có thể có nhiều Treatment.

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

- Backend khởi động với `sequelize.sync()` chế độ mặc định chỉ tạo các bảng còn thiếu; chế độ này không tự alter cấu trúc bảng đang tồn tại.
- Với database hiện hữu, chạy `database/migrations/20261123_disease_treatment_catalog.sql` một lần để chuẩn hóa bảng `treatments` theo mô hình Disease 1-N Treatment. Sao lưu và kiểm tra các Treatment chưa được gắn Disease trước khi migration vì chúng sẽ bị loại khỏi danh mục mới.
- Sau khi schema sẵn sàng, có thể chạy `npm run seed` để tạo Admin/danh mục demo theo script. Script seed không thay thế migration.
