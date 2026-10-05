-- Removing a standing budget item ends it from a given month onwards instead
-- of deleting it, so earlier months (and the public reports built from them)
-- keep showing the line. NULL = still running.
ALTER TABLE `financeOperationsBudget`
  ADD COLUMN `removedFromYear` SMALLINT NULL AFTER `isActive`,
  ADD COLUMN `removedFromMonth` TINYINT NULL AFTER `removedFromYear`;
