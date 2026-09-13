import {
  isFeatureEnabled,
  required,
  optional,
  generateLog,
} from "../common.js";

export default function announcementApiRoute(app, config, db, features, lang) {
  const baseEndpoint = "/api/announcement";

  app.get(baseEndpoint + "/get", async function (req, res) {
    if (!isFeatureEnabled(features.announcements, res, lang)) return;
    const announcementId = optional(req.query, "announcementId");
    const announcementType = optional(req.query, "announcementType");
    const enabled = optional(req.query, "enabled");

    try {
      const activeWindowFilter =
        " AND (startDate IS NULL OR startDate <= NOW()) AND (endDate IS NULL OR endDate >= NOW())";

      let dbQuery;
      let params = [];

      if (announcementId) {
        dbQuery = `SELECT * FROM announcements WHERE announcementId=?;`;
        params = [announcementId];
      } else if (announcementType === "web") {
        dbQuery = `SELECT * FROM announcements WHERE announcementType='web' AND enabled=1${activeWindowFilter} ORDER BY RAND() LIMIT 1;`;
      } else if (announcementType === "popup") {
        dbQuery = `SELECT * FROM announcements WHERE announcementType='popup' AND enabled=1${activeWindowFilter} ORDER BY COALESCE(startDate, updatedDate, NOW()) ASC;`;
      } else if (announcementType === "tip") {
        dbQuery = `SELECT * FROM announcements WHERE announcementType='tip' AND enabled=1${activeWindowFilter} ORDER BY RAND() LIMIT 1;`;
      } else if (announcementType === "motd") {
        dbQuery = `SELECT * FROM announcements WHERE announcementType='motd' AND enabled=1${activeWindowFilter} ORDER BY RAND() LIMIT 1;`;
      } else if (enabled === "1") {
        dbQuery = `SELECT * FROM announcements WHERE enabled=1${activeWindowFilter};`;
      } else if (enabled === "0") {
        dbQuery = `SELECT * FROM announcements WHERE enabled=0;`;
      } else {
        dbQuery = `SELECT * FROM announcements;`;
      }

      const results = await new Promise((resolve, reject) => {
        db.query(dbQuery, params, (error, results) => {
          if (error) return reject(error);
          resolve(results);
        });
      });

      // An empty result set is a valid state, not a failure. Returning
      // success:false with no `data` key broke every consumer that reads
      // $.data unconditionally — zander-velocity's MOTD refresh logged a
      // PathNotFoundException once a minute whenever no motd announcement was
      // inside its active window. Always return the key, empty if need be.
      if (!results || !results.length) {
        return res.send({
          success: true,
          data: [],
          message: lang.announcement.noAnnouncements,
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

  app.post(baseEndpoint + "/create", async function (req, res) {
    if (!isFeatureEnabled(features.announcements, res, lang)) return;

    const actioningUser = required(req.body, "actioningUser", res);
    if (res.sent) return;
    const enabled = required(req.body, "enabled", res);
    if (res.sent) return;
    const announcementType = required(req.body, "announcementType", res);
    if (res.sent) return;
    const body = optional(req.body, "body", res);
    const colourMessageFormat = optional(req.body, "colourMessageFormat", res);
    const link = optional(req.body, "link", res);
    const popupButtonText = optional(req.body, "popupButtonText", res);
    const popupImageUrl = optional(req.body, "popupImageUrl", res);
    const startDateRaw = optional(req.body, "startDate", res);
    const endDateRaw = optional(req.body, "endDate", res);
    const timezoneOffset = optional(req.body, "timezoneOffset", res);
    const startDate = normalizeDateTimeInput(
      startDateRaw && startDateRaw.trim() !== "" ? startDateRaw : null,
      timezoneOffset
    );
    const endDate = normalizeDateTimeInput(
      endDateRaw && endDateRaw.trim() !== "" ? endDateRaw : null,
      timezoneOffset
    );

    const now = new Date();

    if (startDate && startDate.getTime() < now.getTime()) {
      return res.send({
        success: false,
        message: "Start date cannot be in the past.",
      });
    }

    if (endDate && endDate.getTime() < now.getTime()) {
      return res.send({
        success: false,
        message: "End date cannot be in the past.",
      });
    }

    if (startDate && endDate && endDate.getTime() < startDate.getTime()) {
      return res.send({
        success: false,
        message: "End date must be after the start date.",
      });
    }

    try {
      await new Promise((resolve, reject) => {
        db.query(
          `INSERT INTO announcements (enabled, body, announcementType, link, colourMessageFormat, popupButtonText, popupImageUrl, startDate, endDate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            enabled,
            body,
            announcementType,
            link,
            colourMessageFormat,
            popupButtonText,
            popupImageUrl,
            startDate ? formatDateTimeForDb(startDate) : null,
            endDate ? formatDateTimeForDb(endDate) : null,
          ],
          (error, results) => {
            if (error) return reject(error);
            resolve(results);
          }
        );
      });

      await generateLog(
        actioningUser,
        "SUCCESS",
        "ANNOUNCEMENT",
        `Created ${announcementType}`
      );

      return res.send({
        success: true,
        alertType: "success",
        content: lang.announcement.announcementCreated,
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

  app.post(baseEndpoint + "/edit", async function (req, res) {
    if (!isFeatureEnabled(features.announcements, res, lang)) return;

    const actioningUser = required(req.body, "actioningUser", res);
    if (res.sent) return;
    const announcementId = required(req.body, "announcementId", res);
    if (res.sent) return;
    const enabled = required(req.body, "enabled", res);
    if (res.sent) return;
    const announcementType = required(req.body, "announcementType", res);
    if (res.sent) return;
    const body = optional(req.body, "body", res);
    const colourMessageFormat = optional(req.body, "colourMessageFormat", res);
    const link = optional(req.body, "link", res);
    const popupButtonText = optional(req.body, "popupButtonText", res);
    const popupImageUrl = optional(req.body, "popupImageUrl", res);
    const startDateRaw = optional(req.body, "startDate", res);
    const endDateRaw = optional(req.body, "endDate", res);
    const timezoneOffset = optional(req.body, "timezoneOffset", res);
    const startDate = normalizeDateTimeInput(
      startDateRaw && startDateRaw.trim() !== "" ? startDateRaw : null,
      timezoneOffset
    );
    const endDate = normalizeDateTimeInput(
      endDateRaw && endDateRaw.trim() !== "" ? endDateRaw : null,
      timezoneOffset
    );

    const now = new Date();

    if (startDate && startDate.getTime() < now.getTime()) {
      return res.send({
        success: false,
        message: "Start date cannot be in the past.",
      });
    }

    if (endDate && endDate.getTime() < now.getTime()) {
      return res.send({
        success: false,
        message: "End date cannot be in the past.",
      });
    }

    if (startDate && endDate && endDate.getTime() < startDate.getTime()) {
      return res.send({
        success: false,
        message: "End date must be after the start date.",
      });
    }

    try {
      await new Promise((resolve, reject) => {
        db.query(
          `
            UPDATE announcements
                SET
                    enabled=?,
                    announcementType=?,
                    body=?,
                    colourMessageFormat=?,
                    link=?,
                    popupButtonText=?,
                    popupImageUrl=?,
                    startDate=?,
                    endDate=?
                WHERE announcementId=?;`,
          [
            enabled,
            announcementType,
            body,
            colourMessageFormat,
            link,
            popupButtonText,
            popupImageUrl,
            startDate ? formatDateTimeForDb(startDate) : null,
            endDate ? formatDateTimeForDb(endDate) : null,
            announcementId,
          ],
          (error, results) => {
            if (error) return reject(error);
            resolve(results);
          }
        );
      });

      await generateLog(
        actioningUser,
        "SUCCESS",
        "ANNOUNCEMENT",
        `Edited ${announcementId}`
      );

      return res.send({
        success: true,
        message: lang.announcement.announcementEdited,
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

  app.post(baseEndpoint + "/delete", async function (req, res) {
    if (!isFeatureEnabled(features.announcements, res, lang)) return;

    const actioningUser = required(req.body, "actioningUser", res);
    if (res.sent) return;
    const announcementId = required(req.body, "announcementId", res);
    if (res.sent) return;

    try {
      await new Promise((resolve, reject) => {
        db.query(
          `DELETE FROM announcements WHERE announcementId=?;`,
          [announcementId],
          (error, results) => {
            if (error) return reject(error);
            resolve(results);
          }
        );
      });

      await generateLog(
        actioningUser,
        "WARNING",
        "ANNOUNCEMENT",
        `Deleted ${announcementId}`
      );

      return res.send({
        success: true,
        message: lang.announcement.announcementDeleted,
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
  if (!value) return null;

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
