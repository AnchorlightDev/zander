import {
  hasPermission,
  isFeatureWebRouteEnabled,
  setBannerCookie,
} from "../../api/common.js";
import { adminViewData } from "../../admin/adminHelpers.js";
import { prisma } from "../../controllers/databaseController.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import { generateLog } from "../../api/common.js";
import {
  getServerAccess,
  grantPlayer,
  listRanks,
  revokePlayer,
  setRankAccess,
} from "../../controllers/serverAccessController.js";

import { hasPermission as holdsNode } from "../../lib/discord/permissions.mjs";

const ACCESS_NODE = "zander.web.server.access";

/** Load the server named by ?id= / body.serverId for the access screens. */
async function loadServer(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return prisma.servers.findUnique({ where: { serverId: id } });
}

export default function dashboardServersSiteRoute(
  app,
  fetch,
  config,
  db,
  features,
  lang
) {
  //
  // Servers list
  //
  app.get("/dashboard/servers", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.server, req, res, features)) return;
    if (!await hasPermission("zander.web.server", req, res, features)) return;

    // Direct Prisma query — no internal HTTP fetch.
    const [servers, announcementWeb] = await Promise.all([
      prisma.servers.findMany({ orderBy: { position: "asc" } }),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/servers/server-list", {
        pageTitle: "Servers",
        config,
        // Provide the same shape legacy template expected from apiData.
        apiData: { success: true, data: servers },
        canManageAccess: holdsNode(req.session?.user?.permissions ?? [], ACCESS_NODE),
        features,
        req,
        announcementWeb,
        ...adminViewData(req, features),
      })
    );
  });

  //
  // Create server
  //
  app.get("/dashboard/servers/create", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.server, req, res, features)) return;
    if (!await hasPermission("zander.web.server", req, res, features)) return;

    const announcementWeb = await getWebAnnouncement();

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/servers/server-editor", {
        pageTitle: "Create Server",
        config,
        type: "create",
        features,
        req,
        announcementWeb,
        ...adminViewData(req, features),
      })
    );
  });

  //
  // Edit server
  //
  app.get("/dashboard/servers/edit", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.server, req, res, features)) return;
    if (!await hasPermission("zander.web.server", req, res, features)) return;

    const id = Number(req.query.id);

    const [server, announcementWeb] = await Promise.all([
      Number.isInteger(id) && id > 0 ? prisma.servers.findUnique({ where: { serverId: id } }) : Promise.resolve(null),
      getWebAnnouncement(),
    ]);

    // The editor reads serverApiData unguarded; a stale link would 500.
    if (!server) {
      setBannerCookie("danger", "Server not found.", res);
      return res.redirect("/dashboard/servers");
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/servers/server-editor", {
        pageTitle: "Edit Server",
        config,
        serverApiData: server,
        type: "edit",
        features,
        req,
        announcementWeb,
        ...adminViewData(req, features),
      })
    );
  });

  //
  // Access: which ranks and players may join this server
  //
  app.get("/dashboard/servers/access", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.server, req, res, features)) return;
    if (!await hasPermission(ACCESS_NODE, req, res, features)) return;

    const server = await loadServer(req.query.id);
    if (!server) {
      setBannerCookie("danger", "Server not found.", res);
      return res.redirect("/dashboard/servers");
    }

    let access = null;
    let ranks = [];
    let loadError = null;
    if (server.velocityName) {
      try {
        [access, ranks] = await Promise.all([getServerAccess(server.velocityName), listRanks()]);
      } catch (error) {
        console.error("[SERVER ACCESS] Failed to read LuckPerms:", error.message);
        loadError = "Couldn't read access from LuckPerms just now. Nothing can be changed until it loads.";
      }
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/servers/server-access", {
        pageTitle: `Access - ${server.displayName || server.velocityName}`,
        config,
        server,
        access,
        ranks,
        loadError,
        features,
        req,
        announcementWeb: await getWebAnnouncement(),
        ...adminViewData(req, features),
      })
    );
  });

  // Ranks: the ticked boxes are the whole wanted state; only the difference is queued.
  app.post("/dashboard/servers/access", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.server, req, res, features)) return;
    if (!await hasPermission(ACCESS_NODE, req, res, features)) return;

    const server = await loadServer(req.body?.serverId);
    if (!server?.velocityName) {
      setBannerCookie("danger", "Set this server's Velocity name before changing its access.", res);
      return res.redirect("/dashboard/servers");
    }
    const back = `/dashboard/servers/access?id=${server.serverId}`;
    const raw = req.body?.ranks;
    const wanted = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const actor = req.session?.user?.username ?? null;

    try {
      const result = await setRankAccess(server.velocityName, wanted, actor);
      if (!result.queued) {
        setBannerCookie("info", "Nothing changed.", res);
        return res.redirect(back);
      }
      const parts = [];
      if (result.grant.length) parts.push(`granted ${result.grant.join(", ")}`);
      if (result.revoke.length) parts.push(`removed ${result.revoke.join(", ")}`);
      await generateLog(req.session.user.userId, "SUCCESS", "SERVER", `Server access for ${server.velocityName}: ${parts.join("; ")}`).catch(() => {});
      setBannerCookie("success", `Queued: ${parts.join("; ")}. It applies when a server next picks up the queue (usually within a minute).`, res);
    } catch (error) {
      console.error("[SERVER ACCESS] Failed to save ranks:", error.message);
      setBannerCookie("danger", "Those changes couldn't be saved.", res);
    }
    return res.redirect(back);
  });

  // Players: add one (permanent or until a date/time).
  app.post("/dashboard/servers/access/player", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.server, req, res, features)) return;
    if (!await hasPermission(ACCESS_NODE, req, res, features)) return;

    const server = await loadServer(req.body?.serverId);
    if (!server?.velocityName) {
      setBannerCookie("danger", "Set this server's Velocity name before changing its access.", res);
      return res.redirect("/dashboard/servers");
    }
    const back = `/dashboard/servers/access?id=${server.serverId}`;
    const username = String(req.body?.username || "").trim();
    // The form converts the viewer's local date/time to an exact instant
    // (expiresIso). Without script, the raw value is read as UTC.
    let expiresAt = null;
    const rawExpiry = String(req.body?.expiresIso || "").trim() || (req.body?.expiresAt ? `${req.body.expiresAt}Z` : "");
    if (rawExpiry) {
      const d = new Date(rawExpiry);
      expiresAt = Number.isFinite(d.getTime()) ? d : "invalid";
    }

    try {
      const player = await grantPlayer(server.velocityName, username, { expiresAt, actor: req.session?.user?.username ?? null });
      const until = expiresAt ? ` until ${expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
      await generateLog(req.session.user.userId, "SUCCESS", "SERVER", `Server access for ${server.velocityName}: granted ${player.username}${until}`).catch(() => {});
      setBannerCookie("success", `Queued access for ${player.username}${until}.`, res);
    } catch (error) {
      setBannerCookie("danger", error.message || "That player couldn't be added.", res);
    }
    return res.redirect(back);
  });

  // Players: remove one.
  app.post("/dashboard/servers/access/player/remove", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.server, req, res, features)) return;
    if (!await hasPermission(ACCESS_NODE, req, res, features)) return;

    const server = await loadServer(req.body?.serverId);
    if (!server?.velocityName) return res.redirect("/dashboard/servers");
    const back = `/dashboard/servers/access?id=${server.serverId}`;
    const username = String(req.body?.username || "").trim();
    try {
      await revokePlayer(server.velocityName, username, req.session?.user?.username ?? null);
      await generateLog(req.session.user.userId, "SUCCESS", "SERVER", `Server access for ${server.velocityName}: removed ${username}`).catch(() => {});
      setBannerCookie("success", `Queued removal of ${username}.`, res);
    } catch (error) {
      setBannerCookie("danger", error.message || "That player couldn't be removed.", res);
    }
    return res.redirect(back);
  });
}
