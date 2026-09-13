-- Convert the `users` table to real 4-byte UTF-8 (utf8mb4).
--
-- The Prisma baseline (0001) declares `users` as
-- `DEFAULT CHARSET=utf8mb4`, but production predates the Prisma baseline
-- (see the legacy `migration/` dir) and was never converted, so its text
-- columns are still 3-byte `utf8`. Discord `global_name`s routinely contain
-- astral-plane characters (emoji, Mathematical Alphanumeric letters, …),
-- and writing one into `social_discord` blows up with:
--
--   Incorrect string value: '\xF0\x9D\x95\xB8_' for column 'social_discord'
--
-- (that byte sequence is U+1D578 MATHEMATICAL BOLD FRAKTUR CAPITAL M).
--
-- CONVERT TO CHARACTER SET rewrites every char column on the table, so this
-- also covers `username`, `discordId`, and the other `social_*` fields,
-- which are exposed to the same input. No-op on columns already utf8mb4.
--
-- Index-length note: the widest indexed column is `email VARCHAR(254)`
-- (1016 bytes at 4 bytes/char) — well under InnoDB's limit — and `uuid`'s
-- unique/prefix indexes are unaffected. `utf8mb4_unicode_ci` keeps the
-- case-insensitive matching the app already relies on.

ALTER TABLE users
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
