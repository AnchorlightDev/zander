/**
 * controllers/configSettingsController.js
 *
 * Site settings and module switches, stored in the database. There is no
 * config.json or features.json: /dashboard/settings and /dashboard/modules
 * are the only place these are changed.
 *
 * Layers, lowest first
 * --------------------
 *   1. Built-in defaults (lib/config/defaults.cjs).
 *   2. The install's base: a legacy config.json / features.json imported once
 *      into siteSettings as `legacy.config` / `legacy.features` (see below).
 *      Merged over the defaults, so keys a newer release added still get
 *      their default when an old file lacked them.
 *   3. Per-field edits from the dashboard: `config:<path>` / `feature:<path>`.
 * "Reset" on a field returns it to layer 2 (or 1 if there was no file).
 *
 * One-time import
 * ---------------
 * On the first boot that finds no `legacy.*` row, a config.json or
 * features.json on disk (e.g. a Render secret file) is copied into the
 * database. From then on the files are never read and can be deleted.
 *
 * How the values reach every module
 * ---------------------------------
 * Every module loads `lib/config/config.cjs` / `features.cjs`, which Node
 * caches -- they all hold the SAME two objects. Loading settings writes into
 * those objects in place, so every module reading `config.x.y` at use time
 * sees the change. The few that copy a value at import are marked
 * `restart: true` in the settings registry.
 *
 * Multiple instances
 * ------------------
 * A save applies instantly on the instance that handled it; the others notice
 * within SYNC_INTERVAL_MS by polling the newest `config:%`/`feature:%` row
 * timestamp. Resets are stored as NULL rather than deleted so they bump it.
 */

import { createRequire } from "module";
import { existsSync, readFileSync } from "fs";
import path from "path";
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
  setPath,
  settingKeyFor,
} from "../lib/config/settingsRegistry.mjs";
import { LOCKED_FLAGS, describeFlags, listFlagPaths, planFlagWrites } from "../lib/config/featureRegistry.mjs";

const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");
const features = require("../lib/config/features.cjs");
const { DEFAULT_CONFIG, DEFAULT_FEATURES, mergeDeep, assignInPlace } = require("../lib/config/defaults.cjs");

/** Feature flag overrides (/dashboard/modules) live alongside config ones. */
const FEATURE_KEY_PREFIX = "feature:";
const LEGACY_CONFIG_KEY = "legacy.config";
const LEGACY_FEATURES_KEY = "legacy.features";

const SYNC_INTERVAL_MS = 60_000;

/** Defaults + imported legacy file: what "reset" returns a field to. */
let baseline = structuredClone(DEFAULT_CONFIG);
let featureBaseline = structuredClone(DEFAULT_FEATURES);
/** False until the base layer has been read from the database. */
let baseLoaded = false;
let lastSeenUpdate = null;
let syncTimer = null;

/** A legacy settings file from the working directory, or null. */
function readLegacyFile(name) {
  const file = path.join(process.cwd(), name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`[settings] Ignoring unreadable ${name}:`, error.message);
    return null;
  }
}

/**
 * The imported base for one store: the database row if there is one,
 * otherwise the legacy file -- which is then saved so it is never needed
 * again.
 */
async function loadBase(key, fileName) {
  const row = await prisma.siteSettings.findUnique({ where: { settingKey: key } });
  if (row && row.settingValue && typeof row.settingValue === "object") return row.settingValue;

  const legacy = readLegacyFile(fileName);
  if (!legacy) return {};

  await prisma.siteSettings.upsert({
    where: { settingKey: key },
    create: { settingKey: key, settingValue: legacy },
    update: { settingValue: legacy },
  });
  console.log(`[settings] Imported ${fileName} into the database. It is no longer read and can be deleted.`);
  return legacy;
}

async function loadBaseLayers() {
  const [legacyConfig, legacyFeatures] = await Promise.all([
    loadBase(LEGACY_CONFIG_KEY, "config.json"),
    loadBase(LEGACY_FEATURES_KEY, "features.json"),
  ]);
  baseline = mergeDeep(DEFAULT_CONFIG, legacyConfig);
  featureBaseline = mergeDeep(DEFAULT_FEATURES, legacyFeatures);
  baseLoaded = true;
}

async function loadOverrides(prefix = SETTING_KEY_PREFIX) {
  const rows = await prisma.siteSettings.findMany({
    where: { settingKey: { startsWith: prefix } },
  });
  const overrides = new Map();
  let newest = null;
  for (const row of rows) {
    overrides.set(row.settingKey.slice(prefix.length), row.settingValue);
    if (!newest || row.updatedAt > newest) newest = row.updatedAt;
  }
  return { overrides, newest };
}

function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** Base layer, then flag overrides, into the shared features object. */
function overlayFeatures(overrides) {
  assignInPlace(features, featureBaseline);
  for (const flagPath of listFlagPaths(featureBaseline)) {
    const override = LOCKED_FLAGS.has(flagPath) ? null : overrides.get(flagPath);
    setPath(features, flagPath, typeof override === "boolean" ? override : getPath(featureBaseline, flagPath));
  }
}

