import crypto from "crypto";
import { MONTHS } from "../lib/birthday.mjs";
import { groupedTimeZones } from "../lib/timezones.mjs";
import qs from "querystring";
import { getGlobalImage, isLoggedIn, setBannerCookie } from "../api/common.js";
import { checkRateLimit } from "../lib/rateLimiter.mjs";
import { getWebAnnouncement } from "../controllers/announcementController.js";
import {
  UserGetter,
  getProfilePicture,
  getUserLastSession,
  getUserPermissions,
  getUserStats,
  linkDiscordAccount,
  mergePlaceholderUser,
  resolveDiscordLinkConflict,
  unlinkDiscordAccount,
} from "../controllers/userController.js";
import { getTicketsAccessibleByUser, getOpenTicketsWithChannelForUser } from "../controllers/supportTicketController.js";
import {
  getUserByUsername,
  getUserRanks,
  getReportsByReporterId,
  getUserPunishments,
} from "../services/profileService.js";
import { getBadgesForUser } from "../controllers/badgeController.js";
import { retryDeferredDiscordRoles } from "../controllers/webstoreController.js";
import {
  getDiscordPunishmentsForProfile,
  hasActiveWebBan,
} from "../controllers/discordPunishmentController.js";
import {
  getPlatformConnectionsByUserId,
  upsertPlatformConnection,
  deactivatePlatformConnection,
} from "../controllers/watchController.js";
import { checkAndReportNickname } from "../lib/discord/nicknameCheck.mjs";
import { syncMemberRankRoles, stripAllTrackedRankRoles } from "../lib/discord/rankRoleSync.mjs";

