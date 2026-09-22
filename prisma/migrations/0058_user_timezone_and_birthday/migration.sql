-- Optional timezone and birthday on a profile.
--
-- Birthday is a day and a month, with NO YEAR, and that is deliberate. Storing
-- a full date means storing an age, which this community has no use for -- it
-- only wants to say happy birthday. Two small integers say exactly that and
-- cannot be rendered, exported or joined into an age by accident. A DATE column
-- would force a placeholder year that somebody would eventually read as real.
--
-- `timezone` is an IANA name. It is what decides which day "today" is: 20:00
-- UTC on the 14th is already the 15th in Brisbane, so a birthday check against
-- UTC fires on the wrong day for most of the world for part of every day.
--
-- `birthdayLastGrantedYear` is the local year the birthday rank last fired for
-- this user. The job has to run hourly, because midnight arrives at 24
-- different instants, and this is what stops it granting on every one of them.
--
-- All four NULL: nobody has said anything about themselves yet, and nothing
-- happens for a user who never fills them in.
ALTER TABLE `users`
  ADD COLUMN `timezone`                VARCHAR(64)       NULL,
  ADD COLUMN `birthdayDay`             TINYINT UNSIGNED  NULL,
  ADD COLUMN `birthdayMonth`           TINYINT UNSIGNED  NULL,
  ADD COLUMN `birthdayLastGrantedYear` SMALLINT UNSIGNED NULL;

-- The hourly job asks "whose birthday is today?" across the whole table.
CREATE INDEX `users_birthday_idx` ON `users` (`birthdayMonth`, `birthdayDay`);
