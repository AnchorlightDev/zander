/**
 * controllers/configSettingsController.js
 *
 * Dashboard-editable overrides for config.json (see
 * lib/config/settingsRegistry.mjs for which fields and why).
 *
 * How the overlay reaches every module
 * ------------------------------------
 * Every module loads config with `createRequire(...)("../config.json")`, and
 * Node caches that by resolved path -- they all hold the SAME object. So
 * applying an override here is just writing into that object, and every
 * module that reads `config.x.y` at use time sees it immediately. The few
 * that copy a value at startup are marked `restart: true` in the registry.
 *
 * Multiple instances
 * ------------------
 * Production runs several replicas. A save applies instantly on the instance
 * that handled it; the others notice within SYNC_INTERVAL_MS by polling the
 * newest `config:%` row timestamp, then reload. Resets are stored as NULL
 * rather than deleted so they bump that timestamp too.
 */

import { createRequire } from "module";
import { Prisma } from "@prisma/client";
import { prisma } from "./databaseController.js";
import { getRegion } from "../lib/region.mjs";
import {
  ALL_FIELDS,
  SETTING_KEY_PREFIX,
  applyOverrides,
  findSection,
  getPath,
  planSectionWrites,
  settingKeyFor,
} from "../lib/config/settingsRegistry.mjs";

const require = createRequire(import.meta.url);
const config = require("../config.json");

const SYNC_INTERVAL_MS = 60_000;

/** config.json as it was before any override -- what "reset" returns to. */
let baseline = null;
let lastSeenUpdate = null;
let syncTimer = null;

function captureBaseline() {
  if (!baseline) baseline = structuredClone(config);
}

async function loadOverrides() {
  const rows = await prisma.siteSettings.findMany({
    where: { settingKey: { startsWith: SETTING_KEY_PREFIX } },
  });
  const overrides = new Map();
  let newest = null;
  for (const row of rows) {
    overrides.set(row.settingKey.slice(SETTING_KEY_PREFIX.length), row.settingValue);
    if (!newest || row.updatedAt > newest) newest = row.updatedAt;
  }
  return { overrides, newest };
}

function overlay(overrides) {
  applyOverrides(config, baseline, overrides);
  // Region carries derived fields (htmlLang, locale); recompute them in place
  // so references held by templates stay valid.
  config.siteConfiguration = config.siteConfiguration || {};
  const region = getRegion(config);
  if (config.siteConfiguration.region && typeof config.siteConfiguration.region === "object") {
    Object.assign(config.siteConfiguration.region, region);
  } else {
    config.siteConfiguration.region = region;
  }
}

/**
 * Apply stored overrides to the shared config. Called once at boot, before
 * the Discord client and cron jobs load. A database failure leaves config.json
 * values in place rather than blocking startup.
 */
export async function applyConfigOverrides() {
  captureBaseline();
  try {
    const { overrides, newest } = await loadOverrides();
    overlay(overrides);
    lastSeenUpdate = newest;
    if (overrides.size) console.log(`[settings] Applied ${overrides.size} dashboard config override(s).`);
  } catch (error) {
    console.error("[settings] Could not load dashboard config overrides; using config.json only:", error.message);
  }
}

/** Poll for saves made on other instances. */
export function startConfigSync() {
  if (syncTimer) return;
  syncTimer = setInterval(async () => {
    try {
      const latest = await prisma.siteSettings.aggregate({
        where: { settingKey: { startsWith: SETTING_KEY_PREFIX } },
        _max: { updatedAt: true },
      });
      const newest = latest._max.updatedAt;
      if (newest && (!lastSeenUpdate || newest > lastSeenUpdate)) {
        const { overrides, newest: reloadedNewest } = await loadOverrides();
        overlay(overrides);
        lastSeenUpdate = reloadedNewest;
        console.log("[settings] Reloaded dashboard config overrides from another instance.");
      }
    } catch (error) {
      console.error("[settings] Config sync failed:", error.message);
    }
  }, SYNC_INTERVAL_MS);
  if (syncTimer.unref) syncTimer.unref();
}

/**
 * Everything the settings page needs for one field: the live value, the
 * config.json value, and whether the dashboard is overriding it.
 */
export async function describeSettings() {
  captureBaseline();
  const { overrides } = await loadOverrides();
  const byPath = {};
  for (const field of ALL_FIELDS) {
    const override = overrides.get(field.path);
    byPath[field.path] = {
      value: getPath(config, field.path),
      fileValue: getPath(baseline, field.path),
      overridden: override !== undefined && override !== null,
    };
  }
  return byPath;
}

/**
 * Save one section of the settings page.
 *
 * @param {string} sectionKey
 * @param {object} body     Submitted form fields, keyed by field path.
 * @param {string[]} resets Paths ticked "reset to config.json".
 * @returns {Promise<{ saved: number, errors: string[] }>}
 */
export async function saveSection(sectionKey, body, resets = []) {
  captureBaseline();
  const section = findSection(sectionKey);
  if (!section) return { saved: 0, errors: ["Unknown settings section."] };

  const { writes, errors } = planSectionWrites(section, body, resets, baseline);
  if (errors.length) return { saved: 0, errors };

  await prisma.$transaction(
    writes.map(({ path, value }) =>
      prisma.siteSettings.upsert({
        where: { settingKey: settingKeyFor(path) },
        create: { settingKey: settingKeyFor(path), settingValue: value ?? Prisma.DbNull },
        update: { settingValue: value ?? Prisma.DbNull },
      })
    )
  );

  const { overrides, newest } = await loadOverrides();
  overlay(overrides);
  lastSeenUpdate = newest;

  return { saved: writes.length, errors: [] };
}
