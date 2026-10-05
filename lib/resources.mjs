/**
 * lib/resources.mjs
 *
 * Rules for community resources (/resources): what a valid submission or
 * category is, and how the staff vote is counted. No DB or Discord imports,
 * so it is unit-testable. Storage: controllers/resourceController.js;
 * the review flow: services/resourceReviewService.js.
 *
 * The vote
 * --------
 * The electorate is everyone currently holding REVIEW_PERMISSION (resolved
 * from LuckPerms). A submission is approved once MORE THAN HALF of them
 * approve, or rejected once more than half reject. Only votes from current
 * holders count, so someone losing the permission loses their vote too.
 * A submission still undecided at its deadline stays pending and is shown
 * as overdue; staff holding MANAGE_PERMISSION can then decide it by hand.
 */

export const REVIEW_PERMISSION = "zander.web.resources.review";
export const MANAGE_PERMISSION = "zander.web.resources";

export const RESOURCE_STATUSES = ["pending", "approved", "rejected"];
export const VOTES = ["approve", "reject"];

export const RESOURCE_LIMITS = { title: 100, description: 500, url: 500 };
export const CATEGORY_LIMITS = { name: 80, slug: 64, description: 500 };

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True for an absolute http(s) URL -- never javascript:, data: or relative. */
export function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value ?? "").trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** Compare URLs loosely so the same link is not submitted twice. */
export function normaliseUrlForMatch(value) {
  try {
    const parsed = new URL(String(value ?? "").trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${path}${parsed.search}`.toLowerCase();
  } catch {
    return String(value ?? "").trim().toLowerCase();
  }
}

/**
 * Validate a resource (a submission, or a staff edit).
 *
 * @param {object} input  { categoryId, title, description, url }
 * @param {number[]} categoryIds  Categories that exist.
 * @returns {{ ok: true, value: { categoryId, title, description, url } } | { ok: false, errors: string[] }}
 */
export function parseResource(input, categoryIds = []) {
  const errors = [];
  const value = {
    categoryId: Number(input?.categoryId),
    title: String(input?.title ?? "").trim(),
    description: String(input?.description ?? "").trim(),
    url: String(input?.url ?? "").trim(),
  };

  if (!categoryIds.includes(value.categoryId)) errors.push("Choose a category.");
  for (const [key, max] of Object.entries(RESOURCE_LIMITS)) {
    if (!value[key]) errors.push(`The ${key} is required.`);
    else if (value[key].length > max) errors.push(`The ${key} must be ${max} characters or fewer.`);
  }
  if (value.url && !isHttpUrl(value.url)) errors.push("The URL must start with http:// or https://.");

  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/** Validate a category form. */
export function parseCategory(input) {
  const errors = [];
  const name = String(input?.name ?? "").trim();
  const slug = (String(input?.slug ?? "").trim().toLowerCase() || name.toLowerCase())
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CATEGORY_LIMITS.slug);
  const description = String(input?.description ?? "").trim();
  const sortOrder = Number.parseInt(input?.sortOrder ?? 0, 10);

  if (!name) errors.push("A name is required.");
  else if (name.length > CATEGORY_LIMITS.name) errors.push(`The name must be ${CATEGORY_LIMITS.name} characters or fewer.`);
  if (!slug || !SLUG_PATTERN.test(slug)) errors.push("The slug may only use lowercase letters, numbers and hyphens.");
  if (description.length > CATEGORY_LIMITS.description) {
    errors.push(`The description must be ${CATEGORY_LIMITS.description} characters or fewer.`);
  }

  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: { name, slug, description: description || null, sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0 } };
}

/** Votes needed for a majority of `eligible` reviewers. */
export function majorityOf(eligible) {
  return Math.floor(Math.max(0, eligible) / 2) + 1;
}

/**
 * Count the votes that matter.
 *
 * @param {Array<{ userId: number, vote: string }>} votes
 * @param {Set<number>} reviewerIds  Site userIds currently holding REVIEW_PERMISSION.
 */
export function tallyVotes(votes, reviewerIds) {
  let approve = 0;
  let reject = 0;
  for (const { userId, vote } of votes || []) {
    if (!reviewerIds.has(Number(userId))) continue;
    if (vote === "approve") approve++;
    else if (vote === "reject") reject++;
  }
  const eligible = reviewerIds.size;
  return { approve, reject, eligible, needed: majorityOf(eligible) };
}

/**
 * The outcome a tally has reached, or null while it is undecided. With no
 * reviewers at all nothing can pass, so it stays pending for a manual call.
 */
export function decideOutcome({ approve, reject, eligible }) {
  if (!eligible) return null;
  const needed = majorityOf(eligible);
  if (approve >= needed) return "approved";
  if (reject >= needed) return "rejected";
  return null;
}

export function isOverdue(resource, now = new Date()) {
  return resource?.status === "pending" && Boolean(resource.deadlineAt) && new Date(resource.deadlineAt) <= now;
}

/** The deadline for a submission made at `from`. */
export function deadlineFrom(from, windowDays) {
  const days = Number.isFinite(Number(windowDays)) && Number(windowDays) > 0 ? Number(windowDays) : 7;
  return new Date(new Date(from).getTime() + days * 24 * 60 * 60 * 1000);
}
