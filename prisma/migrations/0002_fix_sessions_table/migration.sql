-- Fix sessions table: add missing `id` column required by @quixo3/prisma-session-store.
-- The library uses `id` as the primary key and `sid` as a unique index.
-- Sessions are ephemeral login data, so dropping and recreating is safe.

DROP TABLE IF EXISTS sessions;

CREATE TABLE sessions (
  id        VARCHAR(128) NOT NULL,
  sid       VARCHAR(128) NOT NULL,
  data      MEDIUMTEXT   NOT NULL,
  expiresAt DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_sid (sid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
