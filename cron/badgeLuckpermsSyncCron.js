/**
 * cron/badgeLuckpermsSyncCron.js
 *
 * Periodically syncs badge assignments for badges linked to a LuckPerms group.
 *
 * Logic:
 *  1. Find all badges that have a luckpermsGroup set.
 *  2. For each such badge, look up all website users who currently have that LP group.
 *  3. Grant the badge (non-manual) to users who have the group but don't have the badge.
 *  4. Remove the badge (non-manual only) from users who no longer have the group.
 *
 * Runs every 15 minutes.
 */

import cron from "node-cron";
import { PrismaClient } from "@prisma/client";
import db, { luckpermsDb } from "../controllers/databaseController.js";
import {
  getAllBadges,
  syncLuckpermsBadge,
} from "../controllers/badgeController.js";

const prisma = new PrismaClient();

async function syncBadgesFromLuckperms() {
  try {
    const allBadges = await getAllBadges();
    const lpLinkedBadges = allBadges.filter((b) => b.luckpermsGroup);

    if (lpLinkedBadges.length === 0) return;

    for (const badge of lpLinkedBadges) {
      try {
        await syncOneBadge(badge);
      } catch (err) {
        console.error(`[badge-sync] Error syncing badge #${badge.badgeId} (${badge.name}):`, err);
      }
    }
  } catch (err) {
    console.error("[badge-sync] Fatal error during LP badge sync:", err);
  }
}

async function syncOneBadge(badge) {
  const groupSlug = badge.luckpermsGroup;

  // Get all user UUIDs in the LP group
  const lpRows = await new Promise((resolve, reject) => {
    luckpermsDb.query(
      `SELECT uuid FROM luckperms_user_permissions
        WHERE permission = ? AND value = 1`,
      [`group.${groupSlug}`],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });

  if (lpRows.length === 0) {
    // No one has this group — remove all non-manual badge assignments
    await syncLuckpermsBadge(badge.badgeId, []);
    return;
  }

  const lpUuids = lpRows.map((r) => String(r.uuid).toLowerCase());

  // Map LuckPerms UUIDs → website userIds
  const placeholders = lpUuids.map(() => "?").join(", ");
  const webUsers = await new Promise((resolve, reject) => {
    db.query(
      `SELECT userId, uuid FROM users WHERE LOWER(uuid) IN (${placeholders})`,
      lpUuids,
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });

  const userIds = webUsers.map((u) => u.userId);
  await syncLuckpermsBadge(badge.badgeId, userIds);
}

// Run every 15 minutes
cron.schedule("*/15 * * * *", () => {
  syncBadgesFromLuckperms();
});

// Also run once on startup (after a short delay to let the DB pool settle)
setTimeout(() => {
  syncBadgesFromLuckperms();
}, 10_000);
