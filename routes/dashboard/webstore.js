import { hasPermission, setBannerCookie } from "../../api/common.js";
import { adminViewData } from "../../admin/adminHelpers.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import { client as discordClient } from "../../controllers/discordController.js";
import {
  formatPrice,
  getAllCommands,
  getAllPurchases,
  getAllPurchasesCount,
  getActiveSubscriptionsCount,
  getTotalRevenueCents,
  getWebstoreItems,
  getCommandById,
  createCommand,
  updateCommand,
  deleteCommand,
} from "../../controllers/webstoreController.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canManageWebstore(req) {
  const perms = req.session?.user?.permissions ?? [];
  return perms.some((p) => {
    const c = String(p).trim().toLowerCase();
    return c === "*" || c === "zander.web.webstore.manage" || c === "zander.web.webstore.*";
  });
}

function getDiscordRoles(config) {
  try {
    const guild = discordClient?.guilds?.cache?.get(config?.discord?.guildId);
    if (!guild) return [];
    return [...guild.roles.cache.values()]
      .filter((r) => !r.managed && r.name !== "@everyone")
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));
  } catch {
    return [];
  }
}

export default function dashboardWebstoreRoute(app, fetch, config, db, features, lang) {

  // GET /dashboard/webstore — overview + purchases list
  app.get("/dashboard/webstore", async function (req, res) {
    if (!await hasPermission("zander.web.webstore", req, res, features)) return;
    if (!features.webstore) return res.redirect("/dashboard");

    const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit  = 20;
    const offset = (page - 1) * limit;

    let purchases = [], totalCount = 0, activeSubscriptions = 0, totalRevenueCents = 0;
    try {
      [purchases, totalCount, activeSubscriptions, totalRevenueCents] = await Promise.all([
        getAllPurchases(limit, offset),
        getAllPurchasesCount(),
        getActiveSubscriptionsCount(),
        getTotalRevenueCents(),
      ]);
    } catch (err) {
      console.error("[dashboard/webstore] failed to load data:", err.message);
    }

    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const announcementWeb = await getWebAnnouncement();

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/webstore/index", {
        pageTitle: "Webstore",
        config, features, req, announcementWeb,
        purchases, totalCount, totalPages, page,
        activeSubscriptions, totalRevenueCents,
        formatPrice,
        ...adminViewData(req, features),
      })
    );
  });

  // GET /dashboard/webstore/commands — command configuration
  app.get("/dashboard/webstore/commands", async function (req, res) {
    if (!await hasPermission("zander.web.webstore", req, res, features)) return;
    if (!features.webstore) return res.redirect("/dashboard");

    let commands = [], stripeItems = [];
    try {
      [commands, stripeItems] = await Promise.all([
        getAllCommands(),
        getWebstoreItems().catch(() => []),
      ]);
    } catch (err) {
      console.error("[dashboard/webstore/commands] failed to load:", err.message);
    }

    const announcementWeb = await getWebAnnouncement();

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/webstore/commands", {
        pageTitle: "Webstore — Commands",
        config, features, req, announcementWeb,
        commands, stripeItems,
        canManage: canManageWebstore(req),
        ...adminViewData(req, features),
      })
    );
  });

  // GET /dashboard/webstore/commands/create
  app.get("/dashboard/webstore/commands/create", async function (req, res) {
    if (!await hasPermission("zander.web.webstore", req, res, features)) return;
    if (!features.webstore) return res.redirect("/dashboard");

    if (!canManageWebstore(req)) {
      setBannerCookie("danger", "You do not have permission to create commands.", res);
      return res.redirect("/dashboard/webstore/commands");
    }

    let stripeItems = [];
    try {
      stripeItems = await getWebstoreItems();
    } catch (err) {
      console.error("[dashboard/webstore/commands/create] failed to load stripe items:", err.message);
    }

    const announcementWeb = await getWebAnnouncement();
    const defaultPriceId = req.query.priceId || null;
    const discordRoles = getDiscordRoles(config);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/webstore/command-create", {
        pageTitle: "Webstore — Add Command",
        config, features, req, announcementWeb,
        stripeItems,
        defaultPriceId,
        discordRoles,
        canManage: canManageWebstore(req),
        ...adminViewData(req, features),
      })
    );
  });

  // POST /dashboard/webstore/commands/create
  app.post("/dashboard/webstore/commands/create", async function (req, res) {
    if (!await hasPermission("zander.web.webstore", req, res, features)) return;
    if (!features.webstore) return res.redirect("/dashboard");

    if (!canManageWebstore(req)) {
      setBannerCookie("danger", "You do not have permission to create commands.", res);
      return res.redirect("/dashboard/webstore/commands");
    }

    try {
      const { stripePriceId, action, commandType, commandTemplate, serverSlug, sortOrder } = req.body || {};

      if (!stripePriceId || !action || !commandTemplate) {
        setBannerCookie("danger", "Price ID, action, and command/role ID are required.", res);
        return res.redirect("/dashboard/webstore/commands/create");
      }

      await createCommand({ stripePriceId, action, commandType, commandTemplate, serverSlug: serverSlug || null, sortOrder });
      setBannerCookie("success", "Command created successfully.", res);
      return res.redirect("/dashboard/webstore/commands");
    } catch (error) {
      console.error("[dashboard/webstore] POST /commands/create:", error);
      setBannerCookie("danger", error.message, res);
      return res.redirect("/dashboard/webstore/commands/create");
    }
  });

  // GET /dashboard/webstore/commands/:id/edit
  app.get("/dashboard/webstore/commands/:id/edit", async function (req, res) {
    if (!await hasPermission("zander.web.webstore", req, res, features)) return;
    if (!features.webstore) return res.redirect("/dashboard");

    if (!canManageWebstore(req)) {
      setBannerCookie("danger", "You do not have permission to edit commands.", res);
      return res.redirect("/dashboard/webstore/commands");
    }

    const commandId = parseInt(req.params.id, 10);
    if (!commandId) return res.redirect("/dashboard/webstore/commands");

    let command = null;
    let stripeItems = [];
    try {
      [command, stripeItems] = await Promise.all([
        getCommandById(commandId),
        getWebstoreItems().catch(() => []),
      ]);
    } catch (err) {
      console.error("[dashboard/webstore/commands/:id/edit] failed to load:", err.message);
    }

    if (!command) {
      setBannerCookie("danger", "Command not found.", res);
      return res.redirect("/dashboard/webstore/commands");
    }

    const announcementWeb = await getWebAnnouncement();
    const discordRoles = getDiscordRoles(config);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/webstore/command-edit", {
        pageTitle: "Webstore — Edit Command",
        config, features, req, announcementWeb,
        command,
        stripeItems,
        discordRoles,
        canManage: canManageWebstore(req),
        ...adminViewData(req, features),
      })
    );
  });

  // POST /dashboard/webstore/commands/:id/edit
  app.post("/dashboard/webstore/commands/:id/edit", async function (req, res) {
    if (!await hasPermission("zander.web.webstore", req, res, features)) return;
    if (!features.webstore) return res.redirect("/dashboard");

    if (!canManageWebstore(req)) {
      setBannerCookie("danger", "You do not have permission to edit commands.", res);
      return res.redirect("/dashboard/webstore/commands");
    }

    const commandId = parseInt(req.params.id, 10);
    if (!commandId) return res.redirect("/dashboard/webstore/commands");

    try {
      const { action, commandType, commandTemplate, serverSlug, sortOrder } = req.body || {};

      if (!action || !commandTemplate) {
        setBannerCookie("danger", "Action and command/role ID are required.", res);
        return res.redirect(`/dashboard/webstore/commands/${commandId}/edit`);
      }

      await updateCommand(commandId, { action, commandType, commandTemplate, serverSlug: serverSlug || null, sortOrder });
      setBannerCookie("success", "Command updated successfully.", res);
      return res.redirect("/dashboard/webstore/commands");
    } catch (error) {
      console.error("[dashboard/webstore] POST /commands/:id/edit:", error);
      setBannerCookie("danger", error.message, res);
      return res.redirect(`/dashboard/webstore/commands/${commandId}/edit`);
    }
  });

  // POST /dashboard/webstore/commands/:id/delete
  app.post("/dashboard/webstore/commands/:id/delete", async function (req, res) {
    if (!await hasPermission("zander.web.webstore", req, res, features)) return;
    if (!features.webstore) return res.redirect("/dashboard");

    if (!canManageWebstore(req)) {
      setBannerCookie("danger", "You do not have permission to delete commands.", res);
      return res.redirect("/dashboard/webstore/commands");
    }

    const commandId = parseInt(req.params.id, 10);
    if (!commandId) return res.redirect("/dashboard/webstore/commands");

    try {
      await deleteCommand(commandId);
      setBannerCookie("success", "Command deleted.", res);
      return res.redirect("/dashboard/webstore/commands");
    } catch (error) {
      console.error("[dashboard/webstore] POST /commands/:id/delete:", error);
      setBannerCookie("danger", error.message, res);
      return res.redirect("/dashboard/webstore/commands");
    }
  });
}
