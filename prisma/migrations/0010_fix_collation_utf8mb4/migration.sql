-- Fix collation mismatch on scheduledDiscordMessages and any other tables
-- that may have been created with latin1_swedish_ci before migrations were applied.
-- CONVERT TO CHARACTER SET re-encodes all existing data and sets the default
-- for the table and its varchar/text columns.

ALTER TABLE `scheduledDiscordMessages`
    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Belt-and-suspenders: also ensure the event-related tables are utf8mb4
-- in case any were created with a different server default.
ALTER TABLE `events`
    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `event_announcements`
    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `event_template_announcements`
    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
