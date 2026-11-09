-- ============================================================
-- Crafting For Christ Wrapped
--
-- A Spotify-Wrapped-style yearly recap. Zander owns all presentation
-- and logic; the Discord/voice/reputation numbers are pulled from
-- MineMonitor's read-only /api/wrapped/stats endpoint and merged with
-- Zander's own gameSessions data.
--
-- wrappedRuns       — one persisted, computed payload per user per period.
--                     The payload is stored (not recomputed live) so that:
--                       * the public share link keeps showing that exact run
--                       * next year's year-over-year slide can look back at it
--                     `viewedAt` gates the once-per-period login prompt.
-- wrappedLeaderboardCache
--                   — per-period ranking context (every linked user's stat
--                     values), computed once and reused so per-user Wrapped
--                     builds don't each re-scan the whole playerbase.
-- ============================================================

CREATE TABLE IF NOT EXISTS wrappedRuns (
    runId       INT          NOT NULL AUTO_INCREMENT,
    userId      INT          NOT NULL,
    periodYear  SMALLINT     NOT NULL,
    periodStart DATETIME     NOT NULL,
    periodEnd   DATETIME     NOT NULL,
    shareId     VARCHAR(22)  NOT NULL,
    payload     JSON         NOT NULL,
    createdAt   DATETIME     NOT NULL DEFAULT NOW(),
    updatedAt   DATETIME     NOT NULL DEFAULT NOW() ON UPDATE NOW(),
    viewedAt    DATETIME     NULL,
    PRIMARY KEY (runId),
    UNIQUE KEY wrappedRuns_user_period (userId, periodYear),
    UNIQUE KEY wrappedRuns_shareId (shareId),
    INDEX wrappedRuns_period (periodYear),
    CONSTRAINT fk_wrappedRuns_user FOREIGN KEY (userId) REFERENCES users(userId) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wrappedLeaderboardCache (
    periodYear  SMALLINT     NOT NULL,
    computedAt  DATETIME     NOT NULL DEFAULT NOW(),
    data        JSON         NOT NULL,
    PRIMARY KEY (periodYear)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
