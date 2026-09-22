/**
 * controllers/siteSettingsController.js
 *
 * Named site-wide settings, one JSON value per key.
 *
 * Exists because eligibility thresholds are policy rather than deployment
 * config: staff change their mind about whether it is 20 hours or 15, and that
 * should not mean editing config.json and redeploying. Anything else that turns
 * out to be staff-tunable can use the same table without a migration.
 *
 * Reads are cached in process. These are read on the public form gate, which
 * is on the path of every applicant, and they change about once a quarter.
 * Every write goes through this module and clears the entry, so the cache
 * cannot go stale from anything this app does -- editing the row directly in
 * the database needs a restart to take effect.
 */

import { prisma } from "./databaseController.js";

/** The site-wide eligibility defaults a form can opt into inheriting. */
export const FORM_REQUIREMENTS_KEY = "forms.defaultRequirements";

const cache = new Map();

/**
 * Read a setting, or `fallback` when it has never been set.
 *
 * A read that throws returns the fallback rather than propagating: a settings
 * lookup failing should not take down the page that wanted it.
 */
export async function getSetting(key, fallback = null) {
  if (cache.has(key)) return cache.get(key);

  try {
    const row = await prisma.siteSettings.findUnique({ where: { settingKey: String(key) } });
    const value = row?.settingValue ?? fallback;
    cache.set(key, value);
    return value;
  } catch (error) {
    console.error(`[settings] Failed to read ${key}:`, error.message);
    return fallback;
  }
}

/** Write a setting. Passing null clears it back to unset. */
export async function setSetting(key, value) {
  const settingKey = String(key);

  await prisma.siteSettings.upsert({
    where: { settingKey },
    create: { settingKey, settingValue: value ?? null },
    update: { settingValue: value ?? null },
  });

  cache.set(settingKey, value ?? null);
  return value ?? null;
}

/** Forget what is cached. For tests, and for a settings edit made elsewhere. */
export function clearSettingsCache(key = null) {
  if (key === null) cache.clear();
  else cache.delete(String(key));
}

/**
 * The site-wide default eligibility requirements.
 *
 * Returns the raw blob; lib/formRequirements.mjs clamps and validates it in
 * the same pass it does for a form's own values, so a nonsense default is no
 * more dangerous than a nonsense per-form one.
 */
export async function getDefaultFormRequirements() {
  return getSetting(FORM_REQUIREMENTS_KEY, null);
}

export async function setDefaultFormRequirements(requirements) {
  return setSetting(FORM_REQUIREMENTS_KEY, requirements);
}
