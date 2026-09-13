-- ============================================================
-- users: mark placeholder rows explicitly
--
-- `createUnlinkedUser` (support ticket flow) inserts a stand-in row
-- into `users` for Discord users who open a ticket before ever linking
-- a real Minecraft account: their lowercased Discord username, a random
-- non-Mojang UUID, and their discordId already attached.
--
-- Those rows previously looked identical to a fully registered account,
-- so a later /register attempt for the real Minecraft name was blocked
-- with "An account already exists for this Minecraft player" and the
-- real account could never be linked (the Thylakin bug).
--
-- is_placeholder lets /register (and a one-off cleanup script) tell a
-- ghost row apart from a real account and merge instead of blocking.
-- ============================================================
ALTER TABLE users
  ADD COLUMN is_placeholder BOOLEAN NOT NULL DEFAULT 0 AFTER account_disabled;
