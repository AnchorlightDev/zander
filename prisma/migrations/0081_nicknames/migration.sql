-- Nicknames: a supporter perk gated by the LuckPerms node `zander.nickname`.
--
-- Design notes:
--  * Everything keys off users.userId (the stable PK); never off username.
--  * Each nickname stores a normalised `skeleton` (lowercased, lookalike-folded,
--    `_` stripped) in an INDEXED column so impersonation checks are single
--    indexed lookups rather than full scans.
--  * "Hidden" (owner lost the permission) is NOT stored as a flag. A player's
--    current nickname simply lives in `nicknames`; it is displayed only while the
--    owner currently holds `zander.nickname` (resolved live from LuckPerms). The
--    row's continued existence is what reserves the name to them indefinitely.
--    There is deliberately no cleanup job that deletes lapsed nicknames.
--  * No DB-level foreign keys, matching the existing `reports` / `logs` tables;
--    userId columns are plain indexed INTs.

-- One durable row per user who has ever set a nickname.
--  * nickname/skeleton NOT NULL  -> the user's current nickname (displayed iff
--    the owner currently holds zander.nickname; otherwise "hidden").
--  * nickname/skeleton NULL       -> the user cleared it. The row is kept so the
--    cooldown anchor survives the clear.
-- lastChangeAt anchors the once-per-24h cooldown: set to NOW on every accepted
-- set/change, PRESERVED on a clear (clearing does not reset the cooldown), and
-- set to NULL by a staff reset (staff resets do not count against the player).
CREATE TABLE `nicknames` (
  `nicknameId`   INT          NOT NULL AUTO_INCREMENT,
  `userId`       INT          NOT NULL,
  `nickname`     VARCHAR(16)  NULL,
  `skeleton`     VARCHAR(32)  NULL,
  `color`        VARCHAR(16)  NULL,
  `setAt`        DATETIME     NULL,
  `lastChangeAt` DATETIME     NULL,
  PRIMARY KEY (`nicknameId`),
  UNIQUE KEY `nicknames_userId_key` (`userId`),
  KEY `nicknames_skeleton_idx` (`skeleton`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 14-day holds created when a player changes or clears a nickname, so nobody can
-- grab the old name to impersonate them and the previous owner can reclaim it.
CREATE TABLE `nicknameReservations` (
  `reservationId` INT          NOT NULL AUTO_INCREMENT,
  `userId`        INT          NOT NULL,
  `nickname`      VARCHAR(16)  NOT NULL,
  `skeleton`      VARCHAR(32)  NOT NULL,
  `reservedUntil` DATETIME     NOT NULL,
  `createdAt`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`reservationId`),
  KEY `nicknameReservations_skeleton_idx` (`skeleton`),
  KEY `nicknameReservations_userId_idx` (`userId`),
  KEY `nicknameReservations_reservedUntil_idx` (`reservedUntil`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Full history: every nickname a user has held, when set and cleared, and by whom.
CREATE TABLE `nicknameHistory` (
  `historyId`  INT          NOT NULL AUTO_INCREMENT,
  `userId`     INT          NOT NULL,
  `nickname`   VARCHAR(16)  NOT NULL,
  `color`      VARCHAR(16)  NULL,
  `setAt`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `clearedAt`  DATETIME     NULL,
  -- userId that cleared it (the owner for self-clears, or a staff member). NULL
  -- while the nickname is still active.
  `clearedBy`  INT          NULL,
  `reason`     VARCHAR(255) NULL,
  PRIMARY KEY (`historyId`),
  KEY `nicknameHistory_userId_idx` (`userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Staff lockouts: a player barred from using nicknames, with a reason and
-- optional expiry (NULL expiry = until a staff member unlocks).
CREATE TABLE `nicknameLockouts` (
  `lockoutId`  INT          NOT NULL AUTO_INCREMENT,
  `userId`     INT          NOT NULL,
  `reason`     VARCHAR(255) NULL,
  `lockedBy`   INT          NOT NULL,
  `expiresAt`  DATETIME     NULL,
  `createdAt`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`lockoutId`),
  UNIQUE KEY `nicknameLockouts_userId_key` (`userId`),
  KEY `nicknameLockouts_expiresAt_idx` (`expiresAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Staff-editable blocklist. entryType 'word' = banned substring; entryType 'rank'
-- = rank/authority word that may not appear in a nickname. Matched against the
-- normalised form of a candidate. addedBy NULL = seeded by this migration.
CREATE TABLE `nicknameBlocklist` (
  `entryId`    INT          NOT NULL AUTO_INCREMENT,
  `entryType`  VARCHAR(8)   NOT NULL,
  `value`      VARCHAR(64)  NOT NULL,
  `addedBy`    INT          NULL,
  `createdAt`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`entryId`),
  UNIQUE KEY `nicknameBlocklist_type_value_key` (`entryType`, `value`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed: rank / authority words (impersonation of staff or system roles).
INSERT INTO `nicknameBlocklist` (`entryType`, `value`) VALUES
  ('rank', 'admin'),
  ('rank', 'administrator'),
  ('rank', 'mod'),
  ('rank', 'moderator'),
  ('rank', 'owner'),
  ('rank', 'staff'),
  ('rank', 'helper'),
  ('rank', 'dev'),
  ('rank', 'developer'),
  ('rank', 'support'),
  ('rank', 'server'),
  ('rank', 'console'),
  ('rank', 'system'),
  ('rank', 'official');

-- Seed: starter banned-word list (normalised, lowercase). Staff extend this from
-- the dashboard. Intentionally small; matched against the folded/normalised form.
INSERT INTO `nicknameBlocklist` (`entryType`, `value`) VALUES
  ('word', 'fuck'),
  ('word', 'shit'),
  ('word', 'bitch'),
  ('word', 'cunt'),
  ('word', 'dick'),
  ('word', 'penis'),
  ('word', 'pussy'),
  ('word', 'slut'),
  ('word', 'whore'),
  ('word', 'rape'),
  ('word', 'retard'),
  ('word', 'nigger'),
  ('word', 'nigga'),
  ('word', 'faggot'),
  ('word', 'kike'),
  ('word', 'spic'),
  ('word', 'chink'),
  ('word', 'nazi'),
  ('word', 'hitler');
