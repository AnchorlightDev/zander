-- Support fast search/filter/pagination on the staff Users dashboard
-- (search by username, filter/lookup by discordId).
CREATE INDEX `users_username_idx` ON `users`(`username`);
CREATE INDEX `users_discordId_idx` ON `users`(`discordId`);
