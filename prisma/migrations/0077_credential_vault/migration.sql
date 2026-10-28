-- Credential Vault: shared organisational credentials with per-access
-- reauthentication. Design record: docs/credential-vault-architecture.md.
--
-- Secret values are never stored here in plaintext. They live only in
-- credentialSecretVersions.ciphertext (AES-256-GCM under a per-credential data
-- key), and the data keys live only in credentialKeys.wrappedKey (wrapped by a
-- key-encryption key held outside the database, CREDENTIAL_VAULT_KEKS).
--
-- All times are UTC (the mysql2 pool runs with timezone "Z"); expiry
-- comparisons use timestamps passed in from the application, never NOW(), so
-- the database server's own time zone does not matter.

-- One row today. vaultId exists so further team vaults can be added later
-- without rebuilding the grant model.
CREATE TABLE `credentialVaults` (
  `vaultId`                INT          NOT NULL AUTO_INCREMENT,
  `name`                   VARCHAR(100) NOT NULL,
  `description`            VARCHAR(500) NULL,
  -- HMAC key for password-reuse detection, wrapped by the KEK like a DEK.
  `wrappedFingerprintKey`  VARBINARY(128) NULL,
  `fingerprintKekId`       VARCHAR(32)  NULL,
  `createdAt`              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`vaultId`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `credentialVaults` (`vaultId`, `name`, `description`)
VALUES (1, 'Organisation vault', 'Shared credentials owned by the organisation.');

CREATE TABLE `credentialCollections` (
  `collectionId`   INT          NOT NULL AUTO_INCREMENT,
  `vaultId`        INT          NOT NULL DEFAULT 1,
  `name`           VARCHAR(100) NOT NULL,
  `description`    VARCHAR(500) NULL,
  `icon`           VARCHAR(64)  NULL,
  `colour`         VARCHAR(7)   NULL,
  -- Requestable collections show their name and description in the access
  -- request picker to every vault user. Off by default.
  `isRequestable`  TINYINT(1)   NOT NULL DEFAULT 0,
  `createdBy`      INT          NULL,
  `updatedBy`      INT          NULL,
  `createdAt`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt`      DATETIME(3)  NULL,
  PRIMARY KEY (`collectionId`),
  INDEX `credentialCollections_vault_idx` (`vaultId`, `deletedAt`),
  CONSTRAINT `credentialCollections_vault_fk` FOREIGN KEY (`vaultId`) REFERENCES `credentialVaults` (`vaultId`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `credentialCollections` (`vaultId`, `name`, `description`, `icon`, `colour`) VALUES
  (1, 'Social Media', 'Facebook, Instagram, YouTube, TikTok', 'fa-solid fa-share-nodes', '#6f42c1'),
  (1, 'Development', 'GitHub, development environments, deployment services', 'fa-solid fa-code', '#0d6efd'),
  (1, 'Minecraft Infrastructure', 'Minecraft hosting, management panels, proxies', 'fa-solid fa-cubes', '#198754'),
  (1, 'Infrastructure', 'Cloudflare, DNS, domain registrars, hosting', 'fa-solid fa-server', '#fd7e14'),
  (1, 'Community Management', 'Discord applications, moderation services', 'fa-solid fa-users', '#20c997'),
  (1, 'Administration', 'Organisation accounts, subscriptions, recovery', 'fa-solid fa-building', '#dc3545'),
  (1, 'Other Services', 'Miscellaneous shared credentials', 'fa-solid fa-box-archive', '#6c757d');

CREATE TABLE `credentials` (
  `credentialId`      INT           NOT NULL AUTO_INCREMENT,
  `vaultId`           INT           NOT NULL DEFAULT 1,
  `collectionId`      INT           NOT NULL,
  `type`              VARCHAR(20)   NOT NULL,
  `name`              VARCHAR(150)  NOT NULL,
  `url`               VARCHAR(500)  NULL,
  `username`          VARCHAR(255)  NULL,
  `email`             VARCHAR(254)  NULL,
  `description`       TEXT          NULL,
  -- Non-secret, type-specific metadata (client id, environment, host, ...)
  -- and non-secret custom fields. JSON text. Never contains secret values.
  `details`           TEXT          NULL,
  `tags`              VARCHAR(500)  NULL,
  `ownerUserId`       INT           NULL,
  `isRequestable`     TINYINT(1)    NOT NULL DEFAULT 0,
  `expiresAt`         DATETIME(3)   NULL,
  `rotateEveryDays`   INT           NULL,
  `nextRotationAt`    DATETIME(3)   NULL,
  `lastRotatedAt`     DATETIME(3)   NULL,
  `lastReviewedAt`    DATETIME(3)   NULL,
  `lastReviewedBy`    INT           NULL,
  `currentVersion`    INT           NOT NULL DEFAULT 0,
  `createdBy`         INT           NULL,
  `updatedBy`         INT           NULL,
  `createdAt`         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt`         DATETIME(3)   NULL,
  `deletedBy`         INT           NULL,
  PRIMARY KEY (`credentialId`),
  INDEX `credentials_collection_idx` (`collectionId`, `deletedAt`),
  INDEX `credentials_updated_idx` (`deletedAt`, `updatedAt`),
  INDEX `credentials_owner_idx` (`ownerUserId`),
  INDEX `credentials_rotation_idx` (`deletedAt`, `nextRotationAt`),
  INDEX `credentials_expiry_idx` (`deletedAt`, `expiresAt`),
  CONSTRAINT `credentials_vault_fk` FOREIGN KEY (`vaultId`) REFERENCES `credentialVaults` (`vaultId`),
  CONSTRAINT `credentials_collection_fk` FOREIGN KEY (`collectionId`) REFERENCES `credentialCollections` (`collectionId`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Per-credential data keys, wrapped by a key-encryption key (kekId names which).
-- One active row per credential; superseded rows keep retiredAt for history.
CREATE TABLE `credentialKeys` (
  `keyId`          INT            NOT NULL AUTO_INCREMENT,
  `credentialId`   INT            NOT NULL,
  `kekId`          VARCHAR(32)    NOT NULL,
  `wrappedKey`     VARBINARY(128) NOT NULL,
  `createdAt`      DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `retiredAt`      DATETIME(3)    NULL,
  PRIMARY KEY (`keyId`),
  INDEX `credentialKeys_credential_idx` (`credentialId`, `retiredAt`),
  INDEX `credentialKeys_kek_idx` (`kekId`),
  CONSTRAINT `credentialKeys_credential_fk` FOREIGN KEY (`credentialId`) REFERENCES `credentials` (`credentialId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Encrypted secret payloads. One row per saved version. fieldNames lists which
-- secret fields the version holds (names only, never values) so the UI can
-- offer Reveal/Copy without decrypting anything.
CREATE TABLE `credentialSecretVersions` (
  `versionId`            INT          NOT NULL AUTO_INCREMENT,
  `credentialId`         INT          NOT NULL,
  `version`              INT          NOT NULL,
  `keyId`                INT          NOT NULL,
  `ciphertext`           MEDIUMBLOB   NOT NULL,
  `fieldNames`           TEXT         NOT NULL,
  `changedFields`        TEXT         NULL,
  -- 0-4 estimate of the "password" field computed at save time; NULL if none.
  `passwordStrength`     TINYINT      NULL,
  -- Keyed HMAC of the "password" field for reuse detection. Equality only.
  `passwordFingerprint`  CHAR(64)     NULL,
  `createdBy`            INT          NULL,
  `createdAt`            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `restoredFromVersion`  INT          NULL,
  PRIMARY KEY (`versionId`),
  UNIQUE INDEX `credentialSecretVersions_cred_version_key` (`credentialId`, `version`),
  INDEX `credentialSecretVersions_fingerprint_idx` (`passwordFingerprint`),
  CONSTRAINT `credentialSecretVersions_credential_fk` FOREIGN KEY (`credentialId`) REFERENCES `credentials` (`credentialId`) ON DELETE CASCADE,
  CONSTRAINT `credentialSecretVersions_key_fk` FOREIGN KEY (`keyId`) REFERENCES `credentialKeys` (`keyId`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Vault permission groups (Social Media Team, Development Team, ...). Not
-- LuckPerms groups: membership is explicit and vault-only.
CREATE TABLE `credentialGroups` (
  `groupId`      INT          NOT NULL AUTO_INCREMENT,
  `vaultId`      INT          NOT NULL DEFAULT 1,
  `name`         VARCHAR(100) NOT NULL,
  `description`  VARCHAR(500) NULL,
  `createdBy`    INT          NULL,
  `createdAt`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `deletedAt`    DATETIME(3)  NULL,
  PRIMARY KEY (`groupId`),
  INDEX `credentialGroups_vault_idx` (`vaultId`, `deletedAt`),
  CONSTRAINT `credentialGroups_vault_fk` FOREIGN KEY (`vaultId`) REFERENCES `credentialVaults` (`vaultId`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `credentialGroups` (`vaultId`, `name`, `description`) VALUES
  (1, 'Social Media Team', 'Manages the organisation''s social media accounts.'),
  (1, 'Development Team', 'Development and deployment services.'),
  (1, 'Infrastructure Team', 'Hosting, DNS and server infrastructure.'),
  (1, 'Senior Staff', 'Senior staff with broader access.'),
  (1, 'Credential Administrators', 'Administers the vault.');

CREATE TABLE `credentialGroupMembers` (
  `groupId`    INT          NOT NULL,
  `userId`     INT          NOT NULL,
  `addedBy`    INT          NULL,
  `addedAt`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt`  DATETIME(3)  NULL,
  PRIMARY KEY (`groupId`, `userId`),
  INDEX `credentialGroupMembers_user_idx` (`userId`),
  CONSTRAINT `credentialGroupMembers_group_fk` FOREIGN KEY (`groupId`) REFERENCES `credentialGroups` (`groupId`) ON DELETE CASCADE,
  CONSTRAINT `credentialGroupMembers_user_fk` FOREIGN KEY (`userId`) REFERENCES `users` (`userId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Explicit vault permissions. Deny by default: no row, no access.
--   scope      vault | collection | credential
--   principal  user (userId) | group (groupId)
--   effect     allow | deny   (deny wins)
--   capabilities  comma-separated list, validated by the application
CREATE TABLE `credentialGrants` (
  `grantId`        INT          NOT NULL AUTO_INCREMENT,
  `vaultId`        INT          NOT NULL DEFAULT 1,
  `scope`          VARCHAR(12)  NOT NULL,
  `collectionId`   INT          NULL,
  `credentialId`   INT          NULL,
  `principalType`  VARCHAR(8)   NOT NULL,
  `userId`         INT          NULL,
  `groupId`        INT          NULL,
  `effect`         VARCHAR(8)   NOT NULL DEFAULT 'allow',
  `capabilities`   VARCHAR(400) NOT NULL,
  `expiresAt`      DATETIME(3)  NULL,
  `reason`         VARCHAR(500) NULL,
  `requestId`      INT          NULL,
  `grantedBy`      INT          NULL,
  `createdAt`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `revokedAt`      DATETIME(3)  NULL,
  `revokedBy`      INT          NULL,
  `revokeReason`   VARCHAR(100) NULL,
  PRIMARY KEY (`grantId`),
  INDEX `credentialGrants_user_idx` (`userId`, `revokedAt`),
  INDEX `credentialGrants_group_idx` (`groupId`, `revokedAt`),
  INDEX `credentialGrants_collection_idx` (`collectionId`, `revokedAt`),
  INDEX `credentialGrants_credential_idx` (`credentialId`, `revokedAt`),
  CONSTRAINT `credentialGrants_vault_fk` FOREIGN KEY (`vaultId`) REFERENCES `credentialVaults` (`vaultId`),
  CONSTRAINT `credentialGrants_collection_fk` FOREIGN KEY (`collectionId`) REFERENCES `credentialCollections` (`collectionId`) ON DELETE CASCADE,
  CONSTRAINT `credentialGrants_credential_fk` FOREIGN KEY (`credentialId`) REFERENCES `credentials` (`credentialId`) ON DELETE CASCADE,
  CONSTRAINT `credentialGrants_group_fk` FOREIGN KEY (`groupId`) REFERENCES `credentialGroups` (`groupId`) ON DELETE CASCADE,
  CONSTRAINT `credentialGrants_user_fk` FOREIGN KEY (`userId`) REFERENCES `users` (`userId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `credentialAccessRequests` (
  `requestId`       INT          NOT NULL AUTO_INCREMENT,
  `vaultId`         INT          NOT NULL DEFAULT 1,
  `requesterId`     INT          NOT NULL,
  `scope`           VARCHAR(12)  NOT NULL,
  `collectionId`    INT          NULL,
  `credentialId`    INT          NULL,
  `capabilities`    VARCHAR(400) NOT NULL,
  `reason`          VARCHAR(1000) NOT NULL,
  `durationHours`   INT          NULL,
  -- pending | approved | rejected | cancelled | expired
  `status`          VARCHAR(12)  NOT NULL DEFAULT 'pending',
  `decidedBy`       INT          NULL,
  `decidedAt`       DATETIME(3)  NULL,
  `decisionNote`    VARCHAR(1000) NULL,
  `grantId`         INT          NULL,
  `createdAt`       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`requestId`),
  INDEX `credentialAccessRequests_status_idx` (`status`, `createdAt`),
  INDEX `credentialAccessRequests_requester_idx` (`requesterId`, `createdAt`),
  CONSTRAINT `credentialAccessRequests_requester_fk` FOREIGN KEY (`requesterId`) REFERENCES `users` (`userId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Short-lived, single-use, action-bound reauthentication challenges.
-- Only the SHA-256 of the token is stored.
CREATE TABLE `credentialChallenges` (
  `challengeId`   INT          NOT NULL AUTO_INCREMENT,
  `tokenHash`     CHAR(64)     NOT NULL,
  `userId`        INT          NOT NULL,
  `sessionHash`   CHAR(64)     NOT NULL,
  `credentialId`  INT          NOT NULL,
  `action`        VARCHAR(20)  NOT NULL,
  `field`         VARCHAR(64)  NOT NULL,
  `versionId`     INT          NULL,
  `method`        VARCHAR(20)  NOT NULL,
  -- pending | consumed | revoked
  `status`        VARCHAR(10)  NOT NULL DEFAULT 'pending',
  -- succeeded | failed (set once consumed)
  `outcome`       VARCHAR(10)  NULL,
  `ip`            VARCHAR(45)  NULL,
  `createdAt`     DATETIME(3)  NOT NULL,
  `expiresAt`     DATETIME(3)  NOT NULL,
  `consumedAt`    DATETIME(3)  NULL,
  PRIMARY KEY (`challengeId`),
  UNIQUE INDEX `credentialChallenges_token_key` (`tokenHash`),
  INDEX `credentialChallenges_user_idx` (`userId`, `status`),
  INDEX `credentialChallenges_credential_idx` (`credentialId`, `status`),
  INDEX `credentialChallenges_expiry_idx` (`expiresAt`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Dedicated vault-access passwords (Argon2id verifiers) and per-user lockout
-- state. Lockout fields are used for every factor, including account passwords.
-- Staff without a Zander password enrol with a one-time code issued by a vault
-- administrator; only its SHA-256 is stored.
CREATE TABLE `credentialVaultPasswords` (
  `userId`                  INT           NOT NULL,
  `verifier`                VARCHAR(255)  NULL,
  `enrolledAt`              DATETIME(3)   NULL,
  `changedAt`               DATETIME(3)   NULL,
  `enrolmentCodeHash`       CHAR(64)      NULL,
  `enrolmentCodeExpiresAt`  DATETIME(3)   NULL,
  `enrolmentCodeIssuedBy`   INT           NULL,
  `failedAttempts`  INT           NOT NULL DEFAULT 0,
  `lastFailedAt`    DATETIME(3)   NULL,
  `lockedUntil`     DATETIME(3)   NULL,
  PRIMARY KEY (`userId`),
  CONSTRAINT `credentialVaultPasswords_user_fk` FOREIGN KEY (`userId`) REFERENCES `users` (`userId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `credentialFavourites` (
  `userId`        INT          NOT NULL,
  `credentialId`  INT          NOT NULL,
  `createdAt`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`userId`, `credentialId`),
  CONSTRAINT `credentialFavourites_user_fk` FOREIGN KEY (`userId`) REFERENCES `users` (`userId`) ON DELETE CASCADE,
  CONSTRAINT `credentialFavourites_credential_fk` FOREIGN KEY (`credentialId`) REFERENCES `credentials` (`credentialId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `credentialRotationTasks` (
  `taskId`          INT          NOT NULL AUTO_INCREMENT,
  `credentialId`    INT          NOT NULL,
  -- offboarding | schedule | expiry | manual | revocation
  `reason`          VARCHAR(20)  NOT NULL,
  `details`         VARCHAR(500) NULL,
  `relatedUserId`   INT          NULL,
  -- open | done | dismissed
  `status`          VARCHAR(10)  NOT NULL DEFAULT 'open',
  `createdBy`       INT          NULL,
  `createdAt`       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completedBy`     INT          NULL,
  `completedAt`     DATETIME(3)  NULL,
  PRIMARY KEY (`taskId`),
  INDEX `credentialRotationTasks_status_idx` (`status`, `createdAt`),
  INDEX `credentialRotationTasks_credential_idx` (`credentialId`, `status`),
  CONSTRAINT `credentialRotationTasks_credential_fk` FOREIGN KEY (`credentialId`) REFERENCES `credentials` (`credentialId`) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Append-only, hash-chained audit trail. Never holds secret values,
-- passwords, tokens or keys (enforced by the application's sanitiser).
CREATE TABLE `credentialAuditEvents` (
  `eventId`        BIGINT        NOT NULL AUTO_INCREMENT,
  `occurredAt`     DATETIME(3)   NOT NULL,
  `eventType`      VARCHAR(40)   NOT NULL,
  `outcome`        VARCHAR(10)   NOT NULL,
  `actorUserId`    INT           NULL,
  `subjectUserId`  INT           NULL,
  `credentialId`   INT           NULL,
  `collectionId`   INT           NULL,
  `sessionHash`    CHAR(16)      NULL,
  `ip`             VARCHAR(45)   NULL,
  `userAgent`      VARCHAR(255)  NULL,
  `metadata`       TEXT          NULL,
  `prevHash`       CHAR(64)      NOT NULL,
  `hash`           CHAR(64)      NOT NULL,
  PRIMARY KEY (`eventId`),
  INDEX `credentialAuditEvents_time_idx` (`occurredAt`),
  INDEX `credentialAuditEvents_actor_idx` (`actorUserId`, `occurredAt`),
  INDEX `credentialAuditEvents_credential_idx` (`credentialId`, `occurredAt`),
  INDEX `credentialAuditEvents_collection_idx` (`collectionId`, `occurredAt`),
  INDEX `credentialAuditEvents_type_idx` (`eventType`, `occurredAt`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Single row serialising appends to the audit chain (SELECT ... FOR UPDATE).
-- lastEventId/lastHash detect deletion of the newest events; anchorEventId /
-- anchorHash record where retention last trimmed the chain, so deletion of the
-- oldest events outside a purge is detected too.
CREATE TABLE `credentialAuditHead` (
  `id`             TINYINT     NOT NULL,
  `lastEventId`    BIGINT      NULL,
  `lastHash`       CHAR(64)    NOT NULL,
  `anchorEventId`  BIGINT      NOT NULL DEFAULT 0,
  `anchorHash`     CHAR(64)    NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `credentialAuditHead` (`id`, `lastEventId`, `lastHash`, `anchorEventId`, `anchorHash`)
VALUES (1, NULL, '0000000000000000000000000000000000000000000000000000000000000000', 0,
        '0000000000000000000000000000000000000000000000000000000000000000');

CREATE TABLE `credentialVaultSettings` (
  `settingKey`    VARCHAR(64)  NOT NULL,
  `settingValue`  VARCHAR(500) NOT NULL,
  `updatedBy`     INT          NULL,
  `updatedAt`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`settingKey`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
