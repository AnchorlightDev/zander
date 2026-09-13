-- Badge System: adds badges definition table and user badge assignment table.

CREATE TABLE `badges` (
  `badgeId`         INT           NOT NULL AUTO_INCREMENT,
  `name`            VARCHAR(100)  NOT NULL,
  `description`     TEXT          NULL,
  `itemIcon`        VARCHAR(100)  NOT NULL,
  `backgroundColor` VARCHAR(7)    NOT NULL DEFAULT '#1a1a2e',
  `luckpermsGroup`  VARCHAR(64)   NULL,
  `createdAt`       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`badgeId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `user_badges` (
  `id`        INT         NOT NULL AUTO_INCREMENT,
  `userId`    INT         NOT NULL,
  `badgeId`   INT         NOT NULL,
  `earnedAt`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `isManual`  TINYINT(1)  NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  INDEX `user_badges_userId_idx` (`userId`),
  UNIQUE INDEX `user_badges_userId_badgeId_key` (`userId`, `badgeId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `user_badges`
  ADD CONSTRAINT `user_badges_badgeId_fkey`
  FOREIGN KEY (`badgeId`) REFERENCES `badges`(`badgeId`)
  ON DELETE CASCADE ON UPDATE CASCADE;
