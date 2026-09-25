/**
 * lib/permissions/zanderNodes.mjs
 *
 * Every Zander permission node, grouped the way the README documents them.
 *
 * Imports nothing, so it is unit-testable and safe to load anywhere.
 *
 * This exists so the ranks dashboard can offer a checklist instead of asking
 * somebody to type `zander.web.forms` correctly from memory. A typo in a
 * hand-typed node is silent: it grants nothing and looks granted.
 *
 * The README table is the documented source of truth, and
 * tests/unit/zanderNodes.test.mjs parses it and fails if the two drift. Add a
 * node in both places or the build says so.
 *
 * `grantable: false` marks entries that are documented but must never appear
 * as a tick box:
 *
 *   wildcards  offering `zander.web.finance.*` as one click hands out
 *              everything under it, including anything added later that
 *              nobody reviewed
 *   dynamic    `zander.web.tickets.{slug}` is a pattern, not a node; the real
 *              ones depend on which ticket categories exist
 */

export const PERMISSION_GROUPS = [
  {
    group: "Web Dashboard",
    nodes: [
      { node: "zander.web.dashboard", description: "Access the main dashboard" },
      { node: "zander.web.logs", description: "View system logs and audit trails" },
      { node: "zander.web.announcements", description: "Create, edit, and view announcements" },
      { node: "zander.web.application", description: "Manage player applications" },
      { node: "zander.web.forms", description: "Build forms and review their submissions" },
      { node: "zander.web.server", description: "Manage game servers" },
      { node: "zander.web.rank", description: "Manage individual player ranks via the API" },
      { node: "zander.web.ranks", description: "Access the ranks dashboard page" },
      {
        node: "zander.web.ranks.permissions",
        description: "Grant and revoke Zander permissions on a rank",
      },
      { node: "zander.web.scheduler", description: "Schedule announcements/messages" },
      { node: "zander.web.vault", description: "Access vault management" },
      { node: "zander.web.bridge", description: "Manage bridge/integrations" },
      { node: "zander.web.badges", description: "Access the badge management dashboard" },
      { node: "zander.web.apikeys", description: "Issue, scope and revoke API client credentials" },
      { node: "zander.web.settings", description: "Edit site settings (links, Discord IDs and webhooks, automation) that override `config.json`" },
      { node: "zander.web.users", description: "Access the user administration dashboard (email addresses masked)" },
      { node: "zander.web.users.email", description: "Reveal unmasked email addresses on the user pages" },
      { node: "zander.web.users.manage", description: "Edit user records from the user administration dashboard" },
    ],
  },
  {
    group: "Events",
    nodes: [
      { node: "zander.web.events", description: "Access the events dashboard (view only)" },
      { node: "zander.web.events.edit", description: "Create and edit events" },
      { node: "zander.web.events.review", description: "Review and publish events (implies edit)" },
    ],
  },
  {
    group: "Webstore",
    nodes: [
      { node: "zander.web.webstore", description: "Access the webstore admin dashboard" },
      { node: "zander.web.webstore.manage", description: "Edit webstore products and command configuration" },
      {
        node: "zander.web.webstore.*",
        description: "Everything under webstore",
        grantable: false,
        reason: "wildcard",
      },
    ],
  },
  {
    group: "Finance",
    nodes: [
      { node: "zander.web.finance", description: "View the finance dashboard" },
      { node: "zander.web.finance.manage", description: "Create, edit, and delete finance records" },
      {
        node: "zander.web.finance.*",
        description: "Everything under finance",
        grantable: false,
        reason: "wildcard",
      },
    ],
  },
  {
    group: "Support Tickets",
    nodes: [
      { node: "zander.web.ticket", description: "Access the support ticket dashboard" },
      { node: "zander.web.tickets", description: "Access ticket category listings" },
      {
        node: "zander.web.tickets.{slug}",
        description: "Access one ticket category",
        grantable: false,
        reason: "dynamic",
      },
      {
        node: "zander.web.tickets.*",
        description: "Access all ticket categories",
        grantable: false,
        reason: "wildcard",
      },
      { node: "zander.web.ticket.escalate", description: "Escalate and de-escalate tickets" },
      { node: "zander.web.tickets.manageparticipants", description: "Add and remove ticket participants" },
    ],
  },
  {
    group: "Punishments & Moderation",
    nodes: [
      { node: "zander.web.punishment.view", description: "View the global punishments list" },
      { node: "zander.web.punishment.manage", description: "Manage (edit/delete) punishments" },
      { node: "zander.web.punishments", description: "View punishments on user profiles" },
      { node: "zander.web.web-punishments", description: "Access the web-based punishment dashboard" },
      { node: "zander.web.audit", description: "View user audit entries on profiles" },
      { node: "zander.web.reports", description: "View player reports on profiles" },
    ],
  },
  {
    group: "Voting",
    nodes: [
      { node: "zander.web.voting", description: "Access the voting site management dashboard" },
    ],
  },
  {
    group: "Forums",
    nodes: [
      { node: "zander.web.forums", description: "Access the forums management dashboard" },
      {
        node: "zander.web.forums.{node}",
        description: "View one forum category (suffix chosen when the category is created)",
        grantable: false,
        reason: "dynamic",
      },
      { node: "zander.forums.moderate", description: "General forum moderation rights" },
      { node: "zander.forums.view", description: "View forum content" },
      { node: "zander.forums.post.delete", description: "Delete forum posts" },
      { node: "zander.forums.viewArchived", description: "View archived forum discussions" },
      { node: "zander.forums.discussion.sticky", description: "Sticky forum discussions" },
      { node: "zander.forums.discussion.lock", description: "Lock forum discussions" },
      { node: "zander.forums.discussion.archive", description: "Archive forum discussions" },
      { node: "zander.forums.category.manage", description: "Manage forum categories" },
    ],
  },
  {
    group: "Discord Punishments",
    nodes: [
      { node: "zander.discord.punish.warn", description: "Issue warnings via Discord" },
      { node: "zander.discord.punish.kick", description: "Kick users from Discord" },
      { node: "zander.discord.punish.ban", description: "Ban/unban users from Discord" },
      { node: "zander.discord.punish.mute", description: "Mute/unmute users in Discord" },
      { node: "zander.discord.punish.history", description: "View punishment history" },
    ],
  },
  {
    group: "Discord Commands",
    nodes: [
      {
        node: "zander.web.nicknamecheck",
        description: "Run the /nicknamecheck slash command",
      },
    ],
  },
  {
    group: "Watch / Creator Content",
    nodes: [
      {
        node: "zander.watch.creator",
        description: "Marks the rank as eligible creators, syncing their content to /watch",
      },
    ],
  },
];

