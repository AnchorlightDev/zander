-- Add textColor column to badges table for per-badge text colour control.

ALTER TABLE `badges`
  ADD COLUMN `textColor` VARCHAR(7) NOT NULL DEFAULT '#ffffff'
  AFTER `backgroundColor`;
