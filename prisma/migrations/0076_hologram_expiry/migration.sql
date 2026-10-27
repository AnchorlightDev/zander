-- Give each hologram frame an optional expiry.
--
-- When `expires_at` is set and that instant has passed, the frame is no longer
-- served to the zander-hub plugin (getActiveMessages filters it out), so it drops
-- out of its group's rotation automatically without anyone toggling it off. A
-- group whose every frame has expired renders blank in-game.
--
-- This is distinct from `countdown_to`: a countdown only changes the text a frame
-- shows, whereas `expires_at` removes the frame from rotation entirely.
--
-- NULL `expires_at` means the frame never expires. Stored in UTC (the mysql2 pool
-- runs with timezone "Z"); the active query compares against UTC_TIMESTAMP().
ALTER TABLE `hologram_messages`
  ADD COLUMN `expires_at` DATETIME(3) NULL AFTER `countdown_finished_text`;
