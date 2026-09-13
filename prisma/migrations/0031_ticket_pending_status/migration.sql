-- ============================================================
-- supportTickets: add the 'pending' status
--
-- The Discord /ticket status command and the website ticket page
-- have both offered a "Pending" option since they were built, but
-- the status column was never widened to accept it — every attempt
-- to set a ticket to pending fails at the database level.
-- ============================================================
ALTER TABLE supportTickets
  MODIFY COLUMN status ENUM('open','pending','closed','in-progress') NOT NULL DEFAULT 'open';
