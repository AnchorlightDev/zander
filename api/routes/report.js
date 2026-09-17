import { MessageBuilder, Webhook } from "discord-webhook-node";
import { sendWebhookMessage } from "../../lib/discord/webhooks.mjs";
import {
  isFeatureEnabled,
  required,
  optional,
  setBannerCookie,
} from "../common.js";
import { Colors } from "discord.js";

/** Matches reports.reportReason VARCHAR(100) — see prisma/schema.prisma. */
export const REPORT_REASON_MAX_LENGTH = 100;

/**
 * Fit a report reason into its column without losing what the reporter wrote.
 *
 * reports.reportReason is VARCHAR(100) and MySQL rejects anything longer
 * outright ("Data too long for column 'reportReason'"), which threw away the
 * entire report.  The reason is truncated to fit and the full text is folded
 * into reportReasonEvidence (MEDIUMTEXT) so the moderator still sees all of it.
 *
 * routes/forumRoutes.js already truncates to the same limit before calling the
 * API; this covers the callers that do not — the web form and /report.
 *
 * Pure, so the boundary behaviour is unit-testable without a database.
 *
 * @param {string} rawReason
 * @param {string|null} rawEvidence
 * @returns {{reportReason: string, reportReasonEvidence: string|null}}
 */
export function fitReportReason(rawReason, rawEvidence = null) {
  if (typeof rawReason !== "string" || rawReason.length <= REPORT_REASON_MAX_LENGTH) {
    return { reportReason: rawReason, reportReasonEvidence: rawEvidence };
  }

  return {
    reportReason: rawReason.slice(0, REPORT_REASON_MAX_LENGTH),
    reportReasonEvidence: [`Full reason: ${rawReason}`, rawEvidence]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export default function reportApiRoute(app, config, db, features, lang) {
  const baseEndpoint = "/api/report";

  // TODO: Update docs
  app.get(baseEndpoint + "/get", async function (req, res) {
    isFeatureEnabled(features.report, res, lang);
    const reportedId = optional(req.query, "reportedId");

    try {
      let dbQuery;
      let params = [];

      if (reportedId) {
        dbQuery = "SELECT * FROM reports WHERE reportedId = ?";
        params = [reportedId];
      } else {
        dbQuery = "SELECT * FROM reports";
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
          message: `There are no reports available.`,
        });
      }

      return res.send({
        success: true,
        data: results,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).send({
        success: false,
        message: `${error}`,
      });
    }
  });

  app.post(baseEndpoint + "/create", async function (req, res) {
    isFeatureEnabled(features.report, res, lang);

    const reporterUser = required(req.body, "reporterUser", res);
    const reportedUser = required(req.body, "reportedUser", res);
    const rawReportReason = required(req.body, "reportReason", res);
    const rawReportReasonEvidence = optional(
      req.body,
      "reportReasonEvidence",
      res
    );

    // Keeps the reason inside VARCHAR(100); an over-long one is folded into
    // the evidence field rather than failing the whole insert.
    const { reportReason, reportReasonEvidence } = fitReportReason(
      rawReportReason,
      rawReportReasonEvidence
    );

    const reportPlatform = required(req.body, "reportPlatform", res);

    try {
      await new Promise((resolve, reject) => {
        db.query(
          `
          INSERT INTO
              reports
          (
              reporterId,
              reportedUser,
              reportReason,
              reportReasonEvidence,
              reportPlatform
          ) VALUES ((SELECT userId FROM users WHERE username=?), ?, ?, ?, ?)`,
          [
            reporterUser,
            reportedUser,
            reportReason,
            reportReasonEvidence,
            reportPlatform,
          ],
          (error, results) => {
            if (error) return reject(error);
            resolve(results);
          }
        );
      });

      setBannerCookie("success", "Report has been sent.", res);

      const staffChannelHook = new Webhook(
        config.discord.webhooks.staffChannel
      );

      const embed = new MessageBuilder()
        .setTitle(`New Report: ${reportedUser}`)
        .addField("Report Platform", reportPlatform, true)
        .addField("Report By", reporterUser, true)
        .addField("Report Reason", reportReason)
        .setColor(Colors.Red)
        .setTimestamp();

      if (reportReasonEvidence) {
        embed.addField("Report Evidence", reportReasonEvidence);
      }

      const webhookSent = await sendWebhookMessage(
        staffChannelHook,
        embed,
        { context: "api/report#create" }
      );

      if (!webhookSent) {
        return res.send({
          success: false,
          message:
            "Report saved, but we couldn't notify staff. Please try again soon.",
        });
      }

      return res.send({
        success: true,
        message: `Thanks for your submission: ${reportedUser} for ${reportReason}.`,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).send({
        success: false,
        message: `Report has failed, please try again later.`,
      });
    }
  });
}
