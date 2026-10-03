-- Site-wide default announcements (Events → Announcement Defaults). Copied
-- into every new event and new template as its starting set, which the
-- organiser can then edit or remove. Same shape as event_template_announcements
-- minus the template link.
CREATE TABLE `event_default_announcements` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `label` VARCHAR(100) NULL,
    `announcementType` VARCHAR(32) NOT NULL DEFAULT 'reminder',
    `platform` VARCHAR(32) NOT NULL DEFAULT 'discord',
    `channelId` VARCHAR(32) NULL,
    `contentTemplate` TEXT NULL,
    `body` TEXT NULL,
    `colourMessageFormat` TEXT NULL,
    `link` TEXT NULL,
    `popupButtonText` VARCHAR(60) NULL,
    `popupImageUrl` TEXT NULL,
    `triggerType` VARCHAR(32) NOT NULL DEFAULT 'before_event',
    `offsetMinutes` INTEGER NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
