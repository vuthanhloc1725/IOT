-- Run once on an existing database after a backup. Apply the 20261102 MQTT migration first.
ALTER TABLE `nodes`
  ADD COLUMN `macAddress` VARCHAR(17) NULL AFTER `mqttAccountEnabled`,
  ADD COLUMN `claimTokenHash` CHAR(64) NULL AFTER `macAddress`,
  ADD COLUMN `claimTokenExpiresAt` DATETIME(3) NULL AFTER `claimTokenHash`,
  ADD COLUMN `claimConsumedAt` DATETIME(3) NULL AFTER `claimTokenExpiresAt`,
  ADD COLUMN `claimFailedAt` DATETIME(3) NULL AFTER `claimConsumedAt`,
  ADD COLUMN `claimedAt` DATETIME(3) NULL AFTER `claimFailedAt`,
  ADD UNIQUE KEY `nodes_macAddress_unique` (`macAddress`);
