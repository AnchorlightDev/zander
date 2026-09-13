-- Add viewer_count to creator_content_items
-- Migration: v1.12.0 -> v1.13.0

ALTER TABLE creator_content_items
  ADD COLUMN viewer_count INT UNSIGNED NULL DEFAULT NULL AFTER watch_url;
