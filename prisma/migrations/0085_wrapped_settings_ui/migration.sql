-- ============================================================
-- Wrapped period settings are now driven entirely by the dashboard
-- (no more config.json layer). This migration:
--   * widens periodStart/periodEnd to hold "YYYY-MM-DD" as well as "MM-DD"
--   * adds rollingMonths so the default window length is UI-controlled
--
-- All columns still NULL-able: NULL periodStart+periodEnd => rolling window
-- of rollingMonths (or 12) ending today.
-- ============================================================

ALTER TABLE wrappedSettings
    MODIFY periodStart VARCHAR(10) NULL,
    MODIFY periodEnd   VARCHAR(10) NULL,
    ADD COLUMN rollingMonths TINYINT UNSIGNED NULL AFTER periodEnd;
