/**
 * controllers/badgeController.js
 *
 * CRUD and assignment logic for the Badge system.
 * Uses the Prisma client for all database operations.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Badge CRUD
// ---------------------------------------------------------------------------

export async function getAllBadges() {
  return prisma.badges.findMany({
    orderBy: { createdAt: "asc" },
  });
}

export async function getBadgeById(badgeId) {
  return prisma.badges.findUnique({ where: { badgeId } });
}

export async function getBadgeByLuckpermsGroup(luckpermsGroup) {
  if (!luckpermsGroup) return null;
  return prisma.badges.findFirst({ where: { luckpermsGroup } });
}

export async function createBadge({ name, description, backgroundColor, textColor, luckpermsGroup }) {
  validateBadgeInput({ name, backgroundColor, textColor });

  return prisma.badges.create({
    data: {
      name: name.trim(),
      description: description?.trim() || null,
      backgroundColor: normaliseHex(backgroundColor),
      textColor: normaliseHex(textColor || "#ffffff"),
      luckpermsGroup: luckpermsGroup?.trim() || null,
    },
  });
}

export async function updateBadge(badgeId, { name, description, backgroundColor, textColor, luckpermsGroup }) {
  validateBadgeInput({ name, backgroundColor, textColor });

  return prisma.badges.update({
    where: { badgeId },
    data: {
      name: name.trim(),
      description: description?.trim() || null,
      backgroundColor: normaliseHex(backgroundColor),
      textColor: normaliseHex(textColor || "#ffffff"),
      luckpermsGroup: luckpermsGroup?.trim() || null,
    },
  });
}

export async function deleteBadge(badgeId) {
  return prisma.badges.delete({ where: { badgeId } });
}

export async function duplicateBadge(badgeId) {
  const source = await getBadgeById(badgeId);
  if (!source) throw new Error("Badge not found.");

  return prisma.badges.create({
    data: {
      name: `${source.name} (Copy)`,
      description: source.description,
      backgroundColor: source.backgroundColor,
      textColor: source.textColor,
      luckpermsGroup: null,
    },
  });
}

// ---------------------------------------------------------------------------
// User badge assignment
// ---------------------------------------------------------------------------

/**
 * Get all badges for a user (including badge details).
 */
export async function getBadgesForUser(userId) {
  const rows = await prisma.user_badges.findMany({
    where: { userId },
    include: { badge: true },
    orderBy: { earnedAt: "asc" },
  });
  return rows.map((r) => ({ ...r.badge, earnedAt: r.earnedAt, isManual: r.isManual }));
}

/**
 * Assign a badge to a user manually.
 */
export async function assignBadgeToUser(userId, badgeId) {
  return prisma.user_badges.upsert({
    where: { userId_badgeId: { userId, badgeId } },
    create: { userId, badgeId, isManual: true },
    update: { isManual: true }, // upgrade to manual if it was auto
  });
}

/**
 * Remove a badge from a user (manual operation; respects isManual flag handled at controller level).
 */
export async function removeBadgeFromUser(userId, badgeId) {
  return prisma.user_badges.deleteMany({ where: { userId, badgeId } });
}

/**
 * Sync a badge linked to a LuckPerms group: grant to users who have the group,
 * remove from users who no longer have it (unless isManual=true).
 *
 * @param {number}   badgeId
 * @param {number[]} userIdsWithGroup  – all userId values currently having the LP group
 */
export async function syncLuckpermsBadge(badgeId, userIdsWithGroup) {
  // Grant badge (upsert) for all users who currently have the group
  for (const userId of userIdsWithGroup) {
    await prisma.user_badges.upsert({
      where: { userId_badgeId: { userId, badgeId } },
      create: { userId, badgeId, isManual: false },
      update: {}, // don't overwrite isManual if already set
    });
  }

  // Remove non-manual assignments for users no longer in the group
  await prisma.user_badges.deleteMany({
    where: {
      badgeId,
      isManual: false,
      userId: { notIn: userIdsWithGroup.length > 0 ? userIdsWithGroup : [-1] },
    },
  });
}

/**
 * Get all users that currently hold a given badge (for sync diff).
 */
export async function getUsersWithBadge(badgeId) {
  const rows = await prisma.user_badges.findMany({
    where: { badgeId },
    select: { userId: true, isManual: true },
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateBadgeInput({ name, backgroundColor, textColor }) {
  if (!name || name.trim().length === 0) throw new Error("Badge name is required.");
  if (name.trim().length > 100) throw new Error("Badge name must be 100 characters or fewer.");
  if (!backgroundColor || !/^#[0-9A-Fa-f]{6}$/.test(backgroundColor.trim())) {
    throw new Error("Background colour must be a valid hex colour (e.g. #1a1a2e).");
  }
  if (textColor && !/^#[0-9A-Fa-f]{6}$/.test(textColor.trim())) {
    throw new Error("Text colour must be a valid hex colour (e.g. #ffffff).");
  }
}

function normaliseHex(hex) {
  return hex.trim().toLowerCase();
}
