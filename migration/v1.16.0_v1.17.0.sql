-- Voting & Reward System
-- Migration: v1.16.0 -> v1.17.0
--
-- Creates all tables required by the Voting & Reward feature:
--   vote_sites              - Admin-managed list of voting websites
--   votes                   - Full history of accepted vote deliveries
--   vote_monthly_totals     - Aggregated per-player per-month vote counts
--   vote_monthly_results    - Historical record of monthly winner(s)
--   player_command_queue    - Persistent reward command queue consumed by zander-addon

-- ============================================================
-- vote_sites
-- ============================================================
CREATE TABLE IF NOT EXISTS vote_sites (
  id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  site_name      VARCHAR(128)  NOT NULL,
  service_name   VARCHAR(64)   NOT NULL COMMENT 'Normalised lowercase identifier used to match incoming votes',
  vote_url       VARCHAR(512)  NOT NULL,
  is_active      TINYINT(1)    NOT NULL DEFAULT 1,
  display_order  INT           NOT NULL DEFAULT 0,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_name (service_name),
  KEY idx_active_order (is_active, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- votes
-- ============================================================
CREATE TABLE IF NOT EXISTS votes (
  id              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  vote_site_id    INT UNSIGNED  NOT NULL,
  player_uuid     VARCHAR(36)   NOT NULL,
  player_name     VARCHAR(16)   NOT NULL,
  service_name    VARCHAR(64)   NOT NULL,
  received_from   VARCHAR(64)   DEFAULT NULL COMMENT 'Originating system, e.g. velocity',
  received_at     DATETIME      NOT NULL                COMMENT 'Timestamp reported by the vote receiver (UTC)',
  month_key       CHAR(7)       NOT NULL                COMMENT 'YYYY-MM derived from received_at; used for grouping',
  dedupe_key      VARCHAR(128)  NOT NULL                COMMENT 'SHA-256 of uuid+service+date so duplicate deliveries are rejected',
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dedupe (dedupe_key),
  KEY idx_uuid_month (player_uuid, month_key),
  KEY idx_month_site (month_key, vote_site_id),
  CONSTRAINT fk_votes_site FOREIGN KEY (vote_site_id) REFERENCES vote_sites (id) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- vote_monthly_totals
-- ============================================================
CREATE TABLE IF NOT EXISTS vote_monthly_totals (
  id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  player_uuid  VARCHAR(36)   NOT NULL,
  player_name  VARCHAR(16)   NOT NULL  COMMENT 'Name at time of last vote; best-effort display value',
  month_key    CHAR(7)       NOT NULL  COMMENT 'YYYY-MM',
  vote_count   INT UNSIGNED  NOT NULL DEFAULT 0,
  last_vote_at DATETIME      DEFAULT NULL COMMENT 'Timestamp of most recent accepted vote; used as tie-breaker',
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_uuid_month (player_uuid, month_key),
  KEY idx_month_count (month_key, vote_count DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- vote_monthly_results
-- ============================================================
CREATE TABLE IF NOT EXISTS vote_monthly_results (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  month_key     CHAR(7)       NOT NULL COMMENT 'YYYY-MM of the rewarded month',
  player_uuid   VARCHAR(36)   NOT NULL,
  player_name   VARCHAR(16)   NOT NULL,
  vote_count    INT UNSIGNED  NOT NULL,
  tie_position  TINYINT       NOT NULL DEFAULT 1 COMMENT '1 = sole winner or first in a tie group',
  rewarded_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_month_player (month_key, player_uuid),
  KEY idx_month_key (month_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- player_command_queue
-- ============================================================
CREATE TABLE IF NOT EXISTS player_command_queue (
  id              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  player_uuid     VARCHAR(36)   NOT NULL,
  player_name     VARCHAR(16)   NOT NULL,
  source          VARCHAR(64)   NOT NULL  COMMENT 'e.g. vote_reward, monthly_reward',
  command_text    VARCHAR(512)  NOT NULL  COMMENT 'Raw command template with {player} already resolved',
  execute_as      ENUM('console','player') NOT NULL DEFAULT 'console',
  status          ENUM('pending','claimed','completed','failed') NOT NULL DEFAULT 'pending',
  server_scope    VARCHAR(64)   NOT NULL DEFAULT 'any' COMMENT 'Server name or "any"',
  dedupe_key      VARCHAR(128)  NOT NULL  COMMENT 'Prevents duplicate queue entries for the same logical reward',
  available_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Earliest time the command may be claimed',
  claimed_at      DATETIME      DEFAULT NULL,
  completed_at    DATETIME      DEFAULT NULL,
  failure_reason  VARCHAR(512)  DEFAULT NULL,
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dedupe (dedupe_key),
  KEY idx_claim_lookup (player_uuid, status, server_scope, available_at),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
