-- Rank-locked events.
--
-- `events.visibility` gains a third value, 'rank': the event is only fully
-- readable by visitors holding one of the LuckPerms groups listed in
-- `event_rank_access`.  `teaserPublic` decides what everyone else gets --
-- a locked teaser card (1) or nothing at all (0), which is the same practical
-- result as 'private' but keeps the two concepts separate in the editor.
--
-- Allowed ranks live in a child table rather than a JSON column so listing
-- queries can join/index on them; the JSON alternative made every public
-- events query a full scan.
ALTER TABLE `events`
  ADD COLUMN `teaserPublic` TINYINT(1) NOT NULL DEFAULT 1 AFTER `visibility`;

CREATE TABLE `event_rank_access` (
  `id`       INT         NOT NULL AUTO_INCREMENT,
  `eventId`  INT         NOT NULL,
  `rankSlug` VARCHAR(64) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `event_rank_access_eventId_rankSlug_key` (`eventId`, `rankSlug`),
  INDEX `event_rank_access_rankSlug_idx` (`rankSlug`),
  CONSTRAINT `event_rank_access_eventId_fkey`
    FOREIGN KEY (`eventId`) REFERENCES `events` (`eventId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Templates carry the same lock so recurring supporter events generate
-- already-locked drafts instead of needing a manual fix each week.
ALTER TABLE `event_templates`
  ADD COLUMN `visibility`   VARCHAR(32) NOT NULL DEFAULT 'public',
  ADD COLUMN `teaserPublic` TINYINT(1)  NOT NULL DEFAULT 1;

CREATE TABLE `event_template_rank_access` (
  `id`         INT         NOT NULL AUTO_INCREMENT,
  `templateId` INT         NOT NULL,
  `rankSlug`   VARCHAR(64) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `event_template_rank_access_templateId_rankSlug_key` (`templateId`, `rankSlug`),
  CONSTRAINT `event_template_rank_access_templateId_fkey`
    FOREIGN KEY (`templateId`) REFERENCES `event_templates` (`templateId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
