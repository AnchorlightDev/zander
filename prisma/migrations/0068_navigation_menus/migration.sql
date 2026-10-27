-- The site's editable menus (header, top bar, footer), edited at
-- /dashboard/menus. One row per menu location holding its whole item tree as
-- JSON, saved in one go like WordPress's "Save Menu". A location with no row
-- uses the built-in default menu (lib/navigation/menus.mjs).
CREATE TABLE `navigationMenus` (
  `location`        VARCHAR(32)   NOT NULL,
  `items`           JSON          NOT NULL,
  `updatedByUserId` INT           NULL,
  `updatedAt`       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`location`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
