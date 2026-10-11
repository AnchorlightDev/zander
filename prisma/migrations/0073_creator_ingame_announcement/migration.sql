-- Links a live `creator_content_items` row to the in-game "creator is live"
-- tip announcement it created, so that announcement can be deleted the moment
-- the stream goes offline (see markStreamsOffline in watchController.js).
ALTER TABLE `creator_content_items`
  ADD COLUMN `ingame_announcement_id` INT NULL;
