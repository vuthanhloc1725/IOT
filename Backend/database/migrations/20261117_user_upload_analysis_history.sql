USE `iot`;

ALTER TABLE `leafAnalyses`
  ADD COLUMN `uploadedBy` INT NULL AFTER `deviceId`,
  ADD KEY `idx_leafAnalyses_uploadedBy` (`uploadedBy`),
  ADD CONSTRAINT `fk_leafAnalyses_uploadedBy`
    FOREIGN KEY (`uploadedBy`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO `diseases` (`modelLabel`, `nameVi`, `nameEn`, `isHealthy`) VALUES
  ('anthracnose_leaf_spot', 'Bệnh thán thư', 'Anthracnose leaf spot', 0),
  ('healthy', 'Lá khỏe mạnh', 'Healthy leaf', 1),
  ('straw_mite', 'Nhện hại lá', 'Straw mite damage', 0)
ON DUPLICATE KEY UPDATE
  `nameVi` = VALUES(`nameVi`),
  `nameEn` = VALUES(`nameEn`),
  `isHealthy` = VALUES(`isHealthy`);
