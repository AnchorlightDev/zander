-- =============================================================================
-- Migration 0093: Per-category Discord updates channel
-- =============================================================================
-- Lets a forum category announce new topics and replies to a Discord channel
-- (the bot posts there), independent of the full two-way forum bridge
-- (migration 0088).
--
-- A category with a channel id set here gets a short "new topic" / "new reply"
-- notice posted by the bot. It is deliberately skipped for categories that are
-- bridged to a Discord forum channel, since the bridge already mirrors their
-- posts into Discord — the notifier checks forumBridgeChannels at run time.
--
-- Just one nullable column holding the Discord channel id (a snowflake);
-- NULL / empty means no updates are sent.
-- =============================================================================

DROP PROCEDURE IF EXISTS _zander_migrate_0093;

CREATE PROCEDURE _zander_migrate_0093()
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
END;

CALL _zander_migrate_0093();

DROP PROCEDURE IF EXISTS _zander_migrate_0093;
