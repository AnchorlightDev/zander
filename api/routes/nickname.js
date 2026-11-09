/**
 * Nickname API for the Velocity proxy (scope: "nickname", enforced centrally by
 * api/routes/verifyToken.js via lib/apiKeys.js SCOPE_ROUTES).
 *
 * The proxy never touches the database: it sets/clears/resolves nicknames and
 * reports them through these endpoints. All rules live in the controller.
 *
 * There is deliberately no feature flag: the release is controlled entirely by
 * the zander.nickname permission (granted to supporter ranks on 25 December).
 */

import { MessageBuilder, Webhook } from "discord-webhook-node";
import { sendWebhookMessage } from "../../lib/discord/webhooks.mjs";
import { Colors } from "discord.js";
import { required, optional } from "../common.js";
import {
  setNickname,
  clearNickname,
  resolveNickname,
  resolveRealName,
  resolveUser,
} from "../../controllers/nicknameController.js";

export default function nicknameApiRoute(app, config, db, features, lang) {
  const base = "/api/nickname";

  // Set or change a player's own nickname.
  app.post(base + "/set", async function (req, res) {
    const uuid = required(req.body, "uuid", res);
    if (res.sent) return;
    const name = required(req.body, "name", res);
    if (res.sent) return;
    const color = optional(req.body, "color");

    try {
      const result = await setNickname({ uuid }, { name, color });
      return res.send({
        success: result.ok === true,
        code: result.code || null,
        message: result.message || null,
        nickname: result.nickname || null,
        color: result.color || null,
      });
    } catch (error) {
      console.error("[api/nickname#set]", error);
      return res.status(500).send({ success: false, message: "Nickname update failed." });
    }
  });

  // Clear a player's own nickname (allowed even while punished).
  app.post(base + "/clear", async function (req, res) {
    const uuid = required(req.body, "uuid", res);
    if (res.sent) return;

    try {
      const result = await clearNickname({ uuid });
      return res.send({
        success: result.ok === true,
        code: result.code || null,
        message: result.message || null,
        cleared: Boolean(result.cleared),
      });
    } catch (error) {
      console.error("[api/nickname#clear]", error);
      return res.status(500).send({ success: false, message: "Nickname clear failed." });
    }
  });

  // Effective nickname for a UUID (what the proxy should display). Returns the
  // real username whenever the player has no visible nickname.
  app.get(base + "/effective", async function (req, res) {
    const uuid = required(req.query, "uuid", res);
    if (res.sent) return;

    try {
      const resolved = await resolveNickname({ uuid });
      if (!resolved) return res.send({ success: false, message: "Unknown player." });
      return res.send({
        success: true,
        data: {
          uuid: resolved.uuid,
          realname: resolved.realname,
          nickname: resolved.nickname,
          color: resolved.color,
          display: resolved.display,
          isNick: resolved.isNick,
        },
      });
    } catch (error) {
      console.error("[api/nickname#effective]", error);
      return res.status(500).send({ success: false, message: "Lookup failed." });
    }
  });

  // Real username behind a currently-displayed nickname (/realname).
  app.get(base + "/realname", async function (req, res) {
    const nickname = required(req.query, "nickname", res);
    if (res.sent) return;

    try {
      const match = await resolveRealName(nickname);
      if (!match) return res.send({ success: false, message: "No player is using that nickname." });
      return res.send({
        success: true,
        data: { username: match.username, uuid: match.uuid, nickname: match.nickname },
      });
    } catch (error) {
      console.error("[api/nickname#realname]", error);
      return res.status(500).send({ success: false, message: "Lookup failed." });
    }
  });

  // Report a nickname. Follows the existing player-report flow: a row in the
  // flat `reports` table plus a staff Discord webhook. Always records the real
  // username alongside the displayed nickname.
  app.post(base + "/report", async function (req, res) {
    const reporterUuid = required(req.body, "reporterUuid", res);
    if (res.sent) return;
    const reportedNickname = required(req.body, "reportedNickname", res);
    if (res.sent) return;
    const extra = optional(req.body, "reason");

    try {
      const reporter = await resolveUser({ uuid: reporterUuid });
      if (!reporter) return res.send({ success: false, message: "Unknown reporter." });

      const match = await resolveRealName(reportedNickname);
      const reportedUser = match ? match.username : String(reportedNickname).replace(/^~/, "");
      const displayedNick = String(reportedNickname).replace(/^~/, "");

      const reason = `Nickname report: ~${displayedNick}`.slice(0, 100);
      const evidence = [
        match ? `Real username: ${reportedUser}` : "Real username: could not be resolved",
        `Displayed nickname: ~${displayedNick}`,
        extra ? `Reporter note: ${extra}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      await new Promise((resolve, reject) => {
        db.query(
          `INSERT INTO reports (reporterId, reportedUser, reportReason, reportReasonEvidence, reportPlatform)
           VALUES ((SELECT userId FROM users WHERE userId = ?), ?, ?, ?, 'minecraft')`,
          [reporter.userId, reportedUser.slice(0, 30), reason, evidence],
          (error, results) => (error ? reject(error) : resolve(results))
        );
      });

      const staffChannelHook = new Webhook(config.discord.webhooks.staffChannel);
      const embed = new MessageBuilder()
        .setTitle(`Nickname Report: ~${displayedNick}`)
        .addField("Reported By", reporter.username, true)
        .addField("Real Username", reportedUser, true)
        .addField("Displayed Nickname", `~${displayedNick}`)
        .setColor(Colors.Orange)
        .setTimestamp();
      if (extra) embed.addField("Note", String(extra).slice(0, 1000));
      await sendWebhookMessage(staffChannelHook, embed, { context: "api/nickname#report" });

      return res.send({ success: true, message: "Thanks, staff have been notified." });
    } catch (error) {
      console.error("[api/nickname#report]", error);
      return res.status(500).send({ success: false, message: "Report failed, please try again." });
    }
  });
}
