-- Author-written teaser copy for rank-locked events.
--
-- A locked event previously fell back to generated copy ("The full details of
-- this event are for X, Y or Z members..."), which is fine as a default but
-- cannot say what the event actually is.  Organisers were already writing
-- public-safe blurbs into `description`, only for the lock to redact them.
--
-- `teaserDescription` is the copy shown to everyone who cannot see the full
-- event -- on the website, in the Discord announcement embed and on the
-- Discord scheduled event.  `description` stays the full, gated text.
-- NULL keeps the previous behaviour of generated copy.
ALTER TABLE `events`
  ADD COLUMN `teaserDescription` LONGTEXT NULL AFTER `description`;

ALTER TABLE `event_templates`
  ADD COLUMN `teaserDescription` LONGTEXT NULL AFTER `description`;
