-- Add annual operations budget items that apply in one renewal month.
ALTER TABLE `financeOperationsBudget`
    ADD COLUMN `cadence` VARCHAR(10) NOT NULL DEFAULT 'monthly' AFTER `currency`,
    ADD COLUMN `annualMonth` TINYINT NULL AFTER `cadence`;
