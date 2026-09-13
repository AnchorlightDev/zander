-- CreateTable
CREATE TABLE `event_template_announcements` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `templateId` INTEGER NOT NULL,
    `label` VARCHAR(100) NULL,
    `announcementType` VARCHAR(32) NOT NULL DEFAULT 'reminder',
    `platform` VARCHAR(32) NOT NULL DEFAULT 'discord',
    `channelId` VARCHAR(32) NULL,
    `contentTemplate` TEXT NULL,
    `triggerType` VARCHAR(32) NOT NULL DEFAULT 'before_event',
    `offsetMinutes` INTEGER NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `event_template_announcements` ADD CONSTRAINT `event_template_announcements_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `event_templates`(`templateId`) ON DELETE CASCADE ON UPDATE CASCADE;
