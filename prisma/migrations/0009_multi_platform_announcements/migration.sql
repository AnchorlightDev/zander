-- Add multi-platform fields to event_template_announcements
ALTER TABLE `event_template_announcements`
    ADD COLUMN `body` TEXT NULL,
    ADD COLUMN `colourMessageFormat` TEXT NULL,
    ADD COLUMN `link` TEXT NULL,
    ADD COLUMN `popupButtonText` VARCHAR(60) NULL,
    ADD COLUMN `popupImageUrl` TEXT NULL;

-- Add multi-platform fields to event_announcements
ALTER TABLE `event_announcements`
    ADD COLUMN `body` TEXT NULL,
    ADD COLUMN `colourMessageFormat` TEXT NULL,
    ADD COLUMN `link` TEXT NULL,
    ADD COLUMN `popupButtonText` VARCHAR(60) NULL,
    ADD COLUMN `popupImageUrl` TEXT NULL;
