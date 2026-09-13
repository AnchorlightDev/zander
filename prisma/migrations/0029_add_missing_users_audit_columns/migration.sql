-- =============================================================================
-- Migration 0029: Add missing users.audit_lastMinecraftPunishment /
-- audit_lastDiscordPunishment columns
-- =============================================================================
-- These columns are declared in the 0001_baseline migration, but some
-- existing databases were provisioned before the baseline file was expanded
-- to include them, so `prisma migrate deploy` never re-runs 0001 to add
-- them (it's already marked applied). This left production instances
-- without the columns, breaking any query selecting them (e.g.
-- `SELECT ... audit_lastMinecraftPunishment ... FROM users`, ER_BAD_FIELD_ERROR).
-- Safe to run on both fresh installs (where 0001 already created the
-- columns) and drifted ones.
-- =============================================================================

DROP PROCEDURE IF EXISTS _zander_migrate_0029;

CREATE PROCEDURE _zander_migrate_0029()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'users'
          AND COLUMN_NAME  = 'audit_lastMinecraftPunishment'
    ) THEN
        ALTER TABLE `users`
            ADD COLUMN `audit_lastMinecraftPunishment` DATETIME DEFAULT NULL
            AFTER `audit_lastMinecraftMessage`;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'users'
          AND COLUMN_NAME  = 'audit_lastDiscordPunishment'
    ) THEN
        ALTER TABLE `users`
            ADD COLUMN `audit_lastDiscordPunishment` DATETIME DEFAULT NULL
            AFTER `audit_lastMinecraftPunishment`;
    END IF;
END;

CALL _zander_migrate_0029();

DROP PROCEDURE IF EXISTS _zander_migrate_0029;
