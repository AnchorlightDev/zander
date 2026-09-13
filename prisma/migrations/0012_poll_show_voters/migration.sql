-- Add showVoters flag to forumPolls.
-- When enabled, the poll result display publicly lists which users
-- voted for each option.

ALTER TABLE `forumPolls`
  ADD COLUMN `showVoters` TINYINT(1) NOT NULL DEFAULT 0
  AFTER `allowVoteChange`;
