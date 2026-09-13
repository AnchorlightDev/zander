-- Add optional selected or uploaded icons to operations budget items.
ALTER TABLE `financeOperationsBudget`
    ADD COLUMN `iconName` VARCHAR(50) NULL AFTER `annualMonth`,
    ADD COLUMN `iconImageUrl` VARCHAR(500) NULL AFTER `iconName`;

ALTER TABLE `financeOperationsBudgetMonthly`
    ADD COLUMN `iconName` VARCHAR(50) NULL AFTER `currency`,
    ADD COLUMN `iconImageUrl` VARCHAR(500) NULL AFTER `iconName`;
