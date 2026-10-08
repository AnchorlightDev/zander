import { Command, RegisterBehavior } from "@sapphire/framework";
import {Colors, EmbedBuilder, InteractionContextType } from "discord.js";

export class PollCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("poll")
        .setContexts(InteractionContextType.Guild)
        .setDescription("Ask everyone a question or something to vote on!")
        .addStringOption((option) =>
          option //
            .setName("question")
            .setDescription("Question to ask in the poll.")
            .setRequired(true)
        )
    );
  }

  async chatInputRun(interaction) {
    const pollQuestion = interaction.options.getString("question");

    const embed = new EmbedBuilder()
      .setTitle(`Poll by \`${interaction.user.username}\``)
      .setDescription(`${pollQuestion}`)
      .setFooter({ text: "Vote using the reactions below to have your say!" })
      .setColor(Colors.Blue);

    // withResponse replaces the deprecated fetchReply option.
    const response = await interaction.reply({
      embeds: [embed],
      withResponse: true,
    });
    const message = response.resource.message;

    await message.react("⬆️");
    await message.react("⬇️");
  }
}
