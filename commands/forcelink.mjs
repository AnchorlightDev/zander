import { Command } from "@sapphire/framework";
import { Colors, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { hasPermission } from "../lib/discord/permissions.mjs";
import { syncMemberRankRoles, stripAllTrackedRankRoles } from "../lib/discord/rankRoleSync.mjs";
import { UserGetter, getUserPermissions, linkDiscordAccount, unlinkDiscordAccount } from "../controllers/userController.js";
import { retryDeferredDiscordRoles } from "../controllers/webstoreController.js";
import db from "../controllers/databaseController.js";

const PERMISSION_NODE = "zander.discord.forcelink";

export class ForceLinkCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("forcelink")
        .setDescription("Force-link a Discord user to a Minecraft player account.")
        .addUserOption((option) =>
          option
            .setName("discord_user")
            .setDescription("The Discord user to link")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("minecraft_username")
            .setDescription("The Minecraft username to link them to")
            .setRequired(true),
        )
    );
  }

  async chatInputRun(interaction) {
    await interaction.deferReply({ ephemeral: true });

    // Permission gate — executor must be linked and have the node
    const userGetter = new UserGetter();
    const executorAccount = await userGetter.byDiscordId(interaction.user.id);

    if (!executorAccount) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("No Linked Account")
            .setDescription("You must have a linked Minecraft account to use this command.")
            .setColor(Colors.Red),
        ],
      });
    }

    const userPermissions = await getUserPermissions(executorAccount);
    if (!hasPermission(userPermissions, PERMISSION_NODE)) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("No Permission")
            .setDescription("You do not have permission to force-link accounts.")
            .setColor(Colors.Red),
        ],
      });
    }

    const targetDiscordUser = interaction.options.getUser("discord_user");
    const minecraftUsername = interaction.options.getString("minecraft_username").trim();

    // Look up the Minecraft user
    const mcUser = await userGetter.byUsername(minecraftUsername);
    if (!mcUser) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Minecraft User Not Found")
            .setDescription(
              `No player named \`${minecraftUsername}\` exists in the database.\n` +
              `They must have joined the server at least once before they can be linked.`,
            )
            .setColor(Colors.Red),
        ],
      });
    }

    // Check for existing links that will be displaced
    const existingDiscordLink = await userGetter.byDiscordId(targetDiscordUser.id);

    const warnings = [];

    if (existingDiscordLink && existingDiscordLink.userId !== mcUser.userId) {
      warnings.push(
        `⚠️ <@${targetDiscordUser.id}> was previously linked to \`${existingDiscordLink.username}\` — that link will be cleared.`,
      );
      // Clear the old link from the Discord user's previous MC account
      await unlinkDiscordAccount(existingDiscordLink.userId);
      await stripAllTrackedRankRoles(targetDiscordUser.id);
    }

    if (mcUser.discordId && mcUser.discordId !== targetDiscordUser.id) {
      warnings.push(
        `⚠️ \`${minecraftUsername}\` was previously linked to <@${mcUser.discordId}> — that link will be replaced.`,
      );
      await stripAllTrackedRankRoles(mcUser.discordId);
    }

    // Execute the force link
    const discordHandle = targetDiscordUser.username;
    await linkDiscordAccount(mcUser.userId, targetDiscordUser.id, discordHandle);
    const syncResult = await syncMemberRankRoles(mcUser.userId);

    // Grant any webstore Discord roles that were deferred while unlinked.
    try {
      await retryDeferredDiscordRoles({
        userId: mcUser.userId,
        discordClient: this.container.client,
        guildId: interaction.guildId,
      });
    } catch (roleErr) {
      warnings.push(`⚠️ Could not re-run deferred webstore roles: ${roleErr.message}`);
    }

    // Mark account as registered if not already, and clean up any pending verify codes
    if (!mcUser.account_registered) {
      await new Promise((resolve, reject) =>
        db.query("UPDATE users SET account_registered=? WHERE userId=?", [new Date(), mcUser.userId], (err) =>
          err ? reject(err) : resolve()
        )
      );
    }
    await new Promise((resolve, reject) =>
      db.query("DELETE FROM userVerifyLink WHERE uuid=?", [mcUser.uuid], (err) =>
        err ? reject(err) : resolve()
      )
    );

    const embed = new EmbedBuilder()
      .setTitle("Account Force-Linked")
      .setColor(Colors.Green)
      .addFields(
        { name: "Discord User", value: `<@${targetDiscordUser.id}> (${targetDiscordUser.tag ?? targetDiscordUser.username})`, inline: true },
        { name: "Minecraft Player", value: `\`${mcUser.username}\``, inline: true },
        { name: "UUID", value: `\`${mcUser.uuid}\``, inline: false },
        { name: "Linked By", value: `<@${interaction.user.id}>`, inline: true },
      )
      .setFooter({ text: `User ID: ${mcUser.userId}` })
      .setTimestamp();

    if (warnings.length > 0) {
      embed.addFields({ name: "Warnings", value: warnings.join("\n"), inline: false });
    }

    const roleSyncReasonLabels = {
      FEATURE_DISABLED: "the `ranks` feature flag is disabled.",
      NOT_LINKED: "no Discord account is linked (unexpected — link just succeeded).",
      MEMBER_NOT_IN_GUILD: "they aren't a member of the configured guild.",
      ERROR: `an error occurred (${syncResult?.error ?? "unknown"}).`,
    };

    if (!syncResult?.ok) {
      embed.addFields({
        name: "⚠️ Role Sync Skipped",
        value: `No Discord roles were assigned because ${roleSyncReasonLabels[syncResult?.reason] ?? "of an unknown reason."}`,
        inline: false,
      });
    } else if (!syncResult.toAdd.length && !syncResult.toRemove.length) {
      embed.addFields({
        name: "Role Sync",
        value: syncResult.shouldHaveRoleIds.length
          ? "Their Discord roles already matched their ranks — nothing to change."
          : "No rank-mapped Discord role is configured for their current rank(s) (`meta.discordid` not set in LuckPerms), so nothing was assigned.",
        inline: false,
      });
    } else {
      const parts = [];
      if (syncResult.toAdd.length) parts.push(`Added: ${syncResult.toAdd.map((id) => `<@&${id}>`).join(", ")}`);
      if (syncResult.toRemove.length) parts.push(`Removed: ${syncResult.toRemove.map((id) => `<@&${id}>`).join(", ")}`);
      embed.addFields({ name: "Role Sync", value: parts.join("\n"), inline: false });
    }

    return interaction.editReply({ embeds: [embed] });
  }
}
