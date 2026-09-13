-- =============================================================================
-- Migration 0025: Convert announcements table to utf8mb4
-- =============================================================================
-- The announcements table was created before the charset was standardised on
-- utf8mb4, so the body column (and other TEXT columns) still use MySQL's 3-byte
-- utf8 charset, which rejects 4-byte characters such as emojis.
-- CONVERT TO CHARACTER SET re-encodes every column in the table in one step.
-- =============================================================================

DROP PROCEDURE IF EXISTS _zander_migrate_0025;

CREATE PROCEDURE _zander_migrate_0025()
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'announcements'
          AND TABLE_COLLATION NOT LIKE 'utf8mb4%'
    ) THEN
        ALTER TABLE `announcements`
            CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    END IF;
END;

CALL _zander_migrate_0025();

DROP PROCEDURE IF EXISTS _zander_migrate_0025;
