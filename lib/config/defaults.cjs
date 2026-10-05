/**
 * lib/config/defaults.cjs
 *
 * What a fresh install boots with. There is no config.json or features.json:
 * settings live in the database and are edited at /dashboard/settings and
 * /dashboard/modules. These defaults are the layer underneath -- what a field
 * shows before anyone has saved it, and what "Reset" returns it to.
 *
 * Deliberately blank rather than example values: a placeholder channel ID or
 * webhook looks configured but silently does nothing.
 *
 * CommonJS so the ~50 modules that load config synchronously with
 * createRequire can keep doing so (see lib/config/store.cjs).
 */

const DEFAULT_CONFIG = {
  debug: false,
  resources: {
    voteWindowDays: 7,
    reviewChannelId: "",
  },
  connection: {
    java: { host: "", port: null },
    bedrock: { host: "", port: 19132 },
  },
  birthday: {
    enabled: false,
    rankGroup: "",
    durationHours: 24,
    serverSlug: "any",
    webhookUrl: "",
  },
  siteConfiguration: {
    region: {},
    siteUrl: "",
    siteName: "My Community",
    tagline: "",
    keywords: "",
    email: "",
    googleTag: "",
    policy: {
      termsOfService: "",
      rules: "",
      privacy: "",
      refund: "",
    },
    platforms: {
      webstore: "",
      discord: "",
      issueTracker: "",
      knowledgebase: "",
      facebook: "",
      twitter: "",
      instagram: "",
      reddit: "",
      twitch: "",
      youtube: "",
      linkedin: "",
      tiktok: "",
    },
  },
  discord: {
    guildId: "",
    supportPanelChannelId: "",
    supportTicketCategoryId: "",
    botChannelId: "",
    webhooks: {
      welcome: "",
      networkChatLog: "",
      adminLog: "",
      staffChannel: "",
      staffAuditLog: "",
      staffPunishmentNotifications: "",
      webstoreChannel: "",
      forumLog: "",
      contact: "",
    },
    nicknameReportChannelId: "",
    roles: {
      verified: "",
      muted: "",
    },
    punishments: {
      logChannelId: "",
      appealBaseUrl: "/appeal",
      permissions: {
        can_warn: "zander.discord.punish.warn",
        can_kick: "zander.discord.punish.kick",
        can_ban: "zander.discord.punish.ban",
        can_mute: "zander.discord.punish.mute",
        can_view_history: "zander.discord.punish.history",
      },
      requireDmSuccess: false,
    },
    boosterRewards: {
      enabled: false,
      rankGroups: [],
    },
  },
  forums: {
    // Homepage "Latest from the forums" section. Blank slug = every
    // category the visitor can see; count 0 hides the section.
    homepage: {
      categorySlug: "",
      count: 4,
    },
  },
  watch: {
    contentChannelId: "",
    contentPingRoleId: null,
    filters: {
      twitch: { titleMarkers: [], tags: [] },
      youtube: { tags: [], descriptionMarkers: [] },
    },
  },
  events: {
    discordChannelId: "",
    reviewChannelId: "",
  },
  staffAuditReport: {
    enabled: false,
    dayOfWeek: "Monday",
    time: "12:00",
    timezone: "UTC",
    webhookUrl: "",
  },
  wrapped: {
    minemonitor: {
      baseUrl: "",
      dateFormat: "date",
    },
  },
};

const DEFAULT_FEATURES = {
  announcements: true,
  applications: true,
  forms: true,
  forums: true,
  bedrock: true,
  birthday: true,
  discord: {
    events: {
      generalKenobi: true,
      guildMemberBoost: true,
      guildMemberVerify: true,
      nicknameCheck: true,
      unverifiedReminder: true,
      ipAutoDetect: true,
    },
    punishments: true,
    activityTracking: true,
  },
  server: true,
  ranks: true,
  report: true,
  shopdirectory: true,
  vault: true,
  resources: false,
  contact: false,
  bridge: true,
  filter: {
    link: true,
    phrase: true,
  },
  web: {
    login: true,
    register: true,
  },
  support: true,
  staffAuditReport: true,
  watch: true,
  events: true,
  webstore: true,
  finance: true,
  smDiscord: true,
  smFacebook: true,
  smTwitter: true,
  smInstagram: true,
  smReddit: false,
  smTwitch: true,
  smYouTube: true,
  smLinkedIn: true,
  smTikTok: true,
};

/**
 * Deep-merge `overlay` onto a copy of `base`: plain objects merge key by key,
 * everything else (arrays, scalars, null) replaces. Used to lay an imported
 * legacy config.json over the defaults so keys a newer release added are not
 * lost just because an old file lacked them.
 */
function mergeDeep(base, overlay) {
  const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isPlain(base) || !isPlain(overlay)) return overlay === undefined ? structuredClone(base) : structuredClone(overlay);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    out[key] = isPlain(out[key]) && isPlain(value) ? mergeDeep(out[key], value) : structuredClone(value);
  }
  return out;
}

/**
 * Make `target` hold `source`'s values without replacing any nested object
 * `target` already has -- modules may hold references to e.g. `config.birthday`
 * taken at import time, and those must see the new values. Keys missing from
 * `source` are left alone (source is always defaults-plus-more).
 */
function assignInPlace(target, source) {
  const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  for (const [key, value] of Object.entries(source)) {
    if (isPlain(value) && isPlain(target[key])) assignInPlace(target[key], value);
    else target[key] = structuredClone(value);
  }
  return target;
}

module.exports = { DEFAULT_CONFIG, DEFAULT_FEATURES, mergeDeep, assignInPlace };
