import {
  isFeatureEnabled,
  required,
  optional,
  generateLog,
  hashEmail,
} from "../common.js";

export default function schedulerApiRoute(
  app,
  client,
  config,
  db,
  features,
  lang
) {
  const baseEndpoint = "/api/scheduler";

  app.get(baseEndpoint + "/discord/get", async function (req, res) {
    if (!isFeatureEnabled(features.discord, res, lang)) return;
    const status = optional(req.query, "status");

    try {
      const baseQuery =
        "SELECT s.*, u.username, u.profilePicture_type, u.profilePicture_email, u.uuid FROM scheduledDiscordMessages s LEFT JOIN users u ON s.createdBy = u.userId";
      const queryParams = [];
      let dbQuery = baseQuery;

      if (status) {
        dbQuery += " WHERE s.status = ?";
        queryParams.push(status);
      }

      dbQuery += " ORDER BY s.scheduledFor ASC";

      const results = await new Promise((resolve, reject) => {
        db.query(dbQuery, queryParams, (error, results) => {
          if (error) return reject(error);
          resolve(results);
        });
      });

      if (!results || !results.length) {
        return res.send({
          success: false,
          message: "No scheduled Discord messages found.",
        });
      }

      const enhancedResults = await Promise.all(
        results.map(async (row) => {
          let profilePictureUrl = null;

          if (
            row.profilePicture_type === "GRAVATAR" &&
            row.profilePicture_email
          ) {
            const emailHash = await hashEmail(row.profilePicture_email);
            profilePictureUrl = `https://gravatar.com/avatar/${emailHash}?size=80`;
          }

          if (row.profilePicture_type === "CRAFTATAR" && row.uuid) {
            profilePictureUrl = `https://crafthead.net/helm/${row.uuid}`;
          }

          return {
            ...row,
            profilePictureUrl,
          };
        })
      );

      return res.send({
        success: true,
        data: enhancedResults,
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

  app.post(baseEndpoint + "/discord/create", async function (req, res) {
    if (!isFeatureEnabled(features.discord, res, lang)) return;

    const actioningUser = required(req.body, "actioningUser", res);
    if (res.sent) return;
    const channelId = required(req.body, "channelId", res);
    if (res.sent) return;
    const scheduledFor = required(req.body, "scheduledFor", res);
    if (res.sent) return;
    const timezoneOffset = optional(req.body, "timezoneOffset", res);
    const embedTitle = optional(req.body, "embedTitle", res);
    const embedDescription = optional(req.body, "embedDescription", res);
    const embedColor = optional(req.body, "embedColor", res);

    const scheduledDate = normalizeDateTimeInput(
      scheduledFor,
      timezoneOffset
    );
    if (Number.isNaN(scheduledDate.getTime())) {
      return res.send({
        success: false,
        message: "Invalid scheduled date/time.",
      });
    }

    if (scheduledDate.getTime() < Date.now()) {
      return res.send({
        success: false,
        message: "Scheduled time cannot be in the past.",
      });
    }

    try {
      await new Promise((resolve, reject) => {
        db.query(
          `INSERT INTO scheduledDiscordMessages (channelId, embedTitle, embedDescription, embedColor, scheduledFor, createdBy) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            channelId,
            embedTitle,
            embedDescription,
            embedColor,
            formatDateTimeForDb(scheduledDate),
            actioningUser,
          ],
          (error) => {
            if (error) return reject(error);
            resolve();
          }
        );
      });

      await generateLog(
        actioningUser,
        "SUCCESS",
        "SCHEDULER",
        `Scheduled Discord message for channel ${channelId}`
      );

      return res.send({
        success: true,
        message: "Scheduled Discord message.",
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

  app.post(baseEndpoint + "/discord/edit", async function (req, res) {
    if (!isFeatureEnabled(features.discord, res, lang)) return;

    const actioningUser = required(req.body, "actioningUser", res);
    if (res.sent) return;
    const scheduleId = required(req.body, "scheduleId", res);
    if (res.sent) return;
    const channelId = required(req.body, "channelId", res);
    if (res.sent) return;
    const scheduledFor = required(req.body, "scheduledFor", res);
    if (res.sent) return;
    const timezoneOffset = optional(req.body, "timezoneOffset", res);
    const embedTitle = optional(req.body, "embedTitle", res);
    const embedDescription = optional(req.body, "embedDescription", res);
    const embedColor = optional(req.body, "embedColor", res);

    const scheduledDate = normalizeDateTimeInput(scheduledFor, timezoneOffset);
    if (Number.isNaN(scheduledDate.getTime())) {
      return res.send({
        success: false,
        message: "Invalid scheduled date/time.",
      });
    }

    if (scheduledDate.getTime() < Date.now()) {
      return res.send({
        success: false,
        message: "Scheduled time cannot be in the past.",
      });
    }

    try {
      // Only messages that have not been sent may be edited. Editing a message
      // that previously failed re-arms it (status back to scheduled, error
      // cleared, sentAt reset) so the cron picks it up again.
      const result = await new Promise((resolve, reject) => {
        db.query(
          `UPDATE scheduledDiscordMessages
              SET channelId = ?, embedTitle = ?, embedDescription = ?, embedColor = ?, scheduledFor = ?,
                  status = 'scheduled', sentAt = NULL, lastError = NULL
            WHERE scheduleId = ? AND status <> 'sent'`,
          [
            channelId,
            embedTitle,
            embedDescription,
            embedColor,
            formatDateTimeForDb(scheduledDate),
            scheduleId,
          ],
          (error, results) => {
            if (error) return reject(error);
            resolve(results);
          }
        );
      });

      if (!result || result.affectedRows === 0) {
        return res.send({
          success: false,
          message: "That message can no longer be edited (it may have already been sent).",
        });
      }

      await generateLog(
        actioningUser,
        "SUCCESS",
        "SCHEDULER",
        `Edited scheduled Discord message ${scheduleId}`
      );

      return res.send({
        success: true,
        message: "Scheduled Discord message updated.",
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

  app.post(baseEndpoint + "/discord/delete", async function (req, res) {
    if (!isFeatureEnabled(features.discord, res, lang)) return;

    const actioningUser = required(req.body, "actioningUser", res);
    if (res.sent) return;
    const scheduleId = required(req.body, "scheduleId", res);
    if (res.sent) return;

    try {
      await new Promise((resolve, reject) => {
        db.query(
          `DELETE FROM scheduledDiscordMessages WHERE scheduleId = ?`,
          [scheduleId],
          (error) => {
            if (error) return reject(error);
            resolve();
          }
        );
      });

      await generateLog(
        actioningUser,
        "WARNING",
        "SCHEDULER",
        `Deleted scheduled Discord message ${scheduleId}`
      );

      return res.send({
        success: true,
        message: "Scheduled message deleted.",
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
}

function normalizeDateTimeInput(value, timezoneOffset) {
  if (!value) return new Date("");

  const offsetMinutes =
    typeof timezoneOffset === "string" || typeof timezoneOffset === "number"
      ? Number(timezoneOffset)
      : null;

  if (!Number.isNaN(offsetMinutes)) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (match) {
      const [, year, month, day, hour, minute] = match;
      const utcMillis =
        Date.UTC(
          Number(year),
          Number(month) - 1,
          Number(day),
          Number(hour),
          Number(minute)
        ) +
        offsetMinutes * 60000;
      return new Date(utcMillis);
    }
  }

  return new Date(value);
}

function formatDateTimeForDb(dateValue) {
  return dateValue.toISOString().slice(0, 19).replace("T", " ");
}
