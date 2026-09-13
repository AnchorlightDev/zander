-- Forum Polls feature: adds poll, option, and vote tables linked to forum discussions.

CREATE TABLE `forumPolls` (
  `pollId`          INT           NOT NULL AUTO_INCREMENT,
  `discussionId`    INT           NOT NULL,
  `question`        VARCHAR(500)  NOT NULL,
  `allowMultiple`   TINYINT(1)    NOT NULL DEFAULT 0,
  `allowVoteChange` TINYINT(1)    NOT NULL DEFAULT 0,
  `expiresAt`       DATETIME(3)   NULL,
  `createdByUserId` INT           NOT NULL,
  `createdAt`       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`pollId`),
  UNIQUE INDEX `forumPolls_discussionId_key` (`discussionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `forumPollOptions` (
  `optionId`    INT           NOT NULL AUTO_INCREMENT,
  `pollId`      INT           NOT NULL,
  `label`       VARCHAR(300)  NOT NULL,
  `orderIndex`  INT           NOT NULL DEFAULT 0,
  `createdAt`   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`optionId`),
  INDEX `forumPollOptions_pollId_idx` (`pollId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `forumPollVotes` (
  `voteId`    INT         NOT NULL AUTO_INCREMENT,
  `pollId`    INT         NOT NULL,
  `optionId`  INT         NOT NULL,
  `userId`    INT         NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`voteId`),
  UNIQUE INDEX `forumPollVotes_pollId_optionId_userId_key` (`pollId`, `optionId`, `userId`),
  INDEX `forumPollVotes_pollId_userId_idx` (`pollId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `forumPolls`
  ADD CONSTRAINT `forumPolls_discussionId_fkey`
  FOREIGN KEY (`discussionId`) REFERENCES `forumDiscussions`(`discussionId`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `forumPollOptions`
  ADD CONSTRAINT `forumPollOptions_pollId_fkey`
  FOREIGN KEY (`pollId`) REFERENCES `forumPolls`(`pollId`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `forumPollVotes`
  ADD CONSTRAINT `forumPollVotes_pollId_fkey`
  FOREIGN KEY (`pollId`) REFERENCES `forumPolls`(`pollId`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `forumPollVotes`
  ADD CONSTRAINT `forumPollVotes_optionId_fkey`
  FOREIGN KEY (`optionId`) REFERENCES `forumPollOptions`(`optionId`)
  ON DELETE CASCADE ON UPDATE CASCADE;
