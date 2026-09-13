import moment from "moment";
import {
  getGlobalImage,
  hasPermission,
  setBannerCookie,
} from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import {
  createPunishment,
  getWebPunishments,
  liftPunishment,
  getPunishmentById,
} from "../../controllers/discordPunishmentController.js";
import { getUserByUsername } from "../../services/profileService.js";
import { sendPunishmentWebhook } from "../../commands/punish.mjs";

const MANAGE_PERMISSION = "zander.web.punishment.manage";

export default function dashboardWebPunishmentsRoute(
  app,
  client,
  fetch,
  config,
  db,
  features,
  lang
) {
  // List all web punishments
  app.get("/dashboard/web-punishments", async function (req, res) {
    const hasAccess = await hasPermission(MANAGE_PERMISSION, req, res, features);
    if (!hasAccess) return;

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = 25;

    const [result, globalImage, announcementWeb] = await Promise.all([
      getWebPunishments({ page, limit }),
      getGlobalImage(),
      getWebAnnouncement(),
    ]);

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/web-punishments", {
      pageTitle: `Dashboard - Web Punishments`,
      config,
      features,
      req,
      punishments: result.punishments,
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: Math.ceil(result.total / limit),
      moment,
      globalImage,
      announcementWeb,
    }));
    return;
  });

  // Issue a new web punishment
  app.post("/dashboard/web-punishments/create", async function (req, res) {
    const hasAccess = await hasPermission(MANAGE_PERMISSION, req, res, features);
    if (!hasAccess) return;

    const username = (req.body.username || "").trim();
    const type = req.body.type;
    const reason = (req.body.reason || "").trim();
    const duration = (req.body.duration || "").trim();

    if (!username || !type || !reason) {
      setBannerCookie("danger", "Username, type, and reason are required.", res);
      return res.redirect("/dashboard/web-punishments");
    }

    const validTypes = ["WARN", "TEMP_BAN", "PERM_BAN"];
    if (!validTypes.includes(type)) {
      setBannerCookie("danger", "Invalid punishment type.", res);
      return res.redirect("/dashboard/web-punishments");
    }

    // Look up the target user
    const targetUser = await getUserByUsername(username);
    if (!targetUser) {
      setBannerCookie("danger", `User "${username}" not found.`, res);
      return res.redirect("/dashboard/web-punishments");
    }

    // Parse duration for TEMP_BAN
    let expiresAt = null;
    if (type === "TEMP_BAN") {
      if (!duration) {
        setBannerCookie("danger", "Duration is required for temporary bans (e.g. 1h, 7d, 2w).", res);
        return res.redirect("/dashboard/web-punishments");
      }
      const ms = parseDurationString(duration);
      if (!ms) {
        setBannerCookie("danger", "Invalid duration format. Use e.g. 30m, 1h, 7d, 2w.", res);
        return res.redirect("/dashboard/web-punishments");
      }
      expiresAt = new Date(Date.now() + ms);
    }

    const actorUsername = req.session?.user?.username || "Unknown";
    const actorPlayerId = req.session?.user?.userId || null;

    try {
      await createPunishment({
        type,
        platform: "WEB",
        targetPlayerId: targetUser.userId,
        actorPlayerId,
        actorNameSnapshot: actorUsername,
        reason,
        expiresAt,
      });

      // Send webhook notification
      await sendPunishmentWebhook({
        type,
        targetTag: targetUser.username,
        actorTag: actorUsername,
        reason,
        durationMs: type === "TEMP_BAN" ? parseDurationString(duration) : null,
        platform: "Web",
        punishmentLink: `${process.env.siteAddress}/dashboard/web-punishments`,
      });

      // Try to DM the user via Discord if they have a linked Discord account
      if (targetUser.discordId && client) {
        try {
          const discordUser = await client.users.fetch(targetUser.discordId);
          if (discordUser) {
            const typeLabels = {
              WARN: "Warning",
              TEMP_BAN: "Temporary Ban",
              PERM_BAN: "Permanent Ban",
            };
            const lines = [
              `You have received a **Web ${typeLabels[type] || "Punishment"}**.`,
              `**Reason:** ${reason}`,
            ];
            if (type === "TEMP_BAN" && expiresAt) {
              lines.push(`**Expires:** ${moment(expiresAt).format("MMMM Do YYYY, h:mm A")} UTC`);
            }
            if (type === "PERM_BAN") {
              lines.push(`**Duration:** Permanent`);
            }
            await discordUser.send(lines.join("\n"));
          }
        } catch (dmError) {
          console.error("[WEB PUNISHMENTS] Failed to DM user:", dmError.message);
        }
      }

      setBannerCookie("success", `${type.replace("_", " ")} issued to ${targetUser.username}.`, res);
    } catch (error) {
      console.error("[WEB PUNISHMENTS] Failed to create punishment:", error);
      setBannerCookie("danger", "Failed to create punishment. Please try again.", res);
    }

    return res.redirect("/dashboard/web-punishments");
  });

  // Lift a web punishment
  app.post("/dashboard/web-punishments/:id/lift", async function (req, res) {
    const hasAccess = await hasPermission(MANAGE_PERMISSION, req, res, features);
    if (!hasAccess) return;

    const id = Number.parseInt(req.params.id, 10);
    const punishment = await getPunishmentById(id);

    if (!punishment || punishment.platform !== "WEB") {
      setBannerCookie("danger", "Punishment not found.", res);
      return res.redirect("/dashboard/web-punishments");
    }

    if (punishment.status !== "ACTIVE") {
      setBannerCookie("danger", "This punishment is not currently active.", res);
      return res.redirect("/dashboard/web-punishments");
    }

    try {
      await liftPunishment(id);
      setBannerCookie("success", "Punishment has been lifted.", res);
    } catch (error) {
      console.error("[WEB PUNISHMENTS] Failed to lift punishment:", error);
      setBannerCookie("danger", "Failed to lift punishment.", res);
    }

    return res.redirect("/dashboard/web-punishments");
  });
}

/**
 * Parse a duration string like "1h", "7d", "30m", "2w" into milliseconds.
 */
function parseDurationString(input) {
  if (!input) return null;
  const match = String(input).trim().match(/^(\d+)\s*(m|h|d|w)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  const multipliers = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };

  return value * multipliers[unit];
}
