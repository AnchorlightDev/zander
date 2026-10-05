-- Per-client API credentials, replacing the single app-wide `apiKey` shared by
-- every Minecraft plugin, monitor and internal caller.  Each client carries its
-- own scope list so a compromised or retired caller is revoked on its own.
--
-- Only `keyHash` (SHA-256 of the full key) is stored; `keyPrefix` is the
-- non-secret lookup handle carried in the key itself.
CREATE TABLE `apiClients` (
  `clientId`        INT           NOT NULL AUTO_INCREMENT,
  `name`            VARCHAR(100)  NOT NULL,
  `description`     VARCHAR(255)  NULL,
  `keyPrefix`       VARCHAR(20)   NOT NULL,
  `keyHash`         CHAR(64)      NOT NULL,
  `scopes`          TEXT          NOT NULL,
  `isRevoked`       TINYINT       NOT NULL DEFAULT 0,
  `lastUsedAt`      DATETIME      NULL,
  `lastUsedIp`      VARCHAR(45)   NULL,
  `createdAt`       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `createdByUserId` INT           NULL,
  `revokedAt`       DATETIME      NULL,
  PRIMARY KEY (`clientId`),
  UNIQUE INDEX `apiClients_keyPrefix_key` (`keyPrefix`),
  INDEX `apiClients_isRevoked_idx` (`isRevoked`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
