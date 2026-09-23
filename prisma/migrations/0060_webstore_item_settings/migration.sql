-- =============================================================================
-- Migration 0060: Per-item webstore settings (category + visibility)
-- =============================================================================
-- The /webstore storefront builds its list live from Stripe, so unlike the rank
-- catalog there is no local row per product to hang a category or a visibility
-- flag on. This adds one, keyed by the Stripe price ID -- the same way
-- webstoreStripeCommands already attaches command templates to a price.
--
-- Rows are optional: a Stripe price with no row here behaves exactly as it did
-- before (visible, uncategorised), so nothing disappears the moment this lands.
--
-- Deliberately NOT filtered inside getWebstoreItems(): that loader also serves
-- checkout and subscription renewal, and hiding a product must never stop an
-- existing subscriber's renewal from resolving the item and running its
-- commands. The public storefront does the filtering instead.
-- =============================================================================

DROP PROCEDURE IF EXISTS _zander_migrate_0060;

CREATE PROCEDURE _zander_migrate_0060()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreItemSettings'
    ) THEN
        CREATE TABLE `webstoreItemSettings` (
            `stripePriceId` VARCHAR(64) NOT NULL,
            `categoryId`    INT         NULL DEFAULT NULL,
            `visible`       TINYINT(1)  NOT NULL DEFAULT 1,
            `sortOrder`     INT         NOT NULL DEFAULT 0,
            `createdAt`     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updatedAt`     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                        ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`stripePriceId`),
            KEY `idx_webstoreItemSettings_category` (`categoryId`)
        );
    END IF;

    -- Same rule as rankCatalog: a category still in use cannot be deleted, so
    -- products are never silently orphaned.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA    = DATABASE()
          AND TABLE_NAME      = 'webstoreItemSettings'
          AND CONSTRAINT_NAME = 'fk_webstoreItemSettings_category'
    ) THEN
        ALTER TABLE `webstoreItemSettings`
            ADD CONSTRAINT `fk_webstoreItemSettings_category`
            FOREIGN KEY (`categoryId`) REFERENCES `webstoreCategories` (`id`)
            ON DELETE RESTRICT;
    END IF;
END;

CALL _zander_migrate_0060();

DROP PROCEDURE IF EXISTS _zander_migrate_0060;
