-- Announcements become write-once "posts" that publish to several platforms at
-- once, and holograms become one of those platforms.
--
-- Data model:
--   * `announcement_posts` is the new parent. One row per logical announcement.
--   * `announcements` stays the per-platform delivery row and gains `postId`
--     (FK, cascade). A post has one `announcements` row per platform it targets.
--   * `announcements_type` gains `hologram`, plus hologram-only columns on
--     `announcements`. Hologram text lives in `colourMessageFormat`; `body` holds
--     a colour-code-stripped plain-text copy for list display. Hologram expiry
--     reuses `endDate`; holograms also gain `startDate` support.
--
-- Backfill: every existing announcement gets its own post; every hologram_messages
-- frame is copied into `announcements` as a `hologram` row with its own post. Then
-- `postId` becomes NOT NULL and `hologram_messages` is dropped.
--
-- All timestamps are UTC (the mysql2 pool runs with timezone "Z").

-- 1. Parent post table.
CREATE TABLE `announcement_posts` (
  `postId`    INT          NOT NULL AUTO_INCREMENT,
  `title`     VARCHAR(120) NULL,
  `createdBy` INT          NULL,
  `createdAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`postId`)
);

-- 2. Hologram platform: extend the enum, add hologram-only columns, and link each
-- delivery row to its parent post.
ALTER TABLE `announcements`
  MODIFY COLUMN `announcementType` ENUM('motd','tip','web','popup','hologram') NULL,
  ADD COLUMN `postId`                INT          NULL AFTER `announcementId`,
  ADD COLUMN `hologramGroup`         VARCHAR(64)  NULL AFTER `popupImageUrl`,
  ADD COLUMN `sortOrder`             INT          NULL AFTER `hologramGroup`,
  ADD COLUMN `countdownTo`           DATETIME(3)  NULL AFTER `sortOrder`,
  ADD COLUMN `countdownFinishedText` VARCHAR(512) NULL AFTER `countdownTo`;

ALTER TABLE `announcements`
  ADD INDEX `announcements_postId_idx` (`postId`),
  ADD CONSTRAINT `announcements_postId_fkey`
    FOREIGN KEY (`postId`) REFERENCES `announcement_posts`(`postId`) ON DELETE CASCADE;

-- 3. Backfill: give every existing announcement its own post. A temporary column
-- on announcement_posts carries the source announcementId so the link can be set
-- with a single JOIN (auto-increment ordering alone would be fragile).
ALTER TABLE `announcement_posts` ADD COLUMN `_srcAnnouncementId` INT NULL;

INSERT INTO `announcement_posts` (`title`, `createdBy`, `createdAt`, `updatedAt`, `_srcAnnouncementId`)
SELECT LEFT(COALESCE(NULLIF(TRIM(a.`body`), ''), 'Announcement'), 120),
       NULL,
       COALESCE(a.`createdAt`, UTC_TIMESTAMP(3)),
       UTC_TIMESTAMP(3),
       a.`announcementId`
FROM `announcements` a
WHERE a.`postId` IS NULL;

UPDATE `announcements` a
JOIN `announcement_posts` p ON p.`_srcAnnouncementId` = a.`announcementId`
SET a.`postId` = p.`postId`
WHERE a.`postId` IS NULL;

ALTER TABLE `announcement_posts` DROP COLUMN `_srcAnnouncementId`;

-- 4. Copy hologram_messages frames into announcements as `hologram` rows, one post
-- per frame. body gets the colour-code-stripped message (legacy "&x" codes and
-- hex "&#RRGGBB"); colourMessageFormat keeps the raw text with its codes and
-- {countdown}/{days}/... placeholders. Hologram expiry maps to endDate; holograms
-- had no start window, so startDate stays NULL.
ALTER TABLE `announcement_posts` ADD COLUMN `_srcHologramId` INT NULL;

INSERT INTO `announcement_posts` (`title`, `createdBy`, `createdAt`, `updatedAt`, `_srcHologramId`)
SELECT LEFT(COALESCE(NULLIF(TRIM(REGEXP_REPLACE(h.`message`, '&(#[0-9A-Fa-f]{6}|[0-9A-Fa-fK-Rk-r])', '')), ''), 'Hologram'), 120),
       NULL,
       COALESCE(h.`created_at`, UTC_TIMESTAMP(3)),
       UTC_TIMESTAMP(3),
       h.`id`
FROM `hologram_messages` h;

INSERT INTO `announcements`
  (`postId`, `announcementType`, `enabled`, `body`, `colourMessageFormat`, `link`,
   `hologramGroup`, `sortOrder`, `countdownTo`, `countdownFinishedText`,
   `startDate`, `endDate`, `createdAt`, `updatedDate`)
SELECT p.`postId`,
       'hologram',
       h.`enabled`,
       REGEXP_REPLACE(h.`message`, '&(#[0-9A-Fa-f]{6}|[0-9A-Fa-fK-Rk-r])', ''),
       h.`message`,
       h.`link`,
       h.`hologram_group`,
       h.`sort_order`,
       h.`countdown_to`,
       h.`countdown_finished_text`,
       NULL,
       h.`expires_at`,
       COALESCE(h.`created_at`, UTC_TIMESTAMP(3)),
       UTC_TIMESTAMP(3)
FROM `hologram_messages` h
JOIN `announcement_posts` p ON p.`_srcHologramId` = h.`id`;

ALTER TABLE `announcement_posts` DROP COLUMN `_srcHologramId`;

-- 5. Every announcement now has a post.
ALTER TABLE `announcements` MODIFY COLUMN `postId` INT NOT NULL;

-- 6. The hologram data now lives in announcements.
DROP TABLE `hologram_messages`;
