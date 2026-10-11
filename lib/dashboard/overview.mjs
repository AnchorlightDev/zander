/**
 * lib/dashboard/overview.mjs
 *
 * What the dashboard home shows for one staff member: the queues that need
 * someone, the headline numbers and the shortcuts -- each only when its
 * module is on and the viewer can open the page it links to. The counts are
 * gathered in routes/dashboard/dashboard.js; a count that could not be read
 * is null and its tile is left out rather than shown as "—".
 *
 * No DB imports, so it is unit-testable.
 */

import { hasPermission } from "../discord/permissions.mjs";

const flagOn = (features, path) =>
  !path || path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), features) === true;

/** Queues that need a person. Shown even at zero, so "all clear" is visible. */
const ATTENTION = [
  { key: "openTickets", label: "Open tickets", icon: "fa-solid fa-ticket", href: "/dashboard/support", feature: "support", node: "zander.web.tickets", tone: "blue" },
  { key: "eventsAwaitingReview", label: "Events to review", icon: "fa-solid fa-calendar-check", href: "/dashboard/events/review", feature: "events", node: "zander.web.events", tone: "purple" },
  { key: "formSubmissions", label: "Form submissions", icon: "fa-solid fa-inbox", href: "/dashboard/forms/submissions", feature: "forms", node: "zander.web.forms", tone: "green" },
  {
    key: "resourceSuggestions",
    label: "Resource suggestions",
    icon: "fa-solid fa-book-open",
    href: "/dashboard/resources",
    feature: "resources",
    node: ["zander.web.resources.review", "zander.web.resources"],
    tone: "amber",
    detailKey: "resourcesOverdue",
    detail: (n) => `${n} overdue`,
  },
  {
    key: "failedCommands",
    label: "Failed server commands",
    icon: "fa-solid fa-triangle-exclamation",
    href: "/dashboard/bridge",
    feature: "bridge",
    node: "zander.web.bridge",
    tone: "red",
    hideWhenZero: true,
  },
];

/** Headline numbers. */
const STATS = [
  { key: "members", label: "Members", icon: "fa-solid fa-users", href: "/dashboard/users", node: "zander.web.users", detailKey: "newMembers", detail: (n) => `+${n} this week` },
  { key: "forumPosts", label: "Forum posts this week", icon: "fa-solid fa-comments", href: "/forums", feature: "forums" },
  { key: "webstoreRevenue", label: "Webstore this month", icon: "fa-solid fa-store", href: "/dashboard/webstore", feature: "webstore", node: "zander.web.webstore", detailKey: "webstoreOrders", detail: (n) => `${n} order${n === 1 ? "" : "s"}` },
  { key: "servers", label: "Servers", icon: "fa-solid fa-server", href: "/dashboard/servers", feature: "server", node: "zander.web.server" },
];

/** Shortcuts. */
const ACTIONS = [
  { label: "New announcement", icon: "fa-solid fa-bullhorn", href: "/dashboard/announcements/create", feature: "announcements", node: "zander.web.announcements" },
  { label: "Events calendar", icon: "fa-solid fa-calendar-days", href: "/dashboard/events", feature: "events", node: "zander.web.events" },
  { label: "Write a page", icon: "fa-solid fa-file-pen", href: "/dashboard/pages/create", node: "zander.web.pages" },
  { label: "Edit menus", icon: "fa-solid fa-bars", href: "/dashboard/menus", node: "zander.web.menus" },
  { label: "Add server", icon: "fa-solid fa-server", href: "/dashboard/servers/create", feature: "server", node: "zander.web.server" },
  { label: "Forum categories", icon: "fa-solid fa-comments", href: "/dashboard/forums/categories", feature: "forums", node: "zander.web.forums" },
  { label: "Site settings", icon: "fa-solid fa-sliders", href: "/dashboard/settings", node: "zander.web.settings" },
  { label: "Modules", icon: "fa-solid fa-puzzle-piece", href: "/dashboard/modules", node: "zander.web.modules" },
  { label: "System logs", icon: "fa-solid fa-terminal", href: "/dashboard/logs", node: "zander.web.logs" },
];

function canSee(item, { features, permissions }) {
  if (!flagOn(features, item.feature)) return false;
  if (!item.node) return true;
  const nodes = Array.isArray(item.node) ? item.node : [item.node];
  return nodes.some((n) => hasPermission(permissions, n));
}

/**
 * @param {Record<string, number|null>} counts
 * @param {{ features: object, permissions: string[] }} viewer
 */
export function buildOverview(counts, viewer) {
  // A number, or preformatted text such as a money amount; null = unavailable.
  const valueOf = (key) => (typeof counts[key] === "number" || typeof counts[key] === "string" ? counts[key] : null);
  const tile = (item) => {
    const value = valueOf(item.key);
    const extra = item.detailKey ? valueOf(item.detailKey) : null;
    return {
      label: item.label,
      icon: item.icon,
      href: item.href,
      tone: item.tone || null,
      value,
      detail: extra ? item.detail(extra) : null,
    };
  };

  const attention = ATTENTION.filter((i) => canSee(i, viewer) && valueOf(i.key) !== null)
    .filter((i) => !(i.hideWhenZero && valueOf(i.key) === 0))
    .map(tile);

  return {
    attention,
    allClear: attention.length > 0 && attention.every((t) => t.value === 0),
    stats: STATS.filter((i) => canSee(i, viewer) && valueOf(i.key) !== null).map(tile),
    actions: ACTIONS.filter((i) => canSee(i, viewer)),
  };
}

/**
 * Plain text from an in-game announcement: drops legacy colour codes
 * (&6, §l, &#ff0000) and MiniMessage tags (<gold>, </bold>, <#ff0000>).
 */
export function stripMinecraftFormatting(text) {
  return String(text ?? "")
    .replace(/[&§]#[0-9a-fA-F]{6}/g, "")
    .replace(/[&§][0-9a-fk-orA-FK-OR]/g, "")
    .replace(/<\/?[a-zA-Z_#][^<>]{0,40}>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Good morning" etc. for the viewer's hour (0-23). */
export function greetingFor(hour) {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
