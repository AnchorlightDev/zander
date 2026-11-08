-- View counter for forum threads. Incremented once per session when a
-- discussion is opened (routes/forumRoutes.js), so authors can see how many
-- people have read their post. Lives on the discussion, not each post: a
-- "view" is of the thread, the same way reply counts are per-thread.
ALTER TABLE `forumDiscussions`
  ADD COLUMN `viewCount` INT NOT NULL DEFAULT 0 AFTER `isArchived`;
