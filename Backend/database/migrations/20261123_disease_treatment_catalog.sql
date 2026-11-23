-- Disease/Treatment catalog normalization
-- MySQL 8.0+; take a database backup before running this script.
-- Run once against the database used by this Backend version.
-- Preview records that will be removed because they are not assigned to a disease:
-- SELECT id, diseaseId, type, activeIngredient FROM treatments WHERE diseaseId IS NULL;
-- The cleanup removes unassigned treatment records: the new domain model requires
-- every Treatment to belong to exactly one Disease.

-- 1) Add a meaningful display name for each treatment.
SET @has_name = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'treatments' AND COLUMN_NAME = 'name'
);
SET @sql = IF(@has_name = 0,
  'ALTER TABLE treatments ADD COLUMN name VARCHAR(150) NULL AFTER diseaseId',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE treatments
SET name = CASE
  WHEN activeIngredient IS NOT NULL AND TRIM(activeIngredient) <> ''
    THEN CONCAT('Sử dụng ', TRIM(activeIngredient))
  ELSE CONCAT('Phương pháp điều trị #', id)
END
WHERE name IS NULL OR TRIM(name) = '';

-- 2) Remove records that cannot be attached to a disease in the new model.
DELETE treatment
FROM treatments AS treatment
LEFT JOIN diseases AS disease ON disease.id = treatment.diseaseId
WHERE treatment.diseaseId IS NULL OR disease.id IS NULL;

-- 3) Remove any legacy FK that may protect the old optional association column.
SET @legacy_fk = NULL;
SELECT CONSTRAINT_NAME INTO @legacy_fk
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'treatments'
  AND COLUMN_NAME = 'deficiencyId'
  AND REFERENCED_TABLE_NAME IS NOT NULL
LIMIT 1;
SET @sql = IF(@legacy_fk IS NULL, 'SELECT 1',
  CONCAT('ALTER TABLE treatments DROP FOREIGN KEY `', REPLACE(@legacy_fk, '`', '``'), '`'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4) Remove the legacy association column if it exists.
SET @has_legacy_column = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'treatments' AND COLUMN_NAME = 'deficiencyId'
);
SET @sql = IF(@has_legacy_column > 0,
  'ALTER TABLE treatments DROP COLUMN deficiencyId',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 5) Enforce the one-Disease-to-many-Treatments relationship.
ALTER TABLE treatments
  MODIFY COLUMN diseaseId INT NOT NULL,
  MODIFY COLUMN name VARCHAR(150) NOT NULL;

-- Add the Disease FK only when the database does not already have one.
SET @has_disease_fk = (
  SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'treatments'
    AND COLUMN_NAME = 'diseaseId'
    AND REFERENCED_TABLE_NAME = 'diseases'
);
SET @sql = IF(@has_disease_fk = 0,
  'ALTER TABLE treatments ADD CONSTRAINT fk_treatments_disease FOREIGN KEY (diseaseId) REFERENCES diseases(id) ON UPDATE CASCADE ON DELETE RESTRICT',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Final verification:
-- SHOW COLUMNS FROM treatments;
-- SELECT id, diseaseId, name, type FROM treatments ORDER BY diseaseId, id;
