-- Compass SSO: Zander acts as an OpenID Connect provider for the Compass staff
-- portal (a separate app). Two tables:
--
--   oauthClients  — the OAuth/OIDC client registry. Each first-party app (today
--                   just Compass) has one row; redirect URIs and the client
--                   secret are seeded from env on boot (controllers/oidcController.js).
--                   `firstParty = 1` skips the consent screen.
--
--   oidcPayloads  — persistent storage for the oidc-provider library: grants,
--                   sessions, access/refresh tokens, authorization codes,
--                   interaction state, and the replay-protection registry. One
--                   generic key/value table keyed by (type, id), matching the
--                   oidc-provider "Adapter" contract (lib/oidc/prismaAdapter.mjs).
--
-- No LuckPerms or group data is stored here. Effective groups are read live from
-- LuckPerms at token time (lib/permissions/effectiveGroups.mjs) and never cached.

CREATE TABLE `oauthClients` (
  `clientId`                Int          NOT NULL AUTO_INCREMENT,
  `clientKey`               VARCHAR(64)  NOT NULL,              -- the OIDC client_id, e.g. "compass"
  `name`                    VARCHAR(100) NOT NULL,
  `clientSecret`            VARCHAR(255) NULL,                  -- confidential-client shared secret (null for public PKCE clients)
  `tokenEndpointAuthMethod` VARCHAR(40)  NOT NULL DEFAULT 'client_secret_basic',
  `redirectUris`            TEXT         NOT NULL,              -- JSON array of absolute URIs
  `postLogoutRedirectUris`  TEXT         NULL,                  -- JSON array
  `grantTypes`              TEXT         NOT NULL,              -- JSON array, e.g. ["authorization_code","refresh_token"]
  `responseTypes`           TEXT         NOT NULL,              -- JSON array, e.g. ["code"]
  `scopes`                  TEXT         NOT NULL,              -- space-delimited, e.g. "openid profile groups offline_access"
  `firstParty`              TINYINT(1)   NOT NULL DEFAULT 0,    -- 1 = skip the consent screen
  `isActive`                TINYINT(1)   NOT NULL DEFAULT 1,
  `createdAt`               DATETIME     NOT NULL DEFAULT NOW(),
  `updatedAt`               DATETIME     NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  PRIMARY KEY (`clientId`),
  UNIQUE INDEX `oauthClients_clientKey_key` (`clientKey`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `oidcPayloads` (
  `type`       INT          NOT NULL,                           -- oidc-provider model index (see prismaAdapter.mjs TYPES)
  `id`         VARCHAR(255) NOT NULL,
  `payload`    TEXT         NULL,                               -- JSON blob the library owns
  `grantId`    VARCHAR(255) NULL,
  `userCode`   VARCHAR(255) NULL,
  `uid`        VARCHAR(255) NULL,
  `expiresAt`  DATETIME     NULL,
  `consumedAt` DATETIME     NULL,
  `createdAt`  DATETIME     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (`type`, `id`),
  INDEX `oidcPayloads_grantId_idx` (`grantId`),
  INDEX `oidcPayloads_userCode_idx` (`userCode`),
  INDEX `oidcPayloads_uid_idx` (`uid`),
  INDEX `oidcPayloads_expiresAt_idx` (`expiresAt`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
