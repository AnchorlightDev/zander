/**
 * lib/oidc/staffGroups.mjs
 *
 * The list of LuckPerms group slugs allowed to obtain a Compass token.
 *
 * Source of truth is Compass's own Admin → Access & admins → "Who can sign in"
 * page. Compass pushes that list here (PUT /api/compass/staff-groups) whenever
 * it is saved, and on Compass boot. It is stored in siteSettings under
 * MANAGED_KEY so every Zander instance sees it and it survives restarts.
 *
 * If Compass has never sent a list (or sent "nothing ticked" → null), Zander
 * falls back to config.compass.staffGroups (lib/config/defaults.cjs).
 *
 * Reads are cached briefly; a failed database read keeps the last known list
 * rather than falling back to the default, so a DB blip can't silently widen
 * or narrow who gets in.
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const config = require("../config/config.cjs");

export const MANAGED_KEY = "compass:staffGroups";
const TTL_MS = 30_000;
const SLUG = /^[a-z0-9_.-]{1,64}$/;

let managed = null; // { groups: string[], updatedBy, updatedAt } | null
let loadedAt = 0;
let everLoaded = false;

let _prisma = null;
async function prisma() {
  if (!_prisma) _prisma = (await import("../../controllers/databaseController.js")).prisma;
  return _prisma;
}

/**
 * Normalise a submitted list. Returns a de-duplicated lowercase array, or null
 * if anything in it isn't a valid group slug.
 */
export function cleanStaffGroups(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const raw of input) {
    const slug = String(raw ?? "").trim().toLowerCase();
    if (!slug) continue;
    if (!SLUG.test(slug)) return null;
    if (!out.includes(slug)) out.push(slug);
  }
  return out.length > 200 ? null : out;
}

/** Pick the effective list from a stored value and the config default. */
export function resolveStaffGroups(stored, fallback) {
  if (stored && Array.isArray(stored.groups) && stored.groups.length) {
    return { groups: [...stored.groups], source: "compass", updatedBy: stored.updatedBy || null, updatedAt: stored.updatedAt || null };
  }
  return { groups: Array.isArray(fallback) ? [...fallback] : [], source: "zander", updatedBy: null, updatedAt: null };
}

async function refresh(force = false) {
  if (!force && everLoaded && Date.now() - loadedAt < TTL_MS) return;
  try {
    const db = await prisma();
    const row = await db.siteSettings.findUnique({ where: { settingKey: MANAGED_KEY } });
    const value = row?.settingValue;
    managed = value && typeof value === "object" && Array.isArray(value.groups) ? value : null;
    everLoaded = true;
    loadedAt = Date.now();
  } catch (error) {
    // Keep the last known list; retry on the next call.
    console.error("[compass] couldn't read the Compass staff rank list:", error.message);
  }
}

/** Effective staff group slugs, with where they came from. */
export async function describeStaffGroups() {
  await refresh();
  return resolveStaffGroups(managed, config?.compass?.staffGroups);
}

/** Effective staff group slugs. */
export async function getStaffGroups() {
  return (await describeStaffGroups()).groups;
}

/**
 * Store the list Compass sent. `groups` empty or null clears it, so Zander's
 * own default applies again.
 */
export async function setManagedStaffGroups(groups, { updatedBy = null } = {}) {
  const db = await prisma();
  const { Prisma } = await import("@prisma/client");
  const value = groups && groups.length
    ? { groups, updatedBy: updatedBy ? String(updatedBy).slice(0, 80) : null, updatedAt: new Date().toISOString() }
    : null;
  await db.siteSettings.upsert({
    where: { settingKey: MANAGED_KEY },
    create: { settingKey: MANAGED_KEY, settingValue: value ?? Prisma.DbNull },
    update: { settingValue: value ?? Prisma.DbNull },
  });
  await refresh(true);
  return describeStaffGroups();
}
