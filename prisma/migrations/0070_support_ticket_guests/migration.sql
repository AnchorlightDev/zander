-- Tickets opened from the public contact form by people without an account.
-- Such a ticket has no owner (userId NULL) and is tied to the email given on
-- the form instead; the guest reads and answers it through a private link
-- (lib/guestTickets.mjs). Their replies are stored with userId NULL.
ALTER TABLE `supportTickets`
    MODIFY COLUMN `userId` INT NULL,
    ADD COLUMN `guestEmail` VARCHAR(254) NULL,
    ADD COLUMN `guestName` VARCHAR(100) NULL,
    ADD INDEX `supportTickets_guestEmail_idx` (`guestEmail`);

ALTER TABLE `supportTicketMessages`
    MODIFY COLUMN `userId` INT NULL;
