import { createRequire } from "module";
const require = createRequire(import.meta.url);
const config = require("../../config.json");
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  addTicketUserParticipant,
  createSupportTicket,
  createSupportTicketMessage,
  getCategoryName,
  getCategoryPermissions,
  getSupportCategories,
  getTicketDetailsByChannel,
  getUserIdByDiscordId,
  createUnlinkedUser,
  notifyTicketStatusChange,
  updateTicketStatus,
  deleteTicketChannel,
} from "../../controllers/supportTicketController.js";

const TICKET_SELECT_ID = "support_ticket_category_select";

export async function startTicketFlow(interaction, { parentCategoryId = null } = {}) {
  const resolvedParentCategoryId =
    parentCategoryId && parentCategoryId !== "undefined" && parentCategoryId !== ""
      ? parentCategoryId
      : null;

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }
  const categories = await getSupportCategories();

  if (!categories.length) {
    return interaction.editReply({
      content: "Ticketing is unavailable right now because no categories are configured.",
      components: [],
    });
  }

  const userId = await getUserIdByDiscordId(interaction.user.id);
  if (!userId) {
    const siteBaseUrl =
      (config.siteConfiguration && config.siteConfiguration.siteUrl) ||
      process.env.SITE_URL ||
      "https://craftingforchrist.net";
    const normalizedSiteUrl = siteBaseUrl.endsWith("/") ? siteBaseUrl.slice(0, -1) : siteBaseUrl;

    const linkEmbed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle("Account not linked")
      .setDescription(
        "Your Discord account is not linked to a website account. You need to link it before you can open a ticket.\n\n" +
        "**How to link your account:**\n" +
        "1. Visit the website and log in (or create an account if you don't have one).\n" +
        "2. Once logged in, go to your profile and connect your Discord account.\n" +
        "3. Come back to Discord and try opening a ticket again.\n\n" +
        "Click the button below to get started."
      );

    const loginButton = new ButtonBuilder()
      .setLabel("Log In / Create Account")
      .setStyle(ButtonStyle.Link)
      .setURL(`${normalizedSiteUrl}/login`)
      .setEmoji("🔗");

    return interaction.editReply({
      embeds: [linkEmbed],
      components: [new ActionRowBuilder().addComponents(loginButton)],
    });
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(TICKET_SELECT_ID)
    .setPlaceholder("Choose a category")
    .addOptions(
      categories.map((category) => ({
        label: category.name,
        value: category.categoryId.toString(),
        description: category.description
          ? category.description.substring(0, 100)
          : undefined,
      }))
    );

  const selectRow = new ActionRowBuilder().addComponents(selectMenu);
  const prompt = await interaction.editReply({
    content: "Select a category to start your ticket.",
    components: [selectRow],
  });

  let selection;
  try {
    selection = await prompt.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      time: 60000,
      filter: (componentInteraction) =>
        componentInteraction.customId === TICKET_SELECT_ID &&
        componentInteraction.user.id === interaction.user.id,
    });
  } catch {
    return interaction.editReply({
      content: "Ticket creation timed out. Please try again when you're ready.",
      components: [],
    });
  }

  const categoryId = Number.parseInt(selection.values[0], 10);
  const modal = new ModalBuilder()
    .setCustomId(`support_ticket_modal_${categoryId}`)
    .setTitle("Create Ticket");

  const subjectInput = new TextInputBuilder()
    .setCustomId("subject")
    .setLabel("Subject")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const descriptionInput = new TextInputBuilder()
    .setCustomId("description")
    .setLabel("Description")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);

  modal.addComponents(
    new ActionRowBuilder().addComponents(subjectInput),
    new ActionRowBuilder().addComponents(descriptionInput)
  );

  await selection.showModal(modal);

  let modalInteraction;
  try {
    modalInteraction = await selection.awaitModalSubmit({
      filter: (modalEvent) =>
        modalEvent.customId === `support_ticket_modal_${categoryId}` &&
        modalEvent.user.id === interaction.user.id,
      time: 60000,
    });
  } catch {
    return selection.followUp({ content: "Ticket creation timed out.", ephemeral: true });
  }

  if (!modalInteraction.deferred && !modalInteraction.replied) {
    await modalInteraction.deferReply({ ephemeral: true });
  }

  const subject = modalInteraction.fields.getTextInputValue("subject");
  const description = modalInteraction.fields.getTextInputValue("description");
  const staffRoleIds = await getCategoryPermissions(categoryId);
  const categoryName = await getCategoryName(categoryId);

  let ticketRecord;
  try {
    ticketRecord = await createSupportTicket(
      interaction.client,
      userId,
      categoryId,
      subject,
      {
        discordUserId: interaction.user.id,
        staffRoleIds,
        parentCategoryId: resolvedParentCategoryId,
      }
    );
  } catch (error) {
    console.error("Failed to create ticket", error);
    return modalInteraction.editReply({
      content: "We couldn't open your ticket right now. Please try again in a moment.",
    });
  }

  const { ticketId, channel } = ticketRecord;

  try {
    await addTicketUserParticipant(ticketId, { userId });
  } catch (participantError) {
    console.error("Failed to add ticket opener as participant", participantError);
  }

  const siteBaseUrl =
    (config.siteConfiguration && config.siteConfiguration.siteUrl) ||
    process.env.SITE_URL ||
    "https://craftingforchrist.net";
  const normalizedSiteUrl = siteBaseUrl.endsWith("/")
    ? siteBaseUrl.slice(0, -1)
    : siteBaseUrl;
  const ticketUrl = `${normalizedSiteUrl}/support/ticket/${ticketId}`;

  try {
    await createSupportTicketMessage(
      interaction.client,
      ticketId,
      userId,
      description,
      "discord"
    );
  } catch (messageError) {
    // Never let a failure here (e.g. a transient DB error) prevent the
    // ticket embed below from posting — the channel already exists and
    // the ticket record was already created, so the user must still see
    // the starting embed and get their editReply.
    console.error("Failed to log ticket description as a message", messageError);
  }

  const ticketEmbed = new EmbedBuilder()
    .setTitle(`Ticket #${ticketId}: ${subject}`)
    .setDescription(description)
    .addFields(
      { name: "Opened by", value: `${interaction.user.tag} (<@${interaction.user.id}>)` },
      { name: "Category", value: categoryName }
    )
    .setTimestamp(new Date())
    .setColor(0x2b6cb0);

  const closeButton = new ButtonBuilder()
    .setCustomId("support_ticket_close")
    .setLabel("Close Ticket")
    .setStyle(ButtonStyle.Danger);

  const viewOnlineButton = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel("View Ticket Online")
    .setURL(ticketUrl);

  let message;
  try {
    message = await channel.send({
      content: `<@${interaction.user.id}> your ticket has been created.`,
      embeds: [ticketEmbed],
      components: [new ActionRowBuilder().addComponents(viewOnlineButton, closeButton)],
    });
  } catch (sendError) {
    console.error(
      `[TICKET] Failed to post ticket opener embed (ticketId=${ticketId}, channelId=${channel?.id})`,
      sendError
    );

    // Don't leave the channel completely blank — fall back to a plain-text
    // message with the essentials and the online link so staff and the
    // opener still have something to work from.
    try {
      await channel.send(
        `<@${interaction.user.id}> your ticket has been created (reference #${ticketId}).\n` +
          `**${subject}**\n${description}\n\n` +
          `The interactive opener message failed to post — view or close this ticket online: ${ticketUrl}`
      );
    } catch (fallbackError) {
      console.error(
        `[TICKET] Plain-text fallback also failed (ticketId=${ticketId}, channelId=${channel?.id})`,
        fallbackError
      );
    }

    return modalInteraction.editReply({
      content: `Ticket created in ${channel}, but we couldn't post the opening message. Reference #${ticketId}.`,
    });
  }

  try {
    await message.pin();
  } catch (pinError) {
    console.error("Failed to pin ticket opener message", pinError);
  }

  return modalInteraction.editReply({
    content: `Ticket created in ${channel} with reference #${ticketId}.`,
  });
}

