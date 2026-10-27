-- Community resources (/resources). Members submit links from the website or
-- with /resources submit in Discord; a submission is published once more than
-- half of the current zander.web.resources.review holders approve it. One
-- that has no majority by `deadlineAt` stays pending and is shown as overdue
-- for a manual decision (controllers/resourceController.js).
CREATE TABLE `resourceCategories` (
  `categoryId`  INT           NOT NULL AUTO_INCREMENT,
  `slug`        VARCHAR(64)   NOT NULL,
  `name`        VARCHAR(80)   NOT NULL,
  `description` VARCHAR(500)  NULL,
  `sortOrder`   INT           NOT NULL DEFAULT 0,
  `createdAt`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`categoryId`),
  UNIQUE INDEX `resourceCategories_slug_key` (`slug`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `resources` (
  `resourceId`           INT           NOT NULL AUTO_INCREMENT,
  `categoryId`           INT           NOT NULL,
  `title`                VARCHAR(100)  NOT NULL,
  `description`          VARCHAR(500)  NOT NULL,
  `url`                  VARCHAR(500)  NOT NULL,
  `status`               VARCHAR(16)   NOT NULL DEFAULT 'pending',
  `source`               VARCHAR(16)   NOT NULL,
  `submittedByUserId`    INT           NULL,
  `submittedByDiscordId` VARCHAR(32)   NULL,
  `submittedByName`      VARCHAR(100)  NULL,
  `deadlineAt`           DATETIME      NULL,
  `decidedAt`            DATETIME      NULL,
  `decisionMethod`       VARCHAR(16)   NULL,
  `decidedByUserId`      INT           NULL,
  `reviewChannelId`      VARCHAR(32)   NULL,
  `reviewMessageId`      VARCHAR(32)   NULL,
  `overdueNotifiedAt`    DATETIME      NULL,
  `createdAt`            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`resourceId`),
  INDEX `resources_status_idx` (`status`),
  INDEX `resources_categoryId_idx` (`categoryId`),
  CONSTRAINT `resources_categoryId_fkey` FOREIGN KEY (`categoryId`)
    REFERENCES `resourceCategories` (`categoryId`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `resourceVotes` (
  `resourceId` INT          NOT NULL,
  `userId`     INT          NOT NULL,
  `vote`       VARCHAR(8)   NOT NULL,
  `createdAt`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`resourceId`, `userId`),
  CONSTRAINT `resourceVotes_resourceId_fkey` FOREIGN KEY (`resourceId`)
    REFERENCES `resources` (`resourceId`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
