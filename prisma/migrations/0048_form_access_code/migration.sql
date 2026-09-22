-- One shared passcode per form.
--
-- For a form that is linked rather than listed -- a closed beta signup, an
-- invite-only application round -- the code is the whole gate: anyone holding
-- it gets in, and everyone else sees the code prompt instead of the questions.
--
-- Deliberately a shared secret, not a per-user token: the point is to be
-- pasteable into a Discord announcement, and per-user codes would need issuing,
-- storing and revoking for no gain at this threat level.
--
-- NULL or empty means no gate, which is every existing form.
ALTER TABLE `forms`
  ADD COLUMN `accessCode` VARCHAR(190) NULL AFTER `allowMultiple`;
