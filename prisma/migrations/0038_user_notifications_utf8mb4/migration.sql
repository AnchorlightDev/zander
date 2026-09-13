-- Convert the `userNotifications` table to real 4-byte UTF-8 (utf8mb4).
--
-- `userNotifications` is created at runtime by
-- controllers/notificationController.js via `CREATE TABLE IF NOT EXISTS`
-- with no explicit charset, so on production (whose server/db default is
-- legacy 3-byte `utf8`) its text columns can't store astral-plane
-- characters. Notification bodies are built from user- and Discord-sourced
-- text that routinely contains emoji, so inserts blow up with:
--
--   Incorrect string value: '\xF0\x9F\xAB\xA1' for column 'message'
--
-- (that byte sequence is U+1FAE1 SALUTING FACE).
--
-- CONVERT TO CHARACTER SET rewrites every char column, so this also covers
-- `notificationType`, `title`, and `url`. No-op on columns already utf8mb4.
-- The only indexes on this table are on integer columns, so there is no
-- index-length concern. `utf8mb4_unicode_ci` matches the collation used by
-- the rest of the schema (see 0037_users_utf8mb4).

ALTER TABLE userNotifications
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
