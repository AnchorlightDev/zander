-- Add location type fields to events and event_templates
ALTER TABLE `events`
  ADD COLUMN `locationType` VARCHAR(32) NULL AFTER `locationLabel`,
  ADD COLUMN `locationDiscordChannelId` VARCHAR(64) NULL AFTER `locationType`;

ALTER TABLE `event_templates`
  ADD COLUMN `locationType` VARCHAR(32) NULL AFTER `locationLabel`,
  ADD COLUMN `locationDiscordChannelId` VARCHAR(64) NULL AFTER `locationType`;
