-- Migration: nhận ảnh Camera qua HTTP, lưu ảnh trên Cloudinary và metadata/kết quả AI trong MySQL.
-- Chạy một lần trên database hiện tại. Nếu các cột đã tồn tại, bỏ qua phần ALTER tương ứng.
ALTER TABLE `leafAnalyses`
  ADD COLUMN `aiResult` JSON NULL AFTER `predictions`,
  ADD COLUMN `imageUrl` VARCHAR(1000) NULL AFTER `imagePath`,
  ADD COLUMN `cloudinaryPublicId` VARCHAR(255) NULL AFTER `imageUrl`,
  ADD COLUMN `imageSha256` CHAR(64) NULL AFTER `cloudinaryPublicId`;

CREATE TABLE IF NOT EXISTS `cameraTokens` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `deviceId` INT NOT NULL,
  `tokenHash` CHAR(64) NOT NULL,
  `expiresAt` DATETIME(3) NULL,
  `revokedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastUsedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `cameraTokens_deviceId_unique` (`deviceId`),
  UNIQUE KEY `cameraTokens_tokenHash_unique` (`tokenHash`),
  CONSTRAINT `fk_cameraTokens_device` FOREIGN KEY (`deviceId`) REFERENCES `devices` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
