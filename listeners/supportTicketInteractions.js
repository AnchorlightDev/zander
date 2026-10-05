import { Listener } from "@sapphire/framework";
import { MessageFlags, RESTJSONErrorCodes } from "discord.js";
import {
  handleTicketClose,
  handleTicketCloseCancel,
  handleTicketCloseConfirmation,
  startTicketFlow,
} from "../lib/discord/ticketFlow.mjs";

/*
    Interaction tokens Discord will no longer accept.

    UnknownInteraction (10062) means the token is gone: Discord allows three
    seconds to acknowledge an interaction, and if the gateway event is
    delivered late or the event loop is busy (a cold start, a long
    synchronous task, GC) the handler runs after that window has closed.

    InteractionHasAlreadyBeenAcknowledged (40060) means something else already
    replied to it.

    Neither is recoverable and neither is a bug in the handler — the click is
    simply gone.  They are called out so they can be logged as a one-line
    warning instead of an unhandled-error stack trace, and so we do not try to
    reply on a token we already know is dead.
*/
const DEAD_INTERACTION_CODES = new Set([
  RESTJSONErrorCodes.UnknownInteraction,
  RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged,
]);

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
      if (DEAD_INTERACTION_CODES.has(error?.code)) {
        // Nothing can be sent on this token, so don't try — the reply below
        // would fail with the same code and log a second stack trace.
        console.warn(
          `[TICKET] Interaction expired before it could be acknowledged ` +
            `(customId=${interaction.customId}, user=${interaction.user?.id}, code=${error.code})`
        );
        return;
      }

      console.error("[TICKET] Unhandled error in ticket interaction listener", error);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({
            content: "Something went wrong while processing that ticket action.",
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply({
            content: "Something went wrong while processing that ticket action.",
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (replyError) {
        console.error("[TICKET] Failed to send error reply", replyError);
      }
    }
  }
}
