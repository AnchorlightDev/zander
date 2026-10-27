-- Add an optional countdown to each hologram frame.
--
-- When `countdown_to` is set, the zander-hub plugin substitutes the countdown
-- placeholders in the frame's `message` at render time, ticking every second:
--   {countdown}  -> "2d 5h 30m 10s"
--   {days}       -> "2"
--   {hours}      -> "5"
--   {minutes}    -> "30"
--   {seconds}    -> "10"
-- Once the target instant has passed, `countdown_finished_text` (if set) replaces
-- the countdown entirely; if it is blank the plugin shows zeroes ("0d 0h 0m 0s").
-- A NULL `countdown_to` means the frame has no countdown (a plain message).
--
-- `countdown_to` is stored in UTC (the mysql2 pool runs with timezone "Z").
ALTER TABLE `hologram_messages`
  ADD COLUMN `countdown_to`            DATETIME(3)  NULL AFTER `link`,
  ADD COLUMN `countdown_finished_text` VARCHAR(512) NULL AFTER `countdown_to`;
