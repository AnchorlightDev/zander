-- Mark placeholder ("ghost") user rows explicitly
-- Migration: v1.20.0 -> v1.21.0
--
-- `createUnlinkedUser` inserts a stand-in row into `users` when a Discord
-- user opens a support ticket before linking a real Minecraft account
-- (lowercased Discord username, random non-Mojang UUID, discordId set).
--
-- Without a marker those rows are indistinguishable from a real account,
-- so /register refuses to link the real Minecraft account afterwards
-- ("An account already exists for this Minecraft player" — the Thylakin
-- bug). is_placeholder lets the register handler and the one-off cleanup
-- script merge the ghost row into the real account instead of blocking.

ALTER TABLE users
  ADD COLUMN is_placeholder BOOLEAN NOT NULL DEFAULT 0 AFTER account_disabled;
