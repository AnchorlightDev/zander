-- =============================================================================
-- Migration 0020: Add all missing columns to webstore tables
-- =============================================================================
-- The webstore tables were initially created from an older schema that was
-- missing several columns added later.  This migration is fully idempotent —
-- each column is only added if it doesn't already exist — so it is safe to
-- run on both fresh installs and existing databases.
-- =============================================================================

DROP PROCEDURE IF EXISTS _zander_migrate_0020;

CREATE PROCEDURE _zander_migrate_0020()
BEGIN

    -- -------------------------------------------------------------------------
    -- webstorePurchases
    -- -------------------------------------------------------------------------

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstorePurchases'
          AND COLUMN_NAME  = 'stripePaymentIntentId'
    ) THEN
        ALTER TABLE `webstorePurchases`
            ADD COLUMN `stripePaymentIntentId` VARCHAR(255) NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstorePurchases'
          AND COLUMN_NAME  = 'stripeSubscriptionId'
    ) THEN
        ALTER TABLE `webstorePurchases`
            ADD COLUMN `stripeSubscriptionId` VARCHAR(255) NULL;
        ALTER TABLE `webstorePurchases`
            ADD INDEX `webstorePurchases_subscription` (`stripeSubscriptionId`);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstorePurchases'
          AND COLUMN_NAME  = 'stripeCustomerId'
    ) THEN
        ALTER TABLE `webstorePurchases`
            ADD COLUMN `stripeCustomerId` VARCHAR(255) NULL;
    END IF;

    -- -------------------------------------------------------------------------
    -- webstoreSubscriptions
    -- -------------------------------------------------------------------------

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreSubscriptions'
          AND COLUMN_NAME  = 'stripeCustomerId'
    ) THEN
        ALTER TABLE `webstoreSubscriptions`
            ADD COLUMN `stripeCustomerId` VARCHAR(255) NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreSubscriptions'
          AND COLUMN_NAME  = 'cancelAtPeriodEnd'
    ) THEN
        ALTER TABLE `webstoreSubscriptions`
            ADD COLUMN `cancelAtPeriodEnd` TINYINT(1) NOT NULL DEFAULT 0;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreSubscriptions'
          AND COLUMN_NAME  = 'cancelledAt'
    ) THEN
        ALTER TABLE `webstoreSubscriptions`
            ADD COLUMN `cancelledAt` DATETIME NULL;
    END IF;

    -- -------------------------------------------------------------------------
    -- webstoreCommandRuns
    -- -------------------------------------------------------------------------

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreCommandRuns'
          AND COLUMN_NAME  = 'stripeSubscriptionId'
    ) THEN
        ALTER TABLE `webstoreCommandRuns`
            ADD COLUMN `stripeSubscriptionId` VARCHAR(255) NULL COMMENT 'Set for subscription renewal runs';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreCommandRuns'
          AND COLUMN_NAME  = 'resolvedCommand'
    ) THEN
        ALTER TABLE `webstoreCommandRuns`
            ADD COLUMN `resolvedCommand` TEXT NOT NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreCommandRuns'
          AND COLUMN_NAME  = 'executorTaskId'
    ) THEN
        ALTER TABLE `webstoreCommandRuns`
            ADD COLUMN `executorTaskId` INT NULL;
        ALTER TABLE `webstoreCommandRuns`
            ADD INDEX `webstoreCommandRuns_executor` (`executorTaskId`);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreCommandRuns'
          AND COLUMN_NAME  = 'lastError'
    ) THEN
        ALTER TABLE `webstoreCommandRuns`
            ADD COLUMN `lastError` TEXT NULL;
    END IF;

    -- -------------------------------------------------------------------------
    -- webstoreTransactions
    -- -------------------------------------------------------------------------

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreTransactions'
    ) THEN
        CREATE TABLE `webstoreTransactions` (
            `transactionId`                INT          NOT NULL AUTO_INCREMENT,
            `purchaseId`                   INT          NOT NULL,
            `userId`                       INT          NOT NULL,
            `direction`                    ENUM('incoming','outgoing') NOT NULL,
            `counterpartyMinecraftUsername` VARCHAR(16)  NOT NULL,
            `amountCents`                  INT          NOT NULL,
            `currency`                     VARCHAR(10)  NOT NULL,
            `createdAt`                    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`transactionId`),
            INDEX `webstoreTransactions_user`     (`userId`),
            INDEX `webstoreTransactions_purchase` (`purchaseId`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    END IF;

END;

CALL _zander_migrate_0020();

DROP PROCEDURE IF EXISTS _zander_migrate_0020;
