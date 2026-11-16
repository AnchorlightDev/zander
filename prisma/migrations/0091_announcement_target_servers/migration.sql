-- In-game tips can be limited to specific servers. JSON array of lower-case
-- Velocity server names (servers.velocityName), e.g. ["survival","creative"].
-- NULL or [] means every server, which is how all existing tips behave.
ALTER TABLE `announcements`
  ADD COLUMN `targetServers` JSON NULL AFTER `countdownFinishedText`;
