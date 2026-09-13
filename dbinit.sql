DROP DATABASE IF EXISTS zanderdev;
CREATE DATABASE IF NOT EXISTS zanderdev;
USE zanderdev;

CREATE TABLE users (
        userId INT NOT NULL AUTO_INCREMENT,
        uuid VARCHAR(36) NOT NULL UNIQUE,
        username VARCHAR(16) NOT NULL,
    discordId VARCHAR(32),
    email VARCHAR(254) UNIQUE,
    password_hash VARCHAR(255),
    email_verified BOOLEAN DEFAULT 0,
    email_verified_at DATETIME,
        joined DATETIME NOT NULL DEFAULT NOW(),
    profilePicture_type ENUM('CRAFTATAR', 'GRAVATAR') DEFAULT 'CRAFTATAR',
    profilePicture_email VARCHAR(70),
    account_registered DATETIME,
        account_disabled BOOLEAN DEFAULT 0,
    is_placeholder BOOLEAN NOT NULL DEFAULT 0,
    social_aboutMe MEDIUMTEXT,
    social_interests VARCHAR(50),
    social_discord VARCHAR(32),
    social_steam VARCHAR(100),
    social_twitch VARCHAR(25),
    social_youtube VARCHAR(100),
    social_twitter_x VARCHAR(15),
    social_instagram VARCHAR(30),
    social_reddit VARCHAR(38),
    social_spotify VARCHAR(100),
	audit_lastDiscordMessage DATETIME,
	audit_lastDiscordVoice DATETIME,
	audit_lastMinecraftLogin DATETIME,
	audit_lastMinecraftMessage DATETIME,
	audit_lastMinecraftPunishment DATETIME,
	audit_lastDiscordPunishment DATETIME,
	audit_lastWebsiteLogin DATETIME,
        PRIMARY KEY (userId),
        INDEX users (uuid(8))
);

CREATE TABLE userEmailVerifications (
        verificationId INT NOT NULL AUTO_INCREMENT,
    userId INT NOT NULL,
    codeHash VARCHAR(255) NOT NULL,
    expiresAt DATETIME NOT NULL,
    consumed BOOLEAN DEFAULT 0,
    createdAt DATETIME DEFAULT NOW(),
    consumedAt DATETIME,
    PRIMARY KEY (verificationId),
    INDEX userEmailVerifications_userId (userId),
    CONSTRAINT fk_userEmailVerifications_users FOREIGN KEY (userId) REFERENCES users(userId) ON DELETE CASCADE
);

CREATE TABLE userPasswordResets (
        resetId INT NOT NULL AUTO_INCREMENT,
    userId INT NOT NULL,
    codeHash VARCHAR(255) NOT NULL,
    expiresAt DATETIME NOT NULL,
    consumed BOOLEAN DEFAULT 0,
    createdAt DATETIME DEFAULT NOW(),
    consumedAt DATETIME,
    PRIMARY KEY (resetId),
    INDEX userPasswordResets_userId (userId),
    CONSTRAINT fk_userPasswordResets_users FOREIGN KEY (userId) REFERENCES users(userId) ON DELETE CASCADE
);

CREATE TABLE userVerifyLink (
        verifyId INT NOT NULL AUTO_INCREMENT,
    uuid VARCHAR(36) NOT NULL UNIQUE,
    username TEXT NOT NULL,
    linkCode VARCHAR(6),
    codeExpiry DATETIME NOT NULL,
    PRIMARY KEY (verifyId)
);

