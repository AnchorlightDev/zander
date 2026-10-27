import { Command } from "@sapphire/framework";
import { Colors, EmbedBuilder, MessageFlags } from "discord.js";
import { createRequire } from "module";
import { UserGetter } from "../controllers/userController.js";
import { listCategories } from "../controllers/resourceController.js";
import { RESOURCE_LIMITS } from "../lib/resources.mjs";
import { submitResource } from "../services/resourceReviewService.js";
const require = createRequire(import.meta.url);
const features = require("../lib/config/features.cjs");

function embed(title, description, color) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);
}

export class ResourcesCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("resources")
        .setDescription("View or suggest community resources.")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("view")
            .setDescription("Get a link to the resources page.")
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("submit")
            .setDescription("Suggest a resource for staff to review.")
            .addStringOption((option) =>
              option
                .setName("category")
                .setDescription("Which category it belongs in.")
                .setAutocomplete(true)
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("title")
                .setDescription("The name of the resource.")
                .setMaxLength(RESOURCE_LIMITS.title)
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("description")
                .setDescription("A short description of the resource.")
                .setMaxLength(RESOURCE_LIMITS.description)
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("url")
                .setDescription("The link to the resource.")
                .setMaxLength(RESOURCE_LIMITS.url)
                .setRequired(true)
            )
        )
    );
  }

  async autocompleteRun(interaction) {
    try {
      const typed = String(interaction.options.getFocused() || "").toLowerCase();
      const categories = await listCategories();
      return interaction.respond(
        categories
          .filter((c) => c.name.toLowerCase().includes(typed))
          .slice(0, 25)
          .map((c) => ({ name: c.name, value: String(c.categoryId) }))
      );
    } catch (error) {
      console.error("[resources] Category autocomplete failed:", error.message);
      return interaction.respond([]).catch(() => {});
    }
  }

  async chatInputRun(interaction) {
    if (!features.resources) {
      return interaction.reply({
        embeds: [embed("Feature Disabled", "This feature has been disabled by your System Administrator.", Colors.Red)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.options.getSubcommand() === "view") {
      return interaction.reply({
        embeds: [embed("Resources", `Helpful links, apps and tools shared by the community: ${process.env.siteAddress}/resources`, Colors.DarkGold)],
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Suggestions come from signed-in members only, so every one is traceable.
    const account = await new UserGetter().byDiscordId(interaction.user.id);
    if (!account) {
      return interaction.editReply({
        embeds: [embed("Link Your Account", `Link your Discord to your site account to suggest resources: ${process.env.siteAddress}/login`, Colors.Red)],
      });
    }

    try {
      const result = await submitResource(
        {
          categoryId: interaction.options.getString("category"),
          title: interaction.options.getString("title"),
          description: interaction.options.getString("description"),
          url: interaction.options.getString("url"),
        },
        { userId: account.userId, name: account.username, discordId: interaction.user.id },
        "discord"
      );

      if (!result.ok) {
        return interaction.editReply({ embeds: [embed("Not Submitted", result.errors.join("\n"), Colors.Red)] });
      }
      return interaction.editReply({
        embeds: [embed("Resource Submitted", "Thanks! Staff will review your suggestion, and I'll DM you when they decide.", Colors.Green)],
      });
    } catch (error) {
      console.error("[resources] Discord submission failed:", error);
      return interaction.editReply({ embeds: [embed("Submission Failed", "Your suggestion could not be sent. Please try again later.", Colors.Red)] });
    }
  }
}
