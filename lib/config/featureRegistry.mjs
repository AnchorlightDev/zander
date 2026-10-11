/**
 * lib/config/featureRegistry.mjs
 *
 * The feature flags, as toggles on /dashboard/modules.
 *
 * The list is derived from the baseline -- defaults plus any imported legacy
 * features.json (every boolean, at any depth), so a flag added to
 * lib/config/defaults.cjs shows up on the page without touching this module. FLAG_INFO only supplies nicer labels, grouping and warnings.
 *
 * Imports nothing, so it is unit-testable.
 */

/**
 * Flags that cannot be switched from the dashboard. Turning login off from
 * the dashboard would leave nobody able to sign in to turn it back on.
 */
export const LOCKED_FLAGS = new Set(["web.login"]);

/** Flags read once at startup, so a change needs a restart. */
export const RESTART_FLAGS = new Set(["staffAuditReport"]);

const GROUPS = {
  modules: "Website modules",
  discord: "Discord bot",
  filter: "Chat filter",
  web: "Accounts",
  social: "Social links",
};

const FLAG_INFO = {
  announcements: { label: "Announcements", description: "Site, Discord and in-game announcements." },
  applications: { label: "Applications", description: "Legacy staff/player applications." },
  forms: { label: "Forms", description: "Form builder, public forms and applications." },
  forums: { label: "Forums" },
  bedrock: { label: "Bedrock page", description: "The /play Bedrock join guide." },
  birthday: { label: "Birthdays", description: "Birthday field on profiles. The rank itself is set up under Settings → Automation." },
  server: { label: "Servers", description: "Server list and status." },
  ranks: { label: "Ranks", description: "Rank pages and Discord role sync." },
  report: { label: "Reports", description: "Player reports." },
  shopdirectory: { label: "Shop directory" },
  vault: { label: "Vault" },
  resources: { label: "Resources", description: "Staff-approved community resources and the /resources command. Categories and reviews are under Dashboard → Resources." },
  contact: { label: "Contact form", description: "Public contact form. Each message opens a support ticket; guests get replies by email." },
  bridge: { label: "Bridge", description: "Web ↔ server command bridge." },
  support: { label: "Support tickets" },
  staffAuditReport: { label: "Staff audit report", description: "Weekly staff activity report." },
  watch: { label: "Watch", description: "Creator content (Twitch/YouTube)." },
  events: { label: "Events" },
  webstore: { label: "Webstore" },
  finance: { label: "Finance centre" },
  "discord.punishments": { label: "Punishment commands" },
  "discord.activityTracking": { label: "Activity tracking", description: "Daily message and voice activity stats." },
  "discord.events.generalKenobi": { label: "General Kenobi reply" },
  "discord.events.guildMemberBoost": { label: "Boost announcements" },
  "discord.events.guildMemberVerify": { label: "Member verification" },
  "discord.events.nicknameCheck": { label: "Nickname enforcement" },
  "discord.events.unverifiedReminder": { label: "Unverified member reminders" },
  "discord.events.ipAutoDetect": { label: "Server IP auto-reply" },
  "filter.link": { label: "Link filter" },
  "filter.phrase": { label: "Phrase filter" },
  "web.login": { label: "Login" },
  "web.register": { label: "Registration", description: "Turning this off stops new accounts; existing users can still log in." },
};

function humanise(key) {
  return key
    .replace(/^sm(?=[A-Z])/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function groupFor(path) {
  const top = path.split(".")[0];
  if (/^sm[A-Z]/.test(top)) return "social";
  if (top === "discord" || top === "filter" || top === "web") return top;
  return "modules";
}

/** Every boolean in the features object, as a flat list of dot paths. */
export function listFlagPaths(features, prefix = "") {
  const out = [];
  for (const [key, value] of Object.entries(features || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "boolean") out.push(path);
    else if (value && typeof value === "object" && !Array.isArray(value)) out.push(...listFlagPaths(value, path));
  }
  return out;
}

/**
 * The toggles to show, grouped for the page.
 *
 * @returns {Array<{ key, title, flags: Array<{ path, label, description, locked, restart }> }>}
 */
export function describeFlags(baselineFeatures) {
  const groups = new Map(Object.keys(GROUPS).map((k) => [k, []]));
  for (const path of listFlagPaths(baselineFeatures)) {
    const info = FLAG_INFO[path] || {};
    const key = path.split(".").pop();
    groups.get(groupFor(path)).push({
      path,
      label: info.label || humanise(key),
      description: info.description || null,
      locked: LOCKED_FLAGS.has(path),
      restart: RESTART_FLAGS.has(path),
    });
  }
  return [...groups.entries()]
    .filter(([, flags]) => flags.length)
    .map(([key, flags]) => ({ key, title: GROUPS[key], flags }));
}

/**
 * Work out what saving the modules page should write.
 *
 * Every editable flag on the page is a checkbox, so absent means off. A value
 * equal to the default is stored as null (no override) so the flag keeps
 * following the file. Locked flags are never written.
 */
export function planFlagWrites(body, baselineFeatures, getPath) {
  const writes = [];
  for (const path of listFlagPaths(baselineFeatures)) {
    if (LOCKED_FLAGS.has(path)) continue;
    const raw = body?.[path];
    const on = raw === true || ["1", "on", "true"].includes(String(raw ?? ""));
    writes.push({ path, value: on === getPath(baselineFeatures, path) ? null : on });
  }
  return writes;
}
