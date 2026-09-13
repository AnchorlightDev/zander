-- Public-facing blurb shown under each operations budget line item on /finance.
ALTER TABLE `financeOperationsBudget`
  ADD COLUMN `publicDescription` VARCHAR(300) NULL AFTER `label`;

ALTER TABLE `financeOperationsBudgetMonthly`
  ADD COLUMN `publicDescription` VARCHAR(300) NULL AFTER `label`;
