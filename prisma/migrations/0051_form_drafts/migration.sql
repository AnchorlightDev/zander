-- Autosaved, unsubmitted answers.
--
-- A long application is easy to lose: a closed tab, a flat battery, a "let me
-- go and check my playtime" that turns into tomorrow. Without this the whole
-- thing is retyped, and in practice it simply is not.
--
-- One row per person per form, overwritten in place rather than versioned --
-- the only draft anyone wants is the latest one, and history here would be a
-- lot of rows nobody will ever read.
--
-- Deleted on successful submission: once it is a formSubmissions row, the
-- draft is noise. Drafts skip required-field validation entirely; only
-- submitting enforces it.
--
-- Uploaded images are stored here exactly as they are in a submission -- the
-- Cloudinary metadata the upload endpoint returned. The files are already
-- durable on Cloudinary, so nothing extra is persisted for them.
CREATE TABLE `formDrafts` (
  `draftId`   INT         NOT NULL AUTO_INCREMENT,
  `formId`    INT         NOT NULL,
  `userId`    INT         NOT NULL,
  `answers`   JSON        NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`draftId`),
  UNIQUE INDEX `formDrafts_formId_userId_key` (`formId`, `userId`),
  INDEX `formDrafts_userId_idx` (`userId`),
  CONSTRAINT `formDrafts_formId_fkey`
    FOREIGN KEY (`formId`) REFERENCES `forms` (`formId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
