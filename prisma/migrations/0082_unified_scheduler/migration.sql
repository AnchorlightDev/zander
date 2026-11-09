-- Unified scheduler: jobs with ordered actions, runs tracked for exactly-once
-- execution. Replaces the single-purpose scheduledDiscordMessages table, whose
-- rows are migrated into jobs (one discord_message action each) before it is
-- dropped. All timestamps are UTC (mysql2 pool timezone "Z").
--
-- Reserved-word note: the spec's `interval` and `trigger` are stored as
-- `recurInterval` and `triggerType` to avoid quoting MySQL keywords everywhere.

CREATE TABLE `scheduled_jobs` (
  `id`             INT          NOT NULL AUTO_INCREMENT,
  `title`          VARCHAR(160) NOT NULL,
  `description`    TEXT         NULL,
  `enabled`        TINYINT      NOT NULL DEFAULT 1,
  `scheduleType`   ENUM('once','recurring') NOT NULL DEFAULT 'once',
  `runAt`          DATETIME(3)  NULL,
  `frequency`      ENUM('daily','weekly','monthly') NULL,
  `recurInterval`  INT          NOT NULL DEFAULT 1,
  `byWeekday`      VARCHAR(32)  NULL,
  `byMonthDay`     INT          NULL,
  `timeOfDay`      VARCHAR(5)   NULL,
  `timezone`       VARCHAR(64)  NOT NULL DEFAULT 'Australia/Sydney',
  `untilDate`      DATETIME(3)  NULL,
  `nextRunAt`      DATETIME(3)  NULL,
  `runNumberStart` INT          NOT NULL DEFAULT 1,
  `createdBy`      INT          NULL,
  `updatedBy`      INT          NULL,
  `createdAt`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `scheduled_jobs_due_idx` (`enabled`, `nextRunAt`)
);

CREATE TABLE `scheduled_job_actions` (
  `id`              INT          NOT NULL AUTO_INCREMENT,
  `jobId`           INT          NOT NULL,
  `sortOrder`       INT          NOT NULL DEFAULT 0,
  `actionType`      VARCHAR(32)  NOT NULL,
  `payload`         JSON         NULL,
  `continueOnError` TINYINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `scheduled_job_actions_job_idx` (`jobId`, `sortOrder`),
  CONSTRAINT `scheduled_job_actions_jobId_fkey`
    FOREIGN KEY (`jobId`) REFERENCES `scheduled_jobs`(`id`) ON DELETE CASCADE
);

CREATE TABLE `scheduled_job_runs` (
  `id`          INT         NOT NULL AUTO_INCREMENT,
  `jobId`       INT         NOT NULL,
  `dueAt`       DATETIME(3) NOT NULL,
  `status`      ENUM('running','succeeded','partial','failed','missed','skipped') NOT NULL DEFAULT 'running',
  `startedAt`   DATETIME(3) NULL,
  `finishedAt`  DATETIME(3) NULL,
  `triggerType` ENUM('schedule','manual') NOT NULL DEFAULT 'schedule',
  `triggeredBy` INT         NULL,
  `runNumber`   INT         NULL,
  `results`     JSON        NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `scheduled_job_runs_unique` (`jobId`, `dueAt`, `triggerType`),
  KEY `scheduled_job_runs_job_idx` (`jobId`, `dueAt`),
  CONSTRAINT `scheduled_job_runs_jobId_fkey`
    FOREIGN KEY (`jobId`) REFERENCES `scheduled_jobs`(`id`) ON DELETE CASCADE
);

-- Migrate scheduledDiscordMessages into one-off jobs with a single
-- discord_message action. A temp column carries the source scheduleId so the
-- action and run rows can be linked with a JOIN.
ALTER TABLE `scheduled_jobs` ADD COLUMN `_srcScheduleId` INT NULL;

INSERT INTO `scheduled_jobs`
  (`title`, `scheduleType`, `runAt`, `enabled`, `nextRunAt`, `timezone`, `createdBy`, `createdAt`, `updatedAt`, `_srcScheduleId`)
SELECT LEFT(COALESCE(NULLIF(TRIM(s.`embedTitle`), ''), 'Discord message'), 160),
       'once',
       s.`scheduledFor`,
       CASE WHEN s.`status` = 'scheduled' AND s.`sentAt` IS NULL THEN 1 ELSE 0 END,
       CASE WHEN s.`status` = 'scheduled' AND s.`sentAt` IS NULL THEN s.`scheduledFor` ELSE NULL END,
       'Australia/Sydney',
       s.`createdBy`,
       COALESCE(s.`createdAt`, UTC_TIMESTAMP(3)),
       UTC_TIMESTAMP(3),
       s.`scheduleId`
FROM `scheduledDiscordMessages` s;

INSERT INTO `scheduled_job_actions` (`jobId`, `sortOrder`, `actionType`, `payload`, `continueOnError`)
SELECT j.`id`, 0, 'discord_message',
       JSON_OBJECT('channelId', s.`channelId`, 'embedTitle', s.`embedTitle`,
                   'embedDescription', s.`embedDescription`, 'embedColor', s.`embedColor`),
       0
FROM `scheduledDiscordMessages` s
JOIN `scheduled_jobs` j ON j.`_srcScheduleId` = s.`scheduleId`;

-- Preserve the outcome of rows that already ran (sent or failed) as a run row.
INSERT INTO `scheduled_job_runs`
  (`jobId`, `dueAt`, `status`, `startedAt`, `finishedAt`, `triggerType`, `triggeredBy`, `runNumber`, `results`)
SELECT j.`id`, s.`scheduledFor`,
       CASE s.`status` WHEN 'sent' THEN 'succeeded' WHEN 'failed' THEN 'failed' ELSE 'skipped' END,
       s.`sentAt`, s.`sentAt`, 'schedule', s.`createdBy`, 1,
       JSON_ARRAY(JSON_OBJECT('actionType', 'discord_message',
                              'status', CASE s.`status` WHEN 'sent' THEN 'succeeded' ELSE 'failed' END,
                              'message', COALESCE(s.`lastError`, '')))
FROM `scheduledDiscordMessages` s
JOIN `scheduled_jobs` j ON j.`_srcScheduleId` = s.`scheduleId`
WHERE s.`status` IN ('sent', 'failed');

ALTER TABLE `scheduled_jobs` DROP COLUMN `_srcScheduleId`;

DROP TABLE `scheduledDiscordMessages`;
