-- Consolidated baseline migration
-- Replaces all individual migration files v1.1.0 through v1.19.0
-- This is the single source of truth for the database schema.
--
-- Cross-database VIEWS (luckPermsPlayers, ranks, userRanks, userPermissions,
-- rankRanks, rankPermissions, punishments, shoppingDirectory) reference external
-- databases (cfcdev_luckperms, cfcdev_litebans, cfc_prod_quickshop) and are
-- defined in dbinit.sql only — Prisma cannot model cross-database views.

-- ============================================================
-- users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  userId                     INT          NOT NULL AUTO_INCREMENT,
  uuid                       VARCHAR(36)  NOT NULL,
  username                   VARCHAR(16)  NOT NULL,
  discordId                  VARCHAR(32),
  email                      VARCHAR(254) UNIQUE,
  password_hash              VARCHAR(255),
  email_verified             BOOLEAN      DEFAULT 0,
  email_verified_at          DATETIME,
  joined                     DATETIME     NOT NULL DEFAULT NOW(),
  profilePicture_type        ENUM('CRAFTATAR','GRAVATAR') DEFAULT 'CRAFTATAR',
  profilePicture_email       VARCHAR(70),
  account_registered         DATETIME,
  account_disabled           BOOLEAN      DEFAULT 0,
  social_aboutMe             MEDIUMTEXT,
  social_interests           VARCHAR(50),
  social_discord             VARCHAR(32),
  social_steam               VARCHAR(100),
  social_twitch              VARCHAR(25),
  social_youtube             VARCHAR(100),
  social_twitter_x           VARCHAR(15),
  social_instagram           VARCHAR(30),
  social_reddit              VARCHAR(38),
  social_spotify             VARCHAR(100),
  audit_lastDiscordMessage   DATETIME,
  audit_lastDiscordVoice     DATETIME,
  audit_lastMinecraftLogin   DATETIME,
  audit_lastMinecraftMessage DATETIME,
  audit_lastMinecraftPunishment DATETIME,
  audit_lastDiscordPunishment   DATETIME,
  audit_lastWebsiteLogin     DATETIME,
  PRIMARY KEY (userId),
  UNIQUE KEY uq_users_uuid (uuid),
  INDEX users_uuid_idx (uuid(8))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the CONSOLE system user
INSERT IGNORE INTO users (uuid, username, account_disabled)
VALUES ('f78a4d8d-d51b-4b39-98a3-230f2de0c670', 'CONSOLE', 0);

