-- =============================================================================
-- Migration 0094: finish the forum category Discord updates column
-- =============================================================================
-- Migration 0093 first shipped as a `discordUpdateWebhook` column and was
-- applied to some databases (production included) in that form. It was then
-- changed in place to a `discordUpdateChannelId` column — but Prisma tracks
-- migrations by name, so a database that already ran 0093 never re-ran the
-- edited version and ended up with the old webhook column and not the channel
-- column the code now expects.
--
-- This migration reconciles both cases, idempotently:
--   - add `discordUpdateChannelId` if it is missing (fresh DBs already have it
--     from 0093 and are skipped here)
--   - drop the now-unused `discordUpdateWebhook` if it is present
-- =============================================================================

DROP PROCEDURE IF EXISTS _zander_migrate_0094;

CREATE PROCEDURE _zander_migrate_0094()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'forumCategories'
          AND COLUMN_NAME  = 'discordUpdateChannelId'
    ) THEN
        ALTER TABLE `forumCategories`
            ADD COLUMN `discordUpdateChannelId` VARCHAR(32) NULL DEFAULT NULL AFTER `postPermission`;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'forumCategories'
          AND COLUMN_NAME  = 'discordUpdateWebhook'
    ) THEN
        ALTER TABLE `forumCategories` DROP COLUMN `discordUpdateWebhook`;
    END IF;
END;

CALL _zander_migrate_0094();

DROP PROCEDURE IF EXISTS _zander_migrate_0094;
