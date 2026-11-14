-- The server's name in Velocity's config (e.g. `dev`, `events`, `survival`).
-- Server access on the network is the LuckPerms node
-- `serverpermissions.server.<velocityName>`, so this is what the dashboard's
-- Access screen and the scheduler's server_access action build that node from.
-- Blank means the server has no access management (e.g. an external listing).
ALTER TABLE `servers`
  ADD COLUMN `velocityName` VARCHAR(64) NULL AFTER `serverConnectionAddress`,
  ADD UNIQUE INDEX `servers_velocityName_key` (`velocityName`);
