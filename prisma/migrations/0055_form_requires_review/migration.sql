-- Not every form is an application.
--
-- A feedback survey has nothing to approve or deny: every response is simply
-- collected. Showing those as "Pending" with a Review button gives the
-- dashboard a queue that never empties and cannot be emptied, and puts a
-- pending badge on a form nobody is waiting on.
--
-- DEFAULT 1 preserves today's behaviour for every existing form -- applications
-- keep their review queue. Turn it off per form for surveys.
--
-- Submissions still store `status` as normal, so nothing about the column
-- changes and flipping this back on later leaves the existing rows reviewable.
-- What changes is whether the dashboard presents a decision to make.
ALTER TABLE `forms`
  ADD COLUMN `requiresReview` TINYINT(1) NOT NULL DEFAULT 1 AFTER `allowMultiple`;
