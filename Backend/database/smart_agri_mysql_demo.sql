-- =====================================================================
-- IoT Control / Smart Agriculture - MySQL schema + demo seed data
-- Dựa theo Sequelize models trong Backend/src/models.
-- Target: MySQL 8.0+ (có thể dùng MariaDB hiện đại, nhưng nên kiểm tra JSON).
-- CẢNH BÁO: Dùng trên database mới/trống. Script không DROP bảng hiện có.
-- Database mặc định: iot (đồng bộ với Backend/.env.example: DB_NAME=iot).
-- Tài khoản demo: admin / Demo@12345678 (tất cả user demo dùng cùng mật khẩu).
-- Hãy đổi mật khẩu hoặc xóa tài khoản demo trước khi đưa lên môi trường thật.
-- =====================================================================

CREATE DATABASE IF NOT EXISTS `iot`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `iot`;
SET NAMES utf8mb4;
SET time_zone = '+07:00';

-- 1. USERS ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(50) NOT NULL,
  `email` VARCHAR(255) NOT NULL,
  `passwordHash` VARCHAR(255) NOT NULL,
  `fullName` VARCHAR(100) NOT NULL,
  `role` ENUM('admin','operator','viewer') NOT NULL DEFAULT 'viewer',
  `isActive` TINYINT(1) NOT NULL DEFAULT 1,
  `lastLoginAt DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `users_username_unique` (`username`),
  UNIQUE KEY `users_email_unique` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. NODES ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `nodes` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `nodeCode` VARCHAR(50) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `firmwareVersion` VARCHAR(30) NULL,
  `hardwareVersion` VARCHAR(30) NULL,
  `isOnline` TINYINT(1) NOT NULL DEFAULT 0,
  `onlineSince` DATETIME(3) NULL,
  `lastHeartbeatAt` DATETIME(3) NULL,
  `firmwareBootCount` INT NULL,
  `firmwareBootStartedAt` DATETIME(3) NULL,
  `heartbeatTimeoutSec` INT NOT NULL DEFAULT 60,
  `isRevoked` TINYINT(1) NOT NULL DEFAULT 0,
  `mqttUsername` VARCHAR(80) NULL,
  `mqttRoleName` VARCHAR(100) NULL,
  `mqttProvisionedAt` DATETIME(3) NULL,
  `mqttAccountEnabled` TINYINT(1) NOT NULL DEFAULT 0,
  `macAddress` VARCHAR(17) NULL,
  `claimTokenHash` CHAR(64) NULL,
  `claimTokenExpiresAt` DATETIME(3) NULL,
  `claimConsumedAt` DATETIME(3) NULL,
  `claimFailedAt` DATETIME(3) NULL,
  `claimedAt` DATETIME(3) NULL,
  `revokedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `nodes_nodeCode_unique` (`nodeCode`),
  UNIQUE KEY `nodes_mqttUsername_unique` (`mqttUsername`),
  UNIQUE KEY `nodes_mqttRoleName_unique` (`mqttRoleName`),
  UNIQUE KEY `nodes_macAddress_unique` (`macAddress`),
  KEY `idx_nodes_isOnline` (`isOnline`),
  KEY `idx_nodes_lastHeartbeatAt` (`lastHeartbeatAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. DISEASES -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `diseases` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `modelLabel` VARCHAR(100) NOT NULL,
  `nameVi` VARCHAR(120) NOT NULL,
  `nameEn` VARCHAR(120) NULL,
  `isHealthy` TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `diseases_modelLabel_unique` (`modelLabel`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. DEVICES --------------------------------------------------------------
-- Enum bám backend: PUMP, FAN, SENSOR. Gateway ESP32 được ghi trong bảng nodes.
CREATE TABLE IF NOT EXISTS `devices` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `deviceCode` VARCHAR(50) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `type` ENUM('PUMP','FAN','SENSOR','CAMERA') NOT NULL,
  `location` VARCHAR(150) NULL,
  `nodeId` INT NULL,
  `gpioPin` INT NULL,
  `presenceVerifiedAt` DATETIME(3) NULL,
  `readinessVerifiedAt` DATETIME(3) NULL,
  `readinessType` ENUM('SENSOR_TELEMETRY','CURRENT_SENSOR','FLOW_SENSOR') NULL,
  `lifecycleChangedAt` DATETIME(3) NULL,
  `pendingLifecycleCommandUuid` CHAR(36) NULL,
  `pendingLifecycleCommandTo` VARCHAR(30) NULL,
  `pendingLifecycleCommandSentAt` DATETIME(3) NULL,
  `lifecycle` ENUM('REGISTERED','PROVISIONED','ACTIVE','FAULT','MAINTENANCE','DECOMMISSIONED') NOT NULL DEFAULT 'REGISTERED',
  `isOn` TINYINT(1) NOT NULL DEFAULT 0,
  `stateChangedAt` DATETIME(3) NULL,
  `config` JSON NOT NULL,
  `configVersion` INT NOT NULL DEFAULT 0,
  `configAppliedVersion` INT NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `devices_deviceCode_unique` (`deviceCode`),
  UNIQUE KEY `devices_pendingLifecycleCommandUuid_unique` (`pendingLifecycleCommandUuid`),
  KEY `idx_devices_nodeId` (`nodeId`),
  KEY `idx_devices_lifecycle` (`lifecycle`),
  CONSTRAINT `fk_devices_node` FOREIGN KEY (`nodeId`) REFERENCES `nodes` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4A. CAMERA TOKENS -------------------------------------------------------
-- Mỗi camera có một credential dài hạn; token thô chỉ hiển thị đúng một lần khi cấp.
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

-- 4B. CAMERA MEDIA (fallback lưu đĩa khi chưa cấu hình AI + Cloudinary) ------
-- camera_media.cameraId = devices.deviceCode của camera (type CAMERA, ví dụ CAM-001).
CREATE TABLE IF NOT EXISTS `camera_media` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `eventId` VARCHAR(120) NOT NULL COMMENT 'Idempotency key từ phone agent',
  `cameraId` VARCHAR(60) NOT NULL COMMENT 'devices.deviceCode của camera',
  `requestId` VARCHAR(120) NULL COMMENT 'MQTT command requestId nếu có',
  `mediaType` ENUM('image','video') NOT NULL DEFAULT 'image',
  `mimeType` VARCHAR(60) NOT NULL,
  `filename` VARCHAR(255) NOT NULL COMMENT 'Tên file trên disk (UUID + ext)',
  `sizeBytes` INT UNSIGNED NOT NULL,
  `sha256` CHAR(64) NOT NULL,
  `capturedAt` DATETIME(3) NULL COMMENT 'Thời điểm chụp (do phone báo)',
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `camera_media_eventId_unique` (`eventId`),
  KEY `idx_camera_media_camera` (`cameraId`),
  KEY `idx_camera_media_captured` (`capturedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. USERS <-> DEVICES (phạm vi quyền truy cập) --------------------------
CREATE TABLE IF NOT EXISTS `userDevices` (
  `userId` INT NOT NULL,
  `deviceId` INT NOT NULL,
  `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`userId`,`deviceId`),
  KEY `idx_userDevices_deviceId` (`deviceId`),
  CONSTRAINT `fk_userDevices_user` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_userDevices_device` FOREIGN KEY (`deviceId`) REFERENCES `devices` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. SENSOR READINGS ------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sensorReadings` (
  `deviceId` INT NOT NULL,
  `metric` ENUM('SOIL_MOISTURE','AIR_TEMPERATURE','AIR_HUMIDITY') NOT NULL,
  `recordedAt` DATETIME(3) NOT NULL,
  `value` DECIMAL(8,2) NOT NULL,
  `sourceBootCount` INT NULL,
  `sourceSeq` BIGINT NULL,
  `isBackfilled` TINYINT(1) NOT NULL DEFAULT 0,
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`deviceId`,`metric`,`recordedAt`),
  KEY `idx_sensorReadings_recordedAt` (`recordedAt`),
  KEY `idx_sensorReadings_metric_time` (`metric`,`recordedAt`),
  UNIQUE KEY `uq_sensorReadings_source_seq` (`deviceId`,`metric`,`sourceBootCount`,`sourceSeq`),
  CONSTRAINT `fk_sensorReadings_device` FOREIGN KEY (`deviceId`) REFERENCES `devices` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. TREATMENTS -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `treatments` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `diseaseId` INT NULL,
  `deficiencyId` INT NULL,
  `type` ENUM('BIOLOGICAL','CHEMICAL') NOT NULL,
  `instructions` TEXT NOT NULL,
  `activeIngredient` VARCHAR(120) NULL,
  `dosageText` VARCHAR(150) NULL,
  `intervalDays` INT NULL,
  `sourceReference` TEXT NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_treatments_diseaseId` (`diseaseId`),
  KEY `idx_treatments_type` (`type`),
  CONSTRAINT `fk_treatments_disease` FOREIGN KEY (`diseaseId`) REFERENCES `diseases` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. LEAF ANALYSES --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `leafAnalyses` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `eventId` VARCHAR(100) NULL,
  `deviceId` INT NULL,
  `capturedAt` DATETIME(3) NOT NULL,
  `diseaseId` INT NOT NULL,
  `confidence` DECIMAL(5,4) NOT NULL,
  `boundingBoxes` JSON NULL,
  `predictions` JSON NULL,
  `aiResult` JSON NULL,
  `imagePath` VARCHAR(500) NULL COMMENT 'Legacy local image path; new images use Cloudinary',
  `imageUrl` VARCHAR(1000) NULL,
  `cloudinaryPublicId` VARCHAR(255) NULL,
  `imageSha256` CHAR(64) NULL,
  `modelVersion` VARCHAR(50) NOT NULL,
  `inferenceMs` INT NULL,
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `leafAnalyses_eventId_unique` (`eventId`),
  KEY `idx_leafAnalyses_deviceId` (`deviceId`),
  KEY `idx_leafAnalyses_diseaseId` (`diseaseId`),
  KEY `idx_leafAnalyses_capturedAt` (`capturedAt`),
  CONSTRAINT `fk_leafAnalyses_device` FOREIGN KEY (`deviceId`) REFERENCES `devices` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_leafAnalyses_disease` FOREIGN KEY (`diseaseId`) REFERENCES `diseases` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. ALERTS ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `alerts` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `type` ENUM('disease','offline','fault','system','sensor_threshold') NOT NULL,
  `severity` ENUM('CRITICAL','WARNING','INFO') NOT NULL DEFAULT 'WARNING',
  `status` ENUM('NEW','ACKNOWLEDGED','RESOLVED') NOT NULL DEFAULT 'NEW',
  `title` VARCHAR(200) NOT NULL,
  `message` TEXT NULL,
  `deviceId` INT NULL,
  `analysisId` INT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `acknowledgedBy` INT NULL,
  `acknowledgedAt` DATETIME(3) NULL,
  `resolvedBy` INT NULL,
  `resolvedAt` DATETIME(3) NULL,
  `resolutionNote` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_alerts_status_severity` (`status`,`severity`),
  KEY `idx_alerts_createdAt` (`createdAt`),
  KEY `idx_alerts_deviceId` (`deviceId`),
  KEY `idx_alerts_analysisId` (`analysisId`),
  CONSTRAINT `fk_alerts_device` FOREIGN KEY (`deviceId`) REFERENCES `devices` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_alerts_analysis` FOREIGN KEY (`analysisId`) REFERENCES `leafAnalyses` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_alerts_acknowledgedBy` FOREIGN KEY (`acknowledgedBy`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_alerts_resolvedBy` FOREIGN KEY (`resolvedBy`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. DEVICE COMMANDS -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `deviceCommands` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `commandUuid` CHAR(36) NOT NULL,
  `deviceId` INT NOT NULL,
  `turnOn` TINYINT(1) NOT NULL,
  `source` ENUM('AUTO','MANUAL','ALERT') NOT NULL,
  `issuedBy` INT NULL,
  `alertId` INT NULL,
  `sensorValue` DECIMAL(8,2) NULL,
  `status` ENUM('PENDING','SENT','ACKED','FAILED','TIMEOUT') NOT NULL DEFAULT 'PENDING',
  `resultMessage` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `sentAt` DATETIME(3) NULL,
  `ackedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `deviceCommands_commandUuid_unique` (`commandUuid`),
  KEY `idx_deviceCommands_deviceId` (`deviceId`),
  KEY `idx_deviceCommands_issuedBy` (`issuedBy`),
  KEY `idx_deviceCommands_alertId` (`alertId`),
  CONSTRAINT `fk_deviceCommands_device` FOREIGN KEY (`deviceId`) REFERENCES `devices` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_deviceCommands_issuedBy` FOREIGN KEY (`issuedBy`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_deviceCommands_alert` FOREIGN KEY (`alertId`) REFERENCES `alerts` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. AUDIT LOGS ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS `auditLogs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `userId` INT NULL,
  `action` VARCHAR(60) NOT NULL,
  `entityType` VARCHAR(40) NULL,
  `entityId` INT NULL,
  `detail` JSON NULL,
  `success` TINYINT(1) NOT NULL DEFAULT 1,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_auditLogs_createdAt` (`createdAt`),
  KEY `idx_auditLogs_userId` (`userId`),
  KEY `idx_auditLogs_action` (`action`),
  CONSTRAINT `fk_auditLogs_user` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
-- DEMO SEED DATA
-- All demo accounts use: Demo@12345678
-- Password is bcrypt ($2b$, cost 10), compatible with bcryptjs in backend.
-- =====================================================================

INSERT INTO `users` (`id`,`username`,`email`,`passwordHash`,`fullName`,`role`,`isActive`,`lastLoginAt`,`createdAt`) VALUES
(1,'admin','admin@iot.vn','$2b$10$tD/Ckb/sj7kPXNQm7iygTO7mH16X8lxODr5PgodR1Isl4/hV4qEnS','Nguyễn Văn An','admin',1,DATE_SUB(NOW(3),INTERVAL 5 MINUTE),DATE_SUB(NOW(3),INTERVAL 60 DAY)),
(2,'operator1','operator1@iot.vn','$2b$10$tD/Ckb/sj7kPXNQm7iygTO7mH16X8lxODr5PgodR1Isl4/hV4qEnS','Trần Thị Bình','operator',1,DATE_SUB(NOW(3),INTERVAL 2 HOUR),DATE_SUB(NOW(3),INTERVAL 35 DAY)),
(3,'operator2','operator2@iot.vn','$2b$10$tD/Ckb/sj7kPXNQm7iygTO7mH16X8lxODr5PgodR1Isl4/hV4qEnS','Lê Hoàng Cường','operator',1,DATE_SUB(NOW(3),INTERVAL 1 DAY),DATE_SUB(NOW(3),INTERVAL 30 DAY)),
(4,'viewer1','viewer1@iot.vn','$2b$10$tD/Ckb/sj7kPXNQm7iygTO7mH16X8lxODr5PgodR1Isl4/hV4qEnS','Phạm Minh Đức','viewer',1,DATE_SUB(NOW(3),INTERVAL 3 DAY),DATE_SUB(NOW(3),INTERVAL 20 DAY)),
(5,'viewer2','viewer2@iot.vn','$2b$10$tD/Ckb/sj7kPXNQm7iygTO7mH16X8lxODr5PgodR1Isl4/hV4qEnS','Hoàng Thị Em','viewer',1,DATE_SUB(NOW(3),INTERVAL 15 DAY),DATE_SUB(NOW(3),INTERVAL 12 DAY))
ON DUPLICATE KEY UPDATE `email`=VALUES(`email`),`passwordHash`=VALUES(`passwordHash`),`fullName`=VALUES(`fullName`),`role`=VALUES(`role`),`isActive`=VALUES(`isActive`),`lastLoginAt`=VALUES(`lastLoginAt`);

INSERT INTO `nodes` (`id`,`nodeCode`,`name`,`firmwareVersion`,`hardwareVersion`,`isOnline`,`onlineSince`,`lastHeartbeatAt`,`heartbeatTimeoutSec`,`isRevoked`,`revokedAt`,`createdAt`) VALUES
(1,'NODE-001','ESP32 Nhà kính A','v1.2.0','ESP32-WROOM-32',1,DATE_SUB(NOW(3),INTERVAL 40 MINUTE),NOW(3),3600,0,NULL,DATE_SUB(NOW(3),INTERVAL 50 DAY)),
(2,'NODE-002','ESP32 Khu B','v1.1.4','ESP32-WROOM-32',0,NULL,DATE_SUB(NOW(3),INTERVAL 3 HOUR),60,0,NULL,DATE_SUB(NOW(3),INTERVAL 40 DAY))
ON DUPLICATE KEY UPDATE `name`=VALUES(`name`),`firmwareVersion`=VALUES(`firmwareVersion`),`hardwareVersion`=VALUES(`hardwareVersion`),`isOnline`=VALUES(`isOnline`),`onlineSince`=VALUES(`onlineSince`),`lastHeartbeatAt`=VALUES(`lastHeartbeatAt`),`heartbeatTimeoutSec`=VALUES(`heartbeatTimeoutSec`),`isRevoked`=VALUES(`isRevoked`),`revokedAt`=VALUES(`revokedAt`);

INSERT INTO `diseases` (`id`,`modelLabel`,`nameVi`,`nameEn`,`isHealthy`) VALUES
(1,'Tomato___Late_blight','Bệnh mốc sương','Tomato late blight',0),
(2,'Tomato___Early_blight','Bệnh đốm vòng','Tomato early blight',0),
(3,'Tomato___healthy','Lá cà chua khỏe mạnh','Healthy tomato leaf',1),
(4,'Pepper,_bell___Bacterial_spot','Bệnh đốm vi khuẩn trên ớt','Bacterial spot',0)
ON DUPLICATE KEY UPDATE `nameVi`=VALUES(`nameVi`),`nameEn`=VALUES(`nameEn`),`isHealthy`=VALUES(`isHealthy`);

INSERT INTO `devices` (`id`,`deviceCode`,`name`,`type`,`location`,`nodeId`,`gpioPin`,`lifecycle`,`isOn`,`stateChangedAt`,`lifecycleChangedAt`,`config`,`configVersion`,`configAppliedVersion`,`createdAt`) VALUES
(1,'DEV-001','Bơm chính A1','PUMP','Nhà kính A - Khu 1',1,26,'ACTIVE',0,NULL,DATE_SUB(NOW(3),INTERVAL 40 DAY),JSON_OBJECT('localAutomation',TRUE,'auto',JSON_OBJECT('enabled',TRUE,'metric','SOIL_MOISTURE','onOp','lt','onValue',35,'offOp','gte','offValue',60)),3,3,DATE_SUB(NOW(3),INTERVAL 40 DAY)),
(2,'DEV-002','Quạt thông gió A1','FAN','Nhà kính A - Khu 1',1,27,'ACTIVE',0,NULL,DATE_SUB(NOW(3),INTERVAL 1 DAY),JSON_OBJECT('localAutomation',TRUE,'fanThresholds',JSON_OBJECT('onTempC',32,'offTempC',30,'onHumidityPct',85,'offHumidityPct',80),'auto',JSON_OBJECT('enabled',TRUE,'preset','FAN_HYSTERESIS')),1,1,DATE_SUB(NOW(3),INTERVAL 1 DAY)),
(3,'DEV-003','Bơm B1 - kiểm tra lỗi','PUMP','Nhà kính B - Khu 2',2,26,'FAULT',0,DATE_SUB(NOW(3),INTERVAL 20 MINUTE),DATE_SUB(NOW(3),INTERVAL 20 MINUTE),JSON_OBJECT('auto',JSON_OBJECT('enabled',FALSE)),2,1,DATE_SUB(NOW(3),INTERVAL 30 DAY)),
(4,'DEV-004','Cảm biến độ ẩm đất S1','SENSOR','Nhà kính A - Khu 1',1,34,'ACTIVE',0,NULL,DATE_SUB(NOW(3),INTERVAL 35 DAY),JSON_OBJECT('metrics',JSON_ARRAY('SOIL_MOISTURE')),0,0,DATE_SUB(NOW(3),INTERVAL 35 DAY)),
(5,'DEV-005','Cảm biến DHT11','SENSOR','Nhà kính A - Khu 1',1,4,'ACTIVE',0,NULL,DATE_SUB(NOW(3),INTERVAL 32 DAY),JSON_OBJECT('metrics',JSON_ARRAY('AIR_TEMPERATURE','AIR_HUMIDITY')),0,0,DATE_SUB(NOW(3),INTERVAL 32 DAY)),
(6,'DEV-006','Cảm biến cũ H1 (đã ngừng dùng)','SENSOR','Nhà kính A - Khu 1',1,NULL,'DECOMMISSIONED',0,NULL,DATE_SUB(NOW(3),INTERVAL 1 DAY),JSON_OBJECT(),0,0,DATE_SUB(NOW(3),INTERVAL 28 DAY)),
(7,'DEV-007','Cảm biến đất S2','SENSOR','Nhà kính B - Khu 2',2,NULL,'MAINTENANCE',0,NULL,DATE_SUB(NOW(3),INTERVAL 25 DAY),JSON_OBJECT(),1,0,DATE_SUB(NOW(3),INTERVAL 25 DAY))
ON DUPLICATE KEY UPDATE `name`=VALUES(`name`),`type`=VALUES(`type`),`location`=VALUES(`location`),`nodeId`=VALUES(`nodeId`),`gpioPin`=VALUES(`gpioPin`),`lifecycle`=VALUES(`lifecycle`),`isOn`=VALUES(`isOn`),`stateChangedAt`=VALUES(`stateChangedAt`),`lifecycleChangedAt`=VALUES(`lifecycleChangedAt`),`config`=VALUES(`config`),`configVersion`=VALUES(`configVersion`),`configAppliedVersion`=VALUES(`configAppliedVersion`);

-- Camera gửi ảnh trực tiếp bằng HTTP POST /api/camera/media.
-- Không seed token bí mật; Admin cấp token sau khi đăng nhập qua API.
INSERT INTO `devices` (`id`,`deviceCode`,`name`,`type`,`location`,`nodeId`,`lifecycle`,`isOn`,`config`,`configVersion`,`configAppliedVersion`,`createdAt`) VALUES
(8,'CAM-001','Camera điện thoại Nhà kính A','CAMERA','Nhà kính A - Khu 1',NULL,'REGISTERED',0,JSON_OBJECT('captureIntervalSeconds',60),0,0,NOW(3))
ON DUPLICATE KEY UPDATE `name`=VALUES(`name`),`type`=VALUES(`type`),`location`=VALUES(`location`),`lifecycle`=VALUES(`lifecycle`),`config`=VALUES(`config`);

INSERT INTO `userDevices` (`userId`,`deviceId`,`assignedAt`) VALUES
(2,1,DATE_SUB(NOW(3),INTERVAL 30 DAY)),(2,2,DATE_SUB(NOW(3),INTERVAL 30 DAY)),(2,3,DATE_SUB(NOW(3),INTERVAL 30 DAY)),(2,4,DATE_SUB(NOW(3),INTERVAL 30 DAY)),
(3,4,DATE_SUB(NOW(3),INTERVAL 25 DAY)),(3,5,DATE_SUB(NOW(3),INTERVAL 25 DAY)),(3,6,DATE_SUB(NOW(3),INTERVAL 25 DAY)),(3,7,DATE_SUB(NOW(3),INTERVAL 25 DAY)),
(4,1,DATE_SUB(NOW(3),INTERVAL 15 DAY)),(4,4,DATE_SUB(NOW(3),INTERVAL 15 DAY)),
(5,5,DATE_SUB(NOW(3),INTERVAL 10 DAY)),(5,6,DATE_SUB(NOW(3),INTERVAL 10 DAY))
ON DUPLICATE KEY UPDATE `assignedAt`=VALUES(`assignedAt`);

-- 12 timestamp buckets x 3 metrics; every triple is grouped into one chart point.
SET @t01 = DATE_SUB(NOW(3), INTERVAL 60 MINUTE);
SET @t02 = DATE_SUB(NOW(3), INTERVAL 55 MINUTE);
SET @t03 = DATE_SUB(NOW(3), INTERVAL 50 MINUTE);
SET @t04 = DATE_SUB(NOW(3), INTERVAL 45 MINUTE);
SET @t05 = DATE_SUB(NOW(3), INTERVAL 40 MINUTE);
SET @t06 = DATE_SUB(NOW(3), INTERVAL 35 MINUTE);
SET @t07 = DATE_SUB(NOW(3), INTERVAL 30 MINUTE);
SET @t08 = DATE_SUB(NOW(3), INTERVAL 25 MINUTE);
SET @t09 = DATE_SUB(NOW(3), INTERVAL 20 MINUTE);
SET @t10 = DATE_SUB(NOW(3), INTERVAL 15 MINUTE);
SET @t11 = DATE_SUB(NOW(3), INTERVAL 10 MINUTE);
SET @t12 = DATE_SUB(NOW(3), INTERVAL 5 MINUTE);
INSERT INTO `sensorReadings` (`deviceId`,`metric`,`recordedAt`,`value`,`isBackfilled`,`receivedAt`) VALUES
(4,'SOIL_MOISTURE',@t01,49.0,0,NOW(3)),(4,'AIR_TEMPERATURE',@t01,25.9,0,NOW(3)),(4,'AIR_HUMIDITY',@t01,70.0,0,NOW(3)),
(4,'SOIL_MOISTURE',@t02,47.0,0,NOW(3)),(4,'AIR_TEMPERATURE',@t02,26.1,0,NOW(3)),(4,'AIR_HUMIDITY',@t02,69.0,0,NOW(3)),
(4,'SOIL_MOISTURE',@t03,46.0,0,NOW(3)),(4,'AIR_TEMPERATURE',@t03,26.5,0,NOW(3)),(4,'AIR_HUMIDITY',@t03,67.5,0,NOW(3)),
(4,'SOIL_MOISTURE',@t04,44.0,0,NOW(3)),(4,'AIR_TEMPERATURE',@t04,26.8,0,NOW(3)),(4,'AIR_HUMIDITY',@t04,66.0,0,NOW(3)),
(4,'SOIL_MOISTURE',@t05,43.0,0,NOW(3)),(4,'AIR_TEMPERATURE',@t05,27.0,0,NOW(3)),(4,'AIR_HUMIDITY',@t05,65.0,0,NOW(3)),
(4,'SOIL_MOISTURE',@t06,42.0,0,NOW(3)),(4,'AIR_TEMPERATURE',@t06,27.2,0,NOW(3)),(4,'AIR_HUMIDITY',@t06,64.0,0,NOW(3)),
(4,'SOIL_MOISTURE',@t07,41.0,0,NOW(3)),(4,'AIR_TEMPERATURE',@t07,27.6,0,NOW(3)),(4,'AIR_HUMIDITY',@t07,63.0,0,NOW(3)),
(4,'SOIL_MOISTURE',@t08,40.0,0,NOW(3)),(4,'AIR_TEMPERATURE',@t08,27.8,0,NOW(3)),(4,'AIR_HUMIDITY',@t08,62.0,0,NOW(3)),
(4,'SOIL_MOISTURE',@t09,39.0,0,NOW(3)),(4,'AIR_TEMPERATURE',@t09,27.9,0,NOW(3)),(4,'AIR_HUMIDITY',@t09,61.0,0,NOW(3)),
(4,'SOIL_MOISTURE',@t10,37.0,0,NOW(3)),(4,'AIR_TEMPERATURE',@t10,28.1,0,NOW(3)),(4,'AIR_HUMIDITY',@t10,60.0,0,NOW(3)),
(4,'SOIL_MOISTURE',@t11,35.0,0,NOW(3)),(4,'AIR_TEMPERATURE',@t11,28.3,0,NOW(3)),(4,'AIR_HUMIDITY',@t11,59.0,0,NOW(3)),
(4,'SOIL_MOISTURE',@t12,34.0,0,NOW(3)),(4,'AIR_TEMPERATURE',@t12,28.4,0,NOW(3)),(4,'AIR_HUMIDITY',@t12,58.0,0,NOW(3))
ON DUPLICATE KEY UPDATE `value`=VALUES(`value`),`isBackfilled`=VALUES(`isBackfilled`),`receivedAt`=VALUES(`receivedAt`);

INSERT INTO `treatments` (`id`,`diseaseId`,`deficiencyId`,`type`,`instructions`,`activeIngredient`,`dosageText`,`intervalDays`,`sourceReference`) VALUES
(1,1,NULL,'BIOLOGICAL','DEMO: Loại bỏ lá bệnh, vệ sinh dụng cụ và theo dõi cây. Đây là mô tả minh họa để kiểm thử giao diện, không phải khuyến cáo thực tế.',NULL,'Dữ liệu minh họa',7,'DEMO DATA ONLY — cần chuyên gia bảo vệ thực vật xác minh trước khi áp dụng.'),
(2,1,NULL,'CHEMICAL','DEMO: Đây là bản ghi giả lập để kiểm tra giao diện. Không sử dụng làm chỉ dẫn phun thuốc.', 'DEMO-ACTIVE-INGREDIENT','Không áp dụng — dữ liệu demo',7,'DEMO DATA ONLY — không phải phác đồ hóa học thực tế.'),
(3,2,NULL,'BIOLOGICAL','DEMO: Thu gom lá bị ảnh hưởng, vệ sinh khu trồng và theo dõi diễn biến. Nội dung chỉ nhằm hiển thị thử nghiệm.',NULL,'Dữ liệu minh họa',7,'DEMO DATA ONLY — cần xác minh bởi chuyên gia trước khi sử dụng.'),
(4,2,NULL,'CHEMICAL','DEMO: Bản ghi hóa học giả lập, không phải khuyến cáo nông học.', 'DEMO-ACTIVE-INGREDIENT','Không áp dụng — dữ liệu demo',7,'DEMO DATA ONLY — không phải phác đồ hóa học thực tế.')
ON DUPLICATE KEY UPDATE `diseaseId`=VALUES(`diseaseId`),`type`=VALUES(`type`),`instructions`=VALUES(`instructions`),`activeIngredient`=VALUES(`activeIngredient`),`dosageText`=VALUES(`dosageText`),`intervalDays`=VALUES(`intervalDays`),`sourceReference`=VALUES(`sourceReference`);

INSERT INTO `leafAnalyses` (`id`,`eventId`,`deviceId`,`capturedAt`,`diseaseId`,`confidence`,`boundingBoxes`,`aiResult`,`imagePath`,`imageUrl`,`cloudinaryPublicId`,`imageSha256`,`modelVersion`,`inferenceMs`,`receivedAt`) VALUES
(1,'demo-ai-event-0001',8,DATE_SUB(NOW(3),INTERVAL 22 MINUTE),1,0.9300,JSON_ARRAY(JSON_OBJECT('x',0.22,'y',0.18,'width',0.47,'height',0.55)),NULL,NULL,NULL,NULL,NULL,'plant-ai-v3',241,DATE_SUB(NOW(3),INTERVAL 21 MINUTE)),
(2,'demo-ai-event-0002',NULL,DATE_SUB(NOW(3),INTERVAL 48 MINUTE),2,0.8700,JSON_ARRAY(JSON_OBJECT('x',0.30,'y',0.24,'width',0.38,'height',0.41)),NULL,NULL,NULL,NULL,NULL,'plant-ai-v3',218,DATE_SUB(NOW(3),INTERVAL 47 MINUTE)),
(3,'demo-ai-event-0003',NULL,DATE_SUB(NOW(3),INTERVAL 75 MINUTE),3,0.9850,NULL,NULL,NULL,NULL,NULL,'plant-ai-v3',163,DATE_SUB(NOW(3),INTERVAL 74 MINUTE))
ON DUPLICATE KEY UPDATE `deviceId`=VALUES(`deviceId`),`capturedAt`=VALUES(`capturedAt`),`diseaseId`=VALUES(`diseaseId`),`confidence`=VALUES(`confidence`),`boundingBoxes`=VALUES(`boundingBoxes`),`aiResult`=VALUES(`aiResult`),`imagePath`=VALUES(`imagePath`),`imageUrl`=VALUES(`imageUrl`),`cloudinaryPublicId`=VALUES(`cloudinaryPublicId`),`imageSha256`=VALUES(`imageSha256`),`modelVersion`=VALUES(`modelVersion`),`inferenceMs`=VALUES(`inferenceMs`),`receivedAt`=VALUES(`receivedAt`);

INSERT INTO `alerts` (`id`,`type`,`severity`,`status`,`title`,`message`,`deviceId`,`analysisId`,`createdAt`,`acknowledgedBy`,`acknowledgedAt`,`resolvedBy`,`resolvedAt`,`resolutionNote`) VALUES
(1,'disease','CRITICAL','NEW','Phát hiện bệnh mốc sương','Bệnh: Bệnh mốc sương (độ tin cậy 93%)',NULL,1,DATE_SUB(NOW(3),INTERVAL 20 MINUTE),NULL,NULL,NULL,NULL,NULL),
(2,'sensor_threshold','WARNING','NEW','Độ ẩm đất đang thấp','Độ ẩm đất 34% — thấp hơn ngưỡng cài đặt 40%.',1,NULL,DATE_SUB(NOW(3),INTERVAL 8 MINUTE),NULL,NULL,NULL,NULL,NULL),
(3,'offline','WARNING','ACKNOWLEDGED','Node khu B mất kết nối','NODE-002 chưa gửi heartbeat trong thời gian quy định.',7,NULL,DATE_SUB(NOW(3),INTERVAL 2 HOUR),2,DATE_SUB(NOW(3),INTERVAL 90 MINUTE),NULL,NULL,NULL),
(4,'fault','CRITICAL','NEW','Bơm B1 báo lỗi','Thiết bị đang ở vòng đời FAULT, cần kiểm tra trước khi vận hành.',3,NULL,DATE_SUB(NOW(3),INTERVAL 18 MINUTE),NULL,NULL,NULL,NULL,NULL),
(5,'disease','WARNING','NEW','Phát hiện bệnh đốm vòng','Bệnh: Bệnh đốm vòng (độ tin cậy 87%)',NULL,2,DATE_SUB(NOW(3),INTERVAL 46 MINUTE),NULL,NULL,NULL,NULL,NULL),
(6,'system','INFO','RESOLVED','Kiểm tra hệ thống hoàn tất','Sự kiện minh họa đã xử lý.',1,NULL,DATE_SUB(NOW(3),INTERVAL 1 DAY),1,DATE_SUB(NOW(3),INTERVAL 1 DAY),1,DATE_SUB(NOW(3),INTERVAL 23 HOUR),'Đã xác nhận dữ liệu demo.')
ON DUPLICATE KEY UPDATE `type`=VALUES(`type`),`severity`=VALUES(`severity`),`status`=VALUES(`status`),`title`=VALUES(`title`),`message`=VALUES(`message`),`deviceId`=VALUES(`deviceId`),`analysisId`=VALUES(`analysisId`),`createdAt`=VALUES(`createdAt`),`acknowledgedBy`=VALUES(`acknowledgedBy`),`acknowledgedAt`=VALUES(`acknowledgedAt`),`resolvedBy`=VALUES(`resolvedBy`),`resolvedAt`=VALUES(`resolvedAt`),`resolutionNote`=VALUES(`resolutionNote`);

INSERT INTO `deviceCommands` (`id`,`commandUuid`,`deviceId`,`turnOn`,`source`,`issuedBy`,`alertId`,`sensorValue`,`status`,`resultMessage`,`createdAt`,`sentAt`,`ackedAt`) VALUES
(1,'d6000000-0000-4000-8000-000000000001',1,1,'MANUAL',2,NULL,34.00,'ACKED','DEMO: ACK đã nhận từ Node.',DATE_SUB(NOW(3),INTERVAL 16 MINUTE),DATE_SUB(NOW(3),INTERVAL 16 MINUTE),DATE_SUB(NOW(3),INTERVAL 15 MINUTE)),
(2,'d6000000-0000-4000-8000-000000000002',2,1,'AUTO',NULL,NULL,38.50,'FAILED','DEMO: Không nhận ACK trong thời gian chờ.',DATE_SUB(NOW(3),INTERVAL 2 HOUR),DATE_SUB(NOW(3),INTERVAL 2 HOUR),NULL),
(3,'d6000000-0000-4000-8000-000000000003',3,0,'ALERT',NULL,4,NULL,'TIMEOUT','DEMO: Không gửi được do Node offline.',DATE_SUB(NOW(3),INTERVAL 17 MINUTE),DATE_SUB(NOW(3),INTERVAL 17 MINUTE),NULL)
ON DUPLICATE KEY UPDATE `deviceId`=VALUES(`deviceId`),`turnOn`=VALUES(`turnOn`),`source`=VALUES(`source`),`issuedBy`=VALUES(`issuedBy`),`alertId`=VALUES(`alertId`),`sensorValue`=VALUES(`sensorValue`),`status`=VALUES(`status`),`resultMessage`=VALUES(`resultMessage`),`createdAt`=VALUES(`createdAt`),`sentAt`=VALUES(`sentAt`),`ackedAt`=VALUES(`ackedAt`);

INSERT INTO `auditLogs` (`id`,`userId`,`action`,`entityType`,`entityId`,`detail`,`success`,`createdAt`) VALUES
(1,1,'auth.login','user',1,JSON_OBJECT('username','admin','source','demo'),1,DATE_SUB(NOW(3),INTERVAL 5 MINUTE)),
(2,1,'user.create','user',2,JSON_OBJECT('username','operator1','role','operator','source','demo'),1,DATE_SUB(NOW(3),INTERVAL 3 DAY)),
(3,2,'device.command','device',1,JSON_OBJECT('command','turnOn','source','demo'),1,DATE_SUB(NOW(3),INTERVAL 16 MINUTE)),
(4,1,'device.config_update','device',1,JSON_OBJECT('configVersion',3,'source','demo'),1,DATE_SUB(NOW(3),INTERVAL 1 HOUR)),
(5,NULL,'analysis.camera_received','leafAnalysis',1,JSON_OBJECT('eventId','demo-ai-event-0001','imageSaved',TRUE,'source','demo'),1,DATE_SUB(NOW(3),INTERVAL 21 MINUTE)),
(6,NULL,'node.offline','node',2,JSON_OBJECT('nodeCode','NODE-002','source','demo'),1,DATE_SUB(NOW(3),INTERVAL 2 HOUR)),
(7,2,'authz.denied','device',3,JSON_OBJECT('reason','demo denied request'),0,DATE_SUB(NOW(3),INTERVAL 90 MINUTE))
ON DUPLICATE KEY UPDATE `userId`=VALUES(`userId`),`action`=VALUES(`action`),`entityType`=VALUES(`entityType`),`entityId`=VALUES(`entityId`),`detail`=VALUES(`detail`),`success`=VALUES(`success`),`createdAt`=VALUES(`createdAt`);

-- Thống kê nhanh để kiểm tra seed đã vào database.
SELECT 'users' AS table_name, COUNT(*) AS total FROM `users`
UNION ALL SELECT 'nodes', COUNT(*) FROM `nodes`
UNION ALL SELECT 'devices', COUNT(*) FROM `devices`
UNION ALL SELECT 'sensorReadings', COUNT(*) FROM `sensorReadings`
UNION ALL SELECT 'diseases', COUNT(*) FROM `diseases`
UNION ALL SELECT 'treatments', COUNT(*) FROM `treatments`
UNION ALL SELECT 'leafAnalyses', COUNT(*) FROM `leafAnalyses`
UNION ALL SELECT 'cameraTokens', COUNT(*) FROM `cameraTokens`
UNION ALL SELECT 'camera_media', COUNT(*) FROM `camera_media`
UNION ALL SELECT 'alerts', COUNT(*) FROM `alerts`
UNION ALL SELECT 'deviceCommands', COUNT(*) FROM `deviceCommands`
UNION ALL SELECT 'auditLogs', COUNT(*) FROM `auditLogs`;
