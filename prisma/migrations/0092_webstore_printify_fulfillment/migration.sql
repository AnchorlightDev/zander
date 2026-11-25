-- =============================================================================
-- Migration 0092: Printify (physical) webstore fulfillment
-- =============================================================================
-- The /webstore storefront builds itself live from Stripe and, until now, every
-- purchase was fulfilled by running Minecraft/Discord commands (digital goods).
-- This adds physical print-on-demand fulfilment through Printify.
--
-- There is deliberately NO new mapping table. A Stripe product opts into
-- Printify fulfilment entirely through its own metadata (the same approach that
-- seeds storefront categories -- see migration 0087):
--
--   metadata.fulfillment        = "printify"
--   metadata.printify_product_id = "<printify product id>"
--   metadata.printify_variant_id = "<printify variant id>"
--   metadata.printify_quantity   = "1"   (optional, defaults to 1)
--
-- So this migration only adds the per-order snapshot + audit columns that a
-- physical order needs: the shipping address captured at checkout, what we
-- charged for shipping, and the Printify order reference. Keeping the address
-- on the purchase row (rather than only in Stripe) means the webhook can create
-- the Printify order without a second Stripe round-trip and the record is a
-- self-contained audit trail. Every column is nullable / defaulted so existing
-- digital purchases are unaffected.
-- =============================================================================

DROP PROCEDURE IF EXISTS _zander_migrate_0092;

CREATE PROCEDURE _zander_migrate_0092()
BEGIN
    -- Fulfilment type: digital (the existing command path) vs printify ---------
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstorePurchases'
          AND COLUMN_NAME  = 'fulfillmentType'
    ) THEN
        ALTER TABLE `webstorePurchases`
            ADD COLUMN `fulfillmentType` ENUM('digital','printify')
                NOT NULL DEFAULT 'digital' AFTER `purchaseType`;
    END IF;

    -- Shipping address snapshot (taken at checkout) ----------------------------
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstorePurchases'
          AND COLUMN_NAME  = 'shipName'
    ) THEN
        ALTER TABLE `webstorePurchases`
            ADD COLUMN `shipName`     VARCHAR(191) NULL DEFAULT NULL,
            ADD COLUMN `shipEmail`    VARCHAR(191) NULL DEFAULT NULL,
            ADD COLUMN `shipPhone`    VARCHAR(64)  NULL DEFAULT NULL,
            ADD COLUMN `shipAddress1` VARCHAR(191) NULL DEFAULT NULL,
            ADD COLUMN `shipAddress2` VARCHAR(191) NULL DEFAULT NULL,
            ADD COLUMN `shipCity`     VARCHAR(128) NULL DEFAULT NULL,
            ADD COLUMN `shipRegion`   VARCHAR(128) NULL DEFAULT NULL,
            ADD COLUMN `shipZip`      VARCHAR(32)  NULL DEFAULT NULL,
            ADD COLUMN `shipCountry`  VARCHAR(2)   NULL DEFAULT NULL,
            ADD COLUMN `shippingCents` INT         NULL DEFAULT NULL;
    END IF;

    -- Printify order reference -------------------------------------------------
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstorePurchases'
          AND COLUMN_NAME  = 'printifyOrderId'
    ) THEN
        ALTER TABLE `webstorePurchases`
            ADD COLUMN `printifyOrderId` VARCHAR(64) NULL DEFAULT NULL,
            ADD COLUMN `printifyStatus`  VARCHAR(32) NULL DEFAULT NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstorePurchases'
          AND INDEX_NAME   = 'idx_webstorePurchases_printifyOrderId'
    ) THEN
        ALTER TABLE `webstorePurchases`
            ADD KEY `idx_webstorePurchases_printifyOrderId` (`printifyOrderId`);
    END IF;
END;

CALL _zander_migrate_0092();

DROP PROCEDURE IF EXISTS _zander_migrate_0092;
