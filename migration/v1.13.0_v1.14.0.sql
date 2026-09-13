-- Fix emoji/4-byte Unicode storage in support ticket message columns
-- Migration: v1.13.0 -> v1.14.0
--
-- The supportTicketMessages table was created without an explicit charset,
-- inheriting the database default (utf8 / 3-byte). This causes
-- ER_TRUNCATED_WRONG_VALUE_FOR_FIELD when inserting messages that contain
-- emoji or other 4-byte Unicode characters (e.g. 👍, 🎉).
-- Alter the affected text columns to utf8mb4.

ALTER TABLE supportTicketMessages
  MODIFY COLUMN message     TEXT     NOT NULL CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  MODIFY COLUMN attachments JSON;
