-- IoT Control Firmware v1.2: one MQTT principal per Node + explicit Admin activation.
-- Run once on an existing database after making a backup. Existing Node/Device data is preserved.
ALTER TABLE `nodes`
  ADD COLUMN `mqttUsername` VARCHAR(80) NULL AFTER `isRevoked`,
  ADD COLUMN `mqttRoleName` VARCHAR(100) NULL AFTER `mqttUsername`,
  ADD COLUMN `mqttProvisionedAt` DATETIME(3) NULL AFTER `mqttRoleName`,
  ADD COLUMN `mqttAccountEnabled` TINYINT(1) NOT NULL DEFAULT 0 AFTER `mqttProvisionedAt`,
  ADD UNIQUE KEY `nodes_mqttUsername_unique` (`mqttUsername`),
  ADD UNIQUE KEY `nodes_mqttRoleName_unique` (`mqttRoleName`);

ALTER TABLE `devices`
  ADD COLUMN `pendingLifecycleCommandUuid` CHAR(36) NULL AFTER `lifecycleChangedAt`,
  ADD COLUMN `pendingLifecycleCommandTo` VARCHAR(30) NULL AFTER `pendingLifecycleCommandUuid`,
  ADD COLUMN `pendingLifecycleCommandSentAt` DATETIME(3) NULL AFTER `pendingLifecycleCommandTo`,
  ADD UNIQUE KEY `devices_pendingLifecycleCommandUuid_unique` (`pendingLifecycleCommandUuid`);
