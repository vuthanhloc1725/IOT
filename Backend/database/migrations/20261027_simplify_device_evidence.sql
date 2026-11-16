-- Simplify device evidence storage.
-- Safe to run on an existing `devices` table after taking a backup.
-- It ensures the required timestamp/type columns exist, migrates old values,
-- and removes the redundant presenceEvidence/readinessEvidence columns.
-- Run with the target database selected, e.g. mysql -u root -p iot < this_file.sql

DELIMITER $$
DROP PROCEDURE IF EXISTS `migrate_simplify_device_evidence`$$
CREATE PROCEDURE `migrate_simplify_device_evidence`()
BEGIN
  DECLARE v_count INT DEFAULT 0;

  SELECT COUNT(*) INTO v_count
    FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices';
  IF v_count = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Table devices does not exist. Select the correct database and create the schema first.';
  END IF;

  SELECT COUNT(*) INTO v_count FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'presenceVerifiedAt';
  IF v_count = 0 THEN
    ALTER TABLE `devices` ADD COLUMN `presenceVerifiedAt` DATETIME(3) NULL AFTER `gpioPin`;
  END IF;

  SELECT COUNT(*) INTO v_count FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'readinessVerifiedAt';
  IF v_count = 0 THEN
    ALTER TABLE `devices` ADD COLUMN `readinessVerifiedAt` DATETIME(3) NULL AFTER `presenceVerifiedAt`;
  END IF;

  SELECT COUNT(*) INTO v_count FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'readinessType';
  IF v_count = 0 THEN
    ALTER TABLE `devices`
      ADD COLUMN `readinessType` ENUM('SENSOR_TELEMETRY','CURRENT_SENSOR','FLOW_SENSOR') NULL AFTER `readinessVerifiedAt`;
  END IF;

  SELECT COUNT(*) INTO v_count FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'lifecycleChangedAt';
  IF v_count = 0 THEN
    ALTER TABLE `devices` ADD COLUMN `lifecycleChangedAt` DATETIME(3) NULL AFTER `readinessType`;
  END IF;

  -- Migrate the old verbose readiness strings into one of three fixed categories.
  SELECT COUNT(*) INTO v_count FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'readinessEvidence';
  IF v_count > 0 THEN
    SET @simplify_readiness_sql =
      'UPDATE `devices` SET `readinessType` = CASE
         WHEN `readinessEvidence` LIKE ''SENSOR_TELEMETRY:%'' THEN ''SENSOR_TELEMETRY''
         WHEN `readinessEvidence` LIKE ''CURRENT_SENSOR:%'' THEN ''CURRENT_SENSOR''
         WHEN `readinessEvidence` LIKE ''FLOW_SENSOR:%'' THEN ''FLOW_SENSOR''
         ELSE NULL END
       WHERE `readinessType` IS NULL AND `readinessEvidence` IS NOT NULL';
    PREPARE simplify_stmt FROM @simplify_readiness_sql;
    EXECUTE simplify_stmt;
    DEALLOCATE PREPARE simplify_stmt;
  END IF;

  UPDATE `devices`
     SET `lifecycleChangedAt` = COALESCE(`lifecycleChangedAt`, `stateChangedAt`, `createdAt`)
   WHERE `lifecycleChangedAt` IS NULL;

  SELECT COUNT(*) INTO v_count FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'presenceEvidence';
  IF v_count > 0 THEN
    ALTER TABLE `devices` DROP COLUMN `presenceEvidence`;
  END IF;

  SELECT COUNT(*) INTO v_count FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'readinessEvidence';
  IF v_count > 0 THEN
    ALTER TABLE `devices` DROP COLUMN `readinessEvidence`;
  END IF;
END$$
CALL `migrate_simplify_device_evidence`()$$
DROP PROCEDURE `migrate_simplify_device_evidence`$$
DELIMITER ;
