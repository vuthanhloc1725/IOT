-- Add the full per-class probability output from AI /predict.
-- Run once on an existing database after backup.
ALTER TABLE `leafAnalyses`
  ADD COLUMN `predictions` JSON NULL AFTER `boundingBoxes`;
