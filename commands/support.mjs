import { createRequire } from "module";
const require = createRequire(import.meta.url);
const config = require("../config.json");
import { Command } from "@sapphire/framework";
import {
  SlashCommandBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ActionRowBuilder,
  ChannelType,
  EmbedBuilder,
  OverwriteType,
} from "discord.js";
import { startTicketFlow } from "../lib/discord/ticketFlow.mjs";
import {
  addTicketGroupParticipant,
  addTicketUserParticipant,
  applyTicketParticipantPermissions,
  removeTicketGroupParticipant,
  removeTicketUserParticipant,
  removeTicketParticipantPermissions,
  createUnlinkedUser,
  createSupportTicket,
  createSupportTicketMessage,
  ensureUncategorisedCategory,
  getCategoryPermissions,
  getTicketDetailsByChannel,
  getUserIdByDiscordId,
  setTicketEscalationState,
  setTicketLockState,
  updateTicketStatus,
  deleteTicketChannel,
} from "../controllers/supportTicketController.js";
import { hasPermission } from "../lib/discord/permissions.mjs";
import { UserGetter, getUserPermissions } from "../controllers/userController.js";

const MANAGE_PARTICIPANTS_NODE = "zander.web.tickets.manageparticipants";

async function callerHasManageParticipants(discordUserId) {
  const userGetter = new UserGetter();
  const linked = await userGetter.byDiscordId(discordUserId);
  if (!linked) return false;
  const perms = await getUserPermissions(linked);
  return hasPermission(perms, MANAGE_PARTICIPANTS_NODE);
}

export class SupportCommand extends Command {
  constructor(context, options) {
    super(context, {
      ...options,
      name: "ticket",
      description: "Create and manage support tickets.",
    });
  }

