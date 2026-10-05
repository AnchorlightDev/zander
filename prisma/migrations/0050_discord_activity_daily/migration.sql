-- Daily Discord message counts, for the "consistent community activity" rule.
--
-- The audit_* columns on `users` are last-seen timestamps: they show someone
-- appeared recently, not that they turned up regularly, so consistency cannot
-- be derived from them. This table is the missing half.
--
-- A daily rollup rather than a message log, for two reasons:
--
--   1. Write volume. One row per user per day, upserted, instead of one row
--      per message on a busy guild.
--   2. Privacy. No message content and no per-message timestamps are stored --
--      only how many messages a user sent on a given date. That is the whole
--      of what the requirement needs, and it is deliberately not enough to
--      reconstruct anyone's conversation history. Do not extend this into a
--      message log.
--
-- Both "distinct active days in the window" and "messages in the window" are
-- answered from these rows.
--
-- Note: this only has data from the day the listener was deployed, so a
-- 30-day window is meaningless until 30 days after that.
CREATE TABLE `discordActivityDaily` (
  `id`            INT         NOT NULL AUTO_INCREMENT,
  `discordUserId` VARCHAR(24) NOT NULL,
  `activityDate`  DATE        NOT NULL,
  `messageCount`  INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `discordActivityDaily_user_date_key` (`discordUserId`, `activityDate`),
  INDEX `discordActivityDaily_user_date_idx` (`discordUserId`, `activityDate`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
