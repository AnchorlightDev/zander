-- Creator Content Integration
-- Migration: v1.11.0 -> v1.12.0

-- Stores OAuth-linked Twitch and YouTube accounts per user
CREATE TABLE user_platform_connections (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    platform ENUM('twitch', 'youtube') NOT NULL,
    platform_account_id VARCHAR(255) NOT NULL,
    platform_channel_id VARCHAR(255) NULL,
    platform_username VARCHAR(255) NULL,
    platform_display_name VARCHAR(255) NULL,
    avatar_url VARCHAR(512) NULL,
    access_token TEXT NULL,
    refresh_token TEXT NULL,
    token_expires_at DATETIME NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_successful_sync_at DATETIME NULL,
    last_sync_error TEXT NULL,
    UNIQUE KEY uq_user_platform (user_id, platform),
    INDEX idx_platform_active (platform, is_active),
    INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-user settings controlling watch listing visibility and notifications
CREATE TABLE creator_watch_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL UNIQUE,
    watch_enabled TINYINT(1) NOT NULL DEFAULT 1,
    twitch_enabled TINYINT(1) NOT NULL DEFAULT 1,
    youtube_enabled TINYINT(1) NOT NULL DEFAULT 1,
    public_listing_enabled TINYINT(1) NOT NULL DEFAULT 1,
    notify_discord_on_live TINYINT(1) NOT NULL DEFAULT 1,
    notify_discord_on_upload TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cached CFC-eligible content fetched from linked creator accounts
CREATE TABLE creator_content_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    platform ENUM('twitch', 'youtube') NOT NULL,
    external_content_id VARCHAR(255) NOT NULL,
    external_channel_id VARCHAR(255) NULL,
    content_type ENUM('live_stream', 'video') NOT NULL,
    title VARCHAR(512) NULL,
    description TEXT NULL,
    thumbnail_url VARCHAR(512) NULL,
    watch_url VARCHAR(512) NULL,
    tags_json TEXT NULL,
    is_live TINYINT(1) NOT NULL DEFAULT 0,
    published_at DATETIME NULL,
    started_at DATETIME NULL,
    ended_at DATETIME NULL,
    matched_rule VARCHAR(255) NULL,
    is_cfc_related TINYINT(1) NOT NULL DEFAULT 0,
    is_publicly_visible TINYINT(1) NOT NULL DEFAULT 0,
    first_detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_platform_content (platform, external_content_id),
    INDEX idx_user_id (user_id),
    INDEX idx_public_live (is_publicly_visible, is_live),
    INDEX idx_public_video (is_publicly_visible, content_type, published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Deduplication log for Discord notifications
CREATE TABLE creator_content_notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    platform ENUM('twitch', 'youtube') NOT NULL,
    external_content_id VARCHAR(255) NOT NULL,
    notification_type ENUM('live', 'upload') NOT NULL,
    discord_message_id VARCHAR(255) NULL,
    sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_notification (platform, external_content_id, notification_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
