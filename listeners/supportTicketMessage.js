import { Listener } from "@sapphire/framework";
import {
    createSupportTicketMessage,
    getTicketByChannelId,
    getUserIdByDiscordId,
    createUnlinkedUser,
    syncParticipantsForMessage,
} from "../controllers/supportTicketController.js";
export class SupportTicketMessageListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      event: "messageCreate",
    });
  }

  async run(message) {
    if (message.author.bot) return;

    try {
      const ticket = await getTicketByChannelId(message.channel.id);
      if (!ticket) return;

      let userId = await getUserIdByDiscordId(message.author.id);
      if (!userId) {
        userId = await createUnlinkedUser(message.author.id, message.author.username);
      }

      await createSupportTicketMessage(
        this.container.client,
        ticket.ticketId,
        userId,
        message.content,
        "discord"
      );

      const memberRoleIds = Array.from(message.member?.roles.cache.keys() || []);

      await syncParticipantsForMessage(this.container.client, ticket.ticketId, {
        userId,
        discordRoleIds: memberRoleIds,
      });
    } catch (error) {
      console.error("[TICKET] Failed to process message in ticket channel", error);
    }
  }
}
