-- Chạy đúng một lần trên database đã có bảng devices.
-- Sao lưu DB trước khi chạy. Cột riêng tránh nhầm thời điểm đổi lifecycle với thời điểm bật/tắt bơm.
ALTER TABLE `devices`
  ADD COLUMN `lifecycleChangedAt` DATETIME(3) NULL AFTER `readinessEvidence`;

-- Bản ghi cũ chưa có thời điểm lifecycle riêng; dùng stateChangedAt làm mốc bảo thủ ban đầu.
UPDATE `devices`
SET `lifecycleChangedAt` = COALESCE(`stateChangedAt`, `createdAt`)
WHERE `lifecycleChangedAt` IS NULL;
