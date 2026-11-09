/**
 * services/announcementPostService.js
 *
 * Post-level orchestration for announcements. A "post" (announcement_posts) is
 * one logical announcement that publishes to one or more platforms; each target
 * platform is a row in `announcements` carrying that platform's delivery fields.
 *
 * Platforms: web (site banner), popup (site popup), tip (in-game tip), motd
 * (server-list MOTD) and hologram (in-game hologram frame). Hologram text lives
 * in colourMessageFormat; body holds a colour-code-stripped plain-text copy.
 *
 * Writes use Prisma (new code) and run add/update/remove of a post's platform
 * rows inside a single transaction. Every write busts the web-announcement cache.
 */
import { prisma, withDeadlockRetry } from "../controllers/databaseController.js";
import { isAllowedUrl } from "../lib/navigation/menus.mjs";
import {
  invalidateWebAnnouncementCache,
  normaliseGroup,
  cleanHologramText,
  normaliseDate,
  stripColourCodes,
} from "../controllers/announcementController.js";

export const PLATFORMS = ["web", "popup", "tip", "motd", "hologram"];
export const COLOUR_PLATFORMS = ["tip", "motd", "hologram"]; // use colourMessageFormat

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate one resolved platform row. Returns an array of human-readable error
 * strings (empty when valid). Prefixes each message with the platform so the
 * wizard/MCP can show which tab is at fault.
 */
export function validatePlatform(platform, row = {}) {
  const errors = [];
  const label = platform.toUpperCase();

  if (!PLATFORMS.includes(platform)) {
    errors.push(`Unknown platform "${platform}".`);
    return errors;
  }

  if (row.link && !isAllowedUrl(row.link)) {
    errors.push(`${label}: link must start with /, https://, http:// or mailto:.`);
  }

  if (platform === "motd") {
    const text = String(row.colourMessageFormat ?? row.body ?? "");
    if (text.split(/\r\n|\r|\n/).length > 2) {
      errors.push(`${label}: a server-list MOTD is two lines at most.`);
    }
  }

  if (platform === "popup") {
    if (row.popupButtonText && String(row.popupButtonText).length > 60) {
      errors.push(`${label}: button text is 60 characters at most.`);
    }
  }

  if (platform === "hologram") {
    if (!String(row.colourMessageFormat ?? "").trim()) {
      errors.push(`${label}: a hologram needs message text.`);
    }
    if (
      row.countdownTo !== null &&
      row.countdownTo !== undefined &&
      row.countdownTo !== "" &&
      normaliseDate(row.countdownTo) === null
    ) {
      errors.push(`${label}: the countdown target is not a valid date.`);
    }
  }

  // Non-hologram platforms need some message content.
  if (platform !== "hologram") {
    const hasText = String(row.body ?? "").trim() || String(row.colourMessageFormat ?? "").trim();
    if (!hasText) errors.push(`${label}: a message is required.`);
  }

  const start = normaliseDate(row.startDate);
  const end = normaliseDate(row.endDate);
  if (start && end && end.getTime() < start.getTime()) {
    errors.push(`${label}: the end time must be after the start time.`);
  }

  return errors;
}

/** Validate a whole post (all its platform rows). Returns an array of errors. */
export function validatePost({ platforms = [] } = {}) {
  const errors = [];
  if (!Array.isArray(platforms) || platforms.length === 0) {
    errors.push("Choose at least one platform to publish to.");
    return errors;
  }
  const seen = new Set();
  for (const p of platforms) {
    if (seen.has(p.platform)) errors.push(`Platform "${p.platform}" is listed twice.`);
    seen.add(p.platform);
    errors.push(...validatePlatform(p.platform, p));
  }
  return errors;
}