/** Base layer, then field overrides, into the shared config object. */
function overlay(overrides) {
  assignInPlace(config, baseline);
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

/** Load everything and apply it; returns the newest override row time. */
async function reloadAll() {
  if (!baseLoaded) await loadBaseLayers();
  const [cfg, feat] = await Promise.all([loadOverrides(SETTING_KEY_PREFIX), loadOverrides(FEATURE_KEY_PREFIX)]);
  overlay(cfg.overrides);
  overlayFeatures(feat.overrides);
  return { newest: newer(cfg.newest, feat.newest), count: cfg.overrides.size + feat.overrides.size };
}

/**
 * Load saved settings into the shared objects. Called once at boot, before the
 * Discord client and cron jobs load.
 *
 * If the database is unreachable the site still has to start: it uses any
 * legacy file still on disk, otherwise the defaults, and the sync loop keeps
 * retrying until the database answers.
 */
export async function applyConfigOverrides() {
  try {
    const { newest, count } = await reloadAll();
    lastSeenUpdate = newest;
    console.log(`[settings] Loaded site settings from the database (${count} edited field(s)).`);
  } catch (error) {
    console.error("[settings] Could not load site settings from the database:", error.message);
    const legacyConfig = readLegacyFile("config.json");
    const legacyFeatures = readLegacyFile("features.json");
    baseline = mergeDeep(DEFAULT_CONFIG, legacyConfig || {});
    featureBaseline = mergeDeep(DEFAULT_FEATURES, legacyFeatures || {});
    overlay(new Map());
    overlayFeatures(new Map());
    console.warn(
      `[settings] Running on ${legacyConfig || legacyFeatures ? "legacy files on disk" : "built-in defaults"} until the database is reachable.`
    );
  }
}

/** Poll for saves made on other instances (and retry a failed boot load). */
export function startConfigSync() {
  if (syncTimer) return;
  syncTimer = setInterval(async () => {
    try {
      if (!baseLoaded) {
        const { newest } = await reloadAll();
        lastSeenUpdate = newest;
        console.log("[settings] Database reachable again; site settings loaded.");
        return;
      }
      const latest = await prisma.siteSettings.aggregate({
        where: {
          OR: [
            { settingKey: { startsWith: SETTING_KEY_PREFIX } },
            { settingKey: { startsWith: FEATURE_KEY_PREFIX } },
          ],
        },
        _max: { updatedAt: true },
      });
      const newest = latest._max.updatedAt;
      if (newest && (!lastSeenUpdate || newest > lastSeenUpdate)) {
        const { newest: reloadedNewest } = await reloadAll();
        lastSeenUpdate = reloadedNewest;
        console.log("[settings] Reloaded site settings saved on another instance.");
      }
    } catch (error) {
      console.error("[settings] Settings sync failed:", error.message);
    }
  }, SYNC_INTERVAL_MS);
  if (syncTimer.unref) syncTimer.unref();
}

/**
 * Everything the settings page needs for one field: the live value, the
 * default value, and whether the dashboard is overriding it.
 */
export async function describeSettings() {
  const { overrides } = await loadOverrides(SETTING_KEY_PREFIX);
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
 * @param {string[]} resets Paths ticked "reset to default".
 * @returns {Promise<{ saved: number, errors: string[] }>}
 */
export async function saveSection(sectionKey, body, resets = []) {
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

  const { newest } = await reloadAll();
  lastSeenUpdate = newest;

  return { saved: writes.length, errors: [] };
}

/**
 * The modules page: flags grouped for display, each with its live state,
 * the default value, and whether the dashboard is overriding it.
 */
export async function describeFeatureFlags() {
  const { overrides } = await loadOverrides(FEATURE_KEY_PREFIX);
  return describeFlags(featureBaseline).map((group) => ({
    ...group,
    flags: group.flags.map((flag) => ({
      ...flag,
      enabled: getPath(features, flag.path) === true,
      fileValue: getPath(featureBaseline, flag.path) === true,
      overridden: !flag.locked && typeof overrides.get(flag.path) === "boolean",
    })),
  }));
}

/** Save every toggle on the modules page. */
export async function saveFeatureFlags(body) {
  const writes = planFlagWrites(body, featureBaseline, getPath);

  await prisma.$transaction(
    writes.map(({ path, value }) =>
      prisma.siteSettings.upsert({
        where: { settingKey: `${FEATURE_KEY_PREFIX}${path}` },
        create: { settingKey: `${FEATURE_KEY_PREFIX}${path}`, settingValue: value ?? Prisma.DbNull },
        update: { settingValue: value ?? Prisma.DbNull },
      })
    )
  );

  const { newest } = await reloadAll();
  lastSeenUpdate = newest;

  const changed = writes.filter((w) => w.value !== null).map((w) => `${w.path}=${w.value}`);
  return { changed };
}