export async function handleTicketClose(interaction) {
  const ticketDetails = await getTicketDetailsByChannel(interaction.channel.id);

  if (!ticketDetails) {
    return interaction.reply({
      content: "This channel is not linked to a ticket.",
      ephemeral: true,
    });
  }

  const categoryStaffRoles = await getCategoryPermissions(ticketDetails.categoryId);
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const isStaff =
    member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    member.roles.cache.some((role) => categoryStaffRoles.includes(role.id));
  const isOwner = ticketDetails.discordId && ticketDetails.discordId === interaction.user.id;

  if (!isStaff && !isOwner) {
    return interaction.reply({
      content: "Only ticket staff or the ticket owner can close this ticket.",
      ephemeral: true,
    });
  }

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`support_ticket_close_confirm:${interaction.channel.id}`)
      .setLabel("Confirm Close")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`support_ticket_close_cancel:${interaction.channel.id}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );

  return interaction.reply({
    content:
      "Are you sure you want to close this ticket? The channel will lock and delete 5 seconds after confirmation.",
    components: [confirmRow],
    ephemeral: true,
  });
}

export async function handleTicketCloseConfirmation(interaction) {
  const [, channelId] = interaction.customId.split(":");

  if (channelId && channelId !== interaction.channel.id) {
    return interaction.reply({
      content: "This close confirmation does not match this channel.",
      ephemeral: true,
    });
  }

  return performTicketClose(interaction);
}

export async function handleTicketCloseCancel(interaction) {
  const [, channelId] = interaction.customId.split(":");

  if (channelId && channelId !== interaction.channel.id) {
    return interaction.reply({
      content: "This close confirmation does not match this channel.",
      ephemeral: true,
    });
  }

  return interaction.update({
    content: "Ticket close cancelled.",
    components: [],
  });
}

async function performTicketClose(interaction) {
  // Acknowledge the interaction immediately — Discord rejects responses that
  // arrive more than 3 seconds after the original interaction. All the DB
  // queries and permission edits below can easily exceed that window, so we
  // defer first and edit the reply once the work is done.
  if (interaction.isMessageComponent() && !interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch((e) =>
      console.warn("[TICKET] Failed to defer close interaction", e)
    );
  }

  const ticketDetails = await getTicketDetailsByChannel(interaction.channel.id);

  if (!ticketDetails) {
    return interaction.followUp({
      content: "This channel is not linked to a ticket.",
      ephemeral: true,
    });
  }

  const categoryStaffRoles = await getCategoryPermissions(ticketDetails.categoryId);
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const isStaff =
    member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    member.roles.cache.some((role) => categoryStaffRoles.includes(role.id));
  const isOwner = ticketDetails.discordId && ticketDetails.discordId === interaction.user.id;

  if (!isStaff && !isOwner) {
    return interaction.followUp({
      content: "Only ticket staff or the ticket owner can close this ticket.",
      ephemeral: true,
    });
  }

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("support_ticket_closed")
      .setLabel("Ticket Closed")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );

  try {
    const hasValidDiscordId = /^\d{17,20}$/.test(String(ticketDetails.discordId || ""));
    if (hasValidDiscordId && interaction.channel.permissionOverwrites.cache.has(ticketDetails.discordId)) {
      await interaction.channel.permissionOverwrites.edit(
        ticketDetails.discordId,
        { SendMessages: false, ViewChannel: true },
        { type: OverwriteType.Member },
      );
    }
    await interaction.channel.send(
      `Ticket closed by ${interaction.user}. Deleting channel shortly...`
    );
  } catch (permissionError) {
    console.error("Failed to lock ticket channel", permissionError);
  }

  try {
    await updateTicketStatus(ticketDetails.ticketId, "closed");
    let actorUserId = await getUserIdByDiscordId(interaction.user.id);
    if (!actorUserId) {
      actorUserId = await createUnlinkedUser(interaction.user.id, interaction.user.username);
    }

    await notifyTicketStatusChange(ticketDetails.ticketId, "closed", {
      userId: actorUserId,
      name: interaction.user.username,
    });
  } catch (statusError) {
    console.error("Failed to update ticket status during close", statusError);
  }

  // Update the original close-button message to show the disabled state
  try {
    await interaction.editReply({ components: [closeRow] });
  } catch (replyError) {
    console.warn("Failed to update close button message", replyError);
  }

  setTimeout(async () => {
    try {
      const deleted = await deleteTicketChannel(
        interaction.client,
        ticketDetails.ticketId,
        "Ticket closed",
        interaction.channel
      );
      if (!deleted) {
        console.error("Failed to delete closed ticket channel; cleanup remains retryable", {
          ticketId: ticketDetails.ticketId,
          channelId: interaction.channel.id,
        });
      }
    } catch (deleteError) {
      console.error("Failed to delete closed ticket channel", deleteError);
    }
  }, 2500);
}
