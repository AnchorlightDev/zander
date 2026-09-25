/**
 * lib/config/settingsRegistry.mjs
 *
 * The parts of config.json that staff can edit from /dashboard/settings.
 *
 * config.json stays the baseline -- it is what a fresh install boots with and
 * what "reset" returns a field to. A value saved from the dashboard is stored
 * in siteSettings under `config:<path>` and overlaid onto the shared config
 * object at boot (controllers/configSettingsController.js), so the 29 modules
 * that `require("config.json")` see it without any change of their own.
 *
 * Deliberately NOT here: `debug`, `discord.punishments.permissions` (permission
 * node mapping -- developer config), `voting` (documentation strings) and
 * `mixed.mapSync` (nested source arrays better reviewed in a file).
 *
 * Imports nothing but the timezone helper, so it is unit-testable.
 *
 * Field types: text, textarea, url, email, number, port, boolean, select,
 * list, snowflake (Discord ID), webhook (secret), time, timezone.
 * `restart: true` marks values a module copies once at startup.
 */

import { normaliseTimeZone } from "../timezones.mjs";

const url = (path, label, help) => ({ path, label, type: "url", help });
const channel = (path, label, extra = {}) => ({ path, label, type: "snowflake", help: "Discord channel ID.", ...extra });
const webhook = (path, label, extra = {}) => ({ path, label, type: "webhook", ...extra });

export const SETTINGS_SECTIONS = [
  {
    key: "general",
    title: "General",
    icon: "fa-solid fa-globe",
    fields: [
      { path: "siteConfiguration.siteName", label: "Site name", type: "text", required: true },
      { path: "siteConfiguration.tagline", label: "Tagline", type: "text" },
      { path: "siteConfiguration.siteUrl", label: "Site URL", type: "url", required: true, help: "Public address, no trailing slash." },
      { path: "siteConfiguration.email", label: "Support email", type: "email" },
      { path: "siteConfiguration.googleTag", label: "Google Analytics tag", type: "text", help: "e.g. G-XXXXXXXXXX. Leave blank to disable." },
      { path: "siteConfiguration.keywords", label: "SEO keywords", type: "textarea", help: "Comma-separated." },
      { path: "siteConfiguration.region.name", label: "Region name", type: "text", help: "Shown in site copy, e.g. Australia. Blank = no region claimed." },
      { path: "siteConfiguration.region.countryCode", label: "Country code", type: "text", pattern: /^[A-Za-z]{2}$/, help: "ISO 3166-1 alpha-2, e.g. AU." },
      { path: "siteConfiguration.region.language", label: "Language", type: "text", pattern: /^[A-Za-z]{2}$/, help: "ISO 639-1, e.g. en." },
    ],
  },
  {
    key: "connection",
    title: "Server Connection",
    icon: "fa-solid fa-server",
    fields: [
      { path: "connection.java.host", label: "Java host", type: "text" },
      { path: "connection.java.port", label: "Java port", type: "port", help: "Blank to show the host without a port." },
      { path: "connection.bedrock.host", label: "Bedrock host", type: "text" },
      { path: "connection.bedrock.port", label: "Bedrock port", type: "port" },
    ],
  },
  {
    key: "links",
    title: "Links & Policies",
    icon: "fa-solid fa-link",
    fields: [
      url("siteConfiguration.policy.termsOfService", "Terms of service", "Raw markdown URL."),
      url("siteConfiguration.policy.rules", "Rules", "Raw markdown URL."),
      url("siteConfiguration.policy.privacy", "Privacy policy", "Raw markdown URL."),
      url("siteConfiguration.policy.refund", "Refund policy", "Raw markdown URL."),
      url("siteConfiguration.platforms.discord", "Discord invite"),
      url("siteConfiguration.platforms.webstore", "External webstore"),
      url("siteConfiguration.platforms.issueTracker", "Issue tracker"),
      url("siteConfiguration.platforms.knowledgebase", "Knowledge base"),
      url("siteConfiguration.platforms.facebook", "Facebook"),
      url("siteConfiguration.platforms.twitter", "Twitter / X"),
      url("siteConfiguration.platforms.instagram", "Instagram"),
      url("siteConfiguration.platforms.reddit", "Reddit"),
      url("siteConfiguration.platforms.twitch", "Twitch"),
      url("siteConfiguration.platforms.youtube", "YouTube"),
      url("siteConfiguration.platforms.linkedin", "LinkedIn"),
      url("siteConfiguration.platforms.tiktok", "TikTok"),
    ],
  },
  {
    key: "discord",
    title: "Discord",
    icon: "fa-brands fa-discord",
    fields: [
      { path: "discord.guildId", label: "Guild (server) ID", type: "snowflake", restart: true },
      channel("discord.botChannelId", "Bot channel"),
      channel("discord.supportPanelChannelId", "Support panel channel"),
      { path: "discord.supportTicketCategoryId", label: "Support ticket category", type: "snowflake", help: "Discord category ID." },
      channel("discord.nicknameReportChannelId", "Nickname report channel"),
      { path: "discord.roles.verified", label: "Verified role", type: "snowflake", help: "Discord role ID." },
      { path: "discord.roles.muted", label: "Muted role", type: "snowflake", help: "Discord role ID.", restart: true },
      channel("discord.punishments.logChannelId", "Punishment log channel", { restart: true }),
      { path: "discord.punishments.appealBaseUrl", label: "Appeal link", type: "text", help: "Path or URL shown in punishment DMs." },
      { path: "discord.punishments.requireDmSuccess", label: "Require punishment DM to succeed", type: "boolean" },
      webhook("discord.webhooks.welcome", "Welcome webhook"),
      webhook("discord.webhooks.networkChatLog", "Network chat log webhook"),
      webhook("discord.webhooks.adminLog", "Admin log webhook"),
      webhook("discord.webhooks.staffChannel", "Staff channel webhook"),
      webhook("discord.webhooks.staffAuditLog", "Staff audit log webhook"),
      webhook("discord.webhooks.staffPunishmentNotifications", "Punishment notifications webhook", { restart: true }),
      webhook("discord.webhooks.webstoreChannel", "Webstore webhook"),
    ],
  },
  {
    key: "content",
    title: "Watch & Events",
    icon: "fa-solid fa-tv",
    fields: [
      channel("watch.contentChannelId", "Creator content channel"),
      { path: "watch.contentPingRoleId", label: "Creator content ping role", type: "snowflake", help: "Discord role ID. Blank for no ping." },
      { path: "watch.filters.twitch.titleMarkers", label: "Twitch title markers", type: "list", help: "One per line. A stream title containing any of these counts as community content." },
      { path: "watch.filters.twitch.tags", label: "Twitch tags", type: "list", help: "One per line." },
      { path: "watch.filters.youtube.tags", label: "YouTube tags", type: "list", help: "One per line." },
      { path: "watch.filters.youtube.descriptionMarkers", label: "YouTube description markers", type: "list", help: "One per line." },
      channel("events.discordChannelId", "Events announcement channel"),
      channel("events.reviewChannelId", "Events review channel"),
    ],
  },
  {
    key: "automation",
    title: "Automation",
    icon: "fa-solid fa-robot",
    fields: [
      { path: "staffAuditReport.enabled", label: "Staff audit report enabled", type: "boolean", restart: true },
      {
        path: "staffAuditReport.dayOfWeek",
        label: "Report day",
        type: "select",
        options: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
        restart: true,
      },
      { path: "staffAuditReport.time", label: "Report time", type: "time", restart: true },
      { path: "staffAuditReport.timezone", label: "Report timezone", type: "timezone", restart: true },
      webhook("staffAuditReport.webhookUrl", "Staff audit report webhook"),
      { path: "birthday.enabled", label: "Birthday rank enabled", type: "boolean", restart: true },
      { path: "birthday.rankGroup", label: "Birthday LuckPerms group", type: "text", restart: true, help: "Granted temporarily via lp user parent addtemp." },
      { path: "birthday.durationHours", label: "Birthday rank duration (hours)", type: "number", min: 1, max: 168 },
      { path: "birthday.serverSlug", label: "Birthday command server", type: "text", help: "Server slug, or 'any'." },
      webhook("birthday.webhookUrl", "Birthday announcement webhook", { help: "Optional." }),
      url("wrapped.minemonitor.baseUrl", "MineMonitor base URL"),
      { path: "wrapped.minemonitor.dateFormat", label: "MineMonitor date format", type: "select", options: ["date", "iso", "epoch", "epochms"] },
    ],
  },
];

