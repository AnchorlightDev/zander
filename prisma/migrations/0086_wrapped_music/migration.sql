-- ============================================================
-- Wrapped music bed is now admin-managed from the dashboard.
--
-- Previously the only way to give the deck a real soundtrack was to drop a
-- file on the server disk (assets/audio/wrapped-bed.mp3), which does not
-- survive a redeploy on an ephemeral host. This column stores the URL of an
-- uploaded (or externally hosted) no-copyright track; the deck plays it when
-- set, and otherwise falls back to the on-disk file and then to the browser's
-- generative ambient bed. NULL means "no custom track".
-- ============================================================

ALTER TABLE wrappedSettings
    ADD COLUMN musicUrl VARCHAR(512) NULL AFTER rollingMonths;
