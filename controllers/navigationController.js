/**
 * controllers/navigationController.js
 *
 * Storage and caching for the editable menus (lib/navigation/menus.mjs).
 *
 * Every public page renders the header and footer, so menus are served from
 * memory: refreshed at boot, after any save here or page change in
 * /dashboard/pages, and every REFRESH_MS so other instances pick up edits.
 * `siteMenu()` is handed to every template through @fastify/view's
 * defaultContext (app.js), so views call `siteMenu("header", req)`.
 */

import { createRequire } from "module";
import { prisma } from "./databaseController.js";
import { MENU_LOCATIONS, defaultMenus, resolveMenu } from "../lib/navigation/menus.mjs";
import { getConnectionDetails } from "../lib/connectionDetails.mjs";

const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");
const features = require("../lib/config/features.cjs");

const REFRESH_MS = 60_000;

const cache = {
  saved: new Map(), // location -> items (only locations staff have saved)
  pageSlugs: new Map(), // published pageId -> slug
  servers: [],
  loaded: false,
};

export async function refreshNavigationCache() {
  try {
    const [menus, pages, servers] = await Promise.all([
      prisma.navigationMenus.findMany(),
      prisma.customPages.findMany({ where: { status: "published" }, select: { pageId: true, slug: true } }),
      prisma.servers.findMany({ where: { serverType: "EXTERNAL" }, orderBy: { position: "asc" } }).catch(() => []),
    ]);
    cache.saved = new Map(menus.filter((m) => Array.isArray(m.items)).map((m) => [m.location, m.items]));
    cache.pageSlugs = new Map(pages.map((p) => [p.pageId, p.slug]));
    cache.servers = servers;
    cache.loaded = true;
  } catch (error) {
    // Keep serving the last good copy (or the defaults on a cold start).
    console.error("[navigation] Could not refresh menus:", error.message);
  }
}

let timer = null;
export function startNavigationSync() {
  if (timer) return;
  refreshNavigationCache();
  timer = setInterval(refreshNavigationCache, REFRESH_MS);
  timer.unref?.();
}

/** The stored items for a location, or the built-in default. */
export function getMenuItems(location) {
  return cache.saved.get(location) ?? defaultMenus(config)[location] ?? [];
}

export function isMenuCustomised(location) {
  return cache.saved.has(location);
}

/** Published pages as { pageId, slug } for the editor. */
export function getPublishedPageSlugs() {
  return cache.pageSlugs;
}

/** The menu for `location`, resolved for the visitor making `req`. */
export function siteMenu(location, req) {
  if (!MENU_LOCATIONS[location]) return [];
  const { java, bedrock } = getConnectionDetails(config, cache.servers);
  return resolveMenu(getMenuItems(location), {
    features,
    loggedIn: Boolean(req?.session?.user),
    pageSlugs: cache.pageSlugs,
    addresses: { java: java.address, bedrock: bedrock.address },
    currentPath: req?.url || "",
  });
}

export async function saveMenu(location, items, userId) {
  await prisma.navigationMenus.upsert({
    where: { location },
    create: { location, items, updatedByUserId: userId ?? null },
    update: { items, updatedByUserId: userId ?? null },
  });
  await refreshNavigationCache();
}

/** Forget the saved menu so the location goes back to the default. */
export async function resetMenu(location) {
  await prisma.navigationMenus.deleteMany({ where: { location } });
  await refreshNavigationCache();
}
