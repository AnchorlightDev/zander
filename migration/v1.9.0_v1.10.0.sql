-- Forms System Migration
-- Adds forms, form blocks, form responses, and updates applications table

CREATE TABLE IF NOT EXISTS forms (
    formId INT NOT NULL AUTO_INCREMENT,
    name VARCHAR(120) NOT NULL,
    slug VARCHAR(150) NOT NULL,
    status ENUM('draft', 'published', 'archived') NOT NULL DEFAULT 'draft',
    createdByUserId INT NOT NULL,
    discordWebhookUrl TEXT,
    discordForumChannelId VARCHAR(255),
    postToForumEnabled TINYINT(1) NOT NULL DEFAULT 0,
    webhookEnabled TINYINT(1) NOT NULL DEFAULT 0,
    submitterCanView TINYINT(1) NOT NULL DEFAULT 1,
    requireLogin TINYINT(1) NOT NULL DEFAULT 1,
    createdAt DATETIME NOT NULL DEFAULT NOW(),
    updatedAt DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
    PRIMARY KEY (formId),
    UNIQUE KEY forms_slug_unique (slug),
    INDEX forms_status_idx (status)
);

CREATE TABLE IF NOT EXISTS formBlocks (
    blockId INT NOT NULL AUTO_INCREMENT,
    formId INT NOT NULL,
    type ENUM(
        'short_answer',
        'paragraph',
        'multiple_choice',
        'checkboxes',
        'dropdown',
        'linear_scale',
        'title_description',
        'section_break'
    ) NOT NULL,
    orderIndex INT NOT NULL DEFAULT 0,
    required TINYINT(1) NOT NULL DEFAULT 0,
    label VARCHAR(255),
    description TEXT,
    config JSON,
    PRIMARY KEY (blockId),
    INDEX formBlocks_formId_idx (formId),
    INDEX formBlocks_order_idx (formId, orderIndex),
    CONSTRAINT fk_formBlocks_form FOREIGN KEY (formId) REFERENCES forms(formId) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS formResponses (
    responseId INT NOT NULL AUTO_INCREMENT,
    formId INT NOT NULL,
    submittedByUserId INT,
    submittedAt DATETIME NOT NULL DEFAULT NOW(),
    answers JSON NOT NULL,
    status ENUM('new', 'reviewed', 'converted', 'archived') NOT NULL DEFAULT 'new',
    discordWebhookFailed TINYINT(1) NOT NULL DEFAULT 0,
    discordForumPostFailed TINYINT(1) NOT NULL DEFAULT 0,
    discordForumThreadId VARCHAR(255),
    ticketId INT,
    convertedByUserId INT,
    convertedAt DATETIME,
    PRIMARY KEY (responseId),
    INDEX formResponses_formId_idx (formId),
    INDEX formResponses_submitter_idx (submittedByUserId),
    INDEX formResponses_status_idx (status),
    CONSTRAINT fk_formResponses_form FOREIGN KEY (formId) REFERENCES forms(formId) ON DELETE CASCADE
);

-- Update applications table to support linked forms and external URLs
ALTER TABLE applications
    ADD COLUMN applicationType ENUM('external', 'linked_form') NOT NULL DEFAULT 'external' AFTER applicationStatus,
    ADD COLUMN linkedFormId INT AFTER applicationType;

-- Punishments System (Discord + Web)
-- Migration: v1.9.0 -> v1.10.0

CREATE TABLE IF NOT EXISTS discord_punishments (
    id INT NOT NULL AUTO_INCREMENT,
    type ENUM('WARN', 'DISCORD_KICK', 'TEMP_BAN', 'PERM_BAN', 'TEMP_MUTE', 'PERM_MUTE') NOT NULL,
    platform VARCHAR(16) NOT NULL DEFAULT 'DISCORD',
    target_discord_user_id VARCHAR(24) DEFAULT NULL,
    target_discord_tag VARCHAR(100),
    target_player_id INT DEFAULT NULL,
    actor_discord_user_id VARCHAR(24) DEFAULT NULL,
    actor_player_id INT DEFAULT NULL,
    actor_name_snapshot VARCHAR(100),
    reason TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT NOW(),
    expires_at DATETIME DEFAULT NULL,
    lifted_at DATETIME DEFAULT NULL,
    status ENUM('ACTIVE', 'EXPIRED', 'LIFTED', 'APPEALED', 'APPEAL_PENDING', 'APPEAL_REJECTED') NOT NULL DEFAULT 'ACTIVE',
    appeal_id INT DEFAULT NULL,
    context JSON DEFAULT NULL,
    dm_status ENUM('SENT', 'FAILED_CLOSED_DMS', 'FAILED_UNKNOWN', 'NOT_APPLICABLE') NOT NULL DEFAULT 'NOT_APPLICABLE',
    PRIMARY KEY (id),
    INDEX idx_discord_punishments_target (target_discord_user_id),
    INDEX idx_discord_punishments_status (status),
    INDEX idx_discord_punishments_type (type),
    INDEX idx_discord_punishments_expires (status, expires_at),
    INDEX idx_discord_punishments_player (target_player_id),
    INDEX idx_discord_punishments_platform (platform)
);

CREATE TABLE IF NOT EXISTS discord_punishment_appeals (
    id INT NOT NULL AUTO_INCREMENT,
    punishment_id INT NOT NULL,
    discord_user_id VARCHAR(24) NOT NULL,
    appeal_reason TEXT NOT NULL,
    status ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    reviewer_discord_user_id VARCHAR(24) DEFAULT NULL,
    reviewer_notes TEXT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT NOW(),
    reviewed_at DATETIME DEFAULT NULL,
    PRIMARY KEY (id),
    INDEX idx_appeals_punishment (punishment_id),
    INDEX idx_appeals_user (discord_user_id),
    INDEX idx_appeals_status (status),
    CONSTRAINT fk_appeals_punishment FOREIGN KEY (punishment_id) REFERENCES discord_punishments(id) ON DELETE CASCADE
);
