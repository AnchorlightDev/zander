-- Cancel leftover copies of announcements that already went out.
--
-- Until announcement saving kept sent rows, every save of a published event in
-- the editor re-created its sent announcements as new pending rows. They never
-- sent because nothing gave them a send time; now that pending announcements
-- are scheduled, they would post a second time. A pending row is a copy when a
-- sent row on the same event matches it on platform, trigger, offset and (for
-- Discord) channel -- the same rule as announcementKey() in
-- lib/eventAnnouncements.js. Cancelled rather than deleted, so they can be
-- reviewed; the code cancels any that slip past this too.
UPDATE `event_announcements` AS p
JOIN `events` AS e
    ON e.`eventId` = p.`eventId`
   AND e.`status` = 'published'
JOIN `event_announcements` AS s
    ON s.`eventId` = p.`eventId`
   AND s.`status` = 'sent'
   AND s.`platform` = p.`platform`
   AND s.`triggerType` = p.`triggerType`
   AND COALESCE(s.`offsetMinutes`, 0) = COALESCE(p.`offsetMinutes`, 0)
   AND (p.`platform` <> 'discord' OR COALESCE(s.`channelId`, '') = COALESCE(p.`channelId`, ''))
SET p.`status` = 'cancelled',
    p.`lastError` = 'Duplicate of an announcement already sent'
WHERE p.`status` = 'pending';
