-- Standalone form builder.
--
-- `applications` rows were always a link out to an external host (Google Forms
-- and the like): the row carried a `redirectUrl` and nothing else.  The
-- application editor and `/apply` were already written against a `forms` table
-- that had never been created, so `applicationType`/`linkedFormId` writes threw
-- "Unknown column" and the `forms` join in /api/application/get silently fell
-- back to a plain SELECT.  This migration creates that table and the two
-- columns, so an application can point at a form hosted here instead.
--
-- Forms are not application-only -- a form stands on its own at /forms/<slug>
-- and an application linking to one is just the first consumer.
CREATE TABLE `forms` (
  `formId`           INT          NOT NULL AUTO_INCREMENT,
  `name`             VARCHAR(100) NOT NULL,
  `slug`             VARCHAR(100) NOT NULL,
  `description`      TEXT         NULL,
  `status`           TINYINT(1)   NOT NULL DEFAULT 0,
  `successMessage`   TEXT         NULL,
  `discordChannelId` VARCHAR(255) NULL,
  `allowMultiple`    TINYINT(1)   NOT NULL DEFAULT 0,
  `createdAt`        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`formId`),
  UNIQUE INDEX `forms_slug_key` (`slug`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Fields are rows rather than a JSON blob on `forms` so the submission
-- renderer and the validator read the same ordered list, and so a field can be
-- renamed without rewriting every stored submission (answers key off
-- `fieldKey`, which is immutable once set).
CREATE TABLE `formFields` (
  `fieldId`     INT          NOT NULL AUTO_INCREMENT,
  `formId`      INT          NOT NULL,
  `label`       VARCHAR(255) NOT NULL,
  `fieldKey`    VARCHAR(64)  NOT NULL,
  `fieldType`   VARCHAR(32)  NOT NULL DEFAULT 'text',
  `placeholder` VARCHAR(255) NULL,
  `helpText`    TEXT         NULL,
  `options`     JSON         NULL,
  `isRequired`  TINYINT(1)   NOT NULL DEFAULT 0,
  `maxLength`   INT          NULL,
  `position`    INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (`fieldId`),
  UNIQUE INDEX `formFields_formId_fieldKey_key` (`formId`, `fieldKey`),
  INDEX `formFields_formId_position_idx` (`formId`, `position`),
  CONSTRAINT `formFields_formId_fkey`
    FOREIGN KEY (`formId`) REFERENCES `forms` (`formId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Answers are JSON: the shape is per-form and only ever read back whole, for
-- one submission at a time, so a child value table would buy nothing.
CREATE TABLE `formSubmissions` (
  `submissionId`     INT          NOT NULL AUTO_INCREMENT,
  `formId`           INT          NOT NULL,
  `userId`           INT          NOT NULL,
  `status`           VARCHAR(16)  NOT NULL DEFAULT 'pending',
  `answers`          JSON         NOT NULL,
  `reviewedBy`       INT          NULL,
  `reviewNotes`      TEXT         NULL,
  `reviewedAt`       DATETIME(3)  NULL,
  `discordMessageId` VARCHAR(255) NULL,
  `createdAt`        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`submissionId`),
  INDEX `formSubmissions_formId_status_idx` (`formId`, `status`),
  INDEX `formSubmissions_userId_idx` (`userId`),
  CONSTRAINT `formSubmissions_formId_fkey`
    FOREIGN KEY (`formId`) REFERENCES `forms` (`formId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The columns api/routes/application.js has been writing all along.
-- 'external' preserves every existing row's behaviour (redirect to
-- `redirectUrl`); 'linked_form' reads `linkedFormId` instead.
ALTER TABLE `applications`
  ADD COLUMN `applicationType` VARCHAR(20) NOT NULL DEFAULT 'external' AFTER `applicationStatus`,
  ADD COLUMN `linkedFormId`    INT         NULL                        AFTER `applicationType`;

-- ON DELETE SET NULL, not CASCADE: deleting a form must not delete the
-- application that pointed at it -- it falls back to showing as unavailable.
ALTER TABLE `applications`
  ADD CONSTRAINT `applications_linkedFormId_fkey`
    FOREIGN KEY (`linkedFormId`) REFERENCES `forms` (`formId`) ON DELETE SET NULL;
