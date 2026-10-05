-- Per-form wording for the ticket status thread, and the visibility flag for
-- the reviewer's comment.
--
-- Where a submission has a ticket, that ticket becomes a running status thread:
-- pending when it lands, then approved or denied. A Builder rejection should
-- not have to read like a staff rejection, so each form carries its own three
-- messages. Blank falls back to the defaults in lib/formTicketMessages.mjs.
ALTER TABLE `forms`
  ADD COLUMN `ticketPendingMessage`  TEXT NULL AFTER `ticketCategoryId`,
  ADD COLUMN `ticketApprovedMessage` TEXT NULL AFTER `ticketPendingMessage`,
  ADD COLUMN `ticketDeniedMessage`   TEXT NULL AFTER `ticketApprovedMessage`;

-- `reviewNotes` changes meaning from here on.
--
-- It was collected and labelled as internal staff notes, and formTicketService
-- deliberately did not forward it. From now on it is a comment written to be
-- read by the applicant, and it IS forwarded into their ticket.
--
-- That is a visibility change to data that already exists, so it must not be
-- applied retroactively: notes written by staff who were told they were
-- internal stay internal, whatever they say. NOT NULL DEFAULT 0 backfills
-- every existing row to false in the same statement, and only decisions made
-- after this ships set it true.
ALTER TABLE `formSubmissions`
  ADD COLUMN `commentIsPublic` TINYINT(1) NOT NULL DEFAULT 0 AFTER `reviewNotes`;
