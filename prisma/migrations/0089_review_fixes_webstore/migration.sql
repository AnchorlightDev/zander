-- =============================================================================
-- Migration 0089 (webstore): webhook retry safety, refunds and revenue sources
-- =============================================================================
--   1. webstoreWebhookEvents.completedAt — set once an event has been fully
--      processed. A claimed row without it is in flight (or its process died),
--      so a Stripe retry can tell "already done" from "try again later", and a
--      stale claim can be taken over instead of the event being lost.
--      Existing rows are all finished events, so they are backfilled as done.
--
--   2. webstoreSubscriptions.lastStripeEventAt — the `created` time of the last
--      Stripe event applied to the row, so an out-of-order
--      customer.subscription.updated cannot roll its status back.
--
--   3. webstoreTransactions.stripeRef — the Stripe object a row came from
--      (checkout session, invoice, refund, dispute). Unique, so a retried
--      webhook cannot write the same payment twice. Renewals and refunds are
--      now written here too, which makes this table the webstore's revenue
--      source; renewals already in the finance ledger are copied in once.
--
--   4. financeTransactions.externalRef — the same idea for the finance ledger
--      rows the webhook writes.
-- =============================================================================

DROP PROCEDURE IF EXISTS _zander_migrate_0089_webstore;

CREATE PROCEDURE _zander_migrate_0089_webstore()
BEGIN
    -- 1. Webhook completion marker -------------------------------------------
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreWebhookEvents'
          AND COLUMN_NAME  = 'completedAt'
    ) THEN
        ALTER TABLE `webstoreWebhookEvents`
            ADD COLUMN `completedAt` DATETIME(3) NULL DEFAULT NULL AFTER `processedAt`;

        UPDATE `webstoreWebhookEvents` SET `completedAt` = `processedAt`;
    END IF;

    -- 2. Subscription event ordering ------------------------------------------
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreSubscriptions'
          AND COLUMN_NAME  = 'lastStripeEventAt'
    ) THEN
        ALTER TABLE `webstoreSubscriptions`
            ADD COLUMN `lastStripeEventAt` INT NULL DEFAULT NULL AFTER `cancelledAt`;
    END IF;

    -- 3. Webstore payments ledger reference -----------------------------------
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreTransactions'
          AND COLUMN_NAME  = 'stripeRef'
    ) THEN
        ALTER TABLE `webstoreTransactions`
            ADD COLUMN `stripeRef` VARCHAR(191) NULL DEFAULT NULL AFTER `currency`;

        -- Renewals were only ever written to the finance ledger (notes
        -- "Webstore subscription renewal. Purchase #<id>. ..."), so copy them
        -- in once so revenue totals include them.
        INSERT INTO `webstoreTransactions`
            (`purchaseId`, `userId`, `direction`, `counterpartyMinecraftUsername`,
             `amountCents`, `currency`, `createdAt`)
        SELECT s.`purchaseId`, s.`purchaserUserId`, 'outgoing', s.`recipientMinecraftUsername`,
               ft.`amountCents`, LOWER(ft.`currency`), ft.`createdAt`
          FROM `financeTransactions` ft
          JOIN `webstoreSubscriptions` s
            ON s.`purchaseId` = CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(ft.`notes`, 'Purchase #', -1), '.', 1) AS UNSIGNED)
         WHERE ft.`type` = 'income'
           AND ft.`createdByUserId` = 0
           AND ft.`notes` LIKE 'Webstore subscription renewal. Purchase #%';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreTransactions'
          AND INDEX_NAME   = 'uq_webstoreTransactions_stripeRef'
    ) THEN
        ALTER TABLE `webstoreTransactions`
            ADD UNIQUE KEY `uq_webstoreTransactions_stripeRef` (`stripeRef`);
    END IF;

    -- 4. Finance ledger reference ---------------------------------------------
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'financeTransactions'
          AND COLUMN_NAME  = 'externalRef'
    ) THEN
        ALTER TABLE `financeTransactions`
            ADD COLUMN `externalRef` VARCHAR(191) NULL DEFAULT NULL AFTER `notes`;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'financeTransactions'
          AND INDEX_NAME   = 'uq_financeTransactions_externalRef'
    ) THEN
        ALTER TABLE `financeTransactions`
            ADD UNIQUE KEY `uq_financeTransactions_externalRef` (`externalRef`);
    END IF;
END;

CALL _zander_migrate_0089_webstore();

DROP PROCEDURE IF EXISTS _zander_migrate_0089_webstore;