export const ALL_FIELDS = SETTINGS_SECTIONS.flatMap((s) => s.fields);

export const SETTING_KEY_PREFIX = "config:";

export function settingKeyFor(path) {
  return `${SETTING_KEY_PREFIX}${path}`;
}

export function findSection(key) {
  return SETTINGS_SECTIONS.find((s) => s.key === key) || null;
}

export function findField(path) {
  return ALL_FIELDS.find((f) => f.path === path) || null;
}

/** Read a dot path, or undefined when any segment is missing. */
export function getPath(obj, path) {
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

/**
 * Write a dot path, creating missing objects. Mutates existing nested objects
 * in place rather than replacing them, so a module holding a reference to
 * e.g. `config.birthday` sees the new leaf value.
 */
export function setPath(obj, path, value) {
  const keys = path.split(".");
  let node = obj;
  for (const key of keys.slice(0, -1)) {
    if (node[key] == null || typeof node[key] !== "object") node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

const SNOWFLAKE = /^\d{17,20}$/;
const WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Validate and coerce one submitted form value.
 *
 * @returns {{ ok: true, value: any } | { ok: false, error: string }}
 */
export function parseFieldValue(field, raw) {
  const text = Array.isArray(raw) ? raw.join("\n") : String(raw ?? "");
  const trimmed = text.trim();
  const fail = (error) => ({ ok: false, error: `${field.label}: ${error}` });

  if (field.required && trimmed === "" && field.type !== "boolean") return fail("is required.");

  switch (field.type) {
    case "boolean":
      return { ok: true, value: raw === true || ["1", "on", "true"].includes(trimmed) };

    case "number": {
      if (trimmed === "") return { ok: true, value: null };
      const n = Number(trimmed);
      if (!Number.isInteger(n)) return fail("must be a whole number.");
      if (field.min != null && n < field.min) return fail(`must be at least ${field.min}.`);
      if (field.max != null && n > field.max) return fail(`must be at most ${field.max}.`);
      return { ok: true, value: n };
    }

    case "port": {
      if (trimmed === "") return { ok: true, value: null };
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return fail("must be a port between 1 and 65535.");
      return { ok: true, value: n };
    }

    case "list":
      return {
        ok: true,
        value: text.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean),
      };

    case "snowflake":
      if (trimmed === "") return { ok: true, value: null };
      if (!SNOWFLAKE.test(trimmed)) return fail("must be a Discord ID (17–20 digits).");
      return { ok: true, value: trimmed };

    case "webhook":
      if (trimmed === "") return { ok: true, value: "" };
      if (!WEBHOOK.test(trimmed)) return fail("must be a Discord webhook URL.");
      return { ok: true, value: trimmed };

    case "url":
      if (trimmed === "") return { ok: true, value: "" };
      if (!isHttpUrl(trimmed)) return fail("must be an http(s) URL.");
      return { ok: true, value: trimmed.replace(/\/+$/, "") };

    case "email":
      if (trimmed === "") return { ok: true, value: "" };
      if (!EMAIL.test(trimmed)) return fail("must be an email address.");
      return { ok: true, value: trimmed };

    case "time":
      if (!TIME.test(trimmed)) return fail("must be a 24-hour time, e.g. 12:00.");
      return { ok: true, value: trimmed };

    case "timezone": {
      const zone = normaliseTimeZone(trimmed);
      if (!zone) return fail("must be an IANA timezone, e.g. Australia/Sydney.");
      return { ok: true, value: zone };
    }

    case "select":
      if (!field.options.includes(trimmed)) return fail("is not one of the allowed options.");
      return { ok: true, value: trimmed };

    case "text":
    case "textarea":
    default:
      if (trimmed !== "" && field.pattern && !field.pattern.test(trimmed)) return fail("is not in the expected format.");
      return { ok: true, value: trimmed };
  }
}

/** Whether a value is worth showing in full on the settings page. */
export function isSecretField(field) {
  return field.type === "webhook";
}

/** Mask a secret for display, keeping enough to recognise which one it is. */
export function maskSecret(value) {
  const text = String(value ?? "");
  if (!text) return "";
  return text.length <= 12 ? "••••••" : `${text.slice(0, 40)}…${text.slice(-4)}`;
}

/**
 * Overlay dashboard overrides onto the live config object.
 *
 * For every registered field: the override when one is stored, otherwise the
 * baseline (config.json) value. Fields outside the registry are never touched.
 *
 * @param {object} config     The shared, mutable config object.
 * @param {object} baseline   A deep copy of config.json as loaded at boot.
 * @param {Map<string, any>} overrides  path -> value (null/undefined = unset).
 */
export function applyOverrides(config, baseline, overrides) {
  for (const field of ALL_FIELDS) {
    const override = overrides.get(field.path);
    const value = override !== undefined && override !== null ? override : getPath(baseline, field.path);
    if (value === undefined && getPath(config, field.path) === undefined) continue;
    setPath(config, field.path, value === undefined ? null : value);
  }
}

/**
 * Work out what saving one section should write, without touching storage.
 *
 * - A path in `resets` is cleared back to config.json.
 * - A secret left blank is skipped: the page never renders the real value, so
 *   a blank box is not a request to clear it.
 * - A field absent from the body is skipped, except booleans (an unchecked
 *   checkbox is simply not submitted).
 * - A value equal to config.json is written as null ("no override"), so the
 *   row does not pin a value that would silently stop following the file.
 *
 * Any validation error means nothing should be written.
 *
 * @returns {{ writes: Array<{ path: string, value: any }>, errors: string[] }}
 */
export function planSectionWrites(section, body, resets, baseline) {
  const writes = [];
  const errors = [];
  const resetSet = new Set(resets || []);

  for (const field of section.fields) {
    if (resetSet.has(field.path)) {
      writes.push({ path: field.path, value: null });
      continue;
    }

    const raw = body?.[field.path];
    if (isSecretField(field) && String(raw ?? "").trim() === "") continue;
    if (raw === undefined && field.type !== "boolean") continue;

    const parsed = parseFieldValue(field, raw);
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }

    const fileValue = getPath(baseline, field.path) ?? null;
    const matchesFile = JSON.stringify(parsed.value) === JSON.stringify(fileValue);
    writes.push({ path: field.path, value: matchesFile ? null : parsed.value });
  }

  return errors.length ? { writes: [], errors } : { writes, errors };
}
