/**
 * controllers/resourceController.js
 *
 * Data access for community resources: categories, resources (submissions
 * and published links) and staff votes. The rules live in lib/resources.mjs;
 * the review flow (posting to Discord, deciding, notifying) is in
 * services/resourceReviewService.js.
 */

import { prisma, luckpermsDb } from "./databaseController.js";
import {
  findGrantingGroups,
  findPermissionHolders,
  grantingNodes,
  normaliseUuid,
} from "../lib/permissions/permissionHolders.mjs";
import { REVIEW_PERMISSION, normaliseUrlForMatch } from "../lib/resources.mjs";

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export function listCategories() {
  return prisma.resourceCategories.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

export function getCategoryById(categoryId) {
  return prisma.resourceCategories.findUnique({ where: { categoryId: Number(categoryId) } });
}

export async function isCategorySlugTaken(slug, exceptCategoryId = null) {
  const existing = await prisma.resourceCategories.findUnique({ where: { slug }, select: { categoryId: true } });
  return Boolean(existing && existing.categoryId !== Number(exceptCategoryId));
}

export function createCategory(value) {
  return prisma.resourceCategories.create({ data: value });
}

export function updateCategory(categoryId, value) {
  return prisma.resourceCategories.update({ where: { categoryId: Number(categoryId) }, data: value });
}

/** Delete a category; refuses while any resource still uses it. */
export async function deleteCategory(categoryId) {
  const inUse = await prisma.resources.count({ where: { categoryId: Number(categoryId) } });
  if (inUse) return { ok: false, inUse };
  await prisma.resourceCategories.delete({ where: { categoryId: Number(categoryId) } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/** Published resources grouped under their categories, for /resources. */
export async function getPublishedByCategory() {
  const categories = await prisma.resourceCategories.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: {
      resources: {
        where: { status: "approved" },
        orderBy: { title: "asc" },
        select: {
          resourceId: true,
          title: true,
          description: true,
          url: true,
          source: true,
          submittedByName: true,
          decidedAt: true,
          createdAt: true,
        },
      },
    },
  });
  return categories.filter((c) => c.resources.length);
}

export function listResources(status) {
  return prisma.resources.findMany({
    where: { status },
    include: { category: { select: { name: true } }, votes: true },
    orderBy: status === "pending" ? { deadlineAt: "asc" } : { decidedAt: "desc" },
    take: status === "pending" ? undefined : 200,
  });
}

export function listPendingResources() {
  return prisma.resources.findMany({ where: { status: "pending" }, include: { votes: true, category: true } });
}

export function getResourceById(resourceId) {
  return prisma.resources.findUnique({
    where: { resourceId: Number(resourceId) },
    include: { category: true, votes: true },
  });
}

/** A pending or published resource with the same link, if any. */
export async function findDuplicate(url) {
  const target = normaliseUrlForMatch(url);
  const candidates = await prisma.resources.findMany({
    where: { status: { in: ["pending", "approved"] } },
    select: { resourceId: true, url: true, status: true, title: true },
  });
  return candidates.find((r) => normaliseUrlForMatch(r.url) === target) || null;
}

export function createResource(data) {
  return prisma.resources.create({ data, include: { category: true, votes: true } });
}

export function updateResource(resourceId, data) {
  return prisma.resources.update({
    where: { resourceId: Number(resourceId) },
    data,
    include: { category: true, votes: true },
  });
}

export function deleteResource(resourceId) {
  return prisma.resources.delete({ where: { resourceId: Number(resourceId) } });
}

/**
 * Settle a pending resource exactly once. Returns the updated row, or null
 * when it had already been decided (e.g. two votes landing together).
 */
export async function markDecided(resourceId, { status, method, decidedByUserId = null }) {
  const result = await prisma.resources.updateMany({
    where: { resourceId: Number(resourceId), status: "pending" },
    data: { status, decisionMethod: method, decidedByUserId, decidedAt: new Date() },
  });
  return result.count ? getResourceById(resourceId) : null;
}

export function upsertVote(resourceId, userId, vote) {
  return prisma.resourceVotes.upsert({
    where: { resourceId_userId: { resourceId: Number(resourceId), userId: Number(userId) } },
    create: { resourceId: Number(resourceId), userId: Number(userId), vote },
    update: { vote },
  });
}

// ---------------------------------------------------------------------------
// Reviewers: who currently holds zander.web.resources.review
// ---------------------------------------------------------------------------

const REVIEWER_CACHE_MS = 5 * 60 * 1000;
let reviewerCache = { ids: null, at: 0 };

function lp(query, params = []) {
  return new Promise((resolve, reject) => {
    luckpermsDb.query(query, params, (error, rows) => (error ? reject(error) : resolve(rows || [])));
  });
}

const ACTIVE = "value = 1 AND (expiry IS NULL OR expiry = 0 OR expiry > UNIX_TIMESTAMP())";

async function loadReviewerIds() {
  const groupPermissions = await lp(`SELECT name, permission FROM luckperms_group_permissions WHERE ${ACTIVE}`);
  const granting = [...findGrantingGroups(REVIEW_PERMISSION, groupPermissions)];

  const nodes = grantingNodes(REVIEW_PERMISSION);
  const membership = granting.map((g) => `group.${g}`);
  const wanted = [...nodes, ...membership];
  const userPermissions = await lp(
    `SELECT uuid, permission FROM luckperms_user_permissions WHERE ${ACTIVE} AND LOWER(permission) IN (${wanted.map(() => "?").join(", ")})`,
    wanted
  );

  // A primary group only counts for someone with no group.* rows at all
  // (as in getUserPermissions), so drop candidates that have any.
  let primaryGroups = [];
  if (granting.length) {
    const candidates = await lp(
      `SELECT uuid, primary_group FROM luckperms_players WHERE LOWER(primary_group) IN (${granting.map(() => "?").join(", ")})`,
      granting
    );
    if (candidates.length) {
      const withGroups = await lp(
        `SELECT DISTINCT uuid FROM luckperms_user_permissions
          WHERE ${ACTIVE} AND permission LIKE 'group.%' AND uuid IN (${candidates.map(() => "?").join(", ")})`,
        candidates.map((c) => c.uuid)
      );
      const skip = new Set(withGroups.map((r) => normaliseUuid(r.uuid)));
      primaryGroups = candidates.filter((c) => !skip.has(normaliseUuid(c.uuid)));
    }
  }

  const holders = findPermissionHolders(REVIEW_PERMISSION, { groupPermissions, userPermissions, primaryGroups });
  if (!holders.size) return new Set();

  // Only people with a site account can vote, so only they count.
  // users.uuid may be stored with or without dashes, so ask for both.
  const dashed = (h) => (h.length === 32 ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : h);
  const users = await prisma.users.findMany({
    where: { uuid: { in: [...holders].flatMap((h) => [h, dashed(h)]) } },
    select: { userId: true, uuid: true },
  });
  return new Set(users.filter((u) => holders.has(normaliseUuid(u.uuid))).map((u) => u.userId));
}

/**
 * Site userIds of everyone who can currently review resources. Cached
 * briefly; a failed lookup serves the last good set rather than none, since
 * an empty electorate would stall every vote.
 */
export async function getReviewerIds({ fresh = false } = {}) {
  if (!fresh && reviewerCache.ids && Date.now() - reviewerCache.at < REVIEWER_CACHE_MS) return reviewerCache.ids;
  try {
    reviewerCache = { ids: await loadReviewerIds(), at: Date.now() };
  } catch (error) {
    console.error("[resources] Could not work out who can review resources:", error.message);
    if (!reviewerCache.ids) throw error;
  }
  return reviewerCache.ids;
}
