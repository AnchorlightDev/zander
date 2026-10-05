-- The site announcement (MOTD, tip, web banner, popup) an event announcement
-- created when its event was published. Kept so cancelling, deleting or
-- rescheduling the event can switch it off or move its window -- before this,
-- a cancelled event's MOTD stayed up.
ALTER TABLE `event_announcements`
    ADD COLUMN `linkedAnnouncementId` INTEGER NULL;
