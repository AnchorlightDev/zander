-- Draft and scheduled forum threads.
--
-- status: 'published' (the default, and what every existing row becomes), 'draft'
-- (saved but visible only to its author and moderators), or 'scheduled' (a draft
-- that a cron publishes once publishAt passes -- see cron/forumScheduledCron.js).
-- publishAt is only meaningful while status = 'scheduled'.
ALTER TABLE `forumDiscussions`
  ADD COLUMN `status`    VARCHAR(16) NOT NULL DEFAULT 'published' AFTER `isArchived`,
  ADD COLUMN `publishAt` DATETIME    NULL                        AFTER `status`,
  ADD INDEX `forumDiscussions_status_publishAt_idx` (`status`, `publishAt`);
