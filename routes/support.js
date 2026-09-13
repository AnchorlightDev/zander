import { getWebAnnouncement } from "../controllers/announcementController.js";
import { isFeatureWebRouteEnabled, getGlobalImage, setBannerCookie } from "../api/common.js";
import {
  getSupportCategories,
  createSupportTicket,
  createSupportTicketMessage,
  getTicketsAccessibleByUser,
  getTicketById,
  getTicketMessages,
  getTicketParticipants,
  getLuckPermRankRoles,
  findUserByIdentifier,
  addTicketUserParticipant,
  addTicketGroupParticipant,
  removeTicketUserParticipant,
  removeTicketGroupParticipant,
  applyTicketParticipantPermissions,
  removeTicketParticipantPermissions,
  syncParticipantsForMessage,
  updateTicketStatus,
  deleteTicketChannel,
  recreateTicketChannel,
  getCategoryName,
  getCategoryById,
  getCategoryPermissions,
  setTicketLockState,
  setTicketEscalationState,
  searchUsersByUsername,
  getUserById,
  updateTicketCategory,
  ensureUncategorisedCategory,
} from "../controllers/supportTicketController.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";

export default function supportRoutes(
  app,
  client,
  fetch,
  moment,
  config,
  db,
  features,
  lang
) {
  const userHasPermissionNode = (permissions = [], node) => {
    const normalized = permissions || [];
    return normalized.some((permission) => {
      if (!permission) return false;
      if (permission === "*") return true;
      if (permission === node) return true;
      if (permission.endsWith(".*")) {
        const base = permission.slice(0, -2);
        return node === base || node.startsWith(`${base}.`);
      }
      return false;
    });
  };

  app.get("/support", async function (req, res) {
    try {
      if (!req.session.user) {
          res.header("content-type", "text/html; charset=utf-8").send(
            await app.view("modules/support/login", {
              pageTitle: "Support Tickets",
              pageDescription: "Support Tickets",
              config,
              req,
              features,
              globalImage: await getGlobalImage(),
              announcementWeb: await getWebAnnouncement(),
          }));
          return;
      }

      const userRankSlugs = req.session.user.ranks?.map((rank) => rank.rankSlug) || [];
      const tickets = await getTicketsAccessibleByUser(req.session.user.userId, userRankSlugs);

      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("modules/support/index", {
        pageTitle: "Support Tickets",
        pageDescription: "Support Tickets",
        config,
        req,
        features,
        tickets,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    } catch (error) {
      console.error(error);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
        pageTitle: "Error",
        pageDescription: "Error",
        config,
        req,
        error,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }
  });

  app.post("/appeal", async function (req, res) {
    try {
      if (!req.session.user) {
        const returnTo = encodeURIComponent(req.url);
        return res.redirect(`/login?returnTo=${returnTo}`);
      }

      const { punishmentIndex, appealReason, appealDetails } = req.body;
      const index = Number.parseInt(punishmentIndex, 10);
      const reason = (appealReason || "").trim();
      const details = (appealDetails || "").trim();

      if (!Number.isInteger(index) || index < 0) {
        setBannerCookie("warning", "Please select a punishment to appeal.", res);
        return res.redirect("/appeal");
      }

      if (!reason) {
        setBannerCookie("warning", "Please provide a reason for your appeal.", res);
        return res.redirect("/appeal");
      }

      const fetchPunishmentsURL = `${process.env.siteAddress}/api/user/punishments?username=${encodeURIComponent(
        req.session.user.username
      )}`;
      const punishmentsResponse = await fetch(fetchPunishmentsURL, {
        headers: { "x-access-token": process.env.apiKey },
      });
      const appealPunishmentsApiData = await punishmentsResponse.json();
      const punishments = Array.isArray(appealPunishmentsApiData.data)
        ? appealPunishmentsApiData.data
        : [];
      const punishment = punishments[index];

      if (!punishment) {
        setBannerCookie("warning", "We couldn't find that punishment to appeal.", res);
        return res.redirect("/appeal");
      }

      const fallbackKey = moment(punishment.dateStart).isValid()
        ? `${punishment.type || "unknown"}-${moment(punishment.dateStart).valueOf()}`
        : String(index);
      const punishmentKey = String(
        punishment.id || punishment.punishmentId || punishment.punishment_id || fallbackKey
      );
      const userRankSlugs =
        req.session.user.ranks?.map((rank) => rank.rankSlug) || [];
      const tickets = await getTicketsAccessibleByUser(
        req.session.user.userId,
        userRankSlugs
      );
      const existingTicket = (tickets || []).find((ticket) => {
        if (ticket.status === "closed") return false;
        return String(ticket.title || "").includes(`Appeal #${punishmentKey}`);
      });
      if (existingTicket) {
        setBannerCookie(
          "warning",
          "You already have an appeal in progress for this punishment.",
          res
        );
        return res.redirect(`/support/ticket/${existingTicket.ticketId}`);
      }

      const punishedBy = punishment.bannedByUsername || punishment.bannedByUuid || "System";
      const dateLabel = moment(punishment.dateStart).isValid()
        ? moment(punishment.dateStart).format("LLL")
        : "Unknown date";
      let expiryLabel = "—";
      if (punishment.type === "ban") {
        if (moment(punishment.dateEnd).isValid()) {
          expiryLabel = moment(punishment.dateEnd).isAfter(moment())
            ? moment(punishment.dateEnd).fromNow(true)
            : "Expired";
        } else {
          expiryLabel = "Permanent";
        }
      }

      const title = `Appeal #${punishmentKey} - ${punishment.type || "unknown"} - ${dateLabel}`;
      const categoryId = await ensureUncategorisedCategory();
      const staffRoleIds = await getCategoryPermissions(categoryId);
      const categoryName = await getCategoryName(categoryId);
      const ticketRecord = await createSupportTicket(
        client,
        req.session.user.userId,
        categoryId,
        title,
        {
          discordUserId: req.session.user.discordId,
          staffRoleIds,
        }
      );

      const message = [
        "Punishment Appeal Submitted",
        "",
        `Punished By: ${punishedBy}`,
        `Type: ${punishment.type || "Unknown"}`,
        `Reason: ${punishment.reason || "No reason provided."}`,
        `Start: ${dateLabel}`,
        `Expires: ${expiryLabel}`,
        "",
        "Appeal Reason:",
        reason,
        "",
        "Additional Information:",
        details || "N/A",
      ].join("\n");

      await createSupportTicketMessage(
        client,
        ticketRecord.ticketId,
        req.session.user.userId,
        message,
        "web",
        { skipDiscordPost: true }
      );

      await syncParticipantsForMessage(client, ticketRecord.ticketId, {
        userId: req.session.user.userId,
        rankSlugs: req.session.user.ranks?.map((rank) => rank.rankSlug) || [],
      });

      if (punishment.bannedByUserId && punishment.bannedByUserId !== req.session.user.userId) {
        try {
          await addTicketUserParticipant(ticketRecord.ticketId, {
            userId: punishment.bannedByUserId,
          });
          await applyTicketParticipantPermissions(client, ticketRecord.ticketId);
        } catch (participantError) {
          console.error("Failed to add punished-by participant to appeal ticket", participantError);
        }
      }

      if (ticketRecord.channel) {
        const siteBaseUrl =
          (config.siteConfiguration && config.siteConfiguration.siteUrl) ||
          process.env.SITE_URL ||
          "https://craftingforchrist.net";
        const normalizedSiteUrl = siteBaseUrl.endsWith("/")
          ? siteBaseUrl.slice(0, -1)
          : siteBaseUrl;
        const ticketUrl = `${normalizedSiteUrl}/support/ticket/${ticketRecord.ticketId}`;

        const ticketEmbed = new EmbedBuilder()
          .setTitle(`Appeal Ticket #${ticketRecord.ticketId}`)
          .setDescription(message)
          .addFields(
            { name: "Opened by", value: `${req.session.user.username || "Web user"}` },
            { name: "Punished by", value: `${punishedBy}` },
            { name: "Category", value: categoryName || "Uncategorized" }
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
          const createdMessage = await ticketRecord.channel.send({
            content: req.session.user.discordId
              ? `<@${req.session.user.discordId}> your appeal ticket has been created.`
              : "An appeal ticket has been created.",
            embeds: [ticketEmbed],
            components: [new ActionRowBuilder().addComponents(viewOnlineButton, closeButton)],
          });

          try {
            await createdMessage.pin();
          } catch (pinError) {
            console.error("Failed to pin appeal ticket opener message", pinError);
          }
        } catch (channelError) {
          console.error("Failed to send appeal ticket embed", channelError);
        }
      }

      setBannerCookie("success", "Your appeal has been submitted.", res);
      return res.redirect(`/support/ticket/${ticketRecord.ticketId}`);
    } catch (error) {
      console.error(error);
      setBannerCookie("danger", "We couldn't submit your appeal. Please try again.", res);
      return res.redirect("/appeal");
    }
  });

  app.get("/support/ticket/:id", async function (req, res) {
    try {
      if (!req.session.user) {
        const returnTo = encodeURIComponent(req.url);
        return res.redirect(`/login?returnTo=${returnTo}`);
      }

      const isMinecraftLinked = Boolean(req.session.user.uuid);

      const ticket = await getTicketById(req.params.id);
      if (!ticket) {
        setBannerCookie("danger", "Ticket not found.", res);
        return res.redirect("/support");
      }
      const participants = await getTicketParticipants(req.params.id);
      const rankOptions = await getLuckPermRankRoles();
      const ownerUser = await getUserById(ticket.userId);

      const isOwner = Number(ticket.userId) === Number(req.session.user.userId);
      const isStaff = req.session.user.isStaff;
      const permissions = req.session.user.permissions || [];
      const canEscalate = userHasPermissionNode(permissions, "zander.web.ticket.escalate");
      const canReplyDuringEscalation = !ticket.isEscalated || isOwner || canEscalate;
      const canManageLock = isStaff;
      const userRankSlugs = req.session.user.ranks?.map((rank) => rank.rankSlug) || [];
      const isParticipantUser = participants.users.some(
        (participant) => participant.userId === req.session.user.userId
      );
      const isParticipantRank = userRankSlugs.some((slug) =>
        participants.groups.some((group) => group.rankSlug === slug)
      );
      const isAppeal = /Appeal #/i.test(ticket.title || "");
      const canManageParticipants = userHasPermissionNode(permissions, "zander.web.tickets.manageparticipants") || !isAppeal;
      const canManageTicket = isOwner || isStaff || isParticipantUser || isParticipantRank;

      if (!canManageTicket) {
        return res.redirect("/support");
      }

      const messages = await getTicketMessages(req.params.id, isStaff);
      const categories = await getSupportCategories();

      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("modules/support/ticket", {
        pageTitle: `Ticket #${ticket.ticketId}`,
        pageDescription: `Ticket #${ticket.ticketId}`,
        config,
        req,
        features,
        ticket,
        messages,
        participants,
        rankOptions,
        ownerUser,
        isOwner,
        isStaff,
        isMinecraftLinked,
        canManageTicket,
        canManageParticipants,
        isAppeal,
        canEscalate,
        canReplyDuringEscalation,
        canManageLock,
        categories,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    } catch (error) {
      console.error(error);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
        pageTitle: "Error",
        pageDescription: "Error",
        config,
        req,
        error,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }
  });

  app.post("/support/ticket/:id", async function (req, res) {
    try {
      if (!req.session.user) {
        const returnTo = encodeURIComponent(req.url);
        return res.redirect(`/login?returnTo=${returnTo}`);
      }

      if (!req.session.user.uuid) {
        setBannerCookie(
          "warning",
          "Your Minecraft account is not linked. Visit /register/minecraft to link it before replying.",
          res
        );
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      const ticket = await getTicketById(req.params.id);
      const participants = await getTicketParticipants(req.params.id);
      const userRankSlugs = req.session.user.ranks?.map((rank) => rank.rankSlug) || [];
      const isOwner = Number(ticket.userId) === Number(req.session.user.userId);
      const isStaff = req.session.user.isStaff;
      const permissions = req.session.user.permissions || [];
      const canEscalate = userHasPermissionNode(permissions, "zander.web.ticket.escalate");
      const isParticipantUser = participants.users.some(
        (participant) => participant.userId === req.session.user.userId
      );
      const isParticipantRank = userRankSlugs.some((slug) =>
        participants.groups.some((group) => group.rankSlug === slug)
      );

      if (!isOwner && !isStaff && !isParticipantUser && !isParticipantRank) {
        return res.redirect("/support");
      }

      if (ticket.isEscalated && !isOwner && !canEscalate) {
        setBannerCookie("warning", "This ticket is escalated. Only the opener and escalation staff may reply.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      const body = req.body || {};
      const message = (body.message || "").trim();
      const visibility = (body.visibility || "public").toLowerCase();
      const isInternal = visibility === "internal" && isStaff;
      if (visibility === "internal" && !isStaff) {
        setBannerCookie(
          "warning",
          "Only staff can add internal notes; your reply was sent as a public message.",
          res
        );
      }
      if (!message) {
        setBannerCookie("warning", "Please enter a message before replying.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      console.info("Submitting web ticket reply", {
        ticketId: req.params.id,
        userId: req.session.user.userId,
        messageLength: message.length,
      });

      let messageId;
      try {
        messageId = await createSupportTicketMessage(
          client,
          req.params.id,
          req.session.user.userId,
          message,
          "web",
          { isInternal }
        );
      } catch (createError) {
        console.error("Failed to create support ticket message", {
          ticketId: req.params.id,
          userId: req.session.user.userId,
        }, createError);
        setBannerCookie("danger", "Unable to submit your reply right now. Please try again.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      console.info("Web ticket reply persisted", {
        ticketId: req.params.id,
        userId: req.session.user.userId,
        messageId,
        isInternal,
      });

      await syncParticipantsForMessage(client, ticket.ticketId, {
        userId: req.session.user.userId,
        rankSlugs: userRankSlugs,
      });

      console.info("Completed web ticket reply", {
        ticketId: req.params.id,
        userId: req.session.user.userId,
      });

      return res.redirect(`/support/ticket/${req.params.id}`);
    } catch (error) {
      console.error(error);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
        pageTitle: "Error",
        pageDescription: "Error",
        config,
        req,
        error,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }
  });

  app.post("/support/ticket/:id/status", async function (req, res) {
    try {
      if (!req.session.user) {
        const returnTo = encodeURIComponent(req.url);
        return res.redirect(`/login?returnTo=${returnTo}`);
      }

      const ticket = await getTicketById(req.params.id);
      if (!ticket) {
        setBannerCookie("danger", "Ticket not found.", res);
        return res.redirect("/support");
      }
      const isOwner = Number(ticket.userId) === Number(req.session.user.userId);
      const isStaff = req.session.user.isStaff;
      const username = req.session.user.username || `User ${req.session.user.userId}`;

      if (!isOwner && !isStaff) {
        setBannerCookie("danger", "You do not have access to this ticket.", res);
        return res.redirect("/support");
      }

      const nextStatus = (req.body.status || "").toLowerCase();
      if (!["open", "closed", "pending"].includes(nextStatus)) {
        setBannerCookie("warning", "Invalid ticket status provided.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      // Non-staff owners can only close or reopen, not set to pending
      if (!isStaff && nextStatus === "pending") {
        setBannerCookie("warning", "Only staff can set a ticket to pending.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      if (ticket.isLocked && nextStatus === "open" && !isStaff) {
        setBannerCookie(
          "warning",
          "This ticket is locked and can only be reopened by staff.",
          res
        );
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      await updateTicketStatus(ticket.ticketId, nextStatus);

      const statusMessage = nextStatus === "closed"
        ? `Ticket closed by ${username}`
        : nextStatus === "pending"
        ? `Ticket set to pending by ${username}`
        : `Ticket reopened by ${username}`;
      try {
        await createSupportTicketMessage(client, ticket.ticketId, req.session.user.userId, statusMessage, "web", {
          messageType: "status",
        });
      } catch (statusLogError) {
        console.error("Failed to persist status change message", statusLogError);
      }

      if (nextStatus === "closed") {
        await deleteTicketChannel(client, ticket.ticketId, "Ticket closed from web view");
        setBannerCookie("success", "Ticket closed and channel cleanup scheduled.", res);
      } else if (nextStatus === "open") {
        let needsChannel = !ticket.discordChannelId;

        if (!needsChannel && client) {
          try {
            await client.channels.fetch(ticket.discordChannelId);
          } catch (fetchError) {
            console.warn("ticket reopen: stored channel missing, recreating", fetchError);
            needsChannel = true;
          }
        }

        if (needsChannel) {
          try {
            await recreateTicketChannel(client, ticket.ticketId);
          } catch (recreateError) {
            console.error("Failed to recreate ticket channel on reopen", recreateError);
            setBannerCookie(
              "danger",
              "Ticket reopened, but we couldn't recreate the Discord channel.",
              res
            );
            return res.redirect(`/support/ticket/${req.params.id}`);
          }
        }

        setBannerCookie("success", "Ticket reopened.", res);
      } else if (nextStatus === "pending") {
        setBannerCookie("success", "Ticket marked as pending.", res);
      }

      return res.redirect(`/support/ticket/${req.params.id}`);
    } catch (error) {
      console.error(error);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
        pageTitle: "Error",
        pageDescription: "Error",
        config,
        req,
        error,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }
  });

  app.post("/support/ticket/:id/category", async function (req, res) {
    try {
      if (!req.session.user) {
        const returnTo = encodeURIComponent("/appeal");
        return res.redirect(`/login?returnTo=${returnTo}`);
      }

      const ticket = await getTicketById(req.params.id);
      if (!ticket) {
        setBannerCookie("danger", "Ticket not found.", res);
        return res.redirect("/support");
      }

      if (!req.session.user.isStaff) {
        setBannerCookie("danger", "Only staff can reassign tickets.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      const nextCategoryId = parseInt(req.body?.categoryId, 10);
      if (!nextCategoryId || Number.isNaN(nextCategoryId)) {
        setBannerCookie("warning", "Select a valid category to reassign.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      const [nextCategory, previousCategory] = await Promise.all([
        getCategoryById(nextCategoryId),
        getCategoryById(ticket.categoryId),
      ]);

      if (!nextCategory || nextCategory.enabled === 0) {
        setBannerCookie("warning", "That category is not available.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      if (ticket.categoryId === nextCategoryId) {
        setBannerCookie("info", "Ticket is already in that category.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      await updateTicketCategory(client, ticket.ticketId, nextCategoryId);

      try {
        await createSupportTicketMessage(
          client,
          ticket.ticketId,
          req.session.user.userId,
          `${req.session.user.username || "Staff"} moved this ticket from ${
            previousCategory?.name || `Category ${ticket.categoryId}`
          } to ${nextCategory.name}`,
          "web",
          { messageType: "status" }
        );
      } catch (categoryLogError) {
        console.error("Failed to log category change", categoryLogError);
      }

      setBannerCookie("success", "Ticket category updated.", res);
      return res.redirect(`/support/ticket/${ticket.ticketId}`);
    } catch (error) {
      console.error(error);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
        pageTitle: "Error",
        pageDescription: "Error",
        config,
        req,
        error,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }
  });

  app.post("/support/ticket/:id/escalation", async function (req, res) {
    try {
      if (!req.session.user) {
        return res.redirect("/login");
      }

      const ticket = await getTicketById(req.params.id);
      const isStaff = req.session.user.isStaff;
      const permissions = req.session.user.permissions || [];

      if (!isStaff || !userHasPermissionNode(permissions, "zander.web.ticket.escalate")) {
        setBannerCookie("danger", "You do not have permission to escalate this ticket.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      const action = (req.body?.action || "").toLowerCase();
      if (!["escalate", "deescalate"].includes(action)) {
        setBannerCookie("warning", "Invalid escalation request.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      const shouldEscalate = action === "escalate";
      await setTicketEscalationState(ticket.ticketId, shouldEscalate);

      try {
        await createSupportTicketMessage(
          client,
          ticket.ticketId,
          req.session.user.userId,
          shouldEscalate
            ? `${req.session.user.username || "Staff"} escalated this ticket`
            : `${req.session.user.username || "Staff"} deescalated this ticket`,
          "web",
          { messageType: "status" }
        );
      } catch (escalationLogError) {
        console.error("Failed to log escalation event", escalationLogError);
      }

      setBannerCookie(
        "success",
        shouldEscalate ? "Ticket escalated." : "Ticket deescalated.",
        res
      );
      return res.redirect(`/support/ticket/${ticket.ticketId}`);
    } catch (error) {
      console.error(error);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
        pageTitle: "Error",
        pageDescription: "Error",
        config,
        req,
        error,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }
  });

  app.post("/support/ticket/:id/lock", async function (req, res) {
    try {
      if (!req.session.user) {
        return res.redirect("/login");
      }

      const ticket = await getTicketById(req.params.id);
      const isStaff = req.session.user.isStaff;
      if (!isStaff) {
        setBannerCookie("danger", "You do not have permission to lock this ticket.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      const action = (req.body?.action || "").toLowerCase();
      if (!["lock", "unlock"].includes(action)) {
        setBannerCookie("warning", "Invalid lock request.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      const shouldLock = action === "lock";
      await setTicketLockState(ticket.ticketId, shouldLock);

      try {
        await createSupportTicketMessage(
          client,
          ticket.ticketId,
          req.session.user.userId,
          shouldLock
            ? `${req.session.user.username || "Staff"} locked this ticket`
            : `${req.session.user.username || "Staff"} unlocked this ticket`,
          "web",
          { messageType: "status" }
        );
      } catch (lockLogError) {
        console.error("Failed to log lock event", lockLogError);
      }

      setBannerCookie(
        "success",
        shouldLock ? "Ticket locked." : "Ticket unlocked.",
        res
      );
      return res.redirect(`/support/ticket/${ticket.ticketId}`);
    } catch (error) {
      console.error(error);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
        pageTitle: "Error",
        pageDescription: "Error",
        config,
        req,
        error,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }
  });

  app.post("/support/ticket/:id/add-user", async function (req, res) {
    try {
      if (!req.session.user) {
        return res.redirect("/login");
      }

      const ticket = await getTicketById(req.params.id);
      const participants = await getTicketParticipants(req.params.id);
      const userRankSlugs = req.session.user.ranks?.map((rank) => rank.rankSlug) || [];
      const isOwner = Number(ticket.userId) === Number(req.session.user.userId);
      const isStaff = req.session.user.isStaff;
      const isParticipantUser = participants.users.some(
        (participant) => participant.userId === req.session.user.userId
      );
      const isParticipantRank = userRankSlugs.some((slug) =>
        participants.groups.some((group) => group.rankSlug === slug)
      );
      const isAppealAddUser = /Appeal #/i.test(ticket.title || "");
      const hasMgParticipantsPermAddUser = userHasPermissionNode(req.session.user.permissions || [], "zander.web.tickets.manageparticipants");

      if (isAppealAddUser && !hasMgParticipantsPermAddUser) {
        return res.redirect("/support");
      }
      if (!hasMgParticipantsPermAddUser && !isOwner && !isStaff && !isParticipantUser && !isParticipantRank) {
        return res.redirect("/support");
      }

      const userIdentifier = (req.body?.userIdentifier || "").trim();
      const userIdFromForm = parseInt(req.body?.userId, 10);

      if (!userIdentifier && !userIdFromForm) {
        setBannerCookie("warning", "Provide a username or user ID to add.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      const user = userIdFromForm ? await getUserById(userIdFromForm) : await findUserByIdentifier(userIdentifier);
      if (!user) {
        setBannerCookie("danger", "User not found.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      await addTicketUserParticipant(ticket.ticketId, user);
      try {
        await applyTicketParticipantPermissions(client, ticket.ticketId);
      } catch (permissionError) {
        console.error("add-user: failed to apply participant permissions", {
          ticketId: ticket.ticketId,
          userId: user.userId,
          discordId: user.discordId,
          discordCode: permissionError?.discordCode ?? permissionError?.cause?.code,
          message: permissionError?.message,
        });
        setBannerCookie(
          "warning",
          `Added to ticket, but Discord channel access could not be granted (${permissionError?.discordCode ?? permissionError?.cause?.code ?? "unknown"}). Check the bot's Manage Permissions on the ticket category.`,
          res
        );
        return res.redirect(`/support/ticket/${ticket.ticketId}`);
      }
      try {
        await createSupportTicketMessage(
          client,
          ticket.ticketId,
          req.session.user.userId,
          `${req.session.user.username || "Staff"} added user ${user.username || user.userId} to this ticket.`,
          "web",
          { messageType: "status" }
        );
      } catch (messageError) {
        console.error("Failed to log add user event", messageError);
      }

      setBannerCookie("success", "User added to ticket.", res);
      return res.redirect(`/support/ticket/${ticket.ticketId}`);
    } catch (error) {
      console.error(error);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
        pageTitle: "Error",
        pageDescription: "Error",
        config,
        req,
        error,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }
  });

  app.post("/support/ticket/:id/add-group", async function (req, res) {
    try {
      if (!req.session.user) {
        return res.redirect("/login");
      }

      const ticket = await getTicketById(req.params.id);
      const participants = await getTicketParticipants(req.params.id);
      const userRankSlugs = req.session.user.ranks?.map((rank) => rank.rankSlug) || [];
      const isOwner = Number(ticket.userId) === Number(req.session.user.userId);
      const isStaff = req.session.user.isStaff;
      const isParticipantUser = participants.users.some(
        (participant) => participant.userId === req.session.user.userId
      );
      const isParticipantRank = userRankSlugs.some((slug) =>
        participants.groups.some((group) => group.rankSlug === slug)
      );
      const isAppealAddGroup = /Appeal #/i.test(ticket.title || "");
      const hasMgParticipantsPermAddGroup = userHasPermissionNode(req.session.user.permissions || [], "zander.web.tickets.manageparticipants");

      if (isAppealAddGroup && !hasMgParticipantsPermAddGroup) {
        return res.redirect("/support");
      }
      if (!hasMgParticipantsPermAddGroup && !isOwner && !isStaff && !isParticipantUser && !isParticipantRank) {
        return res.redirect("/support");
      }

      const rankOptions = await getLuckPermRankRoles();
      const selectedRoleId = req.body?.groupRoleId;
      const selectedRank = rankOptions.find((rank) => rank.id === selectedRoleId && /^\d{5,}$/.test(rank.id));

      if (!selectedRank) {
        setBannerCookie("warning", "Select a valid group to add.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      await addTicketGroupParticipant(ticket.ticketId, selectedRank);
      try {
        await applyTicketParticipantPermissions(client, ticket.ticketId);
      } catch (permissionError) {
        console.error("add-group: failed to apply participant permissions", {
          ticketId: ticket.ticketId,
          roleId: selectedRank.id,
          roleName: selectedRank.name,
          discordCode: permissionError?.discordCode ?? permissionError?.cause?.code,
          message: permissionError?.message,
        });
        setBannerCookie(
          "warning",
          `Group added, but Discord channel access could not be granted for ${selectedRank.name || selectedRank.rankSlug} (${permissionError?.discordCode ?? permissionError?.cause?.code ?? "unknown"}). Check the bot's Manage Permissions on the ticket category and that its role is above ${selectedRank.name || "that role"}.`,
          res
        );
        return res.redirect(`/support/ticket/${ticket.ticketId}`);
      }
      try {
        await createSupportTicketMessage(
          client,
          ticket.ticketId,
          req.session.user.userId,
          `${req.session.user.username || "Staff"} added group ${selectedRank.name || selectedRank.rankSlug} to this ticket.`,
          "web",
          { messageType: "status" }
        );
      } catch (messageError) {
        console.error("Failed to log add group event", messageError);
      }

      setBannerCookie("success", "Group added to ticket.", res);
      return res.redirect(`/support/ticket/${ticket.ticketId}`);
    } catch (error) {
      console.error(error);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
        pageTitle: "Error",
        pageDescription: "Error",
        config,
        req,
        error,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }
  });

  app.post("/support/ticket/:id/remove-user", async function (req, res) {
    try {
      if (!req.session.user) {
        return res.redirect("/login");
      }

      const ticket = await getTicketById(req.params.id);
      const participants = await getTicketParticipants(req.params.id);
      const userRankSlugs = req.session.user.ranks?.map((rank) => rank.rankSlug) || [];
      const isOwner = Number(ticket.userId) === Number(req.session.user.userId);
      const isStaff = req.session.user.isStaff;
      const isParticipantUser = participants.users.some(
        (participant) => participant.userId === req.session.user.userId
      );
      const isParticipantRank = userRankSlugs.some((slug) =>
        participants.groups.some((group) => group.rankSlug === slug)
      );
      const isAppealRemoveUser = /Appeal #/i.test(ticket.title || "");
      const hasMgParticipantsPermRemoveUser = userHasPermissionNode(req.session.user.permissions || [], "zander.web.tickets.manageparticipants");

      if (isAppealRemoveUser && !hasMgParticipantsPermRemoveUser) {
        return res.redirect("/support");
      }
      if (!hasMgParticipantsPermRemoveUser && !isOwner && !isStaff && !isParticipantUser && !isParticipantRank) {
        return res.redirect("/support");
      }

      const userIdFromForm = parseInt(req.body?.removeUserId, 10);
      if (!userIdFromForm) {
        setBannerCookie("warning", "Select a user to remove.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      const user = await getUserById(userIdFromForm);
      if (!user) {
        setBannerCookie("danger", "User not found.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      if (user.userId === ticket.userId) {
        setBannerCookie("warning", "Ticket creators cannot remove themselves.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      await removeTicketUserParticipant(ticket.ticketId, user.userId);
      if (user.discordId) {
        await removeTicketParticipantPermissions(client, ticket.ticketId, {
          discordIds: [user.discordId],
        });
      }

      try {
        await createSupportTicketMessage(
          client,
          ticket.ticketId,
          req.session.user.userId,
          `${req.session.user.username || "Staff"} removed user ${user.username || user.userId} from this ticket.`,
          "web",
          { messageType: "status" }
        );
      } catch (messageError) {
        console.error("Failed to log remove user event", messageError);
      }

      setBannerCookie("success", "User removed from ticket.", res);
      return res.redirect(`/support/ticket/${ticket.ticketId}`);
    } catch (error) {
      console.error(error);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
        pageTitle: "Error",
        pageDescription: "Error",
        config,
        req,
        error,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }
  });

  app.post("/support/ticket/:id/remove-group", async function (req, res) {
    try {
      if (!req.session.user) {
        return res.redirect("/login");
      }

      const ticket = await getTicketById(req.params.id);
      const participants = await getTicketParticipants(req.params.id);
      const userRankSlugs = req.session.user.ranks?.map((rank) => rank.rankSlug) || [];
      const isOwner = Number(ticket.userId) === Number(req.session.user.userId);
      const isStaff = req.session.user.isStaff;
      const isParticipantUser = participants.users.some(
        (participant) => participant.userId === req.session.user.userId
      );
      const isParticipantRank = userRankSlugs.some((slug) =>
        participants.groups.some((group) => group.rankSlug === slug)
      );
      const isAppealRemoveGroup = /Appeal #/i.test(ticket.title || "");
      const hasMgParticipantsPermRemoveGroup = userHasPermissionNode(req.session.user.permissions || [], "zander.web.tickets.manageparticipants");

      if (isAppealRemoveGroup && !hasMgParticipantsPermRemoveGroup) {
        return res.redirect("/support");
      }
      if (!hasMgParticipantsPermRemoveGroup && !isOwner && !isStaff && !isParticipantUser && !isParticipantRank) {
        return res.redirect("/support");
      }

      const roleId = (req.body?.removeGroupRoleId || "").trim();
      const group = participants.groups.find((participant) => participant.roleId === roleId);
      if (!group) {
        setBannerCookie("warning", "Select a valid group to remove.", res);
        return res.redirect(`/support/ticket/${req.params.id}`);
      }

      await removeTicketGroupParticipant(ticket.ticketId, group.roleId);
      await removeTicketParticipantPermissions(client, ticket.ticketId, {
        roleIds: [group.roleId],
      });

      try {
        await createSupportTicketMessage(
          client,
          ticket.ticketId,
          req.session.user.userId,
          `${req.session.user.username || "Staff"} removed group ${group.roleName || group.rankSlug || group.roleId} from this ticket.`,
          "web",
          { messageType: "status" }
        );
      } catch (messageError) {
        console.error("Failed to log remove group event", messageError);
      }

      setBannerCookie("success", "Group removed from ticket.", res);
      return res.redirect(`/support/ticket/${ticket.ticketId}`);
    } catch (error) {
      console.error(error);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
        pageTitle: "Error",
        pageDescription: "Error",
        config,
        req,
        error,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }
  });

  app.get("/support/users/search", async function (req, res) {
    try {
      if (!req.session.user) {
        return res.status(401).send({ results: [] });
      }

      const query = req.query?.q || "";
      const results = await searchUsersByUsername(query);
      return res.send({
        results: results.map((user) => ({
          userId: user.userId,
          username: user.username,
          avatarUrl: user.avatarUrl,
        })),
      });
    } catch (error) {
      console.error("support user search failed", error);
      return res.status(500).send({ results: [] });
    }
  });

  app.get("/support/create", async function (req, res) {
    try {
      if (!req.session.user) {
        return res.redirect("/login");
      }

      const categories = await getSupportCategories();
      const isStaff = req.session.user.isStaff;

      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("modules/support/create", {
        pageTitle: "Create Support Ticket",
        pageDescription: "Create Support Ticket",
        config,
        req,
        features,
        categories,
        isStaff,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    } catch (error) {
      console.error(error);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
        pageTitle: "Error",
        pageDescription: "Error",
        config,
        req,
        error,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }
  });

  app.post("/support/create", async function (req, res) {
    try {
      if (!req.session.user) {
        return res.redirect("/login");
      }

      const { title, category, message, manualUserId } = req.body;
      const isStaff = req.session.user.isStaff;
      const isManual = Boolean(manualUserId) && isStaff;

      let selectedCategoryId = category;
      let staffRoleIds = [];
      let categoryName = "";
      let manualUser = null;
      let parentCategoryId = null;

      if (isManual) {
        manualUser = await getUserById(manualUserId);
        if (!manualUser) {
          setBannerCookie("danger", "We couldn't find that user for a manual ticket.", res);
          return res.redirect("/support/create");
        }

        selectedCategoryId = await ensureUncategorisedCategory();
        staffRoleIds = [];
        categoryName = "Uncategorised";
        parentCategoryId = null;
      } else {
        staffRoleIds = await getCategoryPermissions(category);
        categoryName = await getCategoryName(category);
      }

      const ticketRecord = await createSupportTicket(
        client,
        req.session.user.userId,
        selectedCategoryId,
        title,
        {
          discordUserId: req.session.user.discordId,
          staffRoleIds,
          parentCategoryId,
        }
      );
      const { ticketId, channel } = ticketRecord;
      await createSupportTicketMessage(
        client,
        ticketId,
        req.session.user.userId,
        message,
        "web",
        { skipDiscordPost: true }
      );

      await syncParticipantsForMessage(client, ticketId, {
        userId: req.session.user.userId,
        rankSlugs: req.session.user.ranks?.map((rank) => rank.rankSlug) || [],
      });

      if (manualUser) {
        try {
          await addTicketUserParticipant(ticketId, { userId: manualUser.userId });
          await applyTicketParticipantPermissions(client, ticketId);
        } catch (participantError) {
          console.error("Failed to add manual ticket participant", participantError);
        }
      }

      if (channel) {
        const siteBaseUrl =
          (config.siteConfiguration && config.siteConfiguration.siteUrl) ||
          process.env.SITE_URL ||
          "https://craftingforchrist.net";
        const normalizedSiteUrl = siteBaseUrl.endsWith("/")
          ? siteBaseUrl.slice(0, -1)
          : siteBaseUrl;
        const ticketUrl = `${normalizedSiteUrl}/support/ticket/${ticketId}`;

        const ticketEmbed = new EmbedBuilder()
          .setTitle(`Ticket #${ticketId}: ${title}`)
          .setDescription(message)
          .addFields(
            { name: "Opened by", value: `${req.session.user.username || "Web user"}` },
            ...(manualUser
              ? [{ name: "Added user", value: manualUser.username || `User ${manualUser.userId}` }]
              : []),
            { name: "Category", value: categoryName || "Uncategorized" }
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
          const createdMessage = await channel.send({
            content: manualUser?.discordId
              ? `<@${manualUser.discordId}> a ticket has been created for you.`
              : req.session.user.discordId
              ? `<@${req.session.user.discordId}> your ticket has been created.`
              : "A ticket has been created.",
            embeds: [ticketEmbed],
            components: [new ActionRowBuilder().addComponents(viewOnlineButton, closeButton)],
          });

          try {
            await createdMessage.pin();
          } catch (pinError) {
            console.error("Failed to pin ticket opener message from web", pinError);
          }
        } catch (channelError) {
          console.error("Failed to send ticket created embed from web", channelError);
        }
      }

      return res.redirect("/support");
    } catch (error) {
      console.error(error);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/error", {
        pageTitle: "Error",
        pageDescription: "Error",
        config,
        req,
        error,
        features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      }));
      return;
    }
  });
}
