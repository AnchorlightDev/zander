-- Add optional image URL to poll options for picture-based polls.

ALTER TABLE `forumPollOptions`
  ADD COLUMN `imageUrl` VARCHAR(2000) NULL DEFAULT NULL
  AFTER `label`;
