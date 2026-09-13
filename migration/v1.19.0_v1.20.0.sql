-- Add retry / expiry support to the command queue
-- Migration: v1.19.0 -> v1.20.0
--
-- expires_at  — commands are not claimed after this point and are
--               eventually marked failed by the application layer.
--               Set to available_at + 3 days on insert for all new
--               vote reward commands.  NULL on pre-migration rows
--               (treated as non-expiring by the application).
--
-- retry_count — incremented each time a claimed command is reset back
--               to pending (fail-retry or stale-claim recovery).

ALTER TABLE player_command_queue
  ADD COLUMN expires_at   DATETIME     DEFAULT NULL   AFTER available_at,
  ADD COLUMN retry_count  INT UNSIGNED NOT NULL DEFAULT 0 AFTER failure_reason;

-- Update the claim-lookup index to cover the new expires_at column.
ALTER TABLE player_command_queue
  DROP INDEX idx_claim_lookup,
  ADD  KEY   idx_claim_lookup (player_uuid, status, server_scope, available_at, expires_at);
