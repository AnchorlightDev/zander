-- =============================================================================
-- Migration 0093: Per-category Discord updates webhook
-- =============================================================================
-- Lets a forum category announce new topics and replies to a Discord channel
-- via a webhook, independent of the full two-way forum bridge (migration 0088).
--
-- A category with a webhook set here posts a short "new topic" / "new reply"
-- notice to that webhook. It is deliberately skipped for categories that are
-- bridged to a Discord forum channel, since the bridge already mirrors their
-- posts into Discord — the notifier checks forumBridgeChannels at run time.
--
-- Just one nullable column; NULL / empty means no updates are sent.
-- =============================================================================

DROP PROCEDURE IF EXISTS _zander_migrate_0093;

CREATE PROCEDURE _zander_migrate_0093()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'forumCategories'
          AND COLUMN_NAME  = 'discordUpdateWebhook'
    ) THEN
        ALTER TABLE `forumCategories`
            ADD COLUMN `discordUpdateWebhook` VARCHAR(255) NULL DEFAULT NULL AFTER `postPermission`;
    END IF;
END;

CALL _zander_migrate_0093();

DROP PROCEDURE IF EXISTS _zander_migrate_0093;
