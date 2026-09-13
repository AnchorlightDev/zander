-- =============================================================================
-- Migration 0031: Per-month operations budget overrides / one-off items
-- =============================================================================
-- financeOperationsBudget is the standing template (never changes month to
-- month). This table holds per-month deviations from it:
--   - budgetItemId set   -> an override of that template line item's amount
--                           for this specific year/month only.
--   - budgetItemId NULL  -> a one-off line item that only exists this
--                           year/month, not part of the template at all.
-- A month with no rows here simply inherits the template as-is.
-- =============================================================================

CREATE TABLE `financeOperationsBudgetMonthly` (
    `monthlyBudgetItemId` INT          NOT NULL AUTO_INCREMENT,
    `year`                SMALLINT     NOT NULL,
    `month`               TINYINT      NOT NULL,
    `budgetItemId`        INT          NULL,
    `categoryId`          INT          NULL,
    `label`               VARCHAR(150) NOT NULL DEFAULT '',
    `monthlyBudgetCents`  INT          NOT NULL DEFAULT 0,
    `currency`            VARCHAR(3)   NOT NULL DEFAULT 'USD',
    `notes`               TEXT         NULL,
    `createdAt`           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt`           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`monthlyBudgetItemId`),
    UNIQUE KEY `financeOperationsBudgetMonthly_override` (`year`, `month`, `budgetItemId`),
    INDEX `financeOperationsBudgetMonthly_period`   (`year`, `month`),
    INDEX `financeOperationsBudgetMonthly_category` (`categoryId`),
    CONSTRAINT `fk_financeOperationsBudgetMonthly_item`
        FOREIGN KEY (`budgetItemId`) REFERENCES `financeOperationsBudget`(`budgetId`) ON DELETE CASCADE,
    CONSTRAINT `fk_financeOperationsBudgetMonthly_category`
        FOREIGN KEY (`categoryId`) REFERENCES `financeCategories`(`categoryId`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
