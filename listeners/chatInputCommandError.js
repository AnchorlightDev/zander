import { Listener } from "@sapphire/framework";

const DB_ERROR_CODES = new Set([
  "EHOSTUNREACH",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "PROTOCOL_CONNECTION_LOST",
]);

function isDbError(error) {
  return DB_ERROR_CODES.has(error?.code) || DB_ERROR_CODES.has(error?.cause?.code);
}

export class ChatInputCommandErrorListener extends Listener {
  constructor(context, options) {
    super(context, {
      ...options,
      event: "chatInputCommandError",
    });
  }

  async run(error, { interaction }) {
    if (isDbError(error)) {
      const message = "The database is currently unreachable. Please try again in a moment.";
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: message });
        } else {
          await interaction.reply({ content: message, ephemeral: true });
        }
      } catch {
        // Interaction may have already expired — nothing more we can do.
      }
      return;
    }

    // Re-log anything else so it still surfaces in console.
    this.container.logger.error(error);
  }
}
