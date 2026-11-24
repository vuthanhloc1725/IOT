-- Chạy một lần trên database đã được tạo bằng smart_agri_mysql_demo.sql.
-- Backup database trước khi migration.
ALTER TABLE `devices`
  ADD COLUMN `presenceVerifiedAt` DATETIME(3) NULL AFTER `gpioPin`,
  ADD COLUMN `presenceEvidence` VARCHAR(60) NULL AFTER `presenceVerifiedAt`,
  ADD COLUMN `readinessVerifiedAt` DATETIME(3) NULL AFTER `presenceEvidence`,
  ADD COLUMN `readinessEvidence` VARCHAR(80) NULL AFTER `readinessVerifiedAt`;
