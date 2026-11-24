# Camera HTTP + Cloudinary + AI recognition

1. Admin cấp token Camera qua `POST /api/camera/tokens/:cameraId`; token thô chỉ trả một lần, database chỉ lưu SHA-256 hash.
2. Camera gửi `multipart/form-data` tới `POST /api/camera/media`, gồm `metadata` JSON và `file`, kèm `Authorization: Bearer <camera-token>`.
3. Backend kiểm tra token, Camera ID, eventId, file type, kích thước và SHA-256; eventId trùng cùng ảnh được trả `200 duplicate`.
4. Backend gửi ảnh tới AI API `/predict`.
5. Backend lưu ảnh lên Cloudinary và lưu kết quả AI trực tiếp vào `leafAnalyses`: `diseaseName`, `modelLabel`, `confidence`, `predictions`, `aiResult`, `modelVersion`, `inferenceMs`, URL/Cloudinary public ID và SHA-256.
6. Backend phát Socket.IO `analysis:new` để Frontend cập nhật lịch sử nhận diện.

## API
- `POST /api/camera/tokens/:cameraId`: cấp/đổi token (Admin).
- `POST /api/camera/media`: Camera gửi ảnh bằng Bearer token.
- `GET /api/analyses`: lịch sử nhận diện AI.
- `GET /api/analyses/:id`: chi tiết kết quả và thông số AI.
- `GET /api/analyses/:id/image`: lấy ảnh có xác thực.

Hệ thống không có danh mục Disease/Treatment, không có phương pháp điều trị và không tạo cảnh báo bệnh. Tên bệnh/lớp nhận diện được lưu trực tiếp từ AI, không cần khai báo trước trong database.
