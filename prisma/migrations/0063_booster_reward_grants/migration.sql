-- Ranks granted for boosting the Discord server (Settings → Discord → Booster
-- rewards). One row per rank this feature actually added, so ending a boost
-- removes only those -- never a rank the player already had, e.g. one they
-- bought. The Minecraft uuid is kept so revocation still works after a
-- username change.
CREATE TABLE `boosterRewardGrants` (
  `grantId`   INT          NOT NULL AUTO_INCREMENT,
  `userId`    INT          NOT NULL,
  `discordId` VARCHAR(32)  NOT NULL,
  `uuid`      VARCHAR(36)  NOT NULL,
  `rankGroup` VARCHAR(64)  NOT NULL,
  `grantedAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`grantId`),
  UNIQUE INDEX `boosterRewardGrants_userId_rankGroup_key` (`userId`, `rankGroup`),
  INDEX `boosterRewardGrants_discordId_idx` (`discordId`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
