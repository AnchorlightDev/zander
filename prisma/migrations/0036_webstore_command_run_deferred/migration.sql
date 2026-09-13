-- ============================================================
-- webstoreCommandRuns: add a 'deferred' status.
--
-- A discord_role grant for a recipient who has not linked their Discord
-- account can't run yet — but it also shouldn't fail the whole purchase.
-- It's now recorded as 'deferred' and re-driven when the recipient links
-- their Discord account (see webstoreController.retryDeferredDiscordRoles).
-- ============================================================

ALTER TABLE `webstoreCommandRuns`
  MODIFY COLUMN `status`
    ENUM('queued','processing','completed','failed','deferred')
    NOT NULL DEFAULT 'queued';
