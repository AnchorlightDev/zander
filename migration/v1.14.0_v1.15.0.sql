-- Fix emoji/4-byte Unicode storage in discord_punishments columns
-- Migration: v1.14.0 -> v1.15.0
--
-- discord_punishments was created without an explicit charset, inheriting
-- the database default (utf8 / 3-byte). This causes
-- ER_TRUNCATED_WRONG_VALUE_FOR_FIELD when inserting values that contain
-- emoji or other 4-byte Unicode characters (e.g. decorative usernames like
-- '⋆｡˚ ✧ 𝓐𝓼𝓱𝓵𝓮𝔂 ✧ ˚｡⋆').
-- Alter the affected text columns to utf8mb4.

ALTER TABLE discord_punishments
  MODIFY COLUMN target_discord_tag  VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  MODIFY COLUMN actor_name_snapshot VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  MODIFY COLUMN reason              TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL;

ALTER TABLE discord_punishment_appeals
  MODIFY COLUMN appeal_reason TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL;
