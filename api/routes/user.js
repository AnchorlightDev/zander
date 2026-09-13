import fetch from "node-fetch";
import {
  UserGetter,
  UserLinkGetter,
  getProfilePicture,
  getUserLastSession,
  getUserStats,
  setProfileDisplayPreferences,
  setProfileSocialConnections,
  setProfileUserAboutMe,
  setProfileUserInterests,
} from "../../controllers/userController.js";
import { syncMemberRankRoles } from "../../lib/discord/rankRoleSync.mjs";
import {
  required,
  optional,
  generateVerifyCode,
} from "../common.js";
import { hasActiveWebBan } from "../../controllers/discordPunishmentController.js";
import { checkRateLimit } from "../../lib/rateLimiter.mjs";
import { punishmentsDb } from "../../controllers/databaseController.js";
import verifyToken from "./verifyToken.js";

export default function userApiRoute(app, config, db, features, lang) {
  const baseEndpoint = "/api/user";

  app.post(baseEndpoint + "/create", async function (req, res) {
    const uuid = required(req.body, "uuid", res);
    if (res.sent) return;
    const username = required(req.body, "username", res);
    if (res.sent) return;

    const userCreatedLang = lang.api.userCreated;
    const userAlreadyExistsLang = lang.api.userAlreadyExists;

    try {
      // Check if the user exists
      const existingUser = await new Promise((resolve, reject) => {
        db.query(
          `SELECT * FROM users WHERE uuid=?`,
          [uuid],
          function (error, results) {
            if (error) return reject(error);
            resolve(results[0]);
          }
        );
      });

      if (existingUser) {
        // User already exists, update the username
        await new Promise((resolve, reject) => {
          db.query(
            `UPDATE users SET username=? WHERE uuid=?;`,
            [username, uuid],
            function (error, results) {
              if (error) return reject(error);
              resolve();
            }
          );
        });

        return res.send({
          success: null,
          message: userAlreadyExistsLang,
        });
      } else {
        // User does not exist, create them
        await new Promise((resolve, reject) => {
          db.query(
            `INSERT INTO users (uuid, username) VALUES (?, ?)`,
            [uuid, username],
            function (error, results) {
              if (error) return reject(error);
              resolve();
            }
          );
        });

        return res.send({
          success: true,
          message: userCreatedLang
            .replace("%USERNAME%", username)
            .replace("%UUID%", uuid),
        });
      }
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });

  // TODO: Update docs
  app.get(baseEndpoint + "/get", async function (req, res) {
    const username = optional(req.query, "username");
    const discordId = optional(req.query, "discordId");
    const userId = optional(req.query, "userId");

    if (!username && !discordId && !userId) {
      return res.status(400).send({
        success: false,
        message: "One of username, discordId, or userId is required.",
      });
    }

    // Explicit column list — deliberately excludes password_hash.
    const SAFE_COLUMNS = [
      "userId",
      "uuid",
      "username",
      "discordId",
      "email",
      "email_verified",
      "email_verified_at",
      "joined",
      "profilePicture_type",
      "profilePicture_email",
      "account_registered",
      "account_disabled",
      "social_aboutMe",
      "social_interests",
      "social_discord",
      "social_steam",
      "social_twitch",
      "social_youtube",
      "social_twitter_x",
      "social_instagram",
      "social_reddit",
      "social_spotify",
      "audit_lastDiscordMessage",
      "audit_lastDiscordVoice",
      "audit_lastMinecraftLogin",
      "audit_lastMinecraftMessage",
      "audit_lastMinecraftPunishment",
      "audit_lastDiscordPunishment",
      "audit_lastWebsiteLogin",
    ].join(", ");

    try {
      let dbQuery;
      let params = [];

      if (username) {
        dbQuery = `SELECT ${SAFE_COLUMNS} FROM users WHERE username=?`;
        params = [username];
      } else if (discordId) {
        dbQuery = `SELECT ${SAFE_COLUMNS} FROM users WHERE discordId=?`;
        params = [discordId];
      } else {
        dbQuery = `SELECT ${SAFE_COLUMNS} FROM users WHERE userId=?`;
        params = [userId];
      }

      const results = await new Promise((resolve, reject) => {
        db.query(dbQuery, params, (error, results) => {
          if (error) return reject(error);
          resolve(results);
        });
      });

      if (!results || !results.length) {
        return res.send({
          success: false,
          message: lang.api.userDoesNotExist || "No Users found",
        });
      }

      return res.send({
        success: true,
        data: results,
      });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });

  // TODO: Update docs
  app.get(baseEndpoint + "/profile/get", async function (req, res) {
    const username = optional(req.query, "username");
    const discordId = optional(req.query, "discordId");

    try {
      const buildProfileResponse = async (userRecord) => {
        if (!userRecord) {
          return res.send({
            success: false,
            message: lang.api.userDoesNotExist,
          });
        }

        const profilePicture = await getProfilePicture(userRecord.username);
        const profileStats = await getUserStats(userRecord.userId);
        const profileSession = await getUserLastSession(userRecord.userId);

        return res.send({
          success: true,
          data: {
            profileData: userRecord,
            profilePicture: profilePicture,
            profileStats: profileStats,
            profileSession: profileSession,
          },
        });
      };

      if (username) {
        const fetchURL = `${process.env.siteAddress}/api/user/get?username=${encodeURIComponent(username)}`;
        const response = await fetch(fetchURL, {
          headers: { "x-access-token": process.env.apiKey },
        });

        const apiData = await response.json();

        if (!apiData.success || !apiData.data || !apiData.data.length) {
          return res.send({
            success: false,
            message: lang.api.userDoesNotExist,
          });
        }

        return await buildProfileResponse(apiData.data[0]);
      } else if (discordId) {
        const fetchURL = `${process.env.siteAddress}/api/user/get?discordId=${encodeURIComponent(discordId)}`;
        const response = await fetch(fetchURL, {
          headers: { "x-access-token": process.env.apiKey },
        });

        const apiData = await response.json();

        if (!apiData.success || !apiData.data || !apiData.data.length) {
          return res.send({
            success: false,
            message: lang.api.userDoesNotExist,
          });
        }

        return await buildProfileResponse(apiData.data[0]);
      } else {
        return res.send({
          success: false,
          message: `No Users found`,
        });
      }
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });

  app.get(baseEndpoint + "/punishments", async function (req, res) {
    const uuid = optional(req.query, "uuid");
    const username = optional(req.query, "username");
    const discordId = optional(req.query, "discordId");

    try {
      const userGetter = new UserGetter();
      let userRecord = null;
      let resolvedUuid = uuid;

      if (resolvedUuid) {
        userRecord = await userGetter.byUUID(resolvedUuid);
      } else if (username) {
        userRecord = await userGetter.byUsername(username);
      } else if (discordId) {
        userRecord = await userGetter.byDiscordId(discordId);
      }

      if (!resolvedUuid && userRecord?.uuid) {
        resolvedUuid = userRecord.uuid;
      }

      if (!resolvedUuid) {
        return res.send({
          success: false,
          message: lang.api.userDoesNotExist,
        });
      }

      const normalizedUuid = resolvedUuid.replace(/-/g, "").toLowerCase();
      const rawPunishments = await new Promise((resolve, reject) => {
        punishmentsDb.query(
          `SELECT litebans.id AS punishmentId,
                  litebans.uuid AS bannedUuid,
                  litebans.banned_by_uuid AS bannedByUuid,
                  litebans.removed_by_uuid AS removedByUuid,
                  litebans.type,
                  litebans.active,
                  litebans.silent,
                  FROM_UNIXTIME(litebans.time / 1000) AS dateStart,
                  FROM_UNIXTIME(NULLIF(litebans.until / 1000, 0)) AS dateEnd,
                  litebans.removed_by_date AS dateRemoved,
                  litebans.reason,
                  litebans.removed_by_reason AS reasonRemoved,
                  litebans.ip,
                  litebans.ipban,
                  litebans.ipban_wildcard AS ipBanWildcard
           FROM (
             SELECT id, uuid, ip, reason, banned_by_uuid, time,
                    NULL AS until, NULL AS removed_by_uuid, NULL AS removed_by_reason,
                    NULL AS removed_by_date, silent, ipban, ipban_wildcard, NULL AS active,
                    'kick' AS type FROM litebans_kicks
             UNION ALL
             SELECT id, uuid, ip, reason, banned_by_uuid, time,
                    until, removed_by_uuid, removed_by_reason, removed_by_date,
                    silent, ipban, ipban_wildcard, active, 'ban' AS type FROM litebans_bans
             UNION ALL
             SELECT id, uuid, ip, reason, banned_by_uuid, time,
                    until, removed_by_uuid, removed_by_reason, removed_by_date,
                    silent, ipban, ipban_wildcard, active, 'mute' AS type FROM litebans_mutes
             UNION ALL
             SELECT id, uuid, ip, reason, banned_by_uuid, time,
                    until, removed_by_uuid, removed_by_reason, removed_by_date,
                    silent, ipban, ipban_wildcard, active, 'warning' AS type FROM litebans_warnings
           ) AS litebans
           WHERE REPLACE(litebans.uuid, '-', '') = ?
           ORDER BY litebans.time DESC
           LIMIT 50`,
          [normalizedUuid],
          (error, results) => {
            if (error) return reject(error);
            resolve(results || []);
          }
        );
      });

      // Resolve banner/remover UUIDs → usernames from the main DB.
      const actorUuids = [...new Set(
        rawPunishments.flatMap((p) => [p.bannedByUuid, p.removedByUuid].filter(Boolean))
      )];
      let usernameByUuid = {};
      if (actorUuids.length > 0) {
        const placeholders = actorUuids.map(() => "REPLACE(uuid, '-', '') = ?").join(" OR ");
        const normalized = actorUuids.map((u) => u.replace(/-/g, "").toLowerCase());
        const usersRows = await new Promise((resolve, reject) => {
          db.query(
            `SELECT uuid, username FROM users WHERE ${placeholders}`,
            normalized,
            (err, rows) => { if (err) return reject(err); resolve(rows || []); }
          );
        });
        for (const row of usersRows) {
          usernameByUuid[row.uuid.replace(/-/g, "").toLowerCase()] = row.username;
        }
      }

      const punishments = rawPunishments.map((p) => ({
        ...p,
        bannedByUsername: p.bannedByUuid
          ? usernameByUuid[p.bannedByUuid.replace(/-/g, "").toLowerCase()] || null
          : null,
        removedByUsername: p.removedByUuid
          ? usernameByUuid[p.removedByUuid.replace(/-/g, "").toLowerCase()] || null
          : null,
      }));

      return res.send({
        success: true,
        data: punishments,
        target: {
          username: userRecord?.username ?? null,
          uuid: resolvedUuid,
          userId: userRecord?.userId ?? null,
        },
      });
    } catch (error) {
      console.error("Failed to fetch punishments", error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });

  app.post(baseEndpoint + "/verify", async function (req, res) {
    if (!checkRateLimit(req, res, { windowMs: 15 * 60_000, max: 10 })) return;
    const username = required(req.body, "username", res);
    if (res.sent) return;
    const uuid = required(req.body, "uuid", res);
    if (res.sent) return;

    try {
      const userData = new UserGetter();
      const user = await userData.byUUID(uuid);

      if (!user) {
        return res.send({
          success: false,
          message: `User ${username} does not exist in player base, please join the Network and try again.`,
        });
      }

      if (user.discordId) {
        return res.send({
          success: false,
          message: `You are already registered and linked, you cannot do this again.`,
        });
      }

      const linkCode = await generateVerifyCode();
      const now = new Date();
      const codeExpiry = new Date(now.getTime() + 5 * 60000);

      // Only one valid code should exist per player at a time — drop any
      // previous (still-unexpired) code for this UUID before issuing a new
      // one. This also clears the way for the INSERT below, since
      // userVerifyLink.uuid is UNIQUE.
      await new Promise((resolve, reject) => {
        db.query(
          `DELETE FROM userVerifyLink WHERE uuid = ?`,
          [uuid],
          function (error, results) {
            if (error) return reject(error);
            resolve(results);
          }
        );
      });

      await new Promise((resolve, reject) => {
        db.query(
          `INSERT INTO userVerifyLink (uuid, username, linkCode, codeExpiry) VALUES (?, ?, ?, ?)`,
          [uuid, username, linkCode, codeExpiry],
          function (error, results) {
            if (error) return reject(error);
            resolve(results);
          }
        );
      });

      return res.send({
        success: true,
        message: `Here is your code: ${linkCode}\nGo back to the registration form and put this in.\nThis code will expire in 5 minutes.`,
      });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `There was an error in setting your code, try again in 5 minutes.`,
        });
      }
    }
  });

  app.post(baseEndpoint + "/verify/ingame", { preHandler: verifyToken }, async function (req, res) {
    const uuid = required(req.body, "uuid", res);
    if (res.sent) return;
    const code = required(req.body, "code", res);
    if (res.sent) return;

    try {
      const row = await new Promise((resolve, reject) => {
        db.query(
          `SELECT verifyId, uuid FROM userVerifyLink WHERE uuid = ? AND linkCode = ? AND codeExpiry > NOW()`,
          [uuid, code],
          function (error, results) {
            if (error) return reject(error);
            resolve(results && results.length ? results[0] : null);
          }
        );
      });

      if (!row) {
        // Distinguish "wrong code" from "right code, but too late" so the
        // player knows whether to re-check for typos or just run /link again.
        const expiredRow = await new Promise((resolve, reject) => {
          db.query(
            `SELECT verifyId FROM userVerifyLink WHERE uuid = ? AND linkCode = ? AND codeExpiry <= NOW()`,
            [uuid, code],
            function (error, results) {
              if (error) return reject(error);
              resolve(results && results.length ? results[0] : null);
            }
          );
        });

        return res.send({
          success: false,
          message: expiredRow
            ? "That code has expired. Run /link again to get a new one."
            : "That code doesn't match. Double-check it for typos.",
        });
      }

      const userLinkData = new UserLinkGetter();
      await userLinkData.markWebsiteRegistrationComplete(uuid);

      return res.send({
        success: true,
        message: "Your account has been verified and linked successfully.",
      });
    } catch (error) {
      console.error("[user/verify/ingame] Error:", error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });

  app.post(baseEndpoint + "/link", async function (req, res) {
    const discordId = required(req.body, "discordId", res);
    if (res.sent) return;
    const first = required(req.body, "first", res);
    if (res.sent) return;
    const second = required(req.body, "second", res);
    if (res.sent) return;
    const third = required(req.body, "third", res);
    if (res.sent) return;
    const fourth = required(req.body, "fourth", res);
    if (res.sent) return;
    const fifth = required(req.body, "fifth", res);
    if (res.sent) return;
    const sixth = required(req.body, "sixth", res);
    if (res.sent) return;

    const verifyCode = first + second + third + fourth + fifth + sixth;

    try {
      const userLinkData = new UserLinkGetter();
      const linkUser = await userLinkData.getUserByCode(verifyCode);

      if (!linkUser) {
        // Tell an expired code apart from a genuinely wrong one.
        const expiredRow = await new Promise((resolve, reject) => {
          db.query(
            `SELECT verifyId FROM userVerifyLink WHERE linkCode = ? AND codeExpiry <= NOW()`,
            [verifyCode],
            function (error, results) {
              if (error) return reject(error);
              resolve(results && results.length ? results[0] : null);
            }
          );
        });

        return res.send({
          success: false,
          alertType: "warning",
          alertContent: expiredRow
            ? `That code has expired. Run /link in-game again to get a new one.`
            : `That code doesn't match. Check it for typos and try again.`,
        });
      }

      let linkUserUUID = linkUser.uuid;

      try {
        const success = await userLinkData.link(linkUserUUID, discordId);
        if (success) {
          const linkedWebUser = await new UserGetter().byUUID(linkUserUUID);
          if (linkedWebUser) {
            await syncMemberRankRoles(linkedWebUser.userId);
          }
          return res.send({
            success: true,
            alertType: "success",
            alertContent: `Link success`,
          });
        } else {
          return res.send({
            success: false,
            alertType: "warning",
            alertContent: `Link failed`,
          });
        }
      } catch (error) {
        console.error("Error linking:", error);
        return res.send({
          success: false,
          alertType: "warning",
          alertContent: `Issue with linking, try again soon.`,
        });
      }
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });

  app.post(baseEndpoint + "/profile/display", async function (req, res) {
    const userId = required(req.body, "userId", res);
    if (res.sent) return;
    const profilePicture_type = required(req.body, "profilePicture_type", res);
    if (res.sent) return;
    const profilePicture_email = optional(req.body, "profilePicture_email");

    if (await hasActiveWebBan(req.session?.user?.userId)) {
      return res.send({ success: false, message: "You are currently banned from editing your profile." });
    }

    try {
      await setProfileDisplayPreferences(
        userId,
        profilePicture_type,
        profilePicture_email
      );
      return res.send({ success: true, message: "Display preferences updated." });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });

  app.post(baseEndpoint + "/profile/interests", async function (req, res) {
    const userId = required(req.body, "userId", res);
    if (res.sent) return;
    const social_interests = required(req.body, "social_interests", res);
    if (res.sent) return;

    if (await hasActiveWebBan(req.session?.user?.userId)) {
      return res.send({ success: false, message: "You are currently banned from editing your profile." });
    }

    try {
      const filterURL = `${process.env.siteAddress}/api/filter`;
      const bodyJSON = { content: social_interests };

      const response = await fetch(filterURL, {
        method: "POST",
        body: JSON.stringify(bodyJSON),
        headers: {
          "Content-Type": "application/json",
          "x-access-token": process.env.apiKey,
        },
      });

      const dataResponse = await response.json();

      if (dataResponse.success === true) {
        try {
          await setProfileUserInterests(userId, social_interests);
          return res.send({ success: true, message: "Interests updated." });
        } catch (error) {
          console.error(error);
          return res.status(500).send({
            success: false,
            message: `${error}`,
          });
        }
      } else {
        console.log(`Illegal words detected.`);
        setBannerCookie(
          "danger",
          `Illegal words detected, changes not applied.`,
          res
        );
        return res.send({ success: false, message: "Illegal words detected." });
      }
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });

  app.post(baseEndpoint + "/profile/about", async function (req, res) {
    const userId = required(req.body, "userId", res);
    if (res.sent) return;
    const social_aboutMe = required(req.body, "social_aboutMe", res);
    if (res.sent) return;

    if (await hasActiveWebBan(req.session?.user?.userId)) {
      return res.send({ success: false, message: "You are currently banned from editing your profile." });
    }

    try {
      const filterURL = `${process.env.siteAddress}/api/filter`;
      const bodyJSON = { content: social_aboutMe };

      const response = await fetch(filterURL, {
        method: "POST",
        body: JSON.stringify(bodyJSON),
        headers: {
          "Content-Type": "application/json",
          "x-access-token": process.env.apiKey,
        },
      });

      const dataResponse = await response.json();

      if (dataResponse.success === true) {
        try {
          await setProfileUserAboutMe(userId, social_aboutMe);
          return res.send({ success: true, message: "About me updated." });
        } catch (error) {
          console.error(error);
          return res.status(500).send({
            success: false,
            message: `${error}`,
          });
        }
      } else {
        return res.send({ success: false, message: "Illegal words detected." });
      }
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });

  app.post(baseEndpoint + "/profile/social", async function (req, res) {
    const userId = required(req.body, "userId", res);
    if (res.sent) return;
    const social_discord = optional(req.body, "social_discord");
    const social_steam = optional(req.body, "social_steam");
    const social_twitter_x = optional(req.body, "social_twitter_x");
    const social_instagram = optional(req.body, "social_instagram");
    const social_reddit = optional(req.body, "social_reddit");
    const social_spotify = optional(req.body, "social_spotify");

    if (await hasActiveWebBan(req.session?.user?.userId)) {
      return res.send({ success: false, message: "You are currently banned from editing your profile." });
    }

    try {
      await setProfileSocialConnections(
        userId,
        social_discord,
        social_steam,
        social_twitter_x,
        social_instagram,
        social_reddit,
        social_spotify
      );
      return res.send({ success: true, message: "Social connections updated." });
    } catch (error) {
      console.error(error);
      if (!res.sent) {
        return res.status(500).send({
          success: false,
          message: `${error}`,
        });
      }
    }
  });
}
