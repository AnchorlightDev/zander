-- Bedrock (Geyser) address per server, e.g. play.example.net:19132.
-- Blank means the server does not take Bedrock players. Public pages derive
-- their Java and Bedrock connection details from the servers list, so the
-- address is entered once, in the servers dashboard.
ALTER TABLE `servers`
  ADD COLUMN `bedrockAddress` VARCHAR(255) NULL AFTER `serverConnectionAddress`;
