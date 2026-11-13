-- =============================================================================
-- Migration 0088: Forum <-> Discord forum channel bridge, and post reactions
-- =============================================================================
-- A website forum category can be bridged to one Discord forum channel
-- (e.g. "Shopping District" <-> #shopping-district). Discussions map to Discord
-- forum posts, replies to messages inside them, and reactions sync both ways.
--
--   1. forumBridgeChannels   one row per bridged category/channel pair. Only the
--                            webhook id is stored: the bot owns the webhook and
--                            reads its token from Discord, so no secret is kept.
--   2. forumDiscussions      discordThreadId (the Discord forum post) and
--                            discordStarterMessageId (its first message).
--   3. forumPosts            discordMessageId and source ('web' | 'discord').
--   4. forumPostReactions    one row per (post, user, emoji), from either side.
--   5. forumSyncOutbox       queued website -> Discord actions, retried with
--                            backoff so a Discord outage loses nothing.
--
-- Only content created after a channel is bridged syncs; nothing is backfilled.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `forumBridgeChannels` (
    `bridgeId`         INT          NOT NULL AUTO_INCREMENT,
    `categoryId`       INT          NOT NULL,
    `guildId`          VARCHAR(32)  NOT NULL,
    `channelId`        VARCHAR(32)  NOT NULL,
    `webhookId`        VARCHAR(32)  NULL DEFAULT NULL,
    `enabled`          TINYINT(1)   NOT NULL DEFAULT 1,
    `lastSyncedAt`     DATETIME     NULL DEFAULT NULL,
    `createdAt`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`bridgeId`),
    UNIQUE KEY `uq_forumBridgeChannels_category` (`categoryId`),
    UNIQUE KEY `uq_forumBridgeChannels_channel` (`channelId`),
    CONSTRAINT `fk_forumBridgeChannels_category`
        FOREIGN KEY (`categoryId`) REFERENCES `forumCategories` (`categoryId`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `forumPostReactions` (
    `reactionId`  INT          NOT NULL AUTO_INCREMENT,
    `postId`      INT          NOT NULL,
    `userId`      INT          NOT NULL,
    -- Binary collation: utf8mb4_unicode_ci treats most emoji as equal, which
    -- would make different reactions collide on the unique key.
    `emoji`       VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `source`      VARCHAR(16)  NOT NULL DEFAULT 'web',
    `createdAt`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`reactionId`),
    UNIQUE KEY `uq_forumPostReactions_post_user_emoji` (`postId`, `userId`, `emoji`),
    KEY `idx_forumPostReactions_post` (`postId`),
    CONSTRAINT `fk_forumPostReactions_post`
        FOREIGN KEY (`postId`) REFERENCES `forumPosts` (`postId`) ON DELETE CASCADE,
    CONSTRAINT `fk_forumPostReactions_user`
        FOREIGN KEY (`userId`) REFERENCES `users` (`userId`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `forumSyncOutbox` (
    `taskId`        INT          NOT NULL AUTO_INCREMENT,
    `action`        VARCHAR(32)  NOT NULL,
    `discussionId`  INT          NULL DEFAULT NULL,
    `postId`        INT          NULL DEFAULT NULL,
    `payload`       TEXT         NULL,
    `status`        VARCHAR(16)  NOT NULL DEFAULT 'pending',
    `attempts`      INT          NOT NULL DEFAULT 0,
    `lastError`     TEXT         NULL,
    `nextAttemptAt` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `createdAt`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`taskId`),
    KEY `idx_forumSyncOutbox_due` (`status`, `nextAttemptAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP PROCEDURE IF EXISTS _zander_migrate_0088;

CREATE PROCEDURE _zander_migrate_0088()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'forumDiscussions'
          AND COLUMN_NAME  = 'discordThreadId'
    ) THEN
        ALTER TABLE `forumDiscussions`
            ADD COLUMN `discordThreadId` VARCHAR(32) NULL DEFAULT NULL,
            ADD COLUMN `discordStarterMessageId` VARCHAR(32) NULL DEFAULT NULL,
            ADD UNIQUE KEY `uq_forumDiscussions_discordThreadId` (`discordThreadId`);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'forumPosts'
          AND COLUMN_NAME  = 'discordMessageId'
    ) THEN
        ALTER TABLE `forumPosts`
            ADD COLUMN `discordMessageId` VARCHAR(32) NULL DEFAULT NULL,
            ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT 'web',
            ADD UNIQUE KEY `uq_forumPosts_discordMessageId` (`discordMessageId`);
    END IF;
END;

CALL _zander_migrate_0088();

DROP PROCEDURE IF EXISTS _zander_migrate_0088;
