-- Run once on an existing IoT Control database after taking a backup.
-- Adds the FAN actuator type required by Firmware v1.2. Existing records are preserved.
ALTER TABLE `devices`
  MODIFY COLUMN `type` ENUM('PUMP','FAN','SENSOR','CAMERA') NOT NULL;


-- Firmware reports boot counter (bc), uptime (up) and sequence (seq).
ALTER TABLE `nodes`
  ADD COLUMN `firmwareBootCount` INT NULL AFTER `lastHeartbeatAt`,
  ADD COLUMN `firmwareBootStartedAt` DATETIME(3) NULL AFTER `firmwareBootCount`;

ALTER TABLE `sensorReadings`
  ADD COLUMN `sourceBootCount` INT NULL AFTER `value`,
  ADD COLUMN `sourceSeq` BIGINT NULL AFTER `sourceBootCount`,
  ADD UNIQUE KEY `uq_sensorReadings_source_seq` (`deviceId`,`metric`,`sourceBootCount`,`sourceSeq`);
