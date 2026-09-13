-- =============================================================================
-- Migration 0019: Add missing 'action' column to webstore command tables
-- =============================================================================
-- The webstoreStripeCommands and webstoreCommandRuns tables were created
-- before the 'action' ENUM column was present in the schema.  On some
-- installations the column may already exist (e.g. added manually or via
-- a later version of 0017).  This migration uses a stored procedure so it
-- is safe to run on both fresh installs and existing databases.
-- =============================================================================

DROP PROCEDURE IF EXISTS _zander_migrate_0019;

CREATE PROCEDURE _zander_migrate_0019()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreStripeCommands'
          AND COLUMN_NAME  = 'action'
    ) THEN
        ALTER TABLE `webstoreStripeCommands`
            ADD COLUMN `action` ENUM('grant','revoke') NOT NULL DEFAULT 'grant';
        ALTER TABLE `webstoreStripeCommands`
            ADD INDEX `webstoreStripeCommands_action` (`action`);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'webstoreCommandRuns'
          AND COLUMN_NAME  = 'action'
    ) THEN
        ALTER TABLE `webstoreCommandRuns`
            ADD COLUMN `action` ENUM('grant','revoke') NOT NULL DEFAULT 'grant';
    END IF;
END;

CALL _zander_migrate_0019();

DROP PROCEDURE IF EXISTS _zander_migrate_0019;
