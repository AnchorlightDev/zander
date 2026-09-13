import { getWebAnnouncement } from "../../controllers/announcementController.js";
import {
  isFeatureWebRouteEnabled,
  getGlobalImage,
  hasPermission,
  setBannerCookie,
} from "../../api/common.js";
import { adminViewData } from "../../admin/adminHelpers.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import {
  getSupportCategories,
  getSupportCategoriesWithPermissions,
  addCategoryPermission,
  removeCategoryPermission,
  createSupportCategory,
  deleteSupportCategory,
  getAllTickets,
  getTicketById,
  getTicketsByCategory,
  updateTicketStatus,
  notifyTicketStatusChange,
  getCategoryById,
  getCategoryPermissions,
  updateSupportCategory,
  deleteTicketChannel,
  recreateTicketChannel,
  repairPendingTicketChannelNames,
} from "../../controllers/supportTicketController.js";
import { hasPermission as hasPermissionNode } from "../../lib/discord/permissions.mjs";
import { luckpermsDb } from "../../controllers/databaseController.js";

export default function supportDashboardRoutes(
  app,
  client,
  fetch,
  moment,
  config,
  db,
  features,
  lang
) {
  const slugifyCategory = (name, fallback = "") => {
    const source = name || fallback;
    return String(source)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/(^-|-$)/g, "");
  };

  const getCategorySlug = (category) => {
    if (!category) return "";
    if (category.slug) return category.slug;
    return slugifyCategory(category.name, `category-${category.categoryId}`);
  };

  const userHasCategoryPermission = (slug, permissions = []) => {
    if (!slug) return false;
    const ticketNode = `zander.web.tickets.${slug}`;
    return (
      hasPermissionNode(permissions, ticketNode) ||
      hasPermissionNode(permissions, "zander.web.tickets.*")
    );
  };

  const requireTicketPermission = async (req, res) =>
    await hasPermission("zander.web.tickets", req, res, features);

  const requireCategoryPermission = async (category, req, res) => {
    const slug = getCategorySlug(category);

    if (!userHasCategoryPermission(slug, req.session.user?.permissions)) {
      const [globalImage, announcementWeb] = await Promise.all([
        getGlobalImage(),
        getWebAnnouncement(),
      ]);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/noPermission", {
        pageTitle: "Access Restricted",
        config,
        req,
        res,
        features,
        globalImage,
        announcementWeb,
      }));
      return;
    }

    return true;
  };

  const filterCategoriesByPermission = (categories, permissions) => {
    return categories
      .map((category) => ({ ...category, slug: getCategorySlug(category) }))
      .filter((category) =>
        userHasCategoryPermission(category.slug, permissions)
      );
  };

  app.get("/dashboard/support", async function (req, res) {
    try {
      const hasTicketsAccess = await requireTicketPermission(req, res);
      if (hasTicketsAccess !== true) return hasTicketsAccess;

      const categories = filterCategoriesByPermission(
        await getSupportCategories(),
        req.session.user.permissions
      );
      const permittedCategoryIds = categories.map(
        (category) => category.categoryId
      );

      const tickets = (await getAllTickets()).filter((ticket) =>
        permittedCategoryIds.includes(ticket.categoryId)
      );

      const [globalImage, announcementWeb] = await Promise.all([
        getGlobalImage(),
        getWebAnnouncement(),
      ]);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("modules/dashboard/support/index", {
        pageTitle: "Support Tickets",
        pageDescription: "Manage Support Tickets",
        config,
        req,
        features,
        tickets,
        globalImage,
        announcementWeb,
        ...adminViewData(req, features),
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

  app.get("/dashboard/support/explorer", async function (req, res) {
    try {
      const hasTicketsAccess = await requireTicketPermission(req, res);
      if (hasTicketsAccess !== true) return hasTicketsAccess;

      const { category } = req.query;
      let tickets = [];

      const permittedCategories = filterCategoriesByPermission(
        await getSupportCategories(),
        req.session.user.permissions
      );

      const selectedCategory = permittedCategories.find(
        (c) => String(c.categoryId) === category
      );

      if (category && !selectedCategory) {
        const [globalImage, announcementWeb] = await Promise.all([
          getGlobalImage(),
          getWebAnnouncement(),
        ]);
        res.header("content-type", "text/html; charset=utf-8").send(
          await app.view("session/noPermission", {
          pageTitle: "Access Restricted",
          config,
          req,
          res,
          features,
          globalImage,
          announcementWeb,
        }));
        return;
      }

      if (selectedCategory) {
        tickets = await getTicketsByCategory(selectedCategory.categoryId);
      } else {
        const permittedCategoryIds = permittedCategories.map(
          (c) => c.categoryId
        );
        tickets = (await getAllTickets()).filter((ticket) =>
          permittedCategoryIds.includes(ticket.categoryId)
        );
      }

      const [globalImage, announcementWeb] = await Promise.all([
        getGlobalImage(),
        getWebAnnouncement(),
      ]);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("modules/dashboard/support/explorer", {
        pageTitle: "Support Ticket Explorer",
        pageDescription: "Support Ticket Explorer",
        config,
        req,
        features,
        tickets,
        categories: permittedCategories,
        selectedCategory: selectedCategory?.categoryId,
        globalImage,
        announcementWeb,
        ...adminViewData(req, features),
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

  app.get("/dashboard/support/categories", async function (req, res) {
    try {
      const hasTicketsAccess = await requireTicketPermission(req, res);
      if (hasTicketsAccess !== true) return hasTicketsAccess;

      const categories = await getSupportCategoriesWithPermissions();
      const roles = await getLuckPermRoles();

      const rankStyleMap = new Map(roles.map((role) => [String(role.id), role]));

      const categoriesWithRoleNames = await Promise.all(
        categories.map(async (category) => {
          const permissionIds = category.permissions
            ? category.permissions.split(",").filter(Boolean)
            : [];

          const permissionIdSet = new Set(permissionIds.map((id) => String(id)));

          return {
            ...category,
            permissions: await resolvePermissionRoles(permissionIds, rankStyleMap),
            availableRoles: roles.filter(
              (role) => !permissionIdSet.has(String(role.id))
            ),
          };
        })
      );

      console.info(
        "Loaded support categories",
        categories?.length ?? 0,
        "and LuckPerms ranks with Discord roles",
        roles?.length ?? 0
      );

      const [globalImage, announcementWeb] = await Promise.all([
        getGlobalImage(),
        getWebAnnouncement(),
      ]);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("modules/dashboard/support/categories", {
        pageTitle: "Support Ticket Categories",
        pageDescription: "Support Ticket Categories",
        config,
        req,
        features,
        categories: categoriesWithRoleNames,
        roles,
        globalImage,
        announcementWeb,
        ...adminViewData(req, features),
      }));
      return;
    } catch (error) {
      console.error("Failed to render support categories dashboard", error);
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

  app.post(
    "/dashboard/support/categories/:id/permissions",
    async function (req, res) {
      try {
        const hasTicketsAccess = await requireTicketPermission(req, res);
        if (hasTicketsAccess !== true) return hasTicketsAccess;

        const { id } = req.params;
        const { roleId } = req.body;

        await addCategoryPermission(id, roleId);

        const addRedirect =
          typeof req.body?.redirect === "string" &&
          req.body.redirect.startsWith("/") &&
          !req.body.redirect.startsWith("//")
            ? req.body.redirect
            : "/dashboard/support/categories";
        return res.redirect(addRedirect);
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
    }
  );

  app.post(
    "/dashboard/support/categories/:id/permissions/:roleId/delete",
    async function (req, res) {
      try {
        const hasTicketsAccess = await requireTicketPermission(req, res);
        if (hasTicketsAccess !== true) return hasTicketsAccess;

        const { id, roleId } = req.params;

        await removeCategoryPermission(id, roleId);

        const removeRedirect =
          typeof req.body?.redirect === "string" &&
          req.body.redirect.startsWith("/") &&
          !req.body.redirect.startsWith("//")
            ? req.body.redirect
            : "/dashboard/support/categories";
        return res.redirect(removeRedirect);
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
    }
  );

  app.post("/dashboard/support/categories", async function (req, res) {
    try {
      const hasTicketsAccess = await requireTicketPermission(req, res);
      if (hasTicketsAccess !== true) return hasTicketsAccess;

      const { name, description, discordCategoryId } = req.body;
      await createSupportCategory(name, description, discordCategoryId);

      await updateSupportMessage(client);

      return res.redirect("/dashboard/support/categories");
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

  app.get("/dashboard/support/categories/:id/edit", async function (req, res) {
    try {
      const hasTicketsAccess = await requireTicketPermission(req, res);
      if (hasTicketsAccess !== true) return hasTicketsAccess;

      const category = await getCategoryById(req.params.id);
      const roles = await getLuckPermRoles();
      const categoryPermissions =
        (await getCategoryPermissions(category.categoryId)) || [];

      const rankStyleMap = new Map(roles.map((role) => [String(role.id), role]));
      const permissionIdSet = new Set(categoryPermissions.map((roleId) => String(roleId)));

      const categoryWithPermissions = {
        ...category,
        permissions: await resolvePermissionRoles(categoryPermissions, rankStyleMap),
        availableRoles: roles.filter(
          (role) => !permissionIdSet.has(String(role.id))
        ),
      };

      const [globalImage, announcementWeb] = await Promise.all([
        getGlobalImage(),
        getWebAnnouncement(),
      ]);
      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("modules/dashboard/support/edit-category", {
        pageTitle: "Edit Support Category",
        pageDescription: "Edit Support Category",
        config,
        req,
        features,
        category: categoryWithPermissions,
        roles,
        globalImage,
        announcementWeb,
        ...adminViewData(req, features),
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

  app.post("/dashboard/support/categories/:id/edit", async function (req, res) {
    try {
      const hasTicketsAccess = await requireTicketPermission(req, res);
      if (hasTicketsAccess !== true) return hasTicketsAccess;

      const { id } = req.params;
      const { name, description, discordCategoryId } = req.body;
      await updateSupportCategory(id, name, description, discordCategoryId);

      await updateSupportMessage(client);

      return res.redirect("/dashboard/support/categories");
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

  app.post(
    "/dashboard/support/categories/:id/delete",
    async function (req, res) {
      try {
        const hasTicketsAccess = await requireTicketPermission(req, res);
        if (hasTicketsAccess !== true) return hasTicketsAccess;

        const { id } = req.params;
        await deleteSupportCategory(id);

        await updateSupportMessage(client);

        return res.redirect("/dashboard/support/categories");
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
    }
  );

  // One-off repair for ticket channels stuck on the "ticket-pending"
  // placeholder name from before channel naming was fixed to happen on
  // creation instead of via a rename call right after.
  app.post("/dashboard/support/repair-channel-names", async function (req, res) {
    const hasTicketsAccess = await requireTicketPermission(req, res);
    if (hasTicketsAccess !== true) return hasTicketsAccess;

    try {
      const result = await repairPendingTicketChannelNames(client);
      const message = result.failed.length
        ? `Renamed ${result.renamed}/${result.checked} ticket channel(s). ${result.failed.length} failed — see server logs.`
        : `Renamed ${result.renamed}/${result.checked} ticket channel(s).`;
      setBannerCookie(result.failed.length ? "warning" : "success", message, res);
    } catch (error) {
      console.error("Failed to repair ticket channel names", error);
      setBannerCookie("danger", "Failed to repair ticket channel names — see server logs.", res);
    }

    return res.redirect("/dashboard/support");
  });

  app.post("/dashboard/support/ticket/:id/status", async function (req, res) {
    try {
      const hasTicketsAccess = await requireTicketPermission(req, res);
      if (hasTicketsAccess !== true) return hasTicketsAccess;

      const ticket = await getTicketById(req.params.id);
      const category = await getCategoryById(ticket.categoryId);
      const hasCategoryAccess = await requireCategoryPermission(
        category,
        req,
        res
      );
      if (hasCategoryAccess !== true) return hasCategoryAccess;

      const newStatus = req.body.status;
      await updateTicketStatus(ticket.ticketId, newStatus);
      await notifyTicketStatusChange(ticket.ticketId, newStatus, {
        userId: req.session.user.userId,
        name: req.session.user.username,
      });

      if (newStatus === "closed") {
        await deleteTicketChannel(client, ticket.ticketId, "Ticket closed from dashboard");
      } else if (newStatus === "open") {
        let needsChannel = !ticket.discordChannelId;

        if (!needsChannel && client) {
          try {
            await client.channels.fetch(ticket.discordChannelId);
          } catch (fetchError) {
            console.warn(
              "dashboard reopen: stored channel missing, recreating",
              fetchError
            );
            needsChannel = true;
          }
        }

        if (needsChannel) {
          try {
            await recreateTicketChannel(client, ticket.ticketId);
          } catch (recreateError) {
            console.error("Failed to recreate ticket channel on reopen", recreateError);
          }
        }
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

  app.post("/dashboard/support/message", async function (req, res) {
    try {
      const hasTicketsAccess = await requireTicketPermission(req, res);
      if (hasTicketsAccess !== true) return hasTicketsAccess;

      await postSupportMessage(client);

      return res.redirect("/dashboard/support/categories");
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

  async function getLuckPermRoles() {
    try {
      const rows = await new Promise((resolve, reject) => {
        luckpermsDb.query(
          `SELECT
            lpGroups.name AS rankSlug,
            COALESCE(SUBSTRING_INDEX(lpGroupDisplayName.permission, '.', -1), lpGroups.name) AS displayName,
            COALESCE(
              CONCAT('#', SUBSTRING_INDEX(lpMetaBadgeColour.permission, '.', -1)),
              CASE LEFT(SUBSTRING_INDEX(lpGroupPrefix.permission, '[&', -1), 1)
                WHEN '0' THEN '#000000' WHEN '1' THEN '#0000AA' WHEN '2' THEN '#00AA00'
                WHEN '3' THEN '#00AAAA' WHEN '4' THEN '#AA0000' WHEN '5' THEN '#AA00AA'
                WHEN '6' THEN '#FFAA00' WHEN '7' THEN '#AAAAAA' WHEN '8' THEN '#555555'
                WHEN '9' THEN '#5555FF' WHEN 'a' THEN '#55FF55' WHEN 'b' THEN '#55FFFF'
                WHEN 'c' THEN '#FF5555' WHEN 'd' THEN '#FF55FF' WHEN 'e' THEN '#FFFF55'
                WHEN 'g' THEN '#DDD605' ELSE '#FFFFFF'
              END
            ) AS rankBadgeColour,
            COALESCE(
              CONCAT('#', SUBSTRING_INDEX(lpMetaTextColour.permission, '.', -1)),
              CASE WHEN LEFT(SUBSTRING_INDEX(lpGroupPrefix.permission, '[&', -1), 1)
                IN ('0','1','2','3','4','5','8','9') THEN '#FFFFFF' ELSE '#000000' END
            ) AS rankTextColour,
            SUBSTRING_INDEX(lpMetaDiscordId.permission, '.', -1) AS discordRoleId
          FROM luckperms_groups lpGroups
            LEFT JOIN luckperms_group_permissions lpGroupDisplayName
              ON lpGroups.name = lpGroupDisplayName.name
              AND lpGroupDisplayName.permission LIKE 'displayname.%' AND lpGroupDisplayName.value = 1
            LEFT JOIN luckperms_group_permissions lpGroupPrefix
              ON lpGroups.name = lpGroupPrefix.name
              AND lpGroupPrefix.permission LIKE 'prefix.%' AND lpGroupPrefix.value = 1
            LEFT JOIN luckperms_group_permissions lpMetaBadgeColour
              ON lpGroups.name = lpMetaBadgeColour.name
              AND lpMetaBadgeColour.permission LIKE 'meta.rankbadgecolour.%' AND lpMetaBadgeColour.value = 1
            LEFT JOIN luckperms_group_permissions lpMetaTextColour
              ON lpGroups.name = lpMetaTextColour.name
              AND lpMetaTextColour.permission LIKE 'meta.ranktextcolour.%' AND lpMetaTextColour.value = 1
            LEFT JOIN luckperms_group_permissions lpMetaDiscordId
              ON lpGroups.name = lpMetaDiscordId.name
              AND lpMetaDiscordId.permission LIKE 'meta.discordid.%' AND lpMetaDiscordId.value = 1
          HAVING discordRoleId IS NOT NULL AND discordRoleId != '' AND discordRoleId != 'NULL'
          ORDER BY lpGroups.name ASC`,
          (error, results) => {
            if (error) reject(error);
            else resolve(results || []);
          }
        );
      });

      return rows.map((rank) => ({
        id: rank.discordRoleId,
        name: rank.displayName || rank.rankSlug,
        rankSlug: rank.rankSlug,
        rankBadgeColour: rank.rankBadgeColour,
        rankTextColour: rank.rankTextColour,
      }));
    } catch (error) {
      console.error(
        "getLuckPermRoles: failed to fetch rank Discord role mappings from LuckPerms",
        error
      );
      return [];
    }
  }

  /**
   * Build a Map of Discord role ID -> role name by fetching the guild's role list.
   * Used as a fallback when a stored permission roleId is not mapped to any rank.
   */
  async function getDiscordGuildRoleNames() {
    const guildId = config.discord?.guildId || process.env.DISCORD_GUILD_ID;
    if (!client || !guildId) return new Map();

    try {
      const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
      if (!guild) return new Map();

      if (guild.roles.cache.size === 0) {
        await guild.roles.fetch();
      }

      const map = new Map();
      guild.roles.cache.forEach((role) => {
        map.set(String(role.id), role.name);
      });
      return map;
    } catch (err) {
      console.warn("getDiscordGuildRoleNames: failed to fetch guild roles", err.message);
      return new Map();
    }
  }

  /**
   * Map a list of stored permission roleIds to enriched objects with human-readable names.
   * Resolution priority:
   *  1. Rank displayName / rankSlug from the ranks table
   *  2. Discord role name fetched from the guild
   *  3. Raw role ID as a last resort
   */
  async function resolvePermissionRoles(permissionIds, rankStyleMap) {
    // Check if any ID is missing from the ranks map and needs Discord lookup
    const needsDiscord = permissionIds.some((id) => !rankStyleMap.has(String(id)));
    const discordNames = needsDiscord ? await getDiscordGuildRoleNames() : new Map();

    return permissionIds.map((roleId) => {
      const roleMeta = rankStyleMap.get(String(roleId));
      const name = roleMeta?.name || discordNames.get(String(roleId)) || String(roleId);
      return {
        roleId,
        roleName: name,
        badgeColor: roleMeta?.rankBadgeColour,
        textColor: roleMeta?.rankTextColour,
      };
    });
  }

  async function postSupportMessage(client) {
    if (!client) {
      console.warn(
        "postSupportMessage: Discord client unavailable; skipping support panel update"
      );
      return;
    }

    const supportChannelId =
      config.discord?.supportPanelChannelId || process.env.SUPPORT_CHANNEL_ID;

    if (!supportChannelId) {
      console.warn(
        "postSupportMessage: SUPPORT_CHANNEL_ID is not configured; skipping support panel update"
      );
      return;
    }

    let channel;
    try {
      channel = await client.channels.fetch(supportChannelId);
    } catch (error) {
      console.error(
        "postSupportMessage: failed to fetch support channel for ticket panel",
        error
      );
      return;
    }
    const categories = await getSupportCategories();

    const buttons = categories.map((category) =>
      new ButtonBuilder()
        .setCustomId(`support_category_${category.categoryId}`)
        .setLabel(category.name)
        .setStyle(ButtonStyle.Primary)
    );

    const row = new ActionRowBuilder().addComponents(buttons);

    await channel.send({
      content: "Please select a category to create a support ticket:",
      components: [row],
    });
  }

  async function updateSupportMessage(client) {
    if (!client) {
      console.warn(
        "updateSupportMessage: Discord client unavailable; skipping support panel refresh"
      );
      return;
    }

    const supportChannelId =
      config.discord?.supportPanelChannelId || process.env.SUPPORT_CHANNEL_ID;

    if (!supportChannelId) {
      console.warn(
        "updateSupportMessage: SUPPORT_CHANNEL_ID is not configured; skipping support panel refresh"
      );
      return;
    }

    let channel;
    try {
      channel = await client.channels.fetch(supportChannelId);
    } catch (error) {
      console.error(
        "updateSupportMessage: failed to fetch support channel for ticket panel",
        error
      );
      return;
    }
    const messages = await channel.messages.fetch({ limit: 100 });
    const message = messages.find(
      (m) => m.author.id === client.user.id && m.components.length > 0
    );

    if (message) {
      const categories = await getSupportCategories();

      const buttons = categories.map((category) =>
        new ButtonBuilder()
          .setCustomId(`support_category_${category.categoryId}`)
          .setLabel(category.name)
          .setStyle(ButtonStyle.Primary)
      );

      const row = new ActionRowBuilder().addComponents(buttons);

      await message.edit({
        content: "Please select a category to create a support ticket:",
        components: [row],
      });
    }
  }
}
