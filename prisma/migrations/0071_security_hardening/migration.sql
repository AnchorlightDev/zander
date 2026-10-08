-- Failed-guess counters for emailed 6-digit codes (see controllers/sessionController.js).
ALTER TABLE `userEmailVerifications` ADD COLUMN `attempts` INT NOT NULL DEFAULT 0;
ALTER TABLE `userPasswordResets` ADD COLUMN `attempts` INT NOT NULL DEFAULT 0;

-- Indexes for queries that run on every request or on a timer.
CREATE INDEX `sessions_expiresAt_idx` ON `sessions`(`expiresAt`);
CREATE INDEX `userNotifications_userId_isRead_idx` ON `userNotifications`(`userId`, `isRead`);
CREATE INDEX `gameSessions_userId_idx` ON `gameSessions`(`userId`);
CREATE INDEX `scheduledDiscordMessages_status_scheduledFor_idx` ON `scheduledDiscordMessages`(`status`, `scheduledFor`);
CREATE INDEX `userEmailVerifications_userId_createdAt_idx` ON `userEmailVerifications`(`userId`, `createdAt`);
CREATE INDEX `userPasswordResets_userId_createdAt_idx` ON `userPasswordResets`(`userId`, `createdAt`);

-- Previously applied by an ad-hoc ALTER on every boot in app.js; now a real migration.
ALTER TABLE `supportTicketMessages` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