CREATE TABLE forumCategories (
    categoryId INT NOT NULL AUTO_INCREMENT,
    parentCategoryId INT,
    name VARCHAR(120) NOT NULL,
    slug VARCHAR(150) NOT NULL,
    description TEXT,
    position INT DEFAULT 0,
    viewPermission VARCHAR(150),
    postPermission VARCHAR(150),
    createdAt DATETIME DEFAULT NOW(),
    updatedAt DATETIME DEFAULT NOW() ON UPDATE NOW(),
    PRIMARY KEY (categoryId),
    UNIQUE KEY forumCategories_slug_unique (slug),
    INDEX forumCategories_parent_idx (parentCategoryId),
    CONSTRAINT fk_forumCategories_parent FOREIGN KEY (parentCategoryId) REFERENCES forumCategories(categoryId) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE forumDiscussions (
    discussionId INT NOT NULL AUTO_INCREMENT,
    categoryId INT NOT NULL,
    title VARCHAR(200) NOT NULL,
    slug VARCHAR(200) NOT NULL,
    createdBy INT NOT NULL,
    createdAt DATETIME DEFAULT NOW(),
    updatedAt DATETIME DEFAULT NOW() ON UPDATE NOW(),
    lastPostAt DATETIME DEFAULT NOW(),
    lastPostBy INT,
    isLocked TINYINT(1) DEFAULT 0,
    isSticky TINYINT(1) DEFAULT 0,
    isArchived TINYINT(1) DEFAULT 0,
    PRIMARY KEY (discussionId),
    UNIQUE KEY forumDiscussions_slug_unique (categoryId, slug),
    INDEX forumDiscussions_category_idx (categoryId),
    INDEX forumDiscussions_lastPost_idx (lastPostAt),
    CONSTRAINT fk_forumDiscussions_category FOREIGN KEY (categoryId) REFERENCES forumCategories(categoryId) ON DELETE CASCADE,
    CONSTRAINT fk_forumDiscussions_creator FOREIGN KEY (createdBy) REFERENCES users(userId) ON DELETE CASCADE,
    CONSTRAINT fk_forumDiscussions_lastPostUser FOREIGN KEY (lastPostBy) REFERENCES users(userId) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE forumPosts (
    postId INT NOT NULL AUTO_INCREMENT,
    discussionId INT NOT NULL,
    parentPostId INT NULL,
    userId INT NOT NULL,
    content MEDIUMTEXT NOT NULL,
    isOriginal TINYINT(1) DEFAULT 0,
    createdAt DATETIME DEFAULT NOW(),
    updatedAt DATETIME DEFAULT NOW() ON UPDATE NOW(),
    PRIMARY KEY (postId),
    INDEX forumPosts_discussion_idx (discussionId),
    INDEX forumPosts_user_idx (userId),
    INDEX forumPosts_parent_idx (parentPostId),
    CONSTRAINT fk_forumPosts_discussion FOREIGN KEY (discussionId) REFERENCES forumDiscussions(discussionId) ON DELETE CASCADE,
    CONSTRAINT fk_forumPosts_user FOREIGN KEY (userId) REFERENCES users(userId) ON DELETE CASCADE,
    CONSTRAINT fk_forumPosts_parent FOREIGN KEY (parentPostId) REFERENCES forumPosts(postId) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE forumPostRevisions (
    revisionId INT NOT NULL AUTO_INCREMENT,
    postId INT NOT NULL,
    editorId INT,
    previousContent MEDIUMTEXT NOT NULL,
    createdAt DATETIME DEFAULT NOW(),
    PRIMARY KEY (revisionId),
    INDEX forumPostRevisions_post_idx (postId),
    CONSTRAINT fk_forumPostRevisions_post FOREIGN KEY (postId) REFERENCES forumPosts(postId) ON DELETE CASCADE,
    CONSTRAINT fk_forumPostRevisions_editor FOREIGN KEY (editorId) REFERENCES users(userId) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO users (uuid, username, account_disabled)
VALUES ('f78a4d8d-d51b-4b39-98a3-230f2de0c670','CONSOLE',0);

CREATE VIEW zanderdev.luckPermsPlayers AS
SELECT * FROM cfcdev_luckperms.luckperms_players;

CREATE VIEW zanderdev.ranks AS
SELECT
	lpGroups.name AS rankSlug,
    COALESCE(SUBSTRING_INDEX(lpGroupDisplayName.permission ,'.', -1), lpGroups.name) AS displayName,
    SUBSTRING_INDEX(lpGroupWeight.permission, '.', -1) AS priority,
    -- Use meta.rankbadgecolour if set, otherwise fall back to prefix color codes
    COALESCE(
        CONCAT('#', SUBSTRING_INDEX(lpMetaBadgeColour.permission, '.', -1)),
        CASE LEFT(SUBSTRING_INDEX(lpGroupPrefix.permission, '[&', -1), 1)
            WHEN '0' THEN '#000000'
            WHEN '1' THEN '#0000AA'
            WHEN '2' THEN '#00AA00'
            WHEN '3' THEN '#00AAAA'
            WHEN '4' THEN '#AA0000'
            WHEN '5' THEN '#AA00AA'
            WHEN '6' THEN '#FFAA00'
            WHEN '7' THEN '#AAAAAA'
            WHEN '8' THEN '#555555'
            WHEN '9' THEN '#5555FF'
            WHEN 'a' THEN '#55FF55'
            WHEN 'b' THEN '#55FFFF'
            WHEN 'c' THEN '#FF5555'
            WHEN 'd' THEN '#FF55FF'
            WHEN 'e' THEN '#FFFF55'
            WHEN 'g' THEN '#DDD605'
            ELSE '#FFFFFF'
        END
    ) AS rankBadgeColour,
    -- Use meta.ranktextcolour if set, otherwise fall back to contrast color based on prefix
    COALESCE(
        CONCAT('#', SUBSTRING_INDEX(lpMetaTextColour.permission, '.', -1)),
        CASE WHEN
            LEFT(SUBSTRING_INDEX(lpGroupPrefix.permission, '[&', -1), 1) IN ('0','1','2','3','4','5','8','9') THEN '#FFFFFF'
            ELSE '#000000'
        END
    ) AS rankTextColour,
    COALESCE(SUBSTRING_INDEX(lpDiscordId.permission, '.', -1),null) AS discordRoleId,
    COALESCE(RIGHT(lpGroupStaff.permission, 1),'0') AS isStaff,
    COALESCE(RIGHT(lpGroupDonator.permission, 1),'0') AS isDonator,
    REPLACE(COALESCE(SUBSTRING_INDEX(lpGroupDescription.permission, 'meta.rank_description.', -1), ''), '\\', '') AS rankDescription
FROM cfcdev_luckperms.luckperms_groups lpGroups
	-- Scoped to server='global'/world='global' to match how the dashboard's
	-- rank config editor writes these nodes (see updateGroupNode() in
	-- api/routes/ranks.js). Without this, a group with a contextual override
	-- (e.g. a meta.discordid set with server=events on top of the global one)
	-- produces duplicate/ambiguous rows for the same rank.
	LEFT JOIN cfcdev_luckperms.luckperms_group_permissions lpGroupDisplayName ON lpGroups.name = lpGroupDisplayName.name
		AND lpGroupDisplayName.permission LIKE 'displayname.%'
        AND lpGroupDisplayName.value = 1
        AND lpGroupDisplayName.server = 'global' AND lpGroupDisplayName.world = 'global'
	LEFT JOIN cfcdev_luckperms.luckperms_group_permissions lpGroupWeight ON lpGroups.name = lpGroupWeight.name
		AND lpGroupWeight.permission LIKE 'weight.%'
        AND lpGroupWeight.value = 1
        AND lpGroupWeight.server = 'global' AND lpGroupWeight.world = 'global'
	LEFT JOIN cfcdev_luckperms.luckperms_group_permissions lpGroupPrefix ON lpGroups.name = lpGroupPrefix.name
		AND lpGroupPrefix.permission LIKE 'prefix.%'
        AND lpGroupPrefix.value = 1
        AND lpGroupPrefix.server = 'global' AND lpGroupPrefix.world = 'global'
	LEFT JOIN cfcdev_luckperms.luckperms_group_permissions lpGroupStaff On lpGroups.name = lpGroupStaff.name
		AND lpGroupStaff.permission LIKE 'meta.staff.%'
        AND lpGroupStaff.value = 1
        AND lpGroupStaff.server = 'global' AND lpGroupStaff.world = 'global'
	LEFT JOIN cfcdev_luckperms.luckperms_group_permissions lpGroupDonator On lpGroups.name = lpGroupDonator.name
		AND lpGroupDonator.permission LIKE 'meta.donator.%'
        AND lpGroupDonator.value = 1
        AND lpGroupDonator.server = 'global' AND lpGroupDonator.world = 'global'
	LEFT JOIN cfcdev_luckperms.luckperms_group_permissions lpDiscordId ON lpGroups.name = lpDiscordId.name
		AND lpDiscordId.permission LIKE 'meta.discordid.%'
        AND lpDiscordId.value = 1
        AND lpDiscordId.server = 'global' AND lpDiscordId.world = 'global'
	LEFT JOIN cfcdev_luckperms.luckperms_group_permissions lpGroupDescription ON lpGroups.name = lpGroupDescription.name
		AND lpGroupDescription.permission LIKE 'meta.rank\_description.%'
        AND lpGroupDescription.value = 1
        AND lpGroupDescription.server = 'global' AND lpGroupDescription.world = 'global'
	LEFT JOIN cfcdev_luckperms.luckperms_group_permissions lpMetaBadgeColour ON lpGroups.name = lpMetaBadgeColour.name
		AND lpMetaBadgeColour.permission LIKE 'meta.rankbadgecolour.%'
        AND lpMetaBadgeColour.value = 1
        AND lpMetaBadgeColour.server = 'global' AND lpMetaBadgeColour.world = 'global'
	LEFT JOIN cfcdev_luckperms.luckperms_group_permissions lpMetaTextColour ON lpGroups.name = lpMetaTextColour.name
		AND lpMetaTextColour.permission LIKE 'meta.ranktextcolour.%'
        AND lpMetaTextColour.value = 1
        AND lpMetaTextColour.server = 'global' AND lpMetaTextColour.world = 'global';

CREATE VIEW zanderdev.userRanks AS
SELECT
	zdUsers.userId,
	lpUserPermissions.uuid,
	SUBSTRING_INDEX(lpUserPermissions.permission ,'.', -1) AS rankSlug,
    SUBSTRING_INDEX(lpUserTitle.permission, 'title.', -1) AS title
FROM cfcdev_luckperms.luckperms_user_permissions lpUserPermissions
	LEFT JOIN cfcdev_luckperms.luckperms_user_permissions lpUserTitle On lpUserPermissions.uuid = lpUserTitle.uuid
		AND lpUserTitle.permission LIKE CONCAT('meta.group\\\\.',SUBSTRING_INDEX(lpUserPermissions.permission ,'.', -1),'\\\\.title.%')
        AND lpUserTitle.value = 1
	LEFT JOIN zanderdev.users zdUsers ON lpUserPermissions.uuid = zdUsers.uuid
WHERE lpUserPermissions.permission like 'group.%'
	AND lpUserPermissions.value = 1;

CREATE VIEW zanderdev.userPermissions AS
SELECT
    u.uuid,
    u.userId,
	up.permission,
	up.value,
    up.server,
    up.world,
    up.expiry,
    up.contexts,
	u.username
FROM  cfcdev_luckperms.luckperms_user_permissions up
RIGHT JOIN zanderdev.users u ON up.uuid = u.uuid
WHERE up.permission IS NOT NULL
	AND up.permission NOT LIKE 'group.%'
    AND up.value = 1;

CREATE VIEW zanderdev.rankRanks AS
SELECT
	gp.name AS parentRankSlug,
    SUBSTRING_INDEX(gp.permission, '.', -1) AS rankSlug
FROM cfcdev_luckperms.luckperms_group_permissions gp
WHERE gp.permission IS NOT NULL
	AND gp.permission LIKE 'group.%'
    AND gp.value = 1;

CREATE VIEW zanderdev.rankPermissions AS
SELECT
        name AS rankSlug,
    permission,
    value,
    server,
    world,
    expiry,
    contexts
FROM cfcdev_luckperms.luckperms_group_permissions gp
WHERE gp.permission IS NOT NULL
        AND gp.permission NOT LIKE 'group.%'
    AND gp.value = 1;

CREATE TABLE servers (
        serverId INT NOT NULL AUTO_INCREMENT,
    displayName TEXT,
    serverConnectionAddress TEXT,
    serverType ENUM('INTERNAL', 'EXTERNAL', 'VERIFICATION'),
    position INT,
    PRIMARY KEY (serverId)
);

CREATE TABLE serverStatus (
	serverStatusId INT NOT NULL AUTO_INCREMENT,
    statusInfo JSON,
    lastUpdated DATETIME,
    PRIMARY KEY (serverStatusId)
);

INSERT INTO serverStatus (serverStatusId, statusInfo)
VALUES (1, null);

CREATE TABLE gameSessions (
	sessionId INT NOT NULL AUTO_INCREMENT,
    userId INT NOT NULL,
    sessionStart DATETIME NOT NULL DEFAULT NOW(),
    sessionEnd DATETIME,
    ipAddress VARCHAR(45),
    server TEXT,
    PRIMARY KEY (sessionId),
    INDEX gameSessions_sessionStart (sessionStart),
    INDEX gameSessions_sessionEnd (sessionEnd)
);

CREATE TABLE announcements (
	announcementId INT NOT NULL AUTO_INCREMENT,
    enabled BOOLEAN DEFAULT 1,
    announcementType ENUM('motd', 'tip', 'web', 'popup'),
    body TEXT,
    colourMessageFormat TEXT,
    link TEXT,
    popupButtonText VARCHAR(60),
    popupImageUrl TEXT,
    startDate DATETIME,
    endDate DATETIME,
    updatedDate DATETIME,
    PRIMARY KEY (announcementId)
);

-- Update the announcements.updatedDate when record is updated
CREATE TRIGGER announcements_updatedDateBeforeUpdate
BEFORE UPDATE ON announcements FOR EACH ROW
	SET NEW.updatedDate = NOW()
;

CREATE TABLE scheduledDiscordMessages (
    scheduleId INT NOT NULL AUTO_INCREMENT,
    channelId VARCHAR(50) NOT NULL,
    embedTitle VARCHAR(255),
    embedDescription TEXT,
    embedColor VARCHAR(20),
    scheduledFor DATETIME NOT NULL,
    createdBy INT NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT NOW(),
    sentAt DATETIME,
    status ENUM('scheduled', 'sent', 'failed') DEFAULT 'scheduled',
    lastError TEXT,
    PRIMARY KEY (scheduleId),
    INDEX scheduledDiscordMessages_scheduledFor (scheduledFor),
    INDEX scheduledDiscordMessages_status (status)
);

CREATE TABLE applications (
	applicationId INT NOT NULL AUTO_INCREMENT,
    displayName VARCHAR(30),
    description TEXT,
    displayIcon VARCHAR(40),
    requirementsMarkdown TEXT,
    redirectUrl TEXT,
    position INT,
    applicationStatus BOOLEAN DEFAULT 0,
    applicationType ENUM('external', 'linked_form') NOT NULL DEFAULT 'external',
    linkedFormId INT,
    PRIMARY KEY (applicationId)
);

CREATE TABLE forms (
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

CREATE TABLE formBlocks (
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
        'section_break',
        'image_upload'
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

CREATE TABLE formResponses (
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

CREATE TABLE reports (
	reportId INT NOT NULL AUTO_INCREMENT,
    reporterId INT NOT NULL,
    reportedUser VARCHAR(30) NOT NULL,
    reportReason VARCHAR(100) NOT NULL,
    reportReasonEvidence MEDIUMTEXT,
    reportPlatform VARCHAR(10) NOT NULL,
    reportDateTime DATETIME NOT NULL DEFAULT NOW(),
    PRIMARY KEY (reportId)
);

CREATE VIEW shoppingDirectory AS
SELECT 
        `shops`.`id` AS `id`,
        `zanderProd`.`users`.`uuid` AS `uuid`,
        `zanderProd`.`users`.`userId` AS `userId`,
        REPLACE(
            TRIM(SUBSTRING_INDEX(
                SUBSTR(`data`.`item`,
                       LOCATE('id:', `data`.`item`) + OCTET_LENGTH('id:')),
                '\n',
                1
            )),
            'minecraft:',
            ''
        ) AS `item`,
        CASE
            WHEN LOCATE('count:', `data`.`item`) = 0 THEN NULL
            ELSE TRIM(SUBSTRING_INDEX(
                SUBSTR(`data`.`item`,
                       LOCATE('count:', `data`.`item`) + OCTET_LENGTH('count:')),
                '\n',
                1
            ))
        END AS `amount`,
        `data`.`price` AS `price`,
        `stock`.`stock` AS `stock`,
        `map`.`world` AS `world`,
        `map`.`x` AS `x`,
        `map`.`y` AS `y`,
        `map`.`z` AS `z`,
        CASE
            WHEN LOCATE('minecraft:stored_enchantments:', `data`.`item`) > 0
            THEN CONCAT(
                -- enchant name (underscores → spaces, strip quotes, title-case)
                CONCAT(
                    UPPER(LEFT(
                        REPLACE(
                            REPLACE(
                                REPLACE(
                                    TRIM(SUBSTRING_INDEX(
                                        REPLACE(
                                            REPLACE(
                                                TRIM(SUBSTRING_INDEX(
                                                    SUBSTR(`data`.`item`,
                                                           LOCATE('minecraft:stored_enchantments:', `data`.`item`)
                                                             + OCTET_LENGTH('minecraft:stored_enchantments:')),
                                                    '\n',
                                                    1
                                                )),
                                                '{"minecraft:', ''
                                            ),
                                            '}', ''
                                        ),
                                        '":',
                                        1
                                    )),
                                    '\'',
                                    ''
                                ),
                                '"',
                                ''
                            ),
                            '_',
                            ' '
                        ),
                        1
                    )),
                    LOWER(SUBSTRING(
                        REPLACE(
                            REPLACE(
                                REPLACE(
                                    TRIM(SUBSTRING_INDEX(
                                        REPLACE(
                                            REPLACE(
                                                TRIM(SUBSTRING_INDEX(
                                                    SUBSTR(`data`.`item`,
                                                           LOCATE('minecraft:stored_enchantments:', `data`.`item`)
                                                             + OCTET_LENGTH('minecraft:stored_enchantments:')),
                                                    '\n',
                                                    1
                                                )),
                                                '{"minecraft:', ''
                                            ),
                                            '}', ''
                                        ),
                                        '":',
                                        1
                                    )),
                                    '\'',
                                    ''
                                ),
                                '"',
                                ''
                            ),
                            '_',
                            ' '
                        ),
                        2
                    ))
                ),
                ' ',
                -- enchant level
                REPLACE(
                    REPLACE(
                        TRIM(SUBSTRING_INDEX(
                            REPLACE(
                                REPLACE(
                                    TRIM(SUBSTRING_INDEX(
                                        SUBSTR(`data`.`item`,
                                               LOCATE('minecraft:stored_enchantments:', `data`.`item`)
                                                 + OCTET_LENGTH('minecraft:stored_enchantments:')),
                                        '\n',
                                        1
                                    )),
                                    '{"minecraft:', ''
                                ),
                                '}',
                                ''
                            ),
                            '":',
                            -1
                        )),
                        '"',
                        ''
                    ),
                    '\'',
                    ''
                )
            )
            WHEN LOCATE('minecraft:potion_contents:', `data`.`item`) > 0
            THEN REPLACE(
                    REPLACE(
                        REPLACE(
                            REPLACE(
                                TRIM(SUBSTRING_INDEX(
                                    SUBSTR(`data`.`item`,
                                           LOCATE('minecraft:potion_contents:', `data`.`item`)
                                             + OCTET_LENGTH('minecraft:potion_contents:')),
                                    '\n',
                                    1
                                )),
                                '{potion:"minecraft:', ''
                            ),
                            '"}', ''
                        ),
                        '\'', ''
                    ),
                    '}', ''
                )
            WHEN LOCATE('minecraft:enchantments:', `data`.`item`) > 0
            THEN REPLACE(
                    REPLACE(
                        TRIM(SUBSTRING_INDEX(
                            SUBSTR(`data`.`item`,
                                   LOCATE('minecraft:enchantments:', `data`.`item`)
                                     + OCTET_LENGTH('minecraft:enchantments:')),
                            '\n',
                            1
                        )),
                        '\'', ''
                    ),
                    ' ', ''
                )
            ELSE NULL
        END AS `display_name`
    FROM
        ((((`cfc_prod_quickshop`.`qs_shops` `shops`
        JOIN `cfc_prod_quickshop`.`qs_shop_map` `map` ON (`shops`.`id` = `map`.`shop`))
        JOIN `cfc_prod_quickshop`.`qs_data` `data` ON (`shops`.`data` = `data`.`id`))
        JOIN `zanderProd`.`users` ON (`zanderProd`.`users`.`uuid` = `data`.`owner`))
        JOIN `cfc_prod_quickshop`.`qs_external_cache` `stock` ON (`shops`.`id` = `stock`.`shop`))
    WHERE
        `data`.`unlimited` = 0
    ORDER BY `shops`.`id`;

CREATE TABLE vault (
	vaultId INT NOT NULL AUTO_INCREMENT,
    displayName VARCHAR(30),
    description MEDIUMTEXT,
    redirectUrl TEXT,
    position INT,
    PRIMARY KEY (vaultId)
);

CREATE TABLE bridge (
        bridgeId INT NOT NULL AUTO_INCREMENT,
    command TEXT,
    targetServer VARCHAR(30),
    processed BOOLEAN DEFAULT 0,
    bridgeDateTime DATETIME NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bridgeId)
);

CREATE TABLE executorTasks (
        executorTaskId INT NOT NULL AUTO_INCREMENT,
    slug VARCHAR(64) NOT NULL,
    command TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    routineSlug VARCHAR(64) DEFAULT NULL,
    metadata TEXT DEFAULT NULL,
    result TEXT DEFAULT NULL,
    priority INT DEFAULT 0,
    executedBy VARCHAR(64) DEFAULT NULL,
    createdAt DATETIME NOT NULL DEFAULT NOW(),
    updatedAt DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
    processedAt DATETIME DEFAULT NULL,
    PRIMARY KEY (executorTaskId),
    KEY idx_executorTasks_status_slug (status, slug),
    KEY idx_executorTasks_routineSlug (routineSlug)
);

CREATE TABLE executorRoutines (
        executorRoutineId INT NOT NULL AUTO_INCREMENT,
    routineSlug VARCHAR(64) NOT NULL,
    displayName VARCHAR(120) DEFAULT NULL,
    description TEXT DEFAULT NULL,
    createdAt DATETIME NOT NULL DEFAULT NOW(),
    updatedAt DATETIME NOT NULL DEFAULT NOW() ON UPDATE NOW(),
    PRIMARY KEY (executorRoutineId),
    UNIQUE KEY uq_executorRoutines_routineSlug (routineSlug)
);

CREATE TABLE executorRoutineSteps (
        executorRoutineStepId INT NOT NULL AUTO_INCREMENT,
    executorRoutineId INT NOT NULL,
    stepOrder INT NOT NULL DEFAULT 0,
    slug VARCHAR(64) NOT NULL,
    command TEXT NOT NULL,
    metadata TEXT DEFAULT NULL,
    createdAt DATETIME NOT NULL DEFAULT NOW(),
    PRIMARY KEY (executorRoutineStepId),
    KEY idx_executorRoutineSteps_routine (executorRoutineId, stepOrder)
);

CREATE TABLE logs (
	logId INT NOT NULL AUTO_INCREMENT,
    creatorId INT NOT NULL,
    logFeature VARCHAR(30),
    logType VARCHAR(30),
    description TEXT,
    actionedDateTime DATETIME NOT NULL DEFAULT NOW(),
    PRIMARY KEY (logId)
);

CREATE TABLE IF NOT EXISTS discord_punishments (
    id INT NOT NULL AUTO_INCREMENT,
    type ENUM('WARN', 'DISCORD_KICK', 'TEMP_BAN', 'PERM_BAN', 'TEMP_MUTE', 'PERM_MUTE') NOT NULL,
    platform VARCHAR(16) NOT NULL DEFAULT 'DISCORD',
    target_discord_user_id VARCHAR(24) DEFAULT NULL,
    target_discord_tag  VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    target_player_id INT DEFAULT NULL,
    actor_discord_user_id VARCHAR(24) DEFAULT NULL,
    actor_player_id INT DEFAULT NULL,
    actor_name_snapshot VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    reason TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
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
    appeal_reason TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
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

-- Watch feature tables (v1.15.0 -> v1.16.0)

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
