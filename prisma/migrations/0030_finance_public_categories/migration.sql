ALTER TABLE `financeCategories`
  ADD COLUMN `isPublic` TINYINT NOT NULL DEFAULT 0 AFTER `isActive`,
  ADD COLUMN `publicName` VARCHAR(100) NULL AFTER `isPublic`,
  ADD COLUMN `publicDescription` VARCHAR(255) NULL AFTER `publicName`,
  ADD COLUMN `publicSortOrder` INT NOT NULL DEFAULT 0 AFTER `publicDescription`;

CREATE INDEX `financeCategories_isPublic_idx` ON `financeCategories`(`isPublic`);
