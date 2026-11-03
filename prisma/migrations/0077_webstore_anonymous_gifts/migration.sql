-- Let a purchaser send a gift anonymously.
--
-- When `isAnonymous` = 1 the purchaser's username is hidden from the
-- recipient (Gifts Received, My Subscriptions), from the Discord webstore
-- channel embed, and from the `{{ purchaserUsername }}` command placeholder,
-- which resolves to "Anonymous". Staff dashboard and finance views keep the
-- real purchaser for refunds, chargebacks and abuse handling, and the
-- `{{ purchaserUsernameReal }}` placeholder always carries the real name.
--
-- The flag is set on the purchase at checkout and copied onto the
-- subscription row by the webhook so renewals and revocations honour it.
ALTER TABLE `webstorePurchases`
  ADD COLUMN `isAnonymous` TINYINT NOT NULL DEFAULT 0 AFTER `isGift`;

ALTER TABLE `webstoreSubscriptions`
  ADD COLUMN `isAnonymous` TINYINT NOT NULL DEFAULT 0 AFTER `purchaserUserId`;
