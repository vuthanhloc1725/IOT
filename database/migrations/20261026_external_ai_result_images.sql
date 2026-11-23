-- Chạy một lần trên đúng database trước khi khởi động phiên bản backend mới.
-- Sao lưu database trước khi thực hiện.
-- Thêm eventId để khử trùng MQTT QoS 1; deviceId cho phép NULL đối với kết quả AI bên ngoài.

ALTER TABLE `leafAnalyses`
  MODIFY COLUMN `deviceId` INT NULL,
  ADD COLUMN `eventId` VARCHAR(100) NULL AFTER `id`;

-- Xóa unique index cũ (deviceId, capturedAt) nếu tồn tại, bất kể tên index cũ do Sequelize tạo.
SET @old_analysis_index = (
  SELECT INDEX_NAME
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'leafAnalyses'
    AND NON_UNIQUE = 0
  GROUP BY INDEX_NAME
  HAVING COUNT(*) = 2
     AND SUM(COLUMN_NAME = 'deviceId') = 1
     AND SUM(COLUMN_NAME = 'capturedAt') = 1
  LIMIT 1
);
SET @drop_analysis_index_sql = IF(
  @old_analysis_index IS NULL,
  'SELECT 1',
  CONCAT('ALTER TABLE `leafAnalyses` DROP INDEX `', REPLACE(@old_analysis_index, '`', '``'), '`')
);
PREPARE drop_analysis_index_stmt FROM @drop_analysis_index_sql;
EXECUTE drop_analysis_index_stmt;
DEALLOCATE PREPARE drop_analysis_index_stmt;

CREATE UNIQUE INDEX `leafAnalyses_eventId_unique` ON `leafAnalyses` (`eventId`);