class AnnouncementValidationError extends Error {
  constructor(errors) {
    super(errors.join(" "));
    this.name = "AnnouncementValidationError";
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

/**
 * Merge shared defaults (from the wizard's message/schedule steps) into a
 * per-platform override. A field set on the platform wins; otherwise the shared
 * value is used.
 */
function resolveRow(shared, platform) {
  const pick = (key) => (platform[key] !== undefined ? platform[key] : shared[key]);
  return {
    platform: platform.platform,
    enabled: platform.enabled !== undefined ? platform.enabled : (shared.enabled !== undefined ? shared.enabled : true),
    body: pick("body") ?? null,
    colourMessageFormat: pick("colourMessageFormat") ?? null,
    link: pick("link") ?? null,
    popupButtonText: platform.popupButtonText ?? null,
    popupImageUrl: platform.popupImageUrl ?? null,
    hologramGroup: platform.hologramGroup ?? null,
    sortOrder: platform.sortOrder,
    countdownTo: platform.countdownTo ?? null,
    countdownFinishedText: platform.countdownFinishedText ?? null,
    startDate: pick("startDate") ?? null,
    endDate: pick("endDate") ?? null,
  };
}

/**
 * Build the Prisma `data` object for one platform's announcements row (minus
 * postId). Normalises per-platform fields and strips hologram colour codes for
 * the plain-text body copy.
 */
function buildRow(resolved, now) {
  const platform = resolved.platform;
  const data = {
    announcementType: platform,
    enabled: !!resolved.enabled,
    body: resolved.body ? String(resolved.body) : null,
    colourMessageFormat: null,
    link: resolved.link ? String(resolved.link) : null,
    popupButtonText: null,
    popupImageUrl: null,
    hologramGroup: null,
    sortOrder: null,
    countdownTo: null,
    countdownFinishedText: null,
    startDate: normaliseDate(resolved.startDate),
    endDate: normaliseDate(resolved.endDate),
    updatedDate: now,
  };

  if (COLOUR_PLATFORMS.includes(platform)) {
    data.colourMessageFormat = cleanHologramText(resolved.colourMessageFormat ?? resolved.body ?? "") || null;
  }

  if (platform === "popup") {
    data.popupButtonText = resolved.popupButtonText ? String(resolved.popupButtonText).slice(0, 60) : null;
    data.popupImageUrl = resolved.popupImageUrl ? String(resolved.popupImageUrl) : null;
  }

  if (platform === "hologram") {
    data.hologramGroup = normaliseGroup(resolved.hologramGroup);
    data.sortOrder = Number.isFinite(Number(resolved.sortOrder)) ? Number(resolved.sortOrder) : 0;
    data.body = stripColourCodes(data.colourMessageFormat) || null; // plain copy for lists
    const countdownTo = normaliseDate(resolved.countdownTo);
    data.countdownTo = countdownTo;
    data.countdownFinishedText = countdownTo
      ? (resolved.countdownFinishedText ? cleanHologramText(resolved.countdownFinishedText).slice(0, 512) : null)
      : null;
  }

  return data;
}

function deriveTitle(title, shared, resolvedRows) {
  const explicit = title && String(title).trim();
  if (explicit) return String(title).slice(0, 120);
  const sharedBody = shared.body && String(shared.body).trim();
  if (sharedBody) return String(shared.body).slice(0, 120);
  for (const r of resolvedRows) {
    const text = (r.body && String(r.body).trim()) || stripColourCodes(r.colourMessageFormat || "").trim();
    if (text) return text.slice(0, 120);
  }
  return "Announcement";
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Create a post and its platform rows in one transaction.
 * @param {{ title?: string, shared?: object, platforms?: object[], createdBy?: number }} input
 * @returns {Promise<number>} the new postId
 */
export async function createPost({ title, shared = {}, platforms = [], createdBy = null } = {}) {
  const resolved = platforms.map((p) => resolveRow(shared, p));
  const errors = validatePost({ platforms: resolved });
  if (errors.length) throw new AnnouncementValidationError(errors);

  const now = new Date();
  const postTitle = deriveTitle(title, shared, resolved);

  const postId = await withDeadlockRetry(
    () =>
      prisma.$transaction(async (tx) => {
        const post = await tx.announcement_posts.create({
          data: { title: postTitle, createdBy: createdBy ?? null, createdAt: now, updatedAt: now },
        });
        for (const r of resolved) {
          await tx.announcements.create({ data: { postId: post.postId, createdAt: now, ...buildRow(r, now) } });
        }
        return post.postId;
      }),
    { label: "announcement createPost" }
  );

  invalidateWebAnnouncementCache();
  return postId;
}

/**
 * Replace a post's platform rows: add new platforms, update kept ones in place
 * (preserving announcementId, and hologram sortOrder unless overridden), and
 * remove deselected platforms. All in one transaction.
 */
export async function updatePost(postId, { title, shared = {}, platforms = [], updatedBy = null } = {}) {
  const resolved = platforms.map((p) => resolveRow(shared, p));
  const errors = validatePost({ platforms: resolved });
  if (errors.length) throw new AnnouncementValidationError(errors);

  const now = new Date();

  await withDeadlockRetry(
    () =>
      prisma.$transaction(async (tx) => {
        const existing = await tx.announcements.findMany({ where: { postId: Number(postId) } });
        const byType = new Map(existing.map((r) => [r.announcementType, r]));
        const keep = new Set();

        const postTitle = deriveTitle(title, shared, resolved);
        await tx.announcement_posts.update({
          where: { postId: Number(postId) },
          data: { title: postTitle, updatedAt: now, ...(updatedBy != null ? { createdBy: undefined } : {}) },
        });

        for (const r of resolved) {
          keep.add(r.platform);
          const data = buildRow(r, now);
          const ex = byType.get(r.platform);
          // Preserve an existing hologram's sort order when the caller did not set one.
          if (r.platform === "hologram" && ex && (r.sortOrder === undefined || r.sortOrder === null)) {
            data.sortOrder = ex.sortOrder ?? 0;
          }
          if (ex) {
            await tx.announcements.update({ where: { announcementId: ex.announcementId }, data });
          } else {
            await tx.announcements.create({ data: { postId: Number(postId), createdAt: now, ...data } });
          }
        }

        const remove = existing.filter((r) => !keep.has(r.announcementType)).map((r) => r.announcementId);
        if (remove.length) {
          await tx.announcements.deleteMany({ where: { announcementId: { in: remove } } });
        }
      }),
    { label: "announcement updatePost" }
  );

  invalidateWebAnnouncementCache();
}

/** Delete a post and (via cascade) all its platform rows. */
export async function deletePost(postId) {
  await prisma.announcement_posts.delete({ where: { postId: Number(postId) } });
  invalidateWebAnnouncementCache();
}

/** Enable or disable every platform row of a post. */
export async function setPostEnabled(postId, enabled) {
  await prisma.announcements.updateMany({
    where: { postId: Number(postId) },
    data: { enabled: !!enabled, updatedDate: new Date() },
  });
  invalidateWebAnnouncementCache();
}

/** One post with its platform rows, or null. */
export async function getPost(postId) {
  const post = await prisma.announcement_posts.findUnique({
    where: { postId: Number(postId) },
    include: { announcements: true },
  });
  if (!post) return null;
  const { announcements, ...rest } = post;
  return { ...rest, platforms: announcements };
}

// ---------------------------------------------------------------------------
// Listing + status
// ---------------------------------------------------------------------------

/**
 * Derive a single status for a post from its platform rows, relative to `now`:
 *   ended     - every row's endDate is in the past
 *   disabled  - no row is enabled (and not all ended)
 *   scheduled - every enabled row's startDate is still in the future
 *   active    - at least one enabled row is inside its window right now
 */
export function derivePostStatus(rows, now = new Date()) {
  if (!rows.length) return "disabled";
  const t = now.getTime();
  const allEnded = rows.every((r) => r.endDate && new Date(r.endDate).getTime() < t);
  if (allEnded) return "ended";
  const enabledRows = rows.filter((r) => r.enabled);
  if (enabledRows.length === 0) return "disabled";
  const allScheduled = enabledRows.every((r) => r.startDate && new Date(r.startDate).getTime() > t);
  if (allScheduled) return "scheduled";
  return "active";
}

/**
 * List posts, newest first, each with its platform rows and a derived status.
 * Optional filters:
 *   platform - only posts that publish to this platform
 *   status   - active | scheduled | ended | disabled
 *   group    - only posts with a hologram row in this group
 */
export async function listPosts({ platform, status, group } = {}) {
  const posts = await prisma.announcement_posts.findMany({
    include: { announcements: true },
    orderBy: { createdAt: "desc" },
  });
  const now = new Date();

  let result = posts.map((p) => {
    const { announcements, ...rest } = p;
    return { ...rest, platforms: announcements, status: derivePostStatus(announcements, now) };
  });

  if (platform) {
    result = result.filter((p) => p.platforms.some((r) => r.announcementType === platform));
  }
  if (group) {
    const g = normaliseGroup(group);
    result = result.filter((p) =>
      p.platforms.some((r) => r.announcementType === "hologram" && r.hologramGroup === g)
    );
  }
  if (status) {
    result = result.filter((p) => p.status === status);
  }

  return result;
}
