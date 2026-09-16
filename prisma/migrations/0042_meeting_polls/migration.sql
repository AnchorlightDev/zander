-- Meeting polls: "when can everyone make it" scheduling for staff meetings.
-- An organiser proposes a set of candidate time slots (options), a roster of
-- invitees is expanded from LuckPerms ranks, and each invitee marks their
-- availability against *every* slot.  The winning slot is then finalised.
--
-- Phase one is CRUD + responses only.  Notification delivery, send-time
-- membership re-resolution and the finalise -> events handoff are deliberately
-- left unimplemented; the columns they will need (`notifiedAt`,
-- `events.meetingPollId`) are created here so those passes are additive.

CREATE TABLE `meetingPolls` (
  `pollId`            INT           NOT NULL AUTO_INCREMENT,
  `title`             VARCHAR(255)  NOT NULL,
  `description`       TEXT          NULL,
  -- IANA zone the option times are presented in, e.g. 'Australia/Sydney'.
  -- Matches events.timezone's VARCHAR(64).
  `timezone`          VARCHAR(64)   NOT NULL DEFAULT 'UTC',
  -- 'ranks' = roster expanded from meetingPollRoles.  'open' (a town-hall
  -- poll anyone may answer) is reserved and not yet implemented.
  `audienceMode`      VARCHAR(16)   NOT NULL DEFAULT 'ranks',
  -- open | finalized | cancelled
  `status`            VARCHAR(16)   NOT NULL DEFAULT 'open',
  `deadlineAt`        DATETIME      NULL,
  `createdByUserId`   INT           NOT NULL,
  -- The winning meetingPollOptions.optionId once finalised.  Deliberately not
  -- a foreign key: options cascade-delete with their poll, and an FK back the
  -- other way would form a delete cycle MySQL handles poorly.  The service
  -- layer validates that the id belongs to this poll before setting it.
  `finalizedOptionId` INT           NULL,
  `createdAt`         DATETIME      NOT NULL DEFAULT NOW(),
  `updatedAt`         DATETIME      NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  PRIMARY KEY (`pollId`),
  INDEX `meetingPolls_status_idx` (`status`),
  INDEX `meetingPolls_createdByUserId_idx` (`createdByUserId`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One candidate time slot.  `label` is an optional organiser note shown beside
-- the slot ("after the server restart"); the slot itself is startAt/endAt.
CREATE TABLE `meetingPollOptions` (
  `optionId`   INT          NOT NULL AUTO_INCREMENT,
  `pollId`     INT          NOT NULL,
  `startAt`    DATETIME     NOT NULL,
  `endAt`      DATETIME     NOT NULL,
  `label`      VARCHAR(255) NULL,
  `orderIndex` INT          NOT NULL DEFAULT 0,
  `createdAt`  DATETIME     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (`optionId`),
  INDEX `meetingPollOptions_pollId_idx` (`pollId`),
  FOREIGN KEY (`pollId`) REFERENCES `meetingPolls`(`pollId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Which LuckPerms ranks the roster is drawn from.  `rankSlug` is a LuckPerms
-- group name and is sized to match `luckperms_groups`.`name` (VARCHAR(36));
-- LuckPerms lives on a separate MySQL server so it cannot be an FK.
CREATE TABLE `meetingPollRoles` (
  `pollId`   INT         NOT NULL,
  `rankSlug` VARCHAR(36) NOT NULL,
  PRIMARY KEY (`pollId`, `rankSlug`),
  FOREIGN KEY (`pollId`) REFERENCES `meetingPolls`(`pollId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The resolved roster.  Snapshotted at expansion time rather than derived on
-- every read, so the organiser sees a stable list and can add or remove people
-- by hand (`source` = 'manual') without that being undone by a rank change.
--
-- `canRespond` = 0 marks someone who is on the roster but has no usable
-- website login (placeholder / Minecraft-only / disabled), so they are shown
-- to the organiser rather than silently dropped.
--
-- `removedAt` soft-removes rather than deleting, so an existing response is
-- retained if they are added back.  `notifiedAt` is written by the (not yet
-- implemented) notification pass.
CREATE TABLE `meetingPollInvitees` (
  `inviteeId`   INT         NOT NULL AUTO_INCREMENT,
  `pollId`      INT         NOT NULL,
  `userId`      INT         NOT NULL,
  -- 'role' = expanded from meetingPollRoles, 'manual' = added by the organiser
  `source`      VARCHAR(16) NOT NULL DEFAULT 'role',
  `viaRankSlug` VARCHAR(36) NULL,
  `canRespond`  BOOLEAN     NOT NULL DEFAULT true,
  `removedAt`   DATETIME    NULL,
  `notifiedAt`  DATETIME    NULL,
  `createdAt`   DATETIME    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (`inviteeId`),
  UNIQUE INDEX `meetingPollInvitees_pollId_userId_key` (`pollId`, `userId`),
  INDEX `meetingPollInvitees_userId_idx` (`userId`),
  FOREIGN KEY (`pollId`) REFERENCES `meetingPolls`(`pollId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One row per (invitee, option).  A submission is all-or-nothing: the service
-- layer rejects anything that does not cover every option on the poll, so a
-- complete set of rows is written or none are.
CREATE TABLE `meetingPollResponses` (
  `responseId`   INT         NOT NULL AUTO_INCREMENT,
  `pollId`       INT         NOT NULL,
  `userId`       INT         NOT NULL,
  `optionId`     INT         NOT NULL,
  -- yes | no | maybe
  `availability` VARCHAR(8)  NOT NULL,
  `createdAt`    DATETIME    NOT NULL DEFAULT NOW(),
  `updatedAt`    DATETIME    NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  PRIMARY KEY (`responseId`),
  UNIQUE INDEX `meetingPollResponses_pollId_userId_optionId_key` (`pollId`, `userId`, `optionId`),
  INDEX `meetingPollResponses_optionId_idx` (`optionId`),
  FOREIGN KEY (`pollId`) REFERENCES `meetingPolls`(`pollId`) ON DELETE CASCADE,
  FOREIGN KEY (`optionId`) REFERENCES `meetingPollOptions`(`optionId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Events gain an internal/staff-only flag and a back-link to the meeting poll
-- that produced them.  Both columns are unused in phase one: the
-- finalise -> event handoff is a later pass, and nothing writes `meetingPollId`
-- yet.  Added now so that pass is a code change with no further migration.
ALTER TABLE `events`
  ADD COLUMN `internal` BOOLEAN NOT NULL DEFAULT false AFTER `visibility`,
  ADD COLUMN `meetingPollId` INT NULL AFTER `templateId`,
  ADD INDEX `events_meetingPollId_idx` (`meetingPollId`),
  ADD FOREIGN KEY (`meetingPollId`) REFERENCES `meetingPolls`(`pollId`) ON DELETE SET NULL;
