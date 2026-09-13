-- Configurable Reward Templates
-- Migration: v1.17.0 -> v1.18.0
--
-- 1. Adds vote_reward_templates so admins can manage reward commands
--    through the dashboard instead of editing source files.
--
-- 2. Ensures the sessions table exists with the schema expected by
--    express-mysql-session so that the app can start with
--    createDatabaseTable: false (avoiding ECONNRESET on first boot).
--
-- reward_type values:
--   'vote'         – fires for every accepted vote
--   'monthly_top'  – fires for monthly top-voter winner(s)

-- Sessions table (managed by express-mysql-session)
-- Must exist before the web server boots so it can start with
-- createDatabaseTable: false and skip the fragile init query.
CREATE TABLE IF NOT EXISTS `sessions` (
  `session_id` VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  `expires`    INT(11) UNSIGNED NOT NULL,
  `data`       MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS vote_reward_templates (
  id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  reward_type      ENUM('vote','monthly_top') NOT NULL,
  command_template VARCHAR(512)  NOT NULL  COMMENT 'Command with {player}, {uuid}, {month}, {voteCount} placeholders',
  execute_as       ENUM('console','player') NOT NULL DEFAULT 'console',
  server_scope     VARCHAR(64)   NOT NULL DEFAULT 'any' COMMENT 'Server name or "any"',
  is_active        TINYINT(1)    NOT NULL DEFAULT 1,
  display_order    INT           NOT NULL DEFAULT 0,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_type_active (reward_type, is_active, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed with the default templates that were previously hardcoded.
-- INSERT IGNORE keeps this idempotent if the migration is re-run.
INSERT IGNORE INTO vote_reward_templates (id, reward_type, command_template, execute_as, server_scope, display_order) VALUES
  (1, 'vote',         'crate key give {player} vote 1',                                                             'console', 'any', 0),
  (2, 'vote',         'eco give {player} 250',                                                                      'console', 'any', 1),
  (3, 'monthly_top',  'lp user {player} parent addtemp topvoter 30d',                                               'console', 'any', 0),
  (4, 'monthly_top',  'broadcast &6[Vote] &e{player} &awon top voter for &6{month}&a! Congratulations!',            'console', 'any', 1),
  (5, 'monthly_top',  'crate key give {player} vote 10',                                                             'console', 'any', 2);
