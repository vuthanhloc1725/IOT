-- Camera tokens & media storage for smartphone camera nodes.
-- Run once, after the base schema (smart_agri_mysql_demo.sql).

-- ---- Bảng token xác thực cho mỗi camera phone ----
CREATE TABLE IF NOT EXISTS camera_tokens (
    id              INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
    cameraId        VARCHAR(60)     NOT NULL UNIQUE     COMMENT 'Tên duy nhất cho mỗi điện thoại, ví dụ PHONE-CAM-01',
    tokenHash       CHAR(64)        NOT NULL             COMMENT 'SHA-256 hex của Bearer token; token gốc chỉ hiện 1 lần',
    label           VARCHAR(120)    NULL                 COMMENT 'Ghi chú tuỳ ý (vị trí, chủ nhân…)',
    isActive        TINYINT(1)      NOT NULL DEFAULT 1,
    createdAt       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updatedAt       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- Bảng metadata ảnh/video đã nhận ----
CREATE TABLE IF NOT EXISTS camera_media (
    id              INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
    eventId         VARCHAR(120)    NOT NULL UNIQUE     COMMENT 'Idempotency key từ phone agent',
    cameraId        VARCHAR(60)     NOT NULL,
    requestId       VARCHAR(120)    NULL                COMMENT 'MQTT command requestId nếu có',
    mediaType       ENUM('image','video') NOT NULL DEFAULT 'image',
    mimeType        VARCHAR(60)     NOT NULL,
    filename        VARCHAR(255)    NOT NULL             COMMENT 'Tên file trên disk (UUID + ext)',
    sizeBytes       INT UNSIGNED    NOT NULL,
    sha256          CHAR(64)        NOT NULL,
    capturedAt      DATETIME(3)     NULL                COMMENT 'Thời điểm chụp (do phone báo)',
    receivedAt      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_camera_media_camera (cameraId),
    INDEX idx_camera_media_captured (capturedAt),
    CONSTRAINT fk_camera_media_token FOREIGN KEY (cameraId) REFERENCES camera_tokens(cameraId)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