  registerApplicationCommands(registry) {
    const builder = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addSubcommand((subcommand) =>
        subcommand.setName("create").setDescription("Open a new support ticket.")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("submit").setDescription("Submit a support ticket.")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("panel")
          .setDescription("Post a Create Ticket button in this channel.")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("Channel to place the Create Ticket button in.")
              .addChannelTypes(ChannelType.GuildText)
          )
          .addChannelOption((option) =>
            option
              .setName("ticket_category")
              .setDescription("Discord category where ticket channels will be created.")
              .addChannelTypes(ChannelType.GuildCategory)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add")
          .setDescription("Add a user or role(s) to the current ticket.")
          .addUserOption((option) =>
            option
              .setName("user")
              .setDescription("Discord user to add to the ticket")
          )
          .addRoleOption((option) =>
            option
              .setName("role")
              .setDescription("Discord role to grant access to the ticket")
          )
          .addRoleOption((option) =>
            option
              .setName("role_two")
              .setDescription("Second role to grant access to the ticket")
          )
          .addRoleOption((option) =>
            option
              .setName("role_three")
              .setDescription("Third role to grant access to the ticket")
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove")
          .setDescription("Remove a user or role(s) from the current ticket.")
          .addUserOption((option) =>
            option
              .setName("user")
              .setDescription("Discord user to remove from the ticket")
          )
          .addRoleOption((option) =>
            option
              .setName("role")
              .setDescription("Discord role to remove from the ticket")
          )
          .addRoleOption((option) =>
            option
              .setName("role_two")
              .setDescription("Second role to remove from the ticket")
          )
          .addRoleOption((option) =>
            option
              .setName("role_three")
              .setDescription("Third role to remove from the ticket")
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("status")
          .setDescription("Update the status of the current ticket.")
          .addStringOption((option) =>
            option
              .setName("state")
              .setDescription("Status to apply")
              .setRequired(true)
              .addChoices(
                { name: "Open", value: "open" },
                { name: "Pending", value: "pending" },
                { name: "Closed", value: "closed" },
                { name: "Locked", value: "locked" },
                { name: "Unlocked", value: "unlocked" },
                { name: "Escalated", value: "escalated" },
                { name: "Deescalated", value: "deescalated" }
              )
          )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("close").setDescription("Close the current ticket.")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("manual")
          .setDescription("Staff: create an uncategorised ticket for a user.")
          .addUserOption((option) =>
            option
              .setName("user")
              .setDescription("Discord user the ticket is for")
              .setRequired(true)
          )
          .addStringOption((option) =>
            option
              .setName("subject")
              .setDescription("Ticket subject")
              .setRequired(true)
          )
          .addStringOption((option) =>
            option
              .setName("description")
              .setDescription("Ticket description")
              .setRequired(true)
          )
          .addRoleOption((option) =>
            option
              .setName("role")
              .setDescription("Additional role to give access to the ticket")
          )
          .addRoleOption((option) =>
            option
              .setName("role_two")
              .setDescription("Second role to give access to the ticket")
          )
          .addRoleOption((option) =>
            option
              .setName("role_three")
              .setDescription("Third role to give access to the ticket")
          )
      );

    registry.registerChatInputCommand(builder);
  }

  async chatInputRun(interaction) {
    try {
      return await this._handleSubcommand(interaction);
    } catch (error) {
      console.error("ticket command: unhandled error", error);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: "Something went wrong while processing that command." });
        } else {
          await interaction.reply({ content: "Something went wrong while processing that command.", ephemeral: true });
        }
      } catch (replyError) {
        console.error("ticket command: failed to send error reply", replyError);
      }
    }
  }

  async _handleSubcommand(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "create" || subcommand === "submit") {
      return startTicketFlow(interaction);
    }

    if (subcommand === "add") {
      const userOption = interaction.options.getUser("user");
      const roleOptions = [
        interaction.options.getRole("role"),
        interaction.options.getRole("role_two"),
        interaction.options.getRole("role_three"),
      ].filter((role, index, all) => role && all.findIndex((r) => r?.id === role.id) === index);

      if (!userOption && !roleOptions.length) {
        return interaction.reply({
          content: "Provide a user or role to add to this ticket.",
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });

      const ticketDetails = await getTicketDetailsByChannel(interaction.channel.id);

      if (!ticketDetails) {
        console.warn("ticket add: channel not linked to a ticket", {
          channelId: interaction.channel.id,
          channelName: interaction.channel.name,
          parentId: interaction.channel.parentId,
          guildId: interaction.guildId,
        });
        return interaction.editReply({
          content:
            "This channel is not linked to a ticket. Run this in the ticket's own channel — if you created the ticket on the website, its Discord channel may have failed to create (check the bot's permissions on the ticket category).",
        });
      }

      const canAdd = await callerHasManageParticipants(interaction.user.id);

      if (!canAdd) {
        return interaction.editReply({ content: "You need the manage participants permission to update ticket access." });
      }

      const additions = [];
      const staffUserId = await getUserIdByDiscordId(interaction.user.id);

      if (userOption) {
        let targetUserId = await getUserIdByDiscordId(userOption.id);

        if (!targetUserId) {
          try {
            targetUserId = await createUnlinkedUser(userOption.id, userOption.username);
          } catch (userCreateError) {
            console.error("ticket add: failed to create placeholder user", userCreateError);
          }
        }

        if (targetUserId) {
          try {
            await addTicketUserParticipant(ticketDetails.ticketId, { userId: targetUserId });
            additions.push(`Added user ${userOption.tag}`);
            if (staffUserId) {
              await createSupportTicketMessage(
                interaction.client,
                ticketDetails.ticketId,
                staffUserId,
                `${interaction.user.tag} added user ${userOption.tag} to this ticket.`,
                "discord",
                { messageType: "status" }
              );
            }
            // Directly grant channel access using the Discord user ID from the slash command
            try {
              await interaction.channel.permissionOverwrites.edit(
                userOption.id,
                {
                  ViewChannel: true,
                  SendMessages: true,
                  AttachFiles: true,
                  ReadMessageHistory: true,
                },
                { type: OverwriteType.Member },
              );
            } catch (permError) {
              console.error("ticket add: failed to set channel permissions for user", {
                targetUserId: userOption.id,
                channelId: interaction.channel.id,
                discordCode: permError?.code,
                status: permError?.status,
                message: permError?.message,
              });
              additions.push(
                `Warning: could not grant ${userOption.tag} channel access (${permError?.code ?? permError?.message ?? "unknown error"}).`
              );
            }
            await interaction.channel.send(`✅ ${interaction.user.tag} added ${userOption.tag} to this ticket.`);
          } catch (userAddError) {
            console.error("ticket add: failed to add user participant", userAddError);
            additions.push(`Failed to add ${userOption.tag}`);
          }
        } else {
          additions.push(`Unable to add ${userOption.tag} (no linked account).`);
        }
      }

      for (const roleOption of roleOptions) {
        try {
          await addTicketGroupParticipant(ticketDetails.ticketId, {
            id: roleOption.id,
            name: roleOption.name,
            rankSlug: null,
            badgeColor: null,
            textColor: null,
          });
          additions.push(`Added role ${roleOption.name}`);
          if (staffUserId) {
            await createSupportTicketMessage(
              interaction.client,
              ticketDetails.ticketId,
              staffUserId,
              `${interaction.user.tag} added role ${roleOption.name} to this ticket.`,
              "discord",
              { messageType: "status" }
            );
          }
          // Directly grant channel access using the Discord role ID from the slash command
          try {
            await interaction.channel.permissionOverwrites.edit(
              roleOption.id,
              {
                ViewChannel: true,
                SendMessages: true,
                AttachFiles: true,
                ReadMessageHistory: true,
              },
              { type: OverwriteType.Role },
            );
          } catch (permError) {
            console.error("ticket add: failed to set channel permissions for role", {
              roleId: roleOption.id,
              roleName: roleOption.name,
              channelId: interaction.channel.id,
              discordCode: permError?.code,
              status: permError?.status,
              message: permError?.message,
            });
            additions.push(
              `Warning: could not grant ${roleOption.name} channel access (${permError?.code ?? permError?.message ?? "unknown error"}).`
            );
          }
          await interaction.channel.send(`✅ ${interaction.user.tag} added ${roleOption.name} to this ticket.`);
        } catch (roleAddError) {
          console.error("ticket add: failed to add role participant", {
            roleId: roleOption.id,
            roleName: roleOption.name,
            discordCode: roleAddError?.code,
            message: roleAddError?.message,
            stack: roleAddError?.stack,
          });
          additions.push(`Failed to add role ${roleOption.name} (${roleAddError?.code ?? roleAddError?.message ?? "unknown error"})`);
        }
      }

      try {
        await applyTicketParticipantPermissions(interaction.client, ticketDetails.ticketId);
      } catch (permissionError) {
        console.error("ticket add: failed to apply participant permissions", {
          ticketId: ticketDetails.ticketId,
          discordCode: permissionError?.discordCode ?? permissionError?.cause?.code,
          message: permissionError?.message,
        });
        additions.push(
          `Warning: could not refresh channel permissions (${permissionError?.discordCode ?? permissionError?.cause?.code ?? "unknown"}). Check the bot's Manage Permissions on the ticket category.`
        );
      }

      return interaction.editReply({
        content: additions.join("\n") || "No changes applied.",
      });
    }

    if (subcommand === "remove") {
      const userOption = interaction.options.getUser("user");
      const roleOptions = [
        interaction.options.getRole("role"),
        interaction.options.getRole("role_two"),
        interaction.options.getRole("role_three"),
      ].filter((role, index, all) => role && all.findIndex((r) => r?.id === role.id) === index);

      if (!userOption && !roleOptions.length) {
        return interaction.reply({
          content: "Provide a user or role to remove from this ticket.",
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });

      const ticketDetails = await getTicketDetailsByChannel(interaction.channel.id);

      if (!ticketDetails) {
        return interaction.editReply({ content: "This channel is not linked to a ticket." });
      }

      const canRemove = await callerHasManageParticipants(interaction.user.id);

      if (!canRemove) {
        return interaction.editReply({ content: "You need the manage participants permission to update ticket access." });
      }

      const removals = [];
      const staffUserId = await getUserIdByDiscordId(interaction.user.id);

      if (userOption) {
        const targetUserId = await getUserIdByDiscordId(userOption.id);
        if (!targetUserId) {
          removals.push(`Unable to remove ${userOption.tag} (no linked account).`);
        } else {
          try {
            await removeTicketUserParticipant(ticketDetails.ticketId, targetUserId);
            if (userOption.id) {
              await removeTicketParticipantPermissions(interaction.client, ticketDetails.ticketId, {
                discordIds: [userOption.id],
              });
            }
            removals.push(`Removed user ${userOption.tag}`);
            if (staffUserId) {
              try {
                await createSupportTicketMessage(
                  interaction.client,
                  ticketDetails.ticketId,
                  staffUserId,
                  `${interaction.user.tag} removed user ${userOption.tag} from this ticket.`,
                  "discord",
                  { messageType: "status" }
                );
                await interaction.channel.send(
                  `🔒 ${interaction.user.tag} removed ${userOption.tag} from this ticket.`
                );
              } catch (messageError) {
                console.error("ticket remove: failed to log user removal", messageError);
              }
            }
          } catch (userRemoveError) {
            console.error("ticket remove: failed to remove user participant", userRemoveError);
            removals.push(`Failed to remove ${userOption.tag}`);
          }
        }
      }

      for (const roleOption of roleOptions) {
        try {
          await removeTicketGroupParticipant(ticketDetails.ticketId, roleOption.id);
          await removeTicketParticipantPermissions(interaction.client, ticketDetails.ticketId, {
            roleIds: [roleOption.id],
          });
          removals.push(`Removed role ${roleOption.name}`);
          if (staffUserId) {
            try {
              await createSupportTicketMessage(
                interaction.client,
                ticketDetails.ticketId,
                staffUserId,
                `${interaction.user.tag} removed role ${roleOption.name} from this ticket.`,
                "discord",
                { messageType: "status" }
              );
              await interaction.channel.send(
                `🔒 ${interaction.user.tag} removed ${roleOption.name} from this ticket.`
              );
            } catch (messageError) {
              console.error("ticket remove: failed to log role removal", messageError);
            }
          }
        } catch (roleRemoveError) {
          console.error("ticket remove: failed to remove role participant", roleRemoveError);
          removals.push(`Failed to remove role ${roleOption.name}`);
        }
      }

      return interaction.editReply({
        content: removals.join("\n") || "No changes applied.",
      });
    }

    if (subcommand === "status") {
      const state = interaction.options.getString("state", true);

      const ticketDetails = await getTicketDetailsByChannel(interaction.channel.id);

      if (!ticketDetails) {
        return interaction.reply({
          content: "This channel is not linked to a ticket.",
          ephemeral: true,
        });
      }

      const categoryStaffRoles = await getCategoryPermissions(ticketDetails.categoryId);
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const hasPermission =
        member.permissions.has(PermissionFlagsBits.ManageChannels) ||
        member.roles.cache.some((role) => categoryStaffRoles.includes(role.id));

      if (!hasPermission) {
        return interaction.reply({
          content: "You need support staff permissions to update ticket status.",
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });

      const username = interaction.user.tag;
      const staffUserId = await getUserIdByDiscordId(interaction.user.id);
      const statusMessages = {
        open: `Ticket reopened by ${username}`,
        closed: `Ticket closed by ${username}`,
        pending: `Ticket set to pending by ${username}`,
        locked: `Ticket locked by ${username}`,
        unlocked: `Ticket unlocked by ${username}`,
        escalated: `Ticket escalated by ${username}`,
        deescalated: `Ticket deescalated by ${username}`,
      };

      try {
        if (["open", "closed", "pending"].includes(state)) {
          await updateTicketStatus(ticketDetails.ticketId, state);
        }

        if (state === "locked" || state === "unlocked") {
          await setTicketLockState(ticketDetails.ticketId, state === "locked");
        }

        if (state === "escalated" || state === "deescalated") {
          await setTicketEscalationState(ticketDetails.ticketId, state === "escalated");
        }

        if (staffUserId) {
          await createSupportTicketMessage(
            interaction.client,
            ticketDetails.ticketId,
            staffUserId,
            statusMessages[state] || `Ticket status updated by ${username}`,
            "discord",
            { messageType: "status" }
          );
        }
        await interaction.channel.send(`📌 ${statusMessages[state] || `Ticket status updated by ${username}`}`);
      } catch (statusError) {
        console.error("ticket status: failed to update ticket state", statusError);
        return interaction.editReply({
          content: "Failed to update ticket status. Please try again.",
        });
      }

      if (state === "closed") {
        try {
          await deleteTicketChannel(
            interaction.client,
            ticketDetails.ticketId,
            "Ticket closed from Discord",
            interaction.channel
          );
        } catch (closeError) {
          console.error("ticket status: failed to close ticket channel", closeError);
        }
      }

      return interaction.editReply({
        content: `Updated ticket status to ${state}.`,
      });
    }

    if (subcommand === "close") {
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

      await interaction.deferReply({ ephemeral: true });

      const username = interaction.user.tag;
      const actorUserId = await getUserIdByDiscordId(interaction.user.id);

      try {
        await updateTicketStatus(ticketDetails.ticketId, "closed");

        if (actorUserId) {
          await createSupportTicketMessage(
            interaction.client,
            ticketDetails.ticketId,
            actorUserId,
            `Ticket closed by ${username}`,
            "discord",
            { messageType: "status" }
          );
        }
      } catch (statusError) {
        console.error("ticket close: failed to update ticket state", statusError);
        return interaction.editReply({
          content: "Failed to close ticket. Please try again.",
        });
      }

      // Best-effort channel announcement — the ticket is already closed, so a
      // missing-access / deleted channel here must not fail the whole command.
      try {
        await interaction.channel.send(`🔒 Ticket closed by ${username}. This channel will now close.`);
      } catch (announceError) {
        console.warn("ticket close: could not post close notice to channel", announceError?.message || announceError);
      }

      try {
        await interaction.editReply({ content: "Ticket closed." });
      } catch (replyError) {
        console.warn("ticket close: failed to edit reply", replyError);
      }

      try {
        const deleted = await deleteTicketChannel(
          interaction.client,
          ticketDetails.ticketId,
          "Ticket closed from Discord",
          interaction.channel
        );
        if (!deleted) {
          await interaction.followUp({
            content: "The ticket was closed, but the channel could not be deleted. Staff can retry the cleanup.",
            ephemeral: true,
          }).catch(() => {});
        }
      } catch (closeError) {
        console.error("ticket close: failed to close ticket channel", closeError);
      }

      return null;
    }

    if (subcommand === "manual") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels)) {
        return interaction.reply({
          content: "You need Manage Channels permission to create a manual ticket.",
          ephemeral: true,
        });
      }

      const targetUser = interaction.options.getUser("user", true);
      const subject = interaction.options.getString("subject", true);
      const description = interaction.options.getString("description", true);

      const requestedRoles = [
        interaction.options.getRole("role"),
        interaction.options.getRole("role_two"),
        interaction.options.getRole("role_three"),
      ].filter(Boolean);

      let ownerUserId = await getUserIdByDiscordId(interaction.user.id);

      if (!ownerUserId) {
        try {
          ownerUserId = await createUnlinkedUser(interaction.user.id, interaction.user.username);
        } catch (userCreateError) {
          console.error("ticket manual: failed to create owner placeholder user", userCreateError);
        }
      }

      if (!ownerUserId) {
        return interaction.reply({
          content: "Unable to link your account to a ticket record. Please try again.",
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });

      let targetUserId = await getUserIdByDiscordId(targetUser.id);

      if (!targetUserId) {
        try {
          targetUserId = await createUnlinkedUser(targetUser.id, targetUser.username);
        } catch (userCreateError) {
          console.error("ticket manual: failed to create placeholder user", userCreateError);
        }
      }

      if (!targetUserId) {
        return interaction.editReply({
          content: "Unable to link that user to a ticket record. Please try again.",
        });
      }

      let categoryId;
      try {
        categoryId = await ensureUncategorisedCategory();
      } catch (categoryError) {
        console.error("ticket manual: failed to resolve uncategorised category", categoryError);
        return interaction.editReply({
          content: "Couldn't prepare an uncategorised ticket. Please try again later.",
        });
      }

      const staffRoleIds = requestedRoles.map((role) => role.id);

      let ticketRecord;
      try {
        ticketRecord = await createSupportTicket(
          interaction.client,
          ownerUserId,
          categoryId,
          subject,
          {
            discordUserId: interaction.user.id,
            staffRoleIds,
            parentCategoryId: false,
          }
        );
      } catch (ticketError) {
        console.error("ticket manual: failed to create ticket", ticketError);
        return interaction.editReply({
          content: "Couldn't create that ticket right now. Please try again shortly.",
        });
      }

      const { ticketId, channel } = ticketRecord;

      try {
        await addTicketUserParticipant(ticketId, { userId: targetUserId });
      } catch (participantError) {
        console.error("ticket manual: failed to add user participant", participantError);
      }

      for (const role of requestedRoles) {
        try {
          await addTicketGroupParticipant(ticketId, {
            id: role.id,
            name: role.name,
            rankSlug: null,
            badgeColor: null,
            textColor: null,
          });
        } catch (participantError) {
          console.error("ticket manual: failed to add role participant", participantError);
        }
      }

      try {
        await applyTicketParticipantPermissions(interaction.client, ticketId);
      } catch (permissionError) {
        console.error("ticket manual: failed to apply participant permissions", permissionError);
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
          ownerUserId,
          description,
          "discord"
        );
      } catch (messageError) {
        console.error("ticket manual: failed to log ticket description", messageError);
      }

      const ticketEmbed = new EmbedBuilder()
        .setTitle(`Ticket #${ticketId}: ${subject}`)
        .setDescription(description)
        .addFields(
          { name: "Opened by", value: `${interaction.user.tag} (<@${interaction.user.id}>)` },
          { name: "Added user", value: `${targetUser.tag} (<@${targetUser.id}>)` },
          { name: "Category", value: "Uncategorised" },
          { name: "Created by", value: `${interaction.user.tag}` }
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

      try {
        const message = await channel.send({
          content: `<@${targetUser.id}> a ticket has been created by ${interaction.user.tag}.`,
          embeds: [ticketEmbed],
          components: [new ActionRowBuilder().addComponents(viewOnlineButton, closeButton)],
        });

        try {
          await message.pin();
        } catch (pinError) {
          console.error("ticket manual: failed to pin opener message", pinError);
        }
      } catch (channelError) {
        console.error("ticket manual: failed to post opener message", channelError);
      }

      return interaction.editReply({
        content: `Ticket created in ${channel} with reference #${ticketId}.`,
      });
    }

    if (subcommand === "panel") {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels)) {
        return interaction.reply({
          content: "You need Manage Channels permission to post a ticket panel.",
          ephemeral: true,
        });
      }

      const configuredPanelChannelId =
        config.discord?.supportPanelChannelId ?? process.env.SUPPORT_CHANNEL_ID;
      const configuredTicketCategoryId =
        config.discord?.supportTicketCategoryId ?? process.env.SUPPORT_CATEGORY_ID;

      const suppliedChannel = interaction.options.getChannel("channel");
      const suppliedCategory = interaction.options.getChannel("ticket_category");

      let targetChannel = suppliedChannel ?? null;

      if (!targetChannel && configuredPanelChannelId) {
        try {
          targetChannel = await interaction.client.channels.fetch(
            configuredPanelChannelId
          );
        } catch (error) {
          console.warn("ticket panel config channel fetch failed", error);
        }
      }

      if (!targetChannel) {
        targetChannel = interaction.channel;
      }

      let ticketCategory = suppliedCategory ?? null;

      if (!ticketCategory && configuredTicketCategoryId) {
        try {
          ticketCategory = await interaction.client.channels.fetch(
            configuredTicketCategoryId
          );
        } catch (error) {
          console.warn("ticket panel config category fetch failed", error);
        }
      }

      const parentCategoryId = ticketCategory?.id ?? configuredTicketCategoryId ?? "";

      const createButton = new ButtonBuilder()
        .setCustomId(
          parentCategoryId ? `support_ticket_open:${parentCategoryId}` : "support_ticket_open"
        )
        .setLabel("Create Ticket")
        .setStyle(ButtonStyle.Primary);

      const infoEmbed = new EmbedBuilder()
        .setTitle("Need help? Open a ticket")
        .setDescription(
          [
            "Submit your issue privately to the support team.",
            "\n**How it works:**",
            "• Click **Create Ticket** to choose a category.",
            "• Fill out the subject and description in the modal form.",
            "• A private channel will be created for you and our staff.",
            "• Use the Close button in the ticket to wrap up when you're done.",
          ].join("\n")
        )
        .setColor(0x2b6cb0);

      await targetChannel.send({
        embeds: [infoEmbed],
        components: [new ActionRowBuilder().addComponents(createButton)],
      });

      return interaction.reply({
        content: `Posted a Create Ticket panel in ${targetChannel} using the ${
          ticketCategory ? `\`${ticketCategory.name}\`` : "default"
        } ticket category.`,
        ephemeral: true,
      });
    }
  }
}
