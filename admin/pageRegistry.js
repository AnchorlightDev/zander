/**
 * admin/pageRegistry.js
 *
 * Central admin page registry for Zander Web.
 *
 * Every admin screen that appears in the sidebar (or needs permission-gating)
 * is registered here.  The sidebar, breadcrumbs, and active-state detection
 * all derive from this single source of truth instead of being hardcoded in
 * multiple EJS templates.
 *
 * Fields
 * ------
 *  slug          – unique string identifier
 *  title         – full page title (used in <title> and page headers)
 *  menuTitle     – shorter label shown in the sidebar
 *  icon          – Font Awesome class string
 *  capability    – LuckPerms permission node required to see / access this page
 *  path          – canonical URL of the primary entry-point
 *  group         – sidebar section heading  (null / omitted → top-level)
 *  sortOrder     – render order within the group
 *  hiddenFromMenu– true → page exists but is NOT shown in the sidebar
 *  featureFlag   – key in features.json that must be truthy to show the item
 */

// ---------------------------------------------------------------------------
// Primary menu entries (visible in the sidebar)
// ---------------------------------------------------------------------------
export const adminPages = [
  // ── Top level ──────────────────────────────────────────────────────────────
  {
    slug: "dashboard",
    title: "Dashboard",
    menuTitle: "Overview",
    icon: "fas fa-home",
    capability: "zander.web.dashboard",
    path: "/dashboard",
    group: null,
    sortOrder: 0,
  },
  {
    slug: "announcements",
    title: "Announcements",
    menuTitle: "Announcements",
    icon: "fas fa-bullhorn",
    capability: "zander.web.announcements",
    path: "/dashboard/announcements",
    featureFlag: "announcements",
    group: null,
    sortOrder: 10,
  },
  {
    slug: "forums",
    title: "Forum Management",
    menuTitle: "Forums",
    icon: "fa-solid fa-comments",
    capability: "zander.web.forums",
    path: "/dashboard/forums/categories",
    featureFlag: "forums",
    group: null,
    sortOrder: 15,
  },

  // ── Community group ────────────────────────────────────────────────────────
  {
    slug: "servers",
    title: "Servers",
    menuTitle: "Servers",
    icon: "fas fa-server",
    capability: "zander.web.server",
    path: "/dashboard/servers",
    featureFlag: "server",
    group: "Community",
    sortOrder: 20,
  },
  {
    slug: "applications",
    title: "Applications",
    menuTitle: "Applications",
    icon: "fas fa-file-alt",
    capability: "zander.web.application",
    path: "/dashboard/applications",
    featureFlag: "applications",
    group: "Community",
    sortOrder: 21,
  },

  {
    slug: "forms",
    title: "Forms",
    menuTitle: "Forms",
    icon: "fas fa-clipboard-list",
    capability: "zander.web.forms",
    path: "/dashboard/forms",
    featureFlag: "forms",
    group: "Community",
    sortOrder: 22,
  },

  // ── Events group ───────────────────────────────────────────────────────────
  {
    slug: "events-calendar",
    title: "Events Calendar",
    menuTitle: "Calendar",
    icon: "fas fa-calendar-alt",
    capability: "zander.web.events",
    path: "/dashboard/events",
    featureFlag: "events",
    group: "Events",
    sortOrder: 30,
  },
  {
    slug: "events-list",
    title: "All Events",
    menuTitle: "All Events",
    icon: "fas fa-list",
    capability: "zander.web.events",
    path: "/dashboard/events/list",
    featureFlag: "events",
    group: "Events",
    sortOrder: 31,
  },
  {
    slug: "events-review",
    title: "Events Review Queue",
    menuTitle: "Review Queue",
    icon: "fas fa-clock",
    capability: "zander.web.events",
    path: "/dashboard/events/review",
    featureFlag: "events",
    group: "Events",
    sortOrder: 32,
  },
  {
    slug: "events-templates",
    title: "Event Templates",
    menuTitle: "Templates",
    icon: "fas fa-copy",
    capability: "zander.web.events",
    path: "/dashboard/events/templates",
    featureFlag: "events",
    group: "Events",
    sortOrder: 33,
  },

  // ── Moderation group ───────────────────────────────────────────────────────
  {
    slug: "web-punishments",
    title: "Web Punishments",
    menuTitle: "Web Punishments",
    icon: "fa-solid fa-gavel",
    capability: "zander.web.web-punishments",
    path: "/dashboard/web-punishments",
    group: "Moderation",
    sortOrder: 40,
  },

  // ── Support group ──────────────────────────────────────────────────────────
  {
    slug: "support-tickets",
    title: "Support Tickets",
    menuTitle: "Manage Tickets",
    icon: "fas fa-ticket-alt",
    capability: "zander.web.tickets",
    path: "/dashboard/support",
    featureFlag: "support",
    group: "Support",
    sortOrder: 50,
  },
  {
    slug: "support-explorer",
    title: "Ticket Explorer",
    menuTitle: "Ticket Explorer",
    icon: "fas fa-search",
    capability: "zander.web.tickets",
    path: "/dashboard/support/explorer",
    featureFlag: "support",
    group: "Support",
    sortOrder: 51,
  },
  {
    slug: "support-categories",
    title: "Ticket Categories",
    menuTitle: "Categories",
    icon: "fas fa-folder",
    capability: "zander.web.tickets",
    path: "/dashboard/support/categories",
    featureFlag: "support",
    group: "Support",
    sortOrder: 52,
  },

  // ── Voting group ───────────────────────────────────────────────────────────

  // ── System group ───────────────────────────────────────────────────────────
  {
    slug: "vault",
    title: "Vault",
    menuTitle: "Vault",
    icon: "fa-solid fa-vault",
    capability: "zander.web.vault",
    path: "/dashboard/vault",
    featureFlag: "vault",
    group: "System",
    sortOrder: 70,
  },
  {
    slug: "logs",
    title: "System Logs",
    menuTitle: "Logs",
    icon: "fa-solid fa-terminal",
    capability: "zander.web.logs",
    path: "/dashboard/logs",
    group: "System",
    sortOrder: 71,
  },
  {
    slug: "bridge",
    title: "Bridge Processor",
    menuTitle: "Bridge",
    icon: "fa-solid fa-bridge",
    capability: "zander.web.bridge",
    path: "/dashboard/bridge",
    group: "System",
    sortOrder: 72,
  },
  {
    slug: "ranks",
    title: "Ranks",
    menuTitle: "Ranks",
    icon: "fa-solid fa-medal",
    capability: "zander.web.ranks",
    path: "/dashboard/ranks",
    featureFlag: "ranks",
    group: "System",
    sortOrder: 73,
  },
  {
    slug: "scheduler",
    title: "Message Scheduler",
    menuTitle: "Scheduler",
    icon: "fa-solid fa-clock",
    capability: "zander.web.scheduler",
    path: "/dashboard/scheduler",
    group: "System",
    sortOrder: 74,
  },

  // ── Webstore group ─────────────────────────────────────────────────────────
  {
    slug: "webstore-dashboard",
    title: "Webstore",
    menuTitle: "Purchases",
    icon: "fa-solid fa-store",
    capability: "zander.web.webstore",
    path: "/dashboard/webstore",
    featureFlag: "webstore",
    group: "Webstore",
    sortOrder: 78,
  },
  {
    slug: "webstore-commands",
    title: "Command Config",
    menuTitle: "Command Config",
    icon: "fa-solid fa-terminal",
    capability: "zander.web.webstore",
    path: "/dashboard/webstore/commands",
    featureFlag: "webstore",
    group: "Webstore",
    sortOrder: 79,
  },
  {
    slug: "rank-catalog",
    title: "Rank Catalog",
    menuTitle: "Rank Catalog",
    icon: "fa-solid fa-layer-group",
    capability: "zander.web.webstore",
    path: "/dashboard/rank-catalog",
    featureFlag: "webstore",
    group: "Webstore",
    sortOrder: 80,
  },
  {
    slug: "webstore-products",
    title: "Storefront Products",
    menuTitle: "Products",
    icon: "fa-solid fa-box-open",
    capability: "zander.web.webstore",
    path: "/dashboard/webstore/products",
    featureFlag: "webstore",
    group: "Webstore",
    sortOrder: 79.5,
  },
  {
    slug: "webstore-categories",
    title: "Categories",
    menuTitle: "Categories",
    icon: "fa-solid fa-tags",
    capability: "zander.web.webstore",
    path: "/dashboard/webstore/categories",
    featureFlag: "webstore",
    group: "Webstore",
    sortOrder: 81,
  },

  // ── Finance group ──────────────────────────────────────────────────────────
  {
    slug: "finance",
    title: "Finance",
    menuTitle: "Overview",
    icon: "fa-solid fa-chart-line",
    capability: "zander.web.finance",
    path: "/dashboard/finance",
    featureFlag: "finance",
    group: "Finance",
    sortOrder: 80,
  },
  {
    slug: "finance-reports",
    title: "Finance Reports",
    menuTitle: "Reports",
    icon: "fa-solid fa-file-invoice-dollar",
    capability: "zander.web.finance",
    path: "/dashboard/finance/reports",
    featureFlag: "finance",
    group: "Finance",
    sortOrder: 84,
  },
  {
    slug: "finance-settings",
    title: "Finance Settings",
    menuTitle: "Settings",
    icon: "fa-solid fa-gear",
    capability: "zander.web.finance.manage",
    path: "/dashboard/finance/settings",
    featureFlag: "finance",
    group: "Finance",
    sortOrder: 87,
  },

  // ── Mixed group ──────────────────────────────────────────────────────────
  // ── Community — Users ──────────────────────────────────────────────────────
  {
    slug: "users",
    title: "Users",
    menuTitle: "Users",
    icon: "fa-solid fa-users",
    capability: "zander.web.users",
    path: "/dashboard/users",
    group: "Community",
    sortOrder: 22.5,
  },
  // ── Community — Badges ─────────────────────────────────────────────────────
  {
    slug: "badges",
    title: "Badges",
    menuTitle: "Badges",
    icon: "fa-solid fa-award",
    capability: "zander.web.badges",
    path: "/dashboard/badges",
    group: "Community",
    sortOrder: 23,
  },
  {
    slug: "apikeys",
    title: "API Keys",
    menuTitle: "API Keys",
    icon: "fa-solid fa-key",
    capability: "zander.web.apikeys",
    path: "/dashboard/apikeys",
    group: "System",
    sortOrder: 75,
  },
];
// ---------------------------------------------------------------------------
// Sub-pages (registered for breadcrumb / title lookup; not shown in sidebar)
// ---------------------------------------------------------------------------
export const adminSubPages = [
  {
    slug: "forms-create",
    title: "Create Form",
    parent: "forms",
    path: "/dashboard/forms/create",
    capability: "zander.web.forms",
  },
  {
    slug: "forms-submissions",
    title: "Form Submissions",
    parent: "forms",
    path: "/dashboard/forms/submissions",
    capability: "zander.web.forms",
  },
  {
    slug: "announcements-create",
    title: "Create Announcement",
    parent: "announcements",
    path: "/dashboard/announcements/create",
    capability: "zander.web.announcements",
  },
  {
    slug: "announcements-edit",
    title: "Edit Announcement",
    parent: "announcements",
    path: "/dashboard/announcements/edit",
    capability: "zander.web.announcements",
  },
  {
    slug: "servers-create",
    title: "Create Server",
    parent: "servers",
    path: "/dashboard/servers/create",
    capability: "zander.web.server",
  },
  {
    slug: "servers-edit",
    title: "Edit Server",
    parent: "servers",
    path: "/dashboard/servers/edit",
    capability: "zander.web.server",
  },
  {
    slug: "events-edit",
    title: "Edit Event",
    parent: "events-list",
    path: "/dashboard/events",
    capability: "zander.web.events",
  },
  {
    slug: "badges-create",
    title: "Create Badge",
    parent: "badges",
    path: "/dashboard/badges/create",
    capability: "zander.web.badges",
  },
  {
    slug: "badges-edit",
    title: "Edit Badge",
    parent: "badges",
    path: "/dashboard/badges/edit",
    capability: "zander.web.badges",
  },
  {
    slug: "badges-assign",
    title: "Assign Badge",
    parent: "badges",
    path: "/dashboard/badges/assign",
    capability: "zander.web.badges",
  },
  {
    slug: "users-detail",
    title: "User Details",
    parent: "users",
    path: "/dashboard/users/",
    capability: "zander.web.users",
  },

  // Finance sub-pages
  { slug: "finance-transaction-create", title: "New Transaction", parent: "finance-transactions", path: "/dashboard/finance/transactions/create", capability: "zander.web.finance.manage" },
  { slug: "finance-transaction-edit", title: "Edit Transaction", parent: "finance-transactions", path: "/dashboard/finance/transactions/", capability: "zander.web.finance.manage" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal permission check mirroring api/common.js hasSpecificPermission.
 * Kept here to avoid circular imports into the admin layer.
 */
function checkPermission(permissionsArray, node) {
  if (!node) return true;
  if (!Array.isArray(permissionsArray) || permissionsArray.length === 0)
    return false;
  const target = node.trim().toLowerCase();
  return permissionsArray.some((p) => {
    if (!p) return false;
    const c = String(p).trim().toLowerCase();
    if (c === "*") return true;
    if (c === target) return true;
    if (c.endsWith(".*")) return target.startsWith(c.slice(0, -1));
    return false;
  });
}

/**
 * Return all menu pages visible to the current user, sorted by sortOrder.
 *
 * @param {string[]} userPermissions  – req.session.user.permissions
 * @param {object}   features         – parsed features.json
 */
export function getMenuItems(userPermissions, features) {
  return adminPages
    .filter((page) => {
      if (page.hiddenFromMenu) return false;
      if (page.featureFlag && !features[page.featureFlag]) return false;
      if (page.capability && !checkPermission(userPermissions, page.capability))
        return false;
      return true;
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Return menu items grouped by their `group` field, preserving insertion order.
 * Each entry is  { group: string|null, items: AdminPage[] }.
 *
 * @param {string[]} userPermissions
 * @param {object}   features
 */
export function getMenuGroups(userPermissions, features) {
  const items = getMenuItems(userPermissions, features);
  const groups = [];
  const seen = new Map();

  for (const item of items) {
    const key = item.group ?? "__toplevel__";
    if (!seen.has(key)) {
      const entry = { group: item.group, items: [] };
      seen.set(key, entry);
      groups.push(entry);
    }
    seen.get(key).items.push(item);
  }

  return groups;
}

/**
 * Find a registered page (or sub-page) by its URL path.
 * Used to derive breadcrumbs and determine the active menu item.
 *
 * @param {string} urlPath  – req.url (query-string is stripped internally)
 */
export function getPageByPath(urlPath) {
  const clean = urlPath.split("?")[0];
  return (
    adminPages.find((p) => p.path === clean) ??
    adminSubPages.find((p) => clean.startsWith(p.path))
  );
}
