-- =============================================================================
-- Migration 0059: Webstore categories + product visibility
-- =============================================================================
-- Categories used to be a free-text `category` column repeated on every
-- rankCatalog row, with `categorySortOrder` duplicated alongside it -- so two
-- rows claiming the same category could disagree about where it sits. This
-- promotes categories to their own table: named, ordered and shown/hidden in
-- one place.
--
-- Also adds `visible` to rankCatalog so a product can be staged without being
-- published. A hidden category hides its products regardless of their own flag
-- (the read path ANDs the two together).
--
-- Deliberately no slug column: nothing routes by category, and generating
-- slugs here would risk two names colliding into one row during backfill.
-- =============================================================================

DROP PROCEDURE IF EXISTS _zander_migrate_0059;

CREATE PROCEDURE _zander_migrate_0059()
BEGIN
    -- 1. The categories table -------------------------------------------------
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreCategories'
    ) THEN
        CREATE TABLE `webstoreCategories` (
            `id`        INT          NOT NULL AUTO_INCREMENT,
            `name`      VARCHAR(64)  NOT NULL,
            `sortOrder` INT          NOT NULL DEFAULT 0,
            `visible`   TINYINT(1)   NOT NULL DEFAULT 1,
            `createdAt` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updatedAt` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                     ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uq_webstoreCategories_name` (`name`)
        );
    END IF;

    -- 2. Product visibility ---------------------------------------------------
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'rankCatalog'
          AND COLUMN_NAME  = 'visible'
    ) THEN
        ALTER TABLE `rankCatalog`
            ADD COLUMN `visible` TINYINT(1) NOT NULL DEFAULT 1 AFTER `imageUrl`;
    END IF;

    -- 3. Product -> category link --------------------------------------------
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'rankCatalog'
          AND COLUMN_NAME  = 'categoryId'
    ) THEN
        ALTER TABLE `rankCatalog`
            ADD COLUMN `categoryId` INT NULL DEFAULT NULL AFTER `visible`;
    END IF;

    -- 4. Backfill categories from the free-text values, keeping the lowest
    --    sort order each category was given.
    IF EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'rankCatalog'
          AND COLUMN_NAME  = 'category'
    ) THEN
        INSERT IGNORE INTO `webstoreCategories` (`name`, `sortOrder`)
        SELECT TRIM(`category`), MIN(`categorySortOrder`)
          FROM `rankCatalog`
         WHERE `category` IS NOT NULL
           AND TRIM(`category`) <> ''
         GROUP BY TRIM(`category`);

        UPDATE `rankCatalog` rc
          JOIN `webstoreCategories` wc ON wc.`name` = TRIM(rc.`category`)
           SET rc.`categoryId` = wc.`id`
         WHERE rc.`categoryId` IS NULL;
    END IF;

    -- 5. A store with no categories at all still needs somewhere to put things.
    IF NOT EXISTS (SELECT 1 FROM `webstoreCategories`) THEN
        INSERT INTO `webstoreCategories` (`name`, `sortOrder`) VALUES ('Ranks', 0);
    END IF;

    -- 6. Anything still unassigned (blank category, or a row added between
    --    steps) goes to the lowest-ordered category rather than vanishing from
    --    the page.
    UPDATE `rankCatalog`
       SET `categoryId` = (
           SELECT `id` FROM `webstoreCategories`
            ORDER BY `sortOrder` ASC, `id` ASC LIMIT 1
       )
     WHERE `categoryId` IS NULL;

    -- 7. The old columns are now dead weight; categoryId is the only source of
    --    truth. Mirrors what 0024 did to stripePriceId.
    IF EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'rankCatalog'
          AND COLUMN_NAME  = 'category'
    ) THEN
        ALTER TABLE `rankCatalog` DROP COLUMN `category`;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'rankCatalog'
          AND COLUMN_NAME  = 'categorySortOrder'
    ) THEN
        ALTER TABLE `rankCatalog` DROP COLUMN `categorySortOrder`;
    END IF;

    -- 8. Enforce the link. RESTRICT so deleting a category that still holds
    --    products fails loudly instead of orphaning them.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA     = DATABASE()
          AND TABLE_NAME       = 'rankCatalog'
          AND CONSTRAINT_NAME  = 'fk_rankCatalog_category'
    ) THEN
        ALTER TABLE `rankCatalog`
            ADD CONSTRAINT `fk_rankCatalog_category`
            FOREIGN KEY (`categoryId`) REFERENCES `webstoreCategories` (`id`)
            ON DELETE RESTRICT;
    END IF;
END;

CALL _zander_migrate_0059();

DROP PROCEDURE IF EXISTS _zander_migrate_0059;
