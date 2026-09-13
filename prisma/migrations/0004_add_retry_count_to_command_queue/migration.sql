-- Migration 0004: Add retry_count column to player_command_queue.
--
-- The retry_count column was referenced in claimCommands and failCommands
-- controller functions but was missing from the initial schema.

ALTER TABLE player_command_queue
  ADD COLUMN retry_count INT UNSIGNED NOT NULL DEFAULT 0
  AFTER failure_reason;
