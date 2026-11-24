-- ============================================================================
-- IoT Smart Agriculture - schema chuan cho Backend Sequelize hien tai
-- MySQL 8.0+ | Nguon schema: Backend/src/models/*.model.js + models/index.js
-- Khong import smart_agri_mysql_demo.sql hoac migrations cu vao database moi.
-- ============================================================================

CREATE DATABASE IF NOT EXISTS `iot`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE `iot`;

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 1. users: tai khoan va RBAC
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(50) NOT NULL,
  `email` VARCHAR(255) NOT NULL,
  `passwordHash` VARCHAR(255) NOT NULL,
  `fullName` VARCHAR(100) NOT NULL,
  `role` ENUM('admin','operator','viewer') NOT NULL DEFAULT 'viewer',
  `isActive` TINYINT(1) NOT NULL DEFAULT 1,
  `lastLoginAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `users_username_unique` (`username`),
  UNIQUE KEY `users_email_unique` (`email`)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC
  DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. nodes: ESP32, claim identity va Dynamic Security metadata
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
  `claimTokenHash` VARCHAR(64) NULL,
  `claimTokenExpiresAt` DATETIME(3) NULL,
  `claimConsumedAt` DATETIME(3) NULL,
  `claimFailedAt` DATETIME(3) NULL,
  `claimedAt` DATETIME(3) NULL,
  `revokedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `nodes_nodeCode_unique` (`nodeCode`),
  UNIQUE KEY `nodes_mqttUsername_unique` (`mqttUsername`),
  UNIQUE KEY `nodes_mqttRoleName_unique` (`mqttRoleName`),
  UNIQUE KEY `nodes_macAddress_unique` (`macAddress`)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC
  DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. devices: SENSOR/PUMP/FAN va CAMERA (camera dien thoai)
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
  `config` JSON NOT NULL DEFAULT (JSON_OBJECT()),
  `configVersion` INT NOT NULL DEFAULT 0,
  `configAppliedVersion` INT NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `devices_deviceCode_unique` (`deviceCode`),
  UNIQUE KEY `devices_pendingLifecycleCommandUuid_unique` (`pendingLifecycleCommandUuid`),
  KEY `idx_devices_nodeId` (`nodeId`),
  CONSTRAINT `fk_devices_nodeId`
    FOREIGN KEY (`nodeId`) REFERENCES `nodes` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC
  DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. userDevices: pham vi truy cap User <-> Device
CREATE TABLE IF NOT EXISTS `userDevices` (
  `userId` INT NOT NULL,
  `deviceId` INT NOT NULL,
  `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (`userId`, `deviceId`),
  KEY `idx_userDevices_deviceId` (`deviceId`),
  CONSTRAINT `fk_userDevices_userId`
    FOREIGN KEY (`userId`) REFERENCES `users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_userDevices_deviceId`
    FOREIGN KEY (`deviceId`) REFERENCES `devices` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC
  DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. sensorReadings: PK composite chong trung theo device + metric + recordedAt
CREATE TABLE IF NOT EXISTS `sensorReadings` (
  `deviceId` INT NOT NULL,
  `metric` ENUM('SOIL_MOISTURE','AIR_TEMPERATURE','AIR_HUMIDITY') NOT NULL,
  `recordedAt` DATETIME(3) NOT NULL,
  `value` DECIMAL(8,2) NOT NULL,
  `sourceBootCount` INT NULL,
  `sourceSeq` BIGINT NULL,
  `isBackfilled` TINYINT(1) NOT NULL DEFAULT 0,
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (`deviceId`, `metric`, `recordedAt`),
  KEY `idx_sensorReadings_recordedAt` (`recordedAt`),
  CONSTRAINT `fk_sensorReadings_deviceId`
    FOREIGN KEY (`deviceId`) REFERENCES `devices` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC
  DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. leafAnalyses: ket qua nhan dien AI. diseaseName la chuoi nhan/ten lop
-- tra ve tu AI theo implementation hien tai, KHONG phai FK/danh muc Disease.
CREATE TABLE IF NOT EXISTS `leafAnalyses` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `eventId` VARCHAR(100) NULL,
  `deviceId` INT NULL,
  `uploadedBy` INT NULL,
  `capturedAt` DATETIME(3) NOT NULL,
  `diseaseName` VARCHAR(180) NOT NULL,
  `modelLabel` VARCHAR(180) NULL,
  `confidence` DECIMAL(5,4) NOT NULL,
  `boundingBoxes` JSON NULL,
  `predictions` JSON NULL,
  `aiResult` JSON NULL,
  `imagePath` VARCHAR(500) NULL,
  `imageUrl` VARCHAR(1000) NULL,
  `cloudinaryPublicId` VARCHAR(255) NULL,
  `imageSha256` CHAR(64) NULL,
  `modelVersion` VARCHAR(50) NOT NULL,
  `inferenceMs` INT NULL,
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `leafAnalyses_eventId_unique` (`eventId`),
  KEY `idx_leafAnalyses_uploadedBy` (`uploadedBy`),
  KEY `idx_leafAnalyses_deviceId` (`deviceId`),
  CONSTRAINT `fk_leafAnalyses_deviceId`
    FOREIGN KEY (`deviceId`) REFERENCES `devices` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_leafAnalyses_uploadedBy`
    FOREIGN KEY (`uploadedBy`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC
  DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. alerts: canh bao he thong, offline, fault va sensor threshold
CREATE TABLE IF NOT EXISTS `alerts` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `type` ENUM('offline','fault','system','sensor_threshold') NOT NULL,
  `severity` ENUM('CRITICAL','WARNING','INFO') NOT NULL DEFAULT 'WARNING',
  `status` ENUM('NEW','ACKNOWLEDGED','RESOLVED') NOT NULL DEFAULT 'NEW',
  `title` VARCHAR(200) NOT NULL,
  `message` TEXT NULL,
  `deviceId` INT NULL,
  `analysisId` INT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  `acknowledgedBy` INT NULL,
  `acknowledgedAt` DATETIME(3) NULL,
  `resolvedBy` INT NULL,
  `resolvedAt` DATETIME(3) NULL,
  `resolutionNote` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_alerts_deviceId` (`deviceId`),
  KEY `idx_alerts_analysisId` (`analysisId`),
  KEY `idx_alerts_acknowledgedBy` (`acknowledgedBy`),
  KEY `idx_alerts_resolvedBy` (`resolvedBy`),
  CONSTRAINT `fk_alerts_deviceId`
    FOREIGN KEY (`deviceId`) REFERENCES `devices` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_alerts_analysisId`
    FOREIGN KEY (`analysisId`) REFERENCES `leafAnalyses` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_alerts_acknowledgedBy`
    FOREIGN KEY (`acknowledgedBy`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_alerts_resolvedBy`
    FOREIGN KEY (`resolvedBy`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC
  DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. deviceCommands: lich su lenh + ACK tu Firmware
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
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  `sentAt` DATETIME(3) NULL,
  `ackedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `deviceCommands_commandUuid_unique` (`commandUuid`),
  KEY `idx_deviceCommands_deviceId_createdAt` (`deviceId`, `createdAt`),
  KEY `idx_deviceCommands_issuedBy` (`issuedBy`),
  KEY `idx_deviceCommands_alertId` (`alertId`),
  KEY `idx_deviceCommands_status_sentAt` (`status`, `sentAt`),
  CONSTRAINT `fk_deviceCommands_deviceId`
    FOREIGN KEY (`deviceId`) REFERENCES `devices` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_deviceCommands_issuedBy`
    FOREIGN KEY (`issuedBy`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_deviceCommands_alertId`
    FOREIGN KEY (`alertId`) REFERENCES `alerts` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC
  DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. auditLogs: userId NULL khi user da xoa / thao tac he thong
CREATE TABLE IF NOT EXISTS `auditLogs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `userId` INT NULL,
  `action` VARCHAR(60) NOT NULL,
  `entityType` VARCHAR(40) NULL,
  `entityId` INT NULL,
  `detail` JSON NULL,
  `success` TINYINT(1) NOT NULL DEFAULT 1,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (`id`),
  KEY `idx_auditLogs_userId` (`userId`),
  KEY `idx_auditLogs_createdAt` (`createdAt`),
  CONSTRAINT `fk_auditLogs_userId`
    FOREIGN KEY (`userId`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC
  DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. cameraTokens: chi luu SHA-256 token, khong luu token tho
CREATE TABLE IF NOT EXISTS `cameraTokens` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `deviceId` INT NOT NULL,
  `tokenHash` CHAR(64) NOT NULL,
  `expiresAt` DATETIME(3) NULL,
  `revokedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  `lastUsedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `cameraTokens_deviceId_unique` (`deviceId`),
  UNIQUE KEY `cameraTokens_tokenHash_unique` (`tokenHash`),
  CONSTRAINT `fk_cameraTokens_deviceId`
    FOREIGN KEY (`deviceId`) REFERENCES `devices` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC
  DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. camera_media: media fallback tren dia; cameraId la devices.deviceCode.
-- Model khai bao constraints:false, vi vay KHONG tao FK camera_media.cameraId.
CREATE TABLE IF NOT EXISTS `camera_media` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `eventId` VARCHAR(120) NOT NULL,
  `cameraId` VARCHAR(60) NOT NULL,
  `requestId` VARCHAR(120) NULL,
  `mediaType` ENUM('image','video') NOT NULL DEFAULT 'image',
  `mimeType` VARCHAR(60) NOT NULL,
  `filename` VARCHAR(255) NOT NULL,
  `sizeBytes` INT UNSIGNED NOT NULL,
  `sha256` CHAR(64) NOT NULL,
  `capturedAt` DATETIME(3) NULL,
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `camera_media_eventId_unique` (`eventId`),
  KEY `idx_camera_media_camera` (`cameraId`),
  KEY `idx_camera_media_captured` (`capturedAt`)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC
  DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

