-- =============================================================================
-- Migration 0024: Replace single stripePriceId with multi-price JSON array
-- =============================================================================
-- Some ranks offer both a monthly subscription and a one-time permanent price.
-- Replaces the VARCHAR stripePriceId column with a JSON array stripePriceIds.
-- Existing single price IDs are migrated into the new array automatically.
-- =============================================================================

DROP PROCEDURE IF EXISTS _zander_migrate_0024;

CREATE PROCEDURE _zander_migrate_0024()
BEGIN
    -- Add the new JSON array column if not already present
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'rankCatalog'
          AND COLUMN_NAME  = 'stripePriceIds'
    ) THEN
        ALTER TABLE `rankCatalog`
            ADD COLUMN `stripePriceIds` JSON NULL DEFAULT NULL
                AFTER `id`;
    END IF;

    -- Migrate existing single stripePriceId values into the array, if the old
    -- column still exists and has data
    IF EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'rankCatalog'
          AND COLUMN_NAME  = 'stripePriceId'
    ) THEN
        UPDATE `rankCatalog`
           SET `stripePriceIds` = JSON_ARRAY(`stripePriceId`)
         WHERE `stripePriceId` IS NOT NULL
           AND (`stripePriceIds` IS NULL OR JSON_LENGTH(`stripePriceIds`) = 0);

        ALTER TABLE `rankCatalog`
            DROP COLUMN `stripePriceId`;
    END IF;
END;

CALL _zander_migrate_0024();

DROP PROCEDURE IF EXISTS _zander_migrate_0024;
