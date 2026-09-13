-- Finance: account balance reconciliation
--
-- Adds a dated snapshot table so staff can record the *actual* balance shown
-- by Stripe and by the bank at a point in time. The finance dashboard compares
-- each snapshot against the balance computed from the transaction ledger
-- (openingBalanceCents + income - expenses +/- transfers) so the monthly report
-- can be reconciled before it is published.
--
-- Snapshots are additive history — a new "set balance" never overwrites an
-- earlier reading.

CREATE TABLE `financeAccountBalances` (
    `balanceId`        INT          NOT NULL AUTO_INCREMENT,
    `accountId`        INT          NOT NULL,
    `asOfDate`         DATE         NOT NULL,
    `balanceCents`     INT          NOT NULL DEFAULT 0,
    `source`           VARCHAR(20)  NOT NULL DEFAULT 'manual',
    `note`             VARCHAR(255) NULL,
    `createdByUserId`  INT          NOT NULL DEFAULT 0,
    `createdAt`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`balanceId`),
    INDEX `financeAccountBalances_account` (`accountId`),
    INDEX `financeAccountBalances_account_date` (`accountId`, `asOfDate`),
    CONSTRAINT `fk_financeAccountBalances_account`
        FOREIGN KEY (`accountId`) REFERENCES `financeAccounts`(`accountId`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
