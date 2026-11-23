-- Labels must match the AI classifier output exactly.
-- Treatment rows should be imported separately for each diseaseId.
INSERT INTO `diseases` (`modelLabel`, `nameVi`, `nameEn`, `isHealthy`) VALUES
('anthracnose_leaf_spot', 'Bệnh thán thư', 'Anthracnose leaf spot', 0),
('healthy', 'Lá khỏe mạnh', 'Healthy leaf', 1),
('straw_mite', 'Nhện hại lá', 'Straw mite', 0)
ON DUPLICATE KEY UPDATE
  `nameVi`=VALUES(`nameVi`),
  `nameEn`=VALUES(`nameEn`),
  `isHealthy`=VALUES(`isHealthy`);
