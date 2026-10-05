-- When an announcement was created.
--
-- There was no record of it. `updatedDate` moves every time somebody edits,
-- `startDate` is when it was scheduled to begin, and neither answers "how long
-- has this banner been up?" -- which is the question you ask when a launch
-- notice is still sitting above the rules months later.
--
-- Deliberately NULL with no DEFAULT: adding a column WITH a default backfills
-- every existing row with the migration's own timestamp, which would state that
-- every banner was created the day this ran. Existing rows stay NULL and read
-- as "unknown", which is the truth. Only rows created from here on carry a date.
ALTER TABLE `announcements`
  ADD COLUMN `createdAt` DATETIME(3) NULL AFTER `announcementId`;
