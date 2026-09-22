-- How long after a denial someone must wait before applying again.
--
-- Counted from formSubmissions.reviewedAt, so the clock starts when staff
-- actually decided rather than when the application was sent -- a decision that
-- took three weeks does not also eat three weeks of the applicant's wait.
--
-- Denials only. Approved and pending submissions keep whatever `allowMultiple`
-- already does; this adds a rule, it does not replace one.
--
-- NULL means no cooldown, which is every existing form. The applicant is told
-- the exact date they may reapply, for the same reason the requirement
-- failures quote exact numbers.
ALTER TABLE `forms`
  ADD COLUMN `reapplyCooldownDays` INT NULL AFTER `requirements`;
