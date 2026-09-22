-- Site-wide defaults, and the opt-in that lets a form inherit them.
--
-- Eligibility thresholds are policy, not deployment config: staff change their
-- mind about whether it is 20 hours or 15, and that should not need a file
-- edit and a redeploy. So they live in the database and are edited from the
-- dashboard.
--
-- A generic key/value table rather than a column per setting -- there is no
-- settings infrastructure in this app at all yet, and one JSON row per named
-- setting is the smallest thing that does not need a migration every time
-- something new becomes configurable.
CREATE TABLE `siteSettings` (
  `settingKey`   VARCHAR(100) NOT NULL,
  `settingValue` JSON         NULL,
  `updatedAt`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`settingKey`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Opt-in, DEFAULT 0, and that matters.
--
-- If forms inherited the defaults automatically, the moment somebody set a
-- site-wide "20 hours playtime" every feedback survey would start turning
-- people away. Applications tick this; surveys do not.
--
-- A form that opts in still sets its own values for any check it wants to
-- differ on -- those win over the default. Setting one to 0 switches that
-- inherited check off for this form only.
ALTER TABLE `forms`
  ADD COLUMN `useGlobalRequirements` TINYINT(1) NOT NULL DEFAULT 0 AFTER `requirements`;
