-- Fix emoji support in forum tables
-- Migration: v1.18.0 -> v1.19.0
--
-- All four forum tables were created without an explicit CHARACTER SET so
-- they inherited the server default of utf8 (3-byte only).  4-byte
-- Unicode characters such as emoji (e.g. 🎨) trigger
-- ER_TRUNCATED_WRONG_VALUE_FOR_FIELD when inserted into utf8 columns.
--
-- CONVERT TO CHARACTER SET rewrites every string column in the table
-- (VARCHAR, TEXT, MEDIUMTEXT) to utf8mb4 and updates the table default
-- so future ALTER TABLE ADD COLUMN statements also get utf8mb4.

ALTER TABLE forumCategories
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE forumDiscussions
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE forumPosts
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE forumPostRevisions
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