/** Every node in the registry, grantable or not. */
export function listAllNodes() {
  return PERMISSION_GROUPS.flatMap((group) => group.nodes.map((n) => n.node));
}

/** Only the concrete nodes a tick box may grant. */
export function listGrantableNodes() {
  return PERMISSION_GROUPS.flatMap((group) =>
    group.nodes.filter((n) => n.grantable !== false).map((n) => n.node)
  );
}

/**
 * May this node be set from the dashboard?
 *
 * The allow-list is the point. Anything arriving from a form is checked
 * against it, so a hand-crafted POST cannot set `*`, a wildcard, or a node
 * belonging to some other plugin entirely.
 */
export function isGrantableNode(node) {
  return listGrantableNodes().includes(String(node ?? "").trim());
}

/** The groups with their non-grantable entries dropped, for rendering. */
export function grantableGroups() {
  return PERMISSION_GROUPS.map((group) => ({
    group: group.group,
    nodes: group.nodes.filter((n) => n.grantable !== false),
  })).filter((group) => group.nodes.length > 0);
}

/**
 * Split a rank's current permissions into the ones this screen manages and the
 * ones it must leave alone.
 *
 * A LuckPerms group holds far more than Zander nodes -- game permissions,
 * other plugins, meta. Only known Zander nodes are ever touched; everything
 * else is reported so an admin can see it, and never written.
 */
export function partitionHeldNodes(held = []) {
  const grantable = new Set(listGrantableNodes());
  const known = [];
  const unmanaged = [];

  for (const raw of held) {
    const node = String(raw ?? "").trim();
    if (!node) continue;
    if (grantable.has(node)) known.push(node);
    else unmanaged.push(node);
  }

  return { known, unmanaged };
}
