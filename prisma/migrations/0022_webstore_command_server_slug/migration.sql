-- =============================================================================
-- Migration 0022: Add serverSlug column to webstoreStripeCommands
-- =============================================================================
-- Adds an optional serverSlug column so each Minecraft command can target a
-- specific server slug when enqueued via executorTasks.  NULL means the task
-- is not filtered by slug and any bridge executor will pick it up.
-- =============================================================================

DROP PROCEDURE IF EXISTS _zander_migrate_0022;

CREATE PROCEDURE _zander_migrate_0022()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreStripeCommands'
          AND COLUMN_NAME  = 'serverSlug'
    ) THEN
        ALTER TABLE `webstoreStripeCommands`
            ADD COLUMN `serverSlug` VARCHAR(64) NULL DEFAULT NULL
                AFTER `commandTemplate`;
    END IF;
END;

CALL _zander_migrate_0022();

DROP PROCEDURE IF EXISTS _zander_migrate_0022;
