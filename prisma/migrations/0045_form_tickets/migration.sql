-- Optionally open a support ticket when a form is submitted.
--
-- A form submission was previously a dead drop: the submitter got a reference
-- number and then heard nothing until someone happened to tell them. Opening a
-- ticket gives the submission a thread the submitter can already see, and that
-- staff can reply in -- so "your application is being looked at" and the final
-- decision reach the person without a separate manual step.
--
-- Off by default: a contact form or a one-off survey does not want a ticket per
-- response, and ticket creation provisions a Discord channel.
ALTER TABLE `forms`
  ADD COLUMN `createTicket`     TINYINT(1) NOT NULL DEFAULT 0 AFTER `allowMultiple`,
  ADD COLUMN `ticketCategoryId` INT        NULL              AFTER `createTicket`;

-- SET NULL, not CASCADE: deleting a support category must not delete forms.
-- A form left pointing at nothing falls back to the Uncategorised category.
ALTER TABLE `forms`
  ADD CONSTRAINT `forms_ticketCategoryId_fkey`
    FOREIGN KEY (`ticketCategoryId`) REFERENCES `supportTicketCategories` (`categoryId`)
    ON DELETE SET NULL;

-- The ticket opened for this submission, so the dashboard can link straight to
-- it and the review step knows where to post its decision. NULL means no ticket
-- was opened, either because the form has the option off or because ticket
-- creation failed (which must never fail the submission itself).
ALTER TABLE `formSubmissions`
  ADD COLUMN `ticketId` INT NULL AFTER `discordMessageId`;

ALTER TABLE `formSubmissions`
  ADD INDEX `formSubmissions_ticketId_idx` (`ticketId`),
  ADD CONSTRAINT `formSubmissions_ticketId_fkey`
    FOREIGN KEY (`ticketId`) REFERENCES `supportTickets` (`ticketId`)
    ON DELETE SET NULL;