-- ============================================================
-- userEmailVerifications
-- ============================================================
CREATE TABLE IF NOT EXISTS userEmailVerifications (
  verificationId INT          NOT NULL AUTO_INCREMENT,
  userId         INT          NOT NULL,
  codeHash       VARCHAR(255) NOT NULL,
  expiresAt      DATETIME     NOT NULL,
  consumed       BOOLEAN      DEFAULT 0,
  createdAt      DATETIME     DEFAULT NOW(),
  consumedAt     DATETIME,
  PRIMARY KEY (verificationId),
  INDEX userEmailVerifications_userId (userId),
  CONSTRAINT fk_userEmailVerifications_users
    FOREIGN KEY (userId) REFERENCES users(userId) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- userPasswordResets
-- ============================================================
CREATE TABLE IF NOT EXISTS userPasswordResets (
  resetId   INT          NOT NULL AUTO_INCREMENT,
  userId    INT          NOT NULL,
  codeHash  VARCHAR(255) NOT NULL,
  expiresAt DATETIME     NOT NULL,
  consumed  BOOLEAN      DEFAULT 0,
  createdAt DATETIME     DEFAULT NOW(),
  consumedAt DATETIME,
  PRIMARY KEY (resetId),
  INDEX userPasswordResets_userId (userId),
  CONSTRAINT fk_userPasswordResets_users
    FOREIGN KEY (userId) REFERENCES users(userId) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- userVerifyLink
-- ============================================================
CREATE TABLE IF NOT EXISTS userVerifyLink (
  verifyId   INT         NOT NULL AUTO_INCREMENT,
  uuid       VARCHAR(36) NOT NULL,
  username   TEXT        NOT NULL,
  linkCode   VARCHAR(6),
  codeExpiry DATETIME    NOT NULL,
  PRIMARY KEY (verifyId),
  UNIQUE KEY uq_userVerifyLink_uuid (uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- servers
-- ============================================================
CREATE TABLE IF NOT EXISTS servers (
  serverId              INT AUTO_INCREMENT,
  displayName           TEXT,
  serverConnectionAddress TEXT,
  serverType            ENUM('INTERNAL','EXTERNAL','VERIFICATION'),
  position              INT,
  PRIMARY KEY (serverId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- serverStatus
-- ============================================================
CREATE TABLE IF NOT EXISTS serverStatus (
  serverStatusId INT  NOT NULL AUTO_INCREMENT,
  statusInfo     JSON,
  lastUpdated    DATETIME,
  PRIMARY KEY (serverStatusId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO serverStatus (serverStatusId, statusInfo) VALUES (1, null);

-- ============================================================
-- gameSessions
-- ============================================================
CREATE TABLE IF NOT EXISTS gameSessions (
  sessionId    INT         NOT NULL AUTO_INCREMENT,
  userId       INT         NOT NULL,
  sessionStart DATETIME    NOT NULL DEFAULT NOW(),
  sessionEnd   DATETIME,
  ipAddress    VARCHAR(45),
  server       TEXT,
  PRIMARY KEY (sessionId),
  INDEX gameSessions_sessionStart (sessionStart),
  INDEX gameSessions_sessionEnd   (sessionEnd)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- announcements
-- ============================================================
CREATE TABLE IF NOT EXISTS announcements (
  announcementId     INT AUTO_INCREMENT,
  enabled            BOOLEAN DEFAULT 1,
  announcementType   ENUM('motd','tip','web','popup'),
  body               TEXT,
  colourMessageFormat TEXT,
  link               TEXT,
  popupButtonText    VARCHAR(60),
  popupImageUrl      TEXT,
  startDate          DATETIME,
  endDate            DATETIME,
  updatedDate        DATETIME,
  PRIMARY KEY (announcementId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TRIGGER IF NOT EXISTS announcements_updatedDateBeforeUpdate
BEFORE UPDATE ON announcements FOR EACH ROW
  SET NEW.updatedDate = NOW();

-- ============================================================
-- scheduledDiscordMessages
-- ============================================================
CREATE TABLE IF NOT EXISTS scheduledDiscordMessages (
  scheduleId       INT          NOT NULL AUTO_INCREMENT,
  channelId        VARCHAR(50)  NOT NULL,
  embedTitle       VARCHAR(255),
  embedDescription TEXT,
  embedColor       VARCHAR(20),
  scheduledFor     DATETIME     NOT NULL,
  createdBy        INT          NOT NULL,
  createdAt        DATETIME     NOT NULL DEFAULT NOW(),
  sentAt           DATETIME,
  status           ENUM('scheduled','sent','failed') DEFAULT 'scheduled',
  lastError        TEXT,
  PRIMARY KEY (scheduleId),
  INDEX scheduledDiscordMessages_scheduledFor (scheduledFor),
  INDEX scheduledDiscordMessages_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- applications
-- ============================================================
CREATE TABLE IF NOT EXISTS applications (
  applicationId       INT  AUTO_INCREMENT,
  displayName         VARCHAR(30),
  description         TEXT,
  displayIcon         VARCHAR(40),
  requirementsMarkdown TEXT,
  redirectUrl         TEXT,
  position            INT,
  applicationStatus   BOOLEAN DEFAULT 0,
  PRIMARY KEY (applicationId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- reports
-- ============================================================
CREATE TABLE IF NOT EXISTS reports (
  reportId              INT AUTO_INCREMENT,
  reporterId            INT          NOT NULL,
  reportedUser          VARCHAR(30)  NOT NULL,
  reportReason          VARCHAR(100) NOT NULL,
  reportReasonEvidence  MEDIUMTEXT,
  reportPlatform        VARCHAR(10)  NOT NULL,
  reportDateTime        DATETIME     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (reportId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- vault
-- ============================================================
CREATE TABLE IF NOT EXISTS vault (
  vaultId     INT AUTO_INCREMENT,
  displayName VARCHAR(30),
  description MEDIUMTEXT,
  redirectUrl TEXT,
  position    INT,
  PRIMARY KEY (vaultId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- bridge
-- ============================================================
CREATE TABLE IF NOT EXISTS bridge (
  bridgeId       INT AUTO_INCREMENT,
  command        TEXT,
  targetServer   VARCHAR(30),
  processed      BOOLEAN  DEFAULT 0,
  bridgeDateTime DATETIME NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bridgeId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- executorTasks
-- ============================================================
CREATE TABLE IF NOT EXISTS executorTasks (
  executorTaskId INT          NOT NULL AUTO_INCREMENT,
  slug           VARCHAR(64)  NOT NULL,
  command        TEXT         NOT NULL,
  status         VARCHAR(16)  NOT NULL DEFAULT 'pending',
  routineSlug    VARCHAR(64)  DEFAULT NULL,
  metadata       TEXT         DEFAULT NULL,
  result         TEXT         DEFAULT NULL,
  priority       INT          DEFAULT 0,
  executedBy     VARCHAR(64)  DEFAULT NULL,
  createdAt      DATETIME     NOT NULL DEFAULT NOW(),
  updatedAt      DATETIME     NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  processedAt    DATETIME     DEFAULT NULL,
  PRIMARY KEY (executorTaskId),
  KEY idx_executorTasks_status_slug (status, slug),
  KEY idx_executorTasks_routineSlug (routineSlug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- executorRoutines
-- ============================================================
CREATE TABLE IF NOT EXISTS executorRoutines (
  executorRoutineId INT         NOT NULL AUTO_INCREMENT,
  routineSlug       VARCHAR(64) NOT NULL,
  displayName       VARCHAR(120) DEFAULT NULL,
  description       TEXT        DEFAULT NULL,
  createdAt         DATETIME    NOT NULL DEFAULT NOW(),
  updatedAt         DATETIME    NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  PRIMARY KEY (executorRoutineId),
  UNIQUE KEY uq_executorRoutines_routineSlug (routineSlug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- executorRoutineSteps
-- ============================================================
CREATE TABLE IF NOT EXISTS executorRoutineSteps (
  executorRoutineStepId INT         NOT NULL AUTO_INCREMENT,
  executorRoutineId     INT         NOT NULL,
  stepOrder             INT         NOT NULL DEFAULT 0,
  slug                  VARCHAR(64) NOT NULL,
  command               TEXT        NOT NULL,
  metadata              TEXT        DEFAULT NULL,
  createdAt             DATETIME    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (executorRoutineStepId),
  KEY idx_executorRoutineSteps_routine (executorRoutineId, stepOrder)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- logs
-- ============================================================
CREATE TABLE IF NOT EXISTS logs (
  logId           INT  NOT NULL AUTO_INCREMENT,
  creatorId       INT  NOT NULL,
  logFeature      VARCHAR(30),
  logType         VARCHAR(30),
  description     TEXT,
  actionedDateTime DATETIME NOT NULL DEFAULT NOW(),
  PRIMARY KEY (logId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- forumCategories
-- ============================================================
CREATE TABLE IF NOT EXISTS forumCategories (
  categoryId       INT         NOT NULL AUTO_INCREMENT,
  parentCategoryId INT,
  name             VARCHAR(120) NOT NULL,
  slug             VARCHAR(150) NOT NULL,
  description      TEXT,
  position         INT          DEFAULT 0,
  viewPermission   VARCHAR(150),
  postPermission   VARCHAR(150),
  createdAt        DATETIME     DEFAULT NOW(),
  updatedAt        DATETIME     DEFAULT NOW() ON UPDATE NOW(),
  PRIMARY KEY (categoryId),
  UNIQUE KEY forumCategories_slug_unique (slug),
  INDEX forumCategories_parent_idx (parentCategoryId),
  CONSTRAINT fk_forumCategories_parent
    FOREIGN KEY (parentCategoryId) REFERENCES forumCategories(categoryId) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- forumDiscussions
-- ============================================================
CREATE TABLE IF NOT EXISTS forumDiscussions (
  discussionId INT         NOT NULL AUTO_INCREMENT,
  categoryId   INT         NOT NULL,
  title        VARCHAR(200) NOT NULL,
  slug         VARCHAR(200) NOT NULL,
  createdBy    INT         NOT NULL,
  createdAt    DATETIME    DEFAULT NOW(),
  updatedAt    DATETIME    DEFAULT NOW() ON UPDATE NOW(),
  lastPostAt   DATETIME    DEFAULT NOW(),
  lastPostBy   INT,
  isLocked     TINYINT(1)  DEFAULT 0,
  isSticky     TINYINT(1)  DEFAULT 0,
  isArchived   TINYINT(1)  DEFAULT 0,
  PRIMARY KEY (discussionId),
  UNIQUE KEY forumDiscussions_slug_unique (categoryId, slug),
  INDEX forumDiscussions_category_idx (categoryId),
  INDEX forumDiscussions_lastPost_idx (lastPostAt),
  CONSTRAINT fk_forumDiscussions_category
    FOREIGN KEY (categoryId) REFERENCES forumCategories(categoryId) ON DELETE CASCADE,
  CONSTRAINT fk_forumDiscussions_creator
    FOREIGN KEY (createdBy) REFERENCES users(userId) ON DELETE CASCADE,
  CONSTRAINT fk_forumDiscussions_lastPostUser
    FOREIGN KEY (lastPostBy) REFERENCES users(userId) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- forumPosts
-- ============================================================
CREATE TABLE IF NOT EXISTS forumPosts (
  postId       INT        NOT NULL AUTO_INCREMENT,
  discussionId INT        NOT NULL,
  userId       INT        NOT NULL,
  content      MEDIUMTEXT NOT NULL,
  isOriginal   TINYINT(1) DEFAULT 0,
  createdAt    DATETIME   DEFAULT NOW(),
  updatedAt    DATETIME   DEFAULT NOW() ON UPDATE NOW(),
  PRIMARY KEY (postId),
  INDEX forumPosts_discussion_idx (discussionId),
  INDEX forumPosts_user_idx (userId),
  CONSTRAINT fk_forumPosts_discussion
    FOREIGN KEY (discussionId) REFERENCES forumDiscussions(discussionId) ON DELETE CASCADE,
  CONSTRAINT fk_forumPosts_user
    FOREIGN KEY (userId) REFERENCES users(userId) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- forumPostRevisions
-- ============================================================
CREATE TABLE IF NOT EXISTS forumPostRevisions (
  revisionId      INT        NOT NULL AUTO_INCREMENT,
  postId          INT        NOT NULL,
  editorId        INT,
  previousContent MEDIUMTEXT NOT NULL,
  createdAt       DATETIME   DEFAULT NOW(),
  PRIMARY KEY (revisionId),
  INDEX forumPostRevisions_post_idx (postId),
  CONSTRAINT fk_forumPostRevisions_post
    FOREIGN KEY (postId) REFERENCES forumPosts(postId) ON DELETE CASCADE,
  CONSTRAINT fk_forumPostRevisions_editor
    FOREIGN KEY (editorId) REFERENCES users(userId) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- supportTicketCategories
-- ============================================================
CREATE TABLE IF NOT EXISTS supportTicketCategories (
  categoryId  INT          NOT NULL AUTO_INCREMENT,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  enabled     BOOLEAN      NOT NULL DEFAULT 1,
  PRIMARY KEY (categoryId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- supportTickets
-- ============================================================
CREATE TABLE IF NOT EXISTS supportTickets (
  ticketId         INT          NOT NULL AUTO_INCREMENT,
  userId           INT          NOT NULL,
  categoryId       INT          NOT NULL,
  title            VARCHAR(255) NOT NULL,
  status           ENUM('open','closed','in-progress') NOT NULL DEFAULT 'open',
  discordChannelId VARCHAR(255),
  createdAt        DATETIME     NOT NULL DEFAULT NOW(),
  updatedAt        DATETIME     NOT NULL DEFAULT NOW() ON UPDATE NOW(),
  PRIMARY KEY (ticketId),
  CONSTRAINT fk_supportTickets_user
    FOREIGN KEY (userId) REFERENCES users(userId) ON DELETE CASCADE,
  CONSTRAINT fk_supportTickets_category
    FOREIGN KEY (categoryId) REFERENCES supportTicketCategories(categoryId) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- supportTicketMessages
-- ============================================================
CREATE TABLE IF NOT EXISTS supportTicketMessages (
  messageId   INT       NOT NULL AUTO_INCREMENT,
  ticketId    INT       NOT NULL,
  userId      INT       NOT NULL,
  message     TEXT      NOT NULL CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  attachments JSON,
  isInternal  TINYINT(1) NOT NULL DEFAULT 0,
  createdAt   DATETIME  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (messageId),
  CONSTRAINT fk_supportTicketMessages_ticket
    FOREIGN KEY (ticketId) REFERENCES supportTickets(ticketId) ON DELETE CASCADE,
  CONSTRAINT fk_supportTicketMessages_user
    FOREIGN KEY (userId) REFERENCES users(userId) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- supportTicketCategoryPermissions
-- ============================================================
CREATE TABLE IF NOT EXISTS supportTicketCategoryPermissions (
  permissionId INT          NOT NULL AUTO_INCREMENT,
  categoryId   INT          NOT NULL,
  roleId       VARCHAR(255) NOT NULL,
  PRIMARY KEY (permissionId),
  CONSTRAINT fk_supportTicketCategoryPermissions_cat
    FOREIGN KEY (categoryId) REFERENCES supportTicketCategories(categoryId) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- discord_punishments
-- ============================================================
CREATE TABLE IF NOT EXISTS discord_punishments (
  id                    INT          NOT NULL AUTO_INCREMENT,
  type                  ENUM('WARN','DISCORD_KICK','TEMP_BAN','PERM_BAN','TEMP_MUTE','PERM_MUTE') NOT NULL,
  platform              VARCHAR(16)  NOT NULL DEFAULT 'DISCORD',
  target_discord_user_id VARCHAR(24) DEFAULT NULL,
  target_discord_tag    VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  target_player_id      INT          DEFAULT NULL,
  actor_discord_user_id VARCHAR(24)  DEFAULT NULL,
  actor_player_id       INT          DEFAULT NULL,
  actor_name_snapshot   VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  reason                TEXT         CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  created_at            DATETIME     NOT NULL DEFAULT NOW(),
  expires_at            DATETIME     DEFAULT NULL,
  lifted_at             DATETIME     DEFAULT NULL,
  status                ENUM('ACTIVE','EXPIRED','LIFTED','APPEALED','APPEAL_PENDING','APPEAL_REJECTED') NOT NULL DEFAULT 'ACTIVE',
  appeal_id             INT          DEFAULT NULL,
  context               JSON         DEFAULT NULL,
  dm_status             ENUM('SENT','FAILED_CLOSED_DMS','FAILED_UNKNOWN','NOT_APPLICABLE') NOT NULL DEFAULT 'NOT_APPLICABLE',
  PRIMARY KEY (id),
  INDEX idx_discord_punishments_target   (target_discord_user_id),
  INDEX idx_discord_punishments_status   (status),
  INDEX idx_discord_punishments_type     (type),
  INDEX idx_discord_punishments_expires  (status, expires_at),
  INDEX idx_discord_punishments_player   (target_player_id),
  INDEX idx_discord_punishments_platform (platform)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- discord_punishment_appeals
-- ============================================================
CREATE TABLE IF NOT EXISTS discord_punishment_appeals (
  id                       INT         NOT NULL AUTO_INCREMENT,
  punishment_id            INT         NOT NULL,
  discord_user_id          VARCHAR(24) NOT NULL,
  appeal_reason            TEXT        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  status                   ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  reviewer_discord_user_id VARCHAR(24) DEFAULT NULL,
  reviewer_notes           TEXT        DEFAULT NULL,
  created_at               DATETIME    NOT NULL DEFAULT NOW(),
  reviewed_at              DATETIME    DEFAULT NULL,
  PRIMARY KEY (id),
  INDEX idx_appeals_punishment (punishment_id),
  INDEX idx_appeals_user       (discord_user_id),
  INDEX idx_appeals_status     (status),
  CONSTRAINT fk_appeals_punishment
    FOREIGN KEY (punishment_id) REFERENCES discord_punishments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- user_platform_connections
-- ============================================================
CREATE TABLE IF NOT EXISTS user_platform_connections (
  id                      INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id                 INT           NOT NULL,
  platform                VARCHAR(32)   NOT NULL,
  platform_account_id     VARCHAR(128)  NOT NULL,
  platform_channel_id     VARCHAR(128)  DEFAULT NULL,
  platform_username       VARCHAR(128)  DEFAULT NULL,
  platform_display_name   VARCHAR(128)  DEFAULT NULL,
  avatar_url              VARCHAR(512)  DEFAULT NULL,
  access_token            TEXT          DEFAULT NULL,
  refresh_token           TEXT          DEFAULT NULL,
  token_expires_at        DATETIME      DEFAULT NULL,
  is_active               TINYINT(1)    NOT NULL DEFAULT 1,
  last_successful_sync_at DATETIME      DEFAULT NULL,
  last_sync_error         VARCHAR(255)  DEFAULT NULL,
  created_at              TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_platform (user_id, platform),
  KEY idx_platform_active (platform, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- creator_content_items
-- ============================================================
CREATE TABLE IF NOT EXISTS creator_content_items (
  id                  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  user_id             INT           NOT NULL,
  platform            VARCHAR(32)   NOT NULL,
  external_content_id VARCHAR(128)  NOT NULL,
  external_channel_id VARCHAR(128)  DEFAULT NULL,
  content_type        VARCHAR(32)   NOT NULL,
  title               VARCHAR(512)  DEFAULT NULL,
  description         TEXT          DEFAULT NULL,
  thumbnail_url       VARCHAR(512)  DEFAULT NULL,
  watch_url           VARCHAR(512)  DEFAULT NULL,
  viewer_count        INT UNSIGNED  DEFAULT NULL,
  tags_json           TEXT          DEFAULT NULL,
  is_live             TINYINT(1)    NOT NULL DEFAULT 0,
  published_at        DATETIME      DEFAULT NULL,
  started_at          DATETIME      DEFAULT NULL,
  ended_at            DATETIME      DEFAULT NULL,
  matched_rule        VARCHAR(128)  DEFAULT NULL,
  is_cfc_related      TINYINT(1)    NOT NULL DEFAULT 0,
  is_publicly_visible TINYINT(1)    NOT NULL DEFAULT 0,
  last_seen_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_platform_content (platform, external_content_id),
  KEY idx_public_live  (is_publicly_visible, is_live),
  KEY idx_public_video (is_publicly_visible, content_type, is_live),
  KEY idx_user_platform (user_id, platform)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- creator_content_notifications
-- ============================================================
CREATE TABLE IF NOT EXISTS creator_content_notifications (
  id                  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  platform            VARCHAR(32)   NOT NULL,
  external_content_id VARCHAR(128)  NOT NULL,
  notification_type   VARCHAR(64)   NOT NULL,
  discord_message_id  VARCHAR(32)   DEFAULT NULL,
  created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_notification (platform, external_content_id, notification_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- userNotifications
-- ============================================================
CREATE TABLE IF NOT EXISTS userNotifications (
  notificationId   INT          NOT NULL AUTO_INCREMENT,
  userId           INT          NOT NULL,
  ticketId         INT          NULL,
  notificationType VARCHAR(32)  NOT NULL,
  title            VARCHAR(255) NOT NULL,
  message          TEXT         NOT NULL,
  url              VARCHAR(255) NOT NULL,
  isRead           TINYINT(1)   NOT NULL DEFAULT 0,
  createdAt        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (notificationId),
  INDEX idx_user_notifications_user   (userId),
  INDEX idx_user_notifications_unread (userId, isRead),
  INDEX idx_user_notifications_ticket (ticketId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- pushSubscriptions
-- ============================================================
CREATE TABLE IF NOT EXISTS pushSubscriptions (
  subscriptionId INT           NOT NULL AUTO_INCREMENT,
  userId         INT           NOT NULL,
  endpoint       VARCHAR(2048) NOT NULL,
  p256dh         VARCHAR(512)  NOT NULL,
  auth           VARCHAR(128)  NOT NULL,
  createdAt      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updatedAt      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (subscriptionId),
  UNIQUE INDEX idx_push_endpoint (endpoint(255)),
  INDEX idx_push_user (userId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- sessions (managed by @quixo3/prisma-session-store)
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id        VARCHAR(128) NOT NULL,
  sid       VARCHAR(128) NOT NULL,
  data      MEDIUMTEXT   NOT NULL,
  expiresAt DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_sid (sid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ============================================================
-- vote_sites
-- ============================================================
CREATE TABLE IF NOT EXISTS vote_sites (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  site_name     VARCHAR(128)  NOT NULL,
  service_name  VARCHAR(64)   NOT NULL,
  vote_url      VARCHAR(512)  NOT NULL,
  is_active     TINYINT(1)    NOT NULL DEFAULT 1,
  display_order INT           NOT NULL DEFAULT 0,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_name (service_name),
  KEY idx_active_order (is_active, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- votes
-- ============================================================
CREATE TABLE IF NOT EXISTS votes (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  vote_site_id  INT UNSIGNED  NOT NULL,
  player_uuid   VARCHAR(36)   NOT NULL,
  player_name   VARCHAR(16)   NOT NULL,
  service_name  VARCHAR(64)   NOT NULL,
  received_from VARCHAR(64)   DEFAULT NULL,
  received_at   DATETIME      NOT NULL,
  month_key     CHAR(7)       NOT NULL,
  dedupe_key    VARCHAR(128)  NOT NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dedupe (dedupe_key),
  KEY idx_uuid_month  (player_uuid, month_key),
  KEY idx_month_site  (month_key, vote_site_id),
  CONSTRAINT fk_votes_site
    FOREIGN KEY (vote_site_id) REFERENCES vote_sites(id) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- vote_monthly_totals
-- ============================================================
CREATE TABLE IF NOT EXISTS vote_monthly_totals (
  id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  player_uuid  VARCHAR(36)   NOT NULL,
  player_name  VARCHAR(16)   NOT NULL,
  month_key    CHAR(7)       NOT NULL,
  vote_count   INT UNSIGNED  NOT NULL DEFAULT 0,
  last_vote_at DATETIME      DEFAULT NULL,
  created_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_uuid_month  (player_uuid, month_key),
  KEY idx_month_count (month_key, vote_count DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- vote_monthly_results
-- ============================================================
CREATE TABLE IF NOT EXISTS vote_monthly_results (
  id           INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  month_key    CHAR(7)       NOT NULL,
  player_uuid  VARCHAR(36)   NOT NULL,
  player_name  VARCHAR(16)   NOT NULL,
  vote_count   INT UNSIGNED  NOT NULL,
  tie_position TINYINT       NOT NULL DEFAULT 1,
  rewarded_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_month_player (month_key, player_uuid),
  KEY idx_month_key (month_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- player_command_queue
-- ============================================================
CREATE TABLE IF NOT EXISTS player_command_queue (
  id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  player_uuid    VARCHAR(36)   NOT NULL,
  player_name    VARCHAR(16)   NOT NULL,
  source         VARCHAR(64)   NOT NULL,
  command_text   VARCHAR(512)  NOT NULL,
  execute_as     ENUM('console','player') NOT NULL DEFAULT 'console',
  status         ENUM('pending','claimed','completed','failed') NOT NULL DEFAULT 'pending',
  server_scope   VARCHAR(64)   NOT NULL DEFAULT 'any',
  dedupe_key     VARCHAR(128)  NOT NULL,
  available_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at     DATETIME      DEFAULT NULL,
  completed_at   DATETIME      DEFAULT NULL,
  failure_reason VARCHAR(512)  DEFAULT NULL,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dedupe (dedupe_key),
  KEY idx_claim_lookup (player_uuid, status, server_scope, available_at),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- vote_reward_templates
-- ============================================================
CREATE TABLE IF NOT EXISTS vote_reward_templates (
  id               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  reward_type      ENUM('vote','monthly_top') NOT NULL,
  command_template VARCHAR(512)  NOT NULL,
  execute_as       ENUM('console','player') NOT NULL DEFAULT 'console',
  server_scope     VARCHAR(64)   NOT NULL DEFAULT 'any',
  is_active        TINYINT(1)    NOT NULL DEFAULT 1,
  display_order    INT           NOT NULL DEFAULT 0,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_type_active (reward_type, is_active, display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed default reward templates
INSERT IGNORE INTO vote_reward_templates (id, reward_type, command_template, execute_as, server_scope, display_order) VALUES
  (1, 'vote',        'crate key give {player} vote 1',                                                          'console', 'any', 0),
  (2, 'vote',        'eco give {player} 250',                                                                   'console', 'any', 1),
  (3, 'monthly_top', 'lp user {player} parent addtemp topvoter 30d',                                            'console', 'any', 0),
  (4, 'monthly_top', 'broadcast &6[Vote] &e{player} &awon top voter for &6{month}&a! Congratulations!',         'console', 'any', 1),
  (5, 'monthly_top', 'crate key give {player} vote 10',                                                         'console', 'any', 2);
