-- More ways for a submission to reach the people who care about it.
--
-- `discordChannelId` already posts a review embed to one channel. These add
-- two more routes, both optional and independent of it:
--
--   discordForumChannelId  a Discord FORUM channel; each submission opens its
--                          own thread, so discussion about one applicant stays
--                          attached to that applicant instead of scrolling
--                          away in a shared channel
--
--   notifyDiscordUserIds   a JSON array of snowflakes to DM when a submission
--                          lands, for forms nobody is watching a channel for
--
-- Both NULL by default, which is every existing form: nothing starts sending
-- anything until somebody fills a field in.
ALTER TABLE `forms`
  ADD COLUMN `discordForumChannelId` VARCHAR(255) NULL AFTER `discordChannelId`,
  ADD COLUMN `notifyDiscordUserIds`  JSON         NULL AFTER `discordForumChannelId`;

-- The thread opened for this submission, so the dashboard can link to it and
-- a later review can post the decision into the same thread. NULL means no
-- thread: either the form has no forum configured, or creating it failed --
-- which must never fail the submission itself.
ALTER TABLE `formSubmissions`
  ADD COLUMN `discordThreadId` VARCHAR(255) NULL AFTER `discordMessageId`;
