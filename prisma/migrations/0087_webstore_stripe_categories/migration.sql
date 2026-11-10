-- =============================================================================
-- Migration 0087: Stripe-seeded webstore categories
-- =============================================================================
-- The /webstore storefront builds itself live from Stripe, but its categories
-- were created and assigned entirely by hand in the dashboard. This lets a
-- Stripe product carry its own category in `product.metadata.category`
-- ("Stripe seeds"), while anything set in the dashboard still wins
-- ("dashboard overrides"). EdenEffects products, for example, can be grouped
-- just by setting that metadata in Stripe.
--
-- Two small additions make this work through the EXISTING categoryId plumbing
-- (counts, visibility, the delete guard and grouping all keep working):
--
--   1. webstoreCategories.stripeKey — a stable handle for the Stripe metadata
--      value that seeded the category. Matching by this, not by name, means an
--      admin can rename the category without the next sync recreating it.
--
--   2. webstoreItemSettings.categoryManual — 1 when an admin chose the product's
--      category in the dashboard (that choice is never overwritten by a sync),
--      0 when the category was seeded from Stripe (a sync keeps it in step with
--      the product's metadata).
-- =============================================================================

DROP PROCEDURE IF EXISTS _zander_migrate_0087;

CREATE PROCEDURE _zander_migrate_0087()
BEGIN
    -- 1. Stripe handle on the category -----------------------------------------
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreCategories'
          AND COLUMN_NAME  = 'stripeKey'
    ) THEN
        ALTER TABLE `webstoreCategories`
            ADD COLUMN `stripeKey` VARCHAR(191) NULL DEFAULT NULL AFTER `name`;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreCategories'
          AND INDEX_NAME   = 'uq_webstoreCategories_stripeKey'
    ) THEN
        ALTER TABLE `webstoreCategories`
            ADD UNIQUE KEY `uq_webstoreCategories_stripeKey` (`stripeKey`);
    END IF;

    -- 2. Provenance on the per-product settings --------------------------------
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreItemSettings'
          AND COLUMN_NAME  = 'categoryManual'
    ) THEN
        ALTER TABLE `webstoreItemSettings`
            ADD COLUMN `categoryManual` TINYINT(1) NOT NULL DEFAULT 0 AFTER `categoryId`;

        -- Every settings row that exists today was written by the dashboard, so
        -- any existing category assignment is a manual one a sync must respect.
        UPDATE `webstoreItemSettings`
           SET `categoryManual` = 1
         WHERE `categoryId` IS NOT NULL;
    END IF;
END;

CALL _zander_migrate_0087();

DROP PROCEDURE IF EXISTS _zander_migrate_0087;
