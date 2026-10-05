-- Staff-written pages served at /<slug> (routes/customPageRoutes.js), edited
-- at /dashboard/pages. `content` is Summernote HTML, sanitised on save and
-- again on render.
CREATE TABLE `customPages` (
  `pageId`          INT           NOT NULL AUTO_INCREMENT,
  `slug`            VARCHAR(100)  NOT NULL,
  `title`           VARCHAR(150)  NOT NULL,
  `content`         MEDIUMTEXT    NOT NULL,
  `metaDescription` VARCHAR(300)  NULL,
  `status`          VARCHAR(16)   NOT NULL DEFAULT 'draft',
  `createdByUserId` INT           NULL,
  `updatedByUserId` INT           NULL,
  `createdAt`       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`pageId`),
  UNIQUE INDEX `customPages_slug_key` (`slug`),
  INDEX `customPages_status_idx` (`status`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
