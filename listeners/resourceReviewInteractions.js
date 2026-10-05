import { Listener } from "@sapphire/framework";
import { Colors, EmbedBuilder, MessageFlags } from "discord.js";
import { UserGetter, getUserPermissions } from "../controllers/userController.js";
import { hasPermission } from "../lib/discord/permissions.mjs";
import { REVIEW_PERMISSION } from "../lib/resources.mjs";
import { VOTE_BUTTON_PREFIX, castVote } from "../services/resourceReviewService.js";

/*
    Approve / Reject buttons on resource suggestions posted to the review
    channel (services/resourceReviewService.js). A vote here counts the same
    as one cast in /dashboard/resources.
*/
export class ResourceReviewInteractionsListener extends Listener {
  constructor(context, options) {
    super(context, { ...options, event: "interactionCreate" });
  }

  async run(interaction) {
    if (!interaction.isButton() || !interaction.customId.startsWith(`${VOTE_BUTTON_PREFIX}:`)) return;

    const [, vote, resourceId] = interaction.customId.split(":");
    const reply = (title, description, color) =>
      interaction.editReply({ embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setColor(color)] });

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const account = await new UserGetter().byDiscordId(interaction.user.id);
      if (!account) {
        return reply("No Linked Account", "Link your Discord to your site account to review resources.", Colors.Red);
      }

      const permissions = await getUserPermissions(account);
      if (!hasPermission(permissions, REVIEW_PERMISSION)) {
        return reply("No Permission", "You are not a resource reviewer.", Colors.Red);
      }

      const result = await castVote(resourceId, account.userId, vote);
      if (!result.ok) return reply("Vote Not Counted", result.error, Colors.Orange);

      const { tally, resource } = result;
      const outcome = resource.status === "pending"
        ? `👍 ${tally.approve} · 👎 ${tally.reject} — ${tally.needed} of ${tally.eligible} needed.`
        : `That vote settled it: the suggestion was **${resource.status}**.`;
      return reply(vote === "approve" ? "Approved" : "Rejected", `Your vote is recorded. ${outcome}`, Colors.Green);
    } catch (error) {
      console.error("[resources] Vote button failed:", error);
      if (interaction.deferred) {
        await reply("Something Went Wrong", "Your vote could not be recorded. Please try again.", Colors.Red).catch(() => {});
      }
    }
  }
}