export default function profileSiteRoutes(
  app,
  client,
  fetch,
  moment,
  config,
  db,
  features,
  lang
) {
  // ---------------------------------------------------------------------------
  // OAuth URL builders
  // ---------------------------------------------------------------------------

  const buildDiscordLinkAuthorizeUrl = (state) => {
    const params = {
      client_id: process.env.discordClientId,
      redirect_uri: `${process.env.siteAddress}/profile/social/discord/callback`,
      response_type: "code",
      scope: "identify",
      state,
    };

    return `https://discord.com/api/oauth2/authorize?${qs.stringify(params)}`;
  };

  const buildTwitchAuthorizeUrl = (state) => {
    const params = {
      client_id: process.env.twitchClientId,
      redirect_uri: `${process.env.siteAddress}/profile/social/twitch/callback`,
      response_type: "code",
      scope: "user:read:email",
      state,
    };
    return `https://id.twitch.tv/oauth2/authorize?${qs.stringify(params)}`;
  };

  const buildYoutubeAuthorizeUrl = (state) => {
    const params = {
      client_id: process.env.googleClientId,
      redirect_uri: `${process.env.siteAddress}/profile/social/youtube/callback`,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/youtube.readonly",
      access_type: "offline",
      prompt: "consent",
      state,
    };
    return `https://accounts.google.com/o/oauth2/v2/auth?${qs.stringify(params)}`;
  };

  const getProfileEditorRedirect = (req) => {
    const username = req.session?.user?.username;
    return username ? `/profile/${username}/edit` : `/profile`;
  };

  const buildDiscordDisplayName = (discordUser) => {
    if (!discordUser) {
      return null;
    }

    const discriminator =
      discordUser.discriminator && discordUser.discriminator !== "0"
        ? `#${discordUser.discriminator}`
        : "";

    const baseName = discordUser.global_name
      ? discordUser.global_name
      : discriminator
      ? `${discordUser.username}${discriminator}`
      : `@${discordUser.username}`;

    return baseName.substring(0, 32);
  };

  //
  // View User Profile
  //
  app.get("/profile/:username", async function (req, res) {
    const username = req.params.username;

    try {
      const userData = new UserGetter();
      const userHasJoined = await userData.hasJoined(username);

      if (!userHasJoined) {
        res.header("content-type", "text/html; charset=utf-8").send(
          await app.view("session/notFound", {
          pageTitle: `404: Player Not Found`,
          config: config,
          req: req,
          res: res,
          features: features,
          globalImage: await getGlobalImage(),
          announcementWeb: await getWebAnnouncement(),
        }));
        return;
      } else {
        //
        // Grab user profile data (direct DB query, no HTTP self-call)
        //
        const profileData = await getUserByUsername(username);
        if (!profileData) {
          res.header("content-type", "text/html; charset=utf-8").send(
            await app.view("session/notFound", {
            pageTitle: `404: Player Not Found`,
            config: config,
            req: req,
            res: res,
            features: features,
            globalImage: await getGlobalImage(),
            announcementWeb: await getWebAnnouncement(),
          }));
          return;
        }

        //
        // Grab user reports (direct DB query, no HTTP self-call)
        //
        const profileReportsApiData = await getReportsByReporterId(profileData.userId);

        //
        // Get user context for display permissions
        //
        let contextPermissions = null;

        if (req.session.user) {
          if (Array.isArray(req.session.user.permissions)) {
            contextPermissions = req.session.user.permissions;
          } else {
            const userProfile = await userData.byUsername(
              req.session.user.username
            );
            const perms = await getUserPermissions(userProfile);
            contextPermissions = perms;
          }
        } else {
          contextPermissions = null;
        }

        //
        // Grab user punishments (direct DB query, no HTTP self-call)
        //
        let profilePunishmentsApiData = { success: true, data: [] };
        let discordPunishmentsData = [];
        const isViewingOwnProfile =
          req.session.user && req.session.user.username === username;
        if (
          isViewingOwnProfile ||
          (contextPermissions &&
            contextPermissions.includes("zander.web.punishments"))
        ) {
          profilePunishmentsApiData = await getUserPunishments(username);

          // Also fetch Discord punishments for this user
          try {
            discordPunishmentsData = await getDiscordPunishmentsForProfile({
              discordUserId: profileData.discordId || null,
              playerId: profileData.userId || null,
            });
          } catch (err) {
            console.error("[PROFILE] Failed to fetch Discord punishments:", err);
          }
        }

        const canAppeal = isViewingOwnProfile;
        let appealTicketsByKey = {};
        if (canAppeal) {
          const userRankSlugs =
            req.session.user.ranks?.map((rank) => rank.rankSlug) || [];
          const tickets = await getTicketsAccessibleByUser(
            req.session.user.userId,
            userRankSlugs
          );
          appealTicketsByKey = (tickets || []).reduce((acc, ticket) => {
            if (ticket.status === "closed") {
              return acc;
            }
            const match = String(ticket.title || "").match(/Appeal #([^\s]+)/);
            if (match && match[1]) {
              acc[match[1]] = ticket.ticketId;
            }
            return acc;
          }, {});
        }

        //
        // Load platform connections for social links
        //
        let profilePlatformConnections = {};
        try {
          const connRows = await getPlatformConnectionsByUserId(profileData.userId);
          for (const row of connRows) {
            if (row.is_active) profilePlatformConnections[row.platform] = row;
          }
        } catch (err) {
          console.error("[PROFILE] Failed to load platform connections for profile", err);
        }

        //
        // Load badges for profile
        //
        let profileBadges = [];
        try {
          profileBadges = await getBadgesForUser(profileData.userId);
        } catch (err) {
          console.error("[PROFILE] Failed to load badges for profile", err);
        }

        //
        // Render the profile page
        //
        res.header("content-type", "text/html; charset=utf-8").send(
          await app.view("modules/profile/profile", {
          pageTitle: `${profileData.username}`,
          config: config,
          req: req,
          features: features,
          globalImage: await getGlobalImage(),
          announcementWeb: await getWebAnnouncement(),
          profilePicture: await getProfilePicture(profileData.username),
          profileApiData: profileData,
          profileRanks: await getUserRanks(profileData.username),
          profileReportsApiData: profileReportsApiData,
          profilePunishmentsApiData: profilePunishmentsApiData,
          discordPunishmentsData: discordPunishmentsData,
          appealTicketsByKey: appealTicketsByKey,
          canAppeal: canAppeal,
          profileStats: await getUserStats(profileData.userId),
          profileSession: await getUserLastSession(profileData.userId),
          moment: moment,
          contextPermissions: contextPermissions,
          platformConnections: profilePlatformConnections,
          profileBadges: profileBadges,
        }));
        return;
      }
    } catch (error) {
      console.error("[PROFILE] Failed to load profile", error);

      return res.status(500).view("session/error", {
        pageTitle: `Server Error`,
        config: config,
        error: error,
        req: req,
        features: features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      });
    }
  });


  //
  // Edit Signed in User profile
  //
  app.get("/profile/:username/edit", async function (req, res) {
    if (!checkRateLimit(req, res, { windowMs: 60_000, max: 30 })) return;

    const username = req.params.username;

    try {
      const userData = new UserGetter();
      const userHasJoined = await userData.hasJoined(username);

      if (!isLoggedIn(req)) return res.redirect(`/`);

      // Check if user is web-banned
      const sessionUserId = req.session?.user?.userId;
      if (sessionUserId && await hasActiveWebBan(sessionUserId)) {
        setBannerCookie("danger", "You are currently banned from editing your profile.", res);
        return res.redirect(`/profile/${username}`);
      }

      if (!userHasJoined) {
        res.header("content-type", "text/html; charset=utf-8").send(
          await app.view("session/notFound", {
          pageTitle: `404: Player Not Found`,
          config: config,
          req: req,
          res: res,
          features: features,
          globalImage: await getGlobalImage(),
          announcementWeb: await getWebAnnouncement(),
        }));
        return;
      } else {
        //
        // Grab user profile data (direct DB query, no HTTP self-call)
        //
        const profileData = await getUserByUsername(req.session.user.username);
        if (!profileData) {
          res.header("content-type", "text/html; charset=utf-8").send(
            await app.view("session/notFound", {
            pageTitle: `404: Player Not Found`,
            config: config,
            req: req,
            res: res,
            features: features,
            globalImage: await getGlobalImage(),
            announcementWeb: await getWebAnnouncement(),
          }));
          return;
        }

        //
        // Load platform connections for the editor
        //
        let platformConnections = {};
        try {
          const connRows = await getPlatformConnectionsByUserId(profileData.userId);
          for (const row of connRows) {
            platformConnections[row.platform] = row;
          }
        } catch (err) {
          console.error("[PROFILE] Failed to load platform connections", err);
        }

        //
        // Render the profile page
        //
        res.header("content-type", "text/html; charset=utf-8").send(
          await app.view("modules/profile/profileEditor", {
          pageTitle: `${profileData.username} - Profile Editor`,
          config: config,
          req: req,
          features: features,
          globalImage: await getGlobalImage(),
          announcementWeb: await getWebAnnouncement(),
          profilePicture: await getProfilePicture(profileData.username),
          profileApiData: profileData,
          profileRanks: await getUserRanks(profileData.username),
          profileStats: await getUserStats(profileData.userId),
          profileSession: await getUserLastSession(profileData.userId),
          moment: moment,
          platformConnections: platformConnections,
          // Straight from the runtime's ICU data, so the list never goes stale.
          timeZoneGroups: groupedTimeZones(),
          months: MONTHS,
        }));
        return;
      }
    } catch (error) {
      console.error("[PROFILE] Failed to load profile editor", error);

      return res.status(500).view("session/error", {
        pageTitle: `Server Error`,
        config: config,
        error: error,
        req: req,
        features: features,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      });
    }
  });

  app.get("/profile/social/discord/connect", async function (req, res) {
    if (!checkRateLimit(req, res, { windowMs: 60_000, max: 20 })) return;
    if (!isLoggedIn(req)) {
      setBannerCookie(
        "warning",
        "You need to sign in to connect a Discord account.",
        res
      );
      return res.redirect(`/login`);
    }

    const state = crypto.randomBytes(16).toString("hex");
    const requestedRedirect =
      typeof req.query.redirect === "string" && req.query.redirect.startsWith("/")
        ? req.query.redirect
        : getProfileEditorRedirect(req);

    req.session.discordLink = {
      state,
      redirect: requestedRedirect,
    };

    return res.redirect(buildDiscordLinkAuthorizeUrl(state));
  });

  app.get("/profile/social/discord/callback", async function (req, res) {
    const linkSession = req.session.discordLink || {};
    delete req.session.discordLink;

    const redirectPath = linkSession.redirect || getProfileEditorRedirect(req);

    if (!isLoggedIn(req)) {
      setBannerCookie(
        "warning",
        "Please sign in again to complete Discord linking.",
        res
      );
      return res.redirect(`/login`);
    }

    if (!req.query.code) {
      setBannerCookie(
        "danger",
        "Discord did not send an authorisation code.",
        res
      );
      return res.redirect(redirectPath);
    }

    if (!linkSession.state || linkSession.state !== req.query.state) {
      setBannerCookie(
        "danger",
        "Discord connection expired, please try again.",
        res
      );
      return res.redirect(redirectPath);
    }

    try {
      const tokenParams = {
        client_id: process.env.discordClientId,
        client_secret: process.env.discordClientSecret,
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: `${process.env.siteAddress}/profile/social/discord/callback`,
      };

      const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: qs.stringify(tokenParams),
      });

      if (!tokenResponse.ok) {
        const tokenErrorBody = await tokenResponse.text().catch(() => "");
        throw new Error(
          `Failed to obtain Discord token (${tokenResponse.status} ${tokenResponse.statusText}) ${tokenErrorBody}`.trim()
        );
      }

      const tokenData = await tokenResponse.json();

      const userResponse = await fetch("https://discord.com/api/users/@me", {
        headers: {
          Authorization: `${tokenData.token_type} ${tokenData.access_token}`,
        },
      });

      if (!userResponse.ok) {
        throw new Error(
          `Failed to fetch Discord profile (${userResponse.status} ${userResponse.statusText})`
        );
      }

      const discordUser = await userResponse.json();
      const userData = new UserGetter();
      const existingLink = await userData.byDiscordId(discordUser.id);

      const linkConflict = resolveDiscordLinkConflict(
        existingLink,
        req.session.user.userId
      );

      if (linkConflict !== "none") {
        // A placeholder ("ghost") row holds this discordId only because the
        // person used the support bot before linking a Minecraft account
        // (createUnlinkedUser in controllers/supportTicketController.js).
        // Refusing the link here is what stranded their Discord identity on a
        // row with a random UUID and no ranks, permanently splitting them
        // across two accounts — fold the ghost into the real account instead,
        // exactly as registration already does (routes/sessionRoutes.js).
        // A link held by a *real* account is still refused: that would be an
        // account takeover, not a merge.
        if (linkConflict === "absorb") {
          const mergeSummary = await mergePlaceholderUser(
            existingLink.userId,
            req.session.user.userId
          );
          console.log(
            `[PROFILE] Absorbed placeholder userId=${existingLink.userId} into userId=${req.session.user.userId} while linking Discord`,
            mergeSummary
          );
        } else {
          setBannerCookie(
            "danger",
            "That Discord account is already linked to another profile.",
            res
          );
          return res.redirect(redirectPath);
        }
      }

      await linkDiscordAccount(
        req.session.user.userId,
        discordUser.id,
        buildDiscordDisplayName(discordUser)
      );

      req.session.user.discordID = discordUser.id;

      await syncMemberRankRoles(req.session.user.userId);

      // Grant any Discord roles from past webstore purchases that were deferred
      // because this account wasn't linked yet.
      try {
        await retryDeferredDiscordRoles({
          userId: req.session.user.userId,
          discordClient: client,
          guildId: config.discord?.guildId,
        });
      } catch (roleErr) {
        console.error("[PROFILE] Deferred webstore role retry after Discord link failed:", roleErr.message);
      }

      // Trigger nickname enforcement now that the account is linked
      if (features.discord?.events?.nicknameCheck && config.discord?.nicknameReportChannelId && config.discord?.guildId) {
        try {
          const guild = await client.guilds.fetch(config.discord.guildId);
          const member = await guild.members.fetch(discordUser.id).catch(() => null);
          if (member) {
            await checkAndReportNickname(member, config.discord.nicknameReportChannelId, "Discord Account Linked");
          }
        } catch (err) {
          console.error("[PROFILE] Nickname check after Discord link failed:", err.message);
        }
      }

      // Restore access to any open support ticket channels this user belongs to
      try {
        const openTickets = await getOpenTicketsWithChannelForUser(req.session.user.userId);
        for (const ticket of openTickets) {
          try {
            const channel = await client.channels.fetch(ticket.discordChannelId);
            await channel.permissionOverwrites.edit(discordUser.id, {
              ViewChannel: true,
              SendMessages: true,
              AttachFiles: true,
              ReadMessageHistory: true,
            });
          } catch (channelErr) {
            console.error(`[PROFILE] Failed to restore ticket channel access for ticket ${ticket.ticketId}:`, channelErr.message);
          }
        }
      } catch (ticketErr) {
        console.error("[PROFILE] Failed to fetch open tickets after Discord link:", ticketErr.message);
      }

      setBannerCookie("success", "Discord account connected!", res);
    } catch (error) {
      console.error("[PROFILE] Discord link failed", {
        userId: req.session?.user?.userId,
        siteAddress: process.env.siteAddress,
        redirectUri: `${process.env.siteAddress}/profile/social/discord/callback`,
        message: error?.message,
        stack: error?.stack,
      });

      const msg = String(error?.message || "");
      let banner = "We couldn't connect your Discord account. Please try again soon.";
      if (/obtain Discord token/i.test(msg)) {
        banner =
          "Discord rejected the sign-in (token exchange failed). This is a server configuration issue, not something you can fix — staff have been notified.";
      } else if (/fetch Discord profile/i.test(msg)) {
        banner = "Discord accepted the sign-in but wouldn't share your profile. Please try again shortly.";
      }
      setBannerCookie("danger", banner, res);
    }

    return res.redirect(redirectPath);
  });

  app.post("/profile/social/discord/disconnect", async function (req, res) {
    if (!isLoggedIn(req)) {
      setBannerCookie(
        "warning",
        "You need to sign in to disconnect Discord.",
        res
      );
      return res.redirect(`/login`);
    }

    try {
      const discordIdBeingUnlinked = req.session.user.discordID;
      await unlinkDiscordAccount(req.session.user.userId);
      req.session.user.discordID = null;
      if (discordIdBeingUnlinked) {
        await stripAllTrackedRankRoles(discordIdBeingUnlinked);
      }
      setBannerCookie("success", "Discord account disconnected.", res);
    } catch (error) {
      console.error("[PROFILE] Discord unlink failed", error);
      setBannerCookie(
        "danger",
        "We couldn't disconnect your Discord account. Please try again soon.",
        res
      );
    }

    return res.redirect(getProfileEditorRedirect(req));
  });

  // ---------------------------------------------------------------------------
  // Twitch OAuth connect / callback / disconnect
  // ---------------------------------------------------------------------------

  app.get("/profile/social/twitch/connect", async function (req, res) {
    if (!checkRateLimit(req, res, { windowMs: 60_000, max: 20 })) return;
    if (!isLoggedIn(req)) {
      setBannerCookie("warning", "You need to sign in to connect a Twitch account.", res);
      return res.redirect(`/login`);
    }

    if (!process.env.twitchClientId || !process.env.twitchClientSecret) {
      setBannerCookie("danger", "Twitch integration is not configured on this server.", res);
      return res.redirect(getProfileEditorRedirect(req));
    }

    const state = crypto.randomBytes(16).toString("hex");
    const requestedRedirect =
      typeof req.query.redirect === "string" && req.query.redirect.startsWith("/")
        ? req.query.redirect
        : getProfileEditorRedirect(req);

    req.session.twitchLink = { state, redirect: requestedRedirect };
    return res.redirect(buildTwitchAuthorizeUrl(state));
  });

  app.get("/profile/social/twitch/callback", async function (req, res) {
    const linkSession = req.session.twitchLink || {};
    delete req.session.twitchLink;

    const redirectPath = linkSession.redirect || getProfileEditorRedirect(req);

    if (!isLoggedIn(req)) {
      setBannerCookie("warning", "Please sign in again to complete Twitch linking.", res);
      return res.redirect(`/login`);
    }

    if (!req.query.code) {
      setBannerCookie("danger", "Twitch did not send an authorisation code.", res);
      return res.redirect(redirectPath);
    }

    if (!linkSession.state || linkSession.state !== req.query.state) {
      setBannerCookie("danger", "Twitch connection expired, please try again.", res);
      return res.redirect(redirectPath);
    }

    try {
      // Exchange code for token
      const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: qs.stringify({
          client_id: process.env.twitchClientId,
          client_secret: process.env.twitchClientSecret,
          grant_type: "authorization_code",
          code: req.query.code,
          redirect_uri: `${process.env.siteAddress}/profile/social/twitch/callback`,
        }),
      });

      if (!tokenResponse.ok) {
        throw new Error(`Failed to obtain Twitch token (${tokenResponse.status})`);
      }

      const tokenData = await tokenResponse.json();
      const expiresAt = tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null;

      // Fetch Twitch user identity
      const userResponse = await fetch("https://api.twitch.tv/helix/users", {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "Client-Id": process.env.twitchClientId,
        },
      });

      if (!userResponse.ok) {
        throw new Error(`Failed to fetch Twitch profile (${userResponse.status})`);
      }

      const userData = await userResponse.json();
      const twitchUser = userData?.data?.[0];
      if (!twitchUser) throw new Error("Twitch user data missing from response.");

      await upsertPlatformConnection(req.session.user.userId, "twitch", {
        platform_account_id: twitchUser.id,
        platform_channel_id: twitchUser.id, // broadcaster_id == user_id on Twitch
        platform_username: twitchUser.login,
        platform_display_name: twitchUser.display_name,
        avatar_url: twitchUser.profile_image_url || null,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || null,
        token_expires_at: expiresAt,
      });

      setBannerCookie("success", "Twitch account connected!", res);
    } catch (error) {
      console.error("[PROFILE] Twitch link failed", error);
      setBannerCookie("danger", "We couldn't connect your Twitch account. Please try again soon.", res);
    }

    return res.redirect(redirectPath);
  });

  app.post("/profile/social/twitch/disconnect", async function (req, res) {
    if (!isLoggedIn(req)) {
      setBannerCookie("warning", "You need to sign in to disconnect Twitch.", res);
      return res.redirect(`/login`);
    }

    try {
      await deactivatePlatformConnection(req.session.user.userId, "twitch");
      setBannerCookie("success", "Twitch account disconnected.", res);
    } catch (error) {
      console.error("[PROFILE] Twitch unlink failed", error);
      setBannerCookie("danger", "We couldn't disconnect your Twitch account. Please try again soon.", res);
    }

    return res.redirect(getProfileEditorRedirect(req));
  });

  // ---------------------------------------------------------------------------
  // YouTube OAuth connect / callback / disconnect
  // ---------------------------------------------------------------------------

  app.get("/profile/social/youtube/connect", async function (req, res) {
    if (!checkRateLimit(req, res, { windowMs: 60_000, max: 20 })) return;
    if (!isLoggedIn(req)) {
      setBannerCookie("warning", "You need to sign in to connect a YouTube account.", res);
      return res.redirect(`/login`);
    }

    if (!process.env.googleClientId || !process.env.googleClientSecret) {
      setBannerCookie("danger", "YouTube integration is not configured on this server.", res);
      return res.redirect(getProfileEditorRedirect(req));
    }

    const state = crypto.randomBytes(16).toString("hex");
    const requestedRedirect =
      typeof req.query.redirect === "string" && req.query.redirect.startsWith("/")
        ? req.query.redirect
        : getProfileEditorRedirect(req);

    req.session.youtubeLink = { state, redirect: requestedRedirect };
    return res.redirect(buildYoutubeAuthorizeUrl(state));
  });

  app.get("/profile/social/youtube/callback", async function (req, res) {
    const linkSession = req.session.youtubeLink || {};
    delete req.session.youtubeLink;

    const redirectPath = linkSession.redirect || getProfileEditorRedirect(req);

    if (!isLoggedIn(req)) {
      setBannerCookie("warning", "Please sign in again to complete YouTube linking.", res);
      return res.redirect(`/login`);
    }

    if (req.query.error) {
      setBannerCookie("danger", "YouTube authorisation was denied.", res);
      return res.redirect(redirectPath);
    }

    if (!req.query.code) {
      setBannerCookie("danger", "YouTube did not send an authorisation code.", res);
      return res.redirect(redirectPath);
    }

    if (!linkSession.state || linkSession.state !== req.query.state) {
      setBannerCookie("danger", "YouTube connection expired, please try again.", res);
      return res.redirect(redirectPath);
    }

    try {
      // Exchange code for token
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: qs.stringify({
          client_id: process.env.googleClientId,
          client_secret: process.env.googleClientSecret,
          grant_type: "authorization_code",
          code: req.query.code,
          redirect_uri: `${process.env.siteAddress}/profile/social/youtube/callback`,
        }),
      });

      if (!tokenResponse.ok) {
        throw new Error(`Failed to obtain YouTube token (${tokenResponse.status})`);
      }

      const tokenData = await tokenResponse.json();
      const expiresAt = tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null;

      // Fetch YouTube channel identity (the channel owned by the authenticated user)
      const channelResponse = await fetch(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        }
      );

      if (!channelResponse.ok) {
        throw new Error(`Failed to fetch YouTube channel (${channelResponse.status})`);
      }

      const channelData = await channelResponse.json();
      const channel = channelData?.items?.[0];
      if (!channel) throw new Error("No YouTube channel found on this Google account.");

      await upsertPlatformConnection(req.session.user.userId, "youtube", {
        platform_account_id: channel.id,
        platform_channel_id: channel.id,
        platform_username: channel.snippet?.customUrl || channel.id,
        platform_display_name: channel.snippet?.title || channel.id,
        avatar_url: channel.snippet?.thumbnails?.default?.url || null,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || null,
        token_expires_at: expiresAt,
      });

      setBannerCookie("success", "YouTube account connected!", res);
    } catch (error) {
      console.error("[PROFILE] YouTube link failed", error);
      setBannerCookie("danger", "We couldn't connect your YouTube account. Please try again soon.", res);
    }

    return res.redirect(redirectPath);
  });

  app.post("/profile/social/youtube/disconnect", async function (req, res) {
    if (!isLoggedIn(req)) {
      setBannerCookie("warning", "You need to sign in to disconnect YouTube.", res);
      return res.redirect(`/login`);
    }

    try {
      await deactivatePlatformConnection(req.session.user.userId, "youtube");
      setBannerCookie("success", "YouTube account disconnected.", res);
    } catch (error) {
      console.error("[PROFILE] YouTube unlink failed", error);
      setBannerCookie("danger", "We couldn't disconnect your YouTube account. Please try again soon.", res);
    }

    return res.redirect(getProfileEditorRedirect(req));
  });

}
