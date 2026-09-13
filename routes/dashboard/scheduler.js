import {
  getGlobalImage,
  hasPermission,
  isFeatureWebRouteEnabled,
} from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import { ChannelType } from "discord.js";

export default function dashboardSchedulerSiteRoute(
  app,
  client,
  fetch,
  config,
  features,
  lang
) {
  app.get("/dashboard/scheduler", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, features.discord, req, res, features)) return;

    if (!await hasPermission("zander.web.scheduler", req, res, features)) return;

    const headers = { "x-access-token": process.env.apiKey };

    // Fetch announcements, scheduled messages, and page-chrome data concurrently.
    const [announcementsData, scheduledMessages, globalImage, announcementWeb] =
      await Promise.all([
        fetch(`${process.env.siteAddress}/api/announcement/get`, { headers })
          .then((r) => r.json())
          .catch(() => ({ data: [] })),
        fetch(`${process.env.siteAddress}/api/scheduler/discord/get`, { headers })
          .then((r) => r.json())
          .catch(() => ({ data: [] })),
        getGlobalImage(),
        getWebAnnouncement(),
      ]);

    const guildId = config.discord?.guildId ?? process.env.DISCORD_GUILD_ID;
    const discordChannels = [];

    if (guildId && client?.isReady?.()) {
      try {
        const guild = await client.guilds.fetch(guildId);
        const channels = await guild.channels.fetch();
        channels.forEach((channel) => {
          if (
            channel &&
            (channel.type === ChannelType.GuildText ||
              channel.type === ChannelType.GuildAnnouncement)
          ) {
            discordChannels.push({
              id: channel.id,
              name: channel.name,
            });
          }
        });
      } catch (error) {
        console.error("Failed to load Discord channels for scheduler", error);
      }
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/scheduler/scheduler-index", {
        pageTitle: `Dashboard - Scheduler`,
        config: config,
        features: features,
        req: req,
        globalImage,
        announcementWeb,
        announcementsData: announcementsData,
        scheduledMessages: scheduledMessages,
        discordChannels: discordChannels,
      })
    );
    return;
  });
}
