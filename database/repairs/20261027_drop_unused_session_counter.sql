-- Optional cleanup for databases created by an earlier build that used a JWT session counter.
-- Run while connected to the intended schema (for example: iot).
-- No application code depends on this column anymore. This script only removes the unused column.
SET @has_session_counter := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'tokenVersion'
);
SET @drop_session_counter_sql := IF(
  @has_session_counter > 0,
  'ALTER TABLE `users` DROP COLUMN `tokenVersion`',
  'SELECT ''No unused session counter column; nothing to do'' AS message'
);
PREPARE drop_session_counter_stmt FROM @drop_session_counter_sql;
EXECUTE drop_session_counter_stmt;
DEALLOCATE PREPARE drop_session_counter_stmt;
