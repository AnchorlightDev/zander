import { Command } from "@sapphire/framework";
import { Colors, EmbedBuilder, MessageFlags } from "discord.js";
import { hasPermission } from "../lib/discord/permissions.mjs";
import {
  getUserPermissions,
  UserGetter,
} from "../controllers/userController.js";
import { runStaffAuditReport } from "../cron/staffAuditReportCron.js";

const AUDIT_PERMISSION_NODE = "zander.web.audit";

console.log("[StaffAuditReport] Command file loaded.");

export class StaffAuditReportCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("staff-audit-report")
        .setDescription("Manually trigger the staff activity audit report.")
    );
  }

  async chatInputRun(interaction) {
    console.log(`[StaffAuditReport] Invoked by ${interaction.user.tag}`);

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

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

    const userPermissions = await getUserPermissions(linkedAccount);
    if (!hasPermission(userPermissions, AUDIT_PERMISSION_NODE)) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("No Permission")
            .setDescription("You do not have access to use this command.")
            .setColor(Colors.Red),
        ],
      });
    }

    let result;
    try {
      result = await runStaffAuditReport();
    } catch (error) {
      console.error("[StaffAuditReport] Failed to run report:", error);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Report Failed")
            .setDescription(
              "The staff audit report failed to run. Check server logs for details."
            )
            .setColor(Colors.Red),
        ],
      });
    }

    if (!result.sent) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("Report Not Sent")
            .setDescription(result.reason)
            .setColor(Colors.Orange),
        ],
      });
    }

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Staff Audit Report Sent")
          .setDescription(
            `Posted audit for **${result.staffCount}** staff member(s) across **${result.embedCount}** message(s).`
          )
          .setColor(Colors.Green)
          .setTimestamp(new Date()),
      ],
    });
  }
}
