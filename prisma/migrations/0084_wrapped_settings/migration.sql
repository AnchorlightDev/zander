-- ============================================================
-- Crafting For Christ Wrapped — editable period settings
--
-- The Wrapped window was previously config.json-only (gitignored, needs a
-- deploy to change). This singleton table lets an admin adjust the
-- start/end and the on/off switch from the dashboard. A NULL column means
-- "fall back to config.json / built-in default".
--
-- periodStart / periodEnd are "MM-DD" strings (UTC day boundaries).
-- ============================================================

CREATE TABLE IF NOT EXISTS wrappedSettings (
    id          TINYINT      NOT NULL DEFAULT 1,
    enabled     TINYINT(1)   NULL,
    periodStart VARCHAR(5)   NULL,
    periodEnd   VARCHAR(5)   NULL,
    updatedAt   DATETIME     NOT NULL DEFAULT NOW() ON UPDATE NOW(),
    PRIMARY KEY (id),
    CONSTRAINT wrappedSettings_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO wrappedSettings (id, enabled, periodStart, periodEnd)
VALUES (1, NULL, NULL, NULL)
ON DUPLICATE KEY UPDATE id = id;
