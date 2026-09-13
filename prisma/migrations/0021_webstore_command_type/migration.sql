-- =============================================================================
-- Migration 0021: Add commandType column to webstoreStripeCommands
-- =============================================================================
-- Adds a commandType column to distinguish Minecraft console commands from
-- Discord role actions.  The column defaults to 'minecraft' so all existing
-- rows retain their current behaviour without any data migration.
--
-- Supported types:
--   minecraft     — run as a console command via the executorTasks queue
--   discord_role  — add or remove a Discord role from the purchaser/recipient
-- =============================================================================

DROP PROCEDURE IF EXISTS _zander_migrate_0021;

CREATE PROCEDURE _zander_migrate_0021()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreStripeCommands'
          AND COLUMN_NAME  = 'commandType'
    ) THEN
        ALTER TABLE `webstoreStripeCommands`
            ADD COLUMN `commandType`
                ENUM('minecraft','discord_role') NOT NULL DEFAULT 'minecraft'
                AFTER `action`;
    END IF;
END;

CALL _zander_migrate_0021();

DROP PROCEDURE IF EXISTS _zander_migrate_0021;
