-- Lưu ảnh camera phone trên đĩa (fallback khi chưa cấu hình AI + Cloudinary).
-- Chạy SAU 20261115_camera_http_cloudinary.sql (tạo bảng cameraTokens theo deviceId).
-- camera_media.cameraId = devices.deviceCode của camera (type CAMERA, ví dụ CAM-001).

-- Nếu đã chạy bản cũ (bảng camera_tokens + FK fk_camera_media_token), bỏ comment 2 dòng sau:
-- ALTER TABLE camera_media DROP FOREIGN KEY fk_camera_media_token;
-- DROP TABLE IF EXISTS camera_tokens;

CREATE TABLE IF NOT EXISTS camera_media (
    id              INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
    eventId         VARCHAR(120)    NOT NULL UNIQUE     COMMENT 'Idempotency key từ phone agent',
    cameraId        VARCHAR(60)     NOT NULL            COMMENT 'devices.deviceCode của camera',
    requestId       VARCHAR(120)    NULL                COMMENT 'MQTT command requestId nếu có',
    mediaType       ENUM('image','video') NOT NULL DEFAULT 'image',
    mimeType        VARCHAR(60)     NOT NULL,
    filename        VARCHAR(255)    NOT NULL             COMMENT 'Tên file trên disk (UUID + ext)',
    sizeBytes       INT UNSIGNED    NOT NULL,
    sha256          CHAR(64)        NOT NULL,
    capturedAt      DATETIME(3)     NULL                COMMENT 'Thời điểm chụp (do phone báo)',
    receivedAt      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_camera_media_camera (cameraId),
    INDEX idx_camera_media_captured (capturedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
