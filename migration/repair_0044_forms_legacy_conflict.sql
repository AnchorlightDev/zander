-- Repair: 0044_forms failed against a database that already had the v1.9.0
-- forms system.
--
-- SYMPTOM
--   npx prisma migrate deploy  ->  Error P3009
--   "The `0044_forms` migration started at ... failed"
--   _prisma_migrations.applied_steps_count = 0
--
-- CAUSE
--   migration/v1.9.0_v1.10.0.sql (hand-run, pre-Prisma) already created a
--   `forms` table -- a completely different one: formId, name VARCHAR(120),
--   slug VARCHAR(150), status ENUM('draft','published','archived'),
--   createdByUserId, discordWebhookUrl, ... plus `formBlocks` and
--   `formResponses`, and the applications.applicationType / linkedFormId
--   columns.
--
--   prisma/migrations/0044_forms/migration.sql opens with a plain
--   `CREATE TABLE forms` (no IF NOT EXISTS) for an incompatible schema, so it
--   dies on statement 1 of 5. Its statement 4 would then also fail on
--   "Duplicate column name 'applicationType'".
--
--   Nothing from 0044 was applied. 0045 and 0047-0053 never ran at all.
--
-- WHAT THIS DOES
--   Puts the database back to the state 0044 expects to find, so it can be
--   marked rolled-back and re-run for real.
--
--   Nothing is dropped. The legacy tables are RENAMED, not deleted, and the
--   two applications columns are copied to a backup table before being
--   removed. Everything remains readable afterwards.
--
-- WHAT YOU LOSE
--   The 6 legacy forms and their responses do NOT carry over into the new
--   forms system. The two schemas do not map onto one another (legacy
--   `formBlocks.type` vs the new `formFields.fieldType` + immutable
--   `fieldKey`, and `formResponses.answers` is keyed by blockId rather than
--   fieldKey). Anything still wanted has to be rebuilt in the new form
--   builder at /dashboard/forms. The old rows stay in the _legacy_v19 tables
--   for reference.
--
--   Any application currently set to 'linked_form' reverts to 'external'
--   and needs re-pointing once its form has been rebuilt. See step 0.
--
-- TAKE A BACKUP FIRST. This is production.

-- ===========================================================================
-- STEP 0 -- Look before you leap. Run these on their own and keep the output.
-- ===========================================================================

-- What the 6 legacy forms actually are, so you can decide what to rebuild.
--   SELECT formId, name, slug, status, createdAt FROM forms ORDER BY formId;

-- How much is attached to them.
--   SELECT COUNT(*) FROM formBlocks;
--   SELECT formId, COUNT(*) AS responses FROM formResponses GROUP BY formId;

-- Which applications will need re-pointing afterwards.
--   SELECT applicationId, displayName, applicationType, linkedFormId
--   FROM applications
--   WHERE applicationType = 'linked_form' OR linkedFormId IS NOT NULL;

-- Confirm no foreign key already hangs off linkedFormId (there should be
-- none -- 0044's statement 5 is the one that adds it, and it never ran).
--   SELECT CONSTRAINT_NAME, REFERENCED_TABLE_NAME
--   FROM information_schema.KEY_COLUMN_USAGE
--   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'applications'
--     AND REFERENCED_TABLE_NAME IS NOT NULL;


-- ===========================================================================
-- STEP 1 -- Preserve the applications columns, then remove them.
-- ===========================================================================
-- 0044 re-adds both columns itself, with applicationType as VARCHAR(20)
-- rather than the legacy ENUM, which is what prisma/schema.prisma models.
-- Done before the rename so that if a foreign key does exist on linkedFormId,
-- it goes with the column instead of being left pointing at a renamed table.

CREATE TABLE `applications_legacy_v19_cols` AS
  SELECT `applicationId`, `applicationType`, `linkedFormId`
  FROM `applications`;

ALTER TABLE `applications`
  DROP COLUMN `applicationType`,
  DROP COLUMN `linkedFormId`;


-- ===========================================================================
-- STEP 2 -- Move the legacy forms tables aside.
-- ===========================================================================
-- One statement, so it is atomic. InnoDB rewrites the foreign keys on
-- formBlocks and formResponses to follow the renamed parent, so the three
-- tables stay internally consistent and independently readable.

RENAME TABLE
  `formResponses` TO `formResponses_legacy_v19`,
  `formBlocks`    TO `formBlocks_legacy_v19`,
  `forms`         TO `forms_legacy_v19`;


-- ===========================================================================
-- STEP 3 -- Hand back to Prisma. Run these in a shell, not here.
-- ===========================================================================
--   npx prisma migrate resolve --rolled-back 0044_forms
--   npx prisma migrate deploy
--
-- 0044 now applies all five statements against a clean slate, followed by
-- 0045_form_tickets and 0047_form_field_config through
-- 0053_form_ticket_messages.
--
-- Verify:
--   SELECT migration_name, finished_at, applied_steps_count
--   FROM _prisma_migrations
--   WHERE migration_name >= '0044' ORDER BY migration_name;
--
--   SHOW COLUMNS FROM forms;   -- expect description, successMessage,
--                              -- discordChannelId, allowMultiple, accessCode,
--                              -- requirements, reapplyCooldownDays,
--                              -- ticketPendingMessage, ...


-- ===========================================================================
-- STEP 4 -- Afterwards, in the dashboard.
-- ===========================================================================
-- Rebuild whichever of the 6 legacy forms are still wanted at
-- /dashboard/forms, then re-point their applications at the new forms in
-- /dashboard/applications. The editor now shows whether the linked form has a
-- Discord channel, a ticket, requirements and so on, so it is obvious when one
-- is not finished being set up.
--
-- Once you are satisfied nothing was needed from them, the _legacy_v19 tables
-- and applications_legacy_v19_cols can be dropped. Not before.
