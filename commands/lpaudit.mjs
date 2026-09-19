import { Command } from "@sapphire/framework";
import {
  AttachmentBuilder,
  Colors,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { hasPermission } from "../lib/discord/permissions.mjs";
import {
  getUserPermissions,
  UserGetter,
} from "../controllers/userController.js";
import { runAudit } from "../lib/discord/lpAudit.mjs";

const AUDIT_PERMISSION_NODE = "zander.discord.lpaudit";

// Max entries shown per section inside the embed before "see export" kicks in.
const INLINE_LIMIT = 10;

function truncateList(items, limit) {
  if (items.length <= limit) return { shown: items, overflow: 0 };
  return { shown: items.slice(0, limit), overflow: items.length - limit };
}

function formatUnlinked(users) {
  return users
    .map((u) => {
      const roles = u.expectedRoleIds.map((id) => `<@&${id}>`).join(", ") || "none";
      return `\`${u.username}\` — groups: ${u.lpGroups.join(", ")} | would lose: ${roles}`;
    })
    .join("\n");
}

function formatNotInGuild(users) {
  return users
    .map((u) => {
      const roles = u.expectedRoleIds.map((id) => `<@&${id}>`).join(", ") || "none";
      return `\`${u.username}\` (<@${u.discordId}>) — groups: ${u.lpGroups.join(", ")} | would lose: ${roles}`;
    })
    .join("\n");
}

function formatDiscordNotLinked(users) {
  return users
    .map((u) => {
      const roles = u.heldRoles.join(", ") || "none";
      return `<@${u.discordId}> (\`${u.discordTag}\`) — has roles: ${roles}`;
    })
    .join("\n");
}

function formatMissingRoles(users) {
  return users
    .map(
      (u) =>
        `<@${u.discordId}> (\`${u.username}\`) — missing: ${u.missingRoles.join(", ")}`
    )
    .join("\n");
}

function buildSectionField(embed, title, count, items, formatFn, scope, scopeKey) {
  if (scope !== "all" && scope !== scopeKey) return;

  const { shown, overflow } = truncateList(items, INLINE_LIMIT);
  let value =
    shown.length > 0
      ? formatFn(shown)
      : "None";

  if (overflow > 0) {
    value += `\n…and ${overflow} more (see attached report)`;
  }

  embed.addFields({
    name: `${title} (${count})`,
    value: value.slice(0, 1024),
  });
}

function buildReportText({ unlinked, notInGuild, missingRoles, discordNotLinked, summary }) {
  const ts = new Date().toISOString();
  const lines = [
    `LP ↔ Discord Audit Report`,
    `Generated: ${ts}`,
    `Tracked LP users: ${summary.total} | Tracked rank mappings: ${summary.trackedRankCount}`,
    "",
    `=== UNLINKED — no Discord ID in system (${unlinked.length}) ===`,
    ...unlinked.map(
      (u) =>
        `  ${u.username} [${u.uuid}]  groups: ${u.lpGroups.join(", ")}  would-lose-role-ids: ${u.expectedRoleIds.join(", ") || "none"}`
    ),
    "",
    `=== NOT IN GUILD — Discord ID recorded but user not a guild member (${notInGuild.length}) ===`,
    ...notInGuild.map(
      (u) =>
        `  ${u.username} [${u.uuid}]  discordId: ${u.discordId}  groups: ${u.lpGroups.join(", ")}  would-lose-role-ids: ${u.expectedRoleIds.join(", ") || "none"}`
    ),
    "",
    `=== MISSING DISCORD ROLES — in guild but role(s) absent (${missingRoles.length}) ===`,
    ...missingRoles.map(
      (u) =>
        `  ${u.username} [${u.uuid}]  discordId: ${u.discordId}  missing: ${u.missingRoles.join(", ")}`
    ),
    "",
    `=== IN DISCORD WITH ROLES BUT NOT LINKED (${discordNotLinked.length}) ===`,
    ...discordNotLinked.map(
      (u) =>
        `  ${u.discordTag}  discordId: ${u.discordId}  has-role-ids: ${u.heldRoleIds.join(", ")}  roles: ${u.heldRoles.join(", ")}`
    ),
    "",
    `Note: this report is read-only. No roles were changed.`,
  ];
  return lines.join("\n");
}

export class LpAuditCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    const builder = new SlashCommandBuilder()
      .setName("lp-audit")
      .setDescription(
        "Audit LuckPerms ↔ Discord role sync. Read-only — no changes are made."
      )
      .addStringOption((opt) =>
        opt
          .setName("scope")
          .setDescription("Which section of the audit to show (default: all).")
          .setRequired(false)
          .addChoices(
            { name: "All sections", value: "all" },
            { name: "Unlinked — no Discord ID", value: "unlinked" },
            { name: "Not in guild — Discord ID exists but user left", value: "not_in_guild" },
            { name: "Missing Discord roles", value: "missing_roles" },
            { name: "In Discord with roles but not linked", value: "discord_not_linked" }
          )
      )
      .addBooleanOption((opt) =>
        opt
          .setName("export")
          .setDescription(
            "Attach a full plain-text report file (default: true)."
          )
          .setRequired(false)
      );

    registry.registerChatInputCommand(builder);
  }

  async chatInputRun(interaction) {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error("[lp-audit] Failed to defer reply:", err);
      return;
    }

    // Require a linked account
    const userGetter = new UserGetter();
    const linkedAccount = await userGetter.byDiscordId(interaction.user.id);

    if (!linkedAccount) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("No Linked Account")
            .setDescription(
              "Link your Minecraft account on the website before using this command."
            )
            .setColor(Colors.Red),
        ],
      });
    }

    // Permission gate
    const userPermissions = await getUserPermissions(linkedAccount);
    if (!hasPermission(userPermissions, AUDIT_PERMISSION_NODE)) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("No Permission")
            .setDescription("You do not have access to run LP audits.")
            .setColor(Colors.Red),
        ],
      });
    }

    const scope = interaction.options.getString("scope") ?? "all";
    const attachExport = interaction.options.getBoolean("export") ?? true;

    let auditResult;
    try {
      auditResult = await runAudit(interaction.guild);
    } catch (err) {
      console.error("[lp-audit] Audit failed:", err);
      return interaction.editReply({
        content:
          "The audit failed due to a database or Discord API error. Check server logs.",
      });
    }

    const { unlinked, notInGuild, missingRoles, discordNotLinked, summary } = auditResult;

    if (summary.trackedRankCount === 0) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("No Tracked Ranks")
            .setDescription(
              "No ranks have a Discord role ID configured. Add `meta.discordid` to LuckPerms groups to enable sync auditing."
            )
            .setColor(Colors.Orange),
        ],
      });
    }

    const embed = new EmbedBuilder()
      .setTitle("LP ↔ Discord Audit")
      .setColor(Colors.Blurple)
      .setTimestamp(new Date())
      .setDescription(
        [
          `**Tracked LP users:** ${summary.total}`,
          `**Tracked rank mappings:** ${summary.trackedRankCount}`,
          "",
          `**Unlinked (LP ranked, no Discord ID):** ${unlinked.length}`,
          `**Not in guild:** ${notInGuild.length}`,
          `**Missing Discord roles:** ${missingRoles.length}`,
          `**In Discord with roles but not linked:** ${discordNotLinked.length}`,
        ].join("\n")
      )
      .setFooter({ text: "Audit only — no roles were changed." });

    buildSectionField(
      embed,
      "Unlinked — no Discord ID",
      unlinked.length,
      unlinked,
      formatUnlinked,
      scope,
      "unlinked"
    );

    buildSectionField(
      embed,
      "Not in Guild",
      notInGuild.length,
      notInGuild,
      formatNotInGuild,
      scope,
      "not_in_guild"
    );

    buildSectionField(
      embed,
      "Missing Discord Roles",
      missingRoles.length,
      missingRoles,
      formatMissingRoles,
      scope,
      "missing_roles"
    );

    buildSectionField(
      embed,
      "In Discord with roles but not linked",
      discordNotLinked.length,
      discordNotLinked,
      formatDiscordNotLinked,
      scope,
      "discord_not_linked"
    );

    const files = [];
    if (attachExport) {
      const reportText = buildReportText(auditResult);
      files.push(
        new AttachmentBuilder(Buffer.from(reportText, "utf-8"), {
          name: `lp-audit-${Date.now()}.txt`,
        })
      );
    }

    return interaction.editReply({ embeds: [embed], files });
  }
}
