-- ============================================================
-- forumPosts: threaded replies
-- ============================================================
ALTER TABLE forumPosts
  ADD COLUMN parentPostId INT NULL AFTER discussionId,
  ADD INDEX forumPosts_parent_idx (parentPostId),
  ADD CONSTRAINT fk_forumPosts_parent
    FOREIGN KEY (parentPostId) REFERENCES forumPosts(postId) ON DELETE SET NULL;
