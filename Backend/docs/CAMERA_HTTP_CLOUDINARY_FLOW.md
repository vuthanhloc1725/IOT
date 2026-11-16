# Camera HTTP upload + Cloudinary + AI result

## Luồng

1. Admin đăng ký Camera qua `POST /api/camera` với `{\"name\":\"Camera điện thoại Nhà kính A\",\"location\":\"Nhà kính A\",\"captureIntervalSeconds\":60}`. Server sinh `cameraId` dạng `CAM-001`.
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

## API

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
  -d '{"expiresInDays":90}'
```

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
