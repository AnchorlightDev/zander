-- =============================================================================
-- Migration 0023: Create rankCatalog table
-- =============================================================================
-- Stores the public-facing rank/product catalog for the /ranks page.
-- Each entry can optionally link to a Stripe price ID for checkout.
-- Perks are stored as a JSON array of strings.
-- =============================================================================

DROP PROCEDURE IF EXISTS _zander_migrate_0023;

CREATE PROCEDURE _zander_migrate_0023()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'rankCatalog'
    ) THEN
        CREATE TABLE `rankCatalog` (
            `id`                  INT            NOT NULL AUTO_INCREMENT,
            `stripePriceId`       VARCHAR(64)    NULL DEFAULT NULL,
            `displayName`         VARCHAR(128)   NOT NULL,
            `description`         TEXT           NULL,
            `imageUrl`            VARCHAR(512)   NULL,
            `category`            VARCHAR(64)    NOT NULL DEFAULT 'Ranks',
            `categorySortOrder`   INT            NOT NULL DEFAULT 0,
            `sortOrder`           INT            NOT NULL DEFAULT 0,
            `perks`               JSON           NULL,
            `createdAt`           DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updatedAt`           DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`)
        );
    END IF;
END;

CALL _zander_migrate_0023();

DROP PROCEDURE IF EXISTS _zander_migrate_0023;
