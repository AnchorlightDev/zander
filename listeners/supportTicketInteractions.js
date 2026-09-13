import { Listener } from "@sapphire/framework";
import {
  handleTicketClose,
  handleTicketCloseCancel,
  handleTicketCloseConfirmation,
  startTicketFlow,
} from "../lib/discord/ticketFlow.mjs";

export class SupportTicketInteractionsListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      event: "interactionCreate",
    });
  }

  async run(interaction) {
    if (!interaction.isButton()) return;

    let handler = null;
    if (interaction.customId.startsWith("support_ticket_open")) {
      const [, parentCategoryId] = interaction.customId.split(":");
      handler = () => startTicketFlow(interaction, { parentCategoryId });
    } else if (interaction.customId === "support_ticket_close") {
      handler = () => handleTicketClose(interaction);
    } else if (interaction.customId.startsWith("support_ticket_close_confirm")) {
      handler = () => handleTicketCloseConfirmation(interaction);
    } else if (interaction.customId.startsWith("support_ticket_close_cancel")) {
      handler = () => handleTicketCloseCancel(interaction);
    }

    if (!handler) return;

    try {
      return await handler();
    } catch (error) {
      console.error("[TICKET] Unhandled error in ticket interaction listener", error);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({
            content: "Something went wrong while processing that ticket action.",
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content: "Something went wrong while processing that ticket action.",
            ephemeral: true,
          });
        }
      } catch (replyError) {
        console.error("[TICKET] Failed to send error reply", replyError);
      }
    }
  }
}
