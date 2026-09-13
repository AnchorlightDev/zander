import {
  isFeatureEnabled,
  required,
  optional,
  generateLog,
} from "../common.js";

export default function applicationApiRoute(app, config, db, features, lang) {
  const baseEndpoint = "/api/application";

  app.get(baseEndpoint + "/get", async function (req, res) {
    if (!isFeatureEnabled(features.applications, res, lang)) return;
    const applicationId = optional(req.query, "id");

    try {
      let results;
      try {
        results = await new Promise((resolve, reject) => {
          let dbQuery;
          let params = [];
          if (applicationId) {
            dbQuery = `SELECT a.*, f.name as linkedFormName, f.slug as linkedFormSlug, f.status as linkedFormStatus FROM applications a LEFT JOIN forms f ON a.linkedFormId = f.formId WHERE a.applicationId=?;`;
            params = [applicationId];
          } else {
            dbQuery = `SELECT a.*, f.name as linkedFormName, f.slug as linkedFormSlug, f.status as linkedFormStatus FROM applications a LEFT JOIN forms f ON a.linkedFormId = f.formId ORDER BY a.position ASC;`;
          }
          db.query(dbQuery, params, (error, results) => {
            if (error) return reject(error);
            resolve(results);
          });
        });
      } catch (joinError) {
        results = await new Promise((resolve, reject) => {
          const dbQuery = applicationId
            ? `SELECT * FROM applications WHERE applicationId=?;`
            : `SELECT * FROM applications ORDER BY position ASC;`;
          const params = applicationId ? [applicationId] : [];
          db.query(dbQuery, params, (error, results) => {
            if (error) return reject(error);
            resolve(results);
          });
        });
      }

      if (!results || !results.length) {
        return res.send({
          success: false,
          message: lang.applications.noApplicationsFound,
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
    if (!isFeatureEnabled(features.applications, res, lang)) return;

    const actioningUser = required(req.body, "actioningUser", res);
    if (res.sent) return;
    const displayName = required(req.body, "displayName", res);
    if (res.sent) return;
    const description = required(req.body, "description", res);
    if (res.sent) return;
    const displayIcon = required(req.body, "displayIcon", res);
    if (res.sent) return;
    const requirementsMarkdown = required(
      req.body,
      "requirementsMarkdown",
      res
    );
    if (res.sent) return;
    const position = required(req.body, "position", res);
    if (res.sent) return;
    const applicationStatus = required(req.body, "applicationStatus", res);
    if (res.sent) return;

    const applicationType = optional(req.body, "applicationType") || "external";
    const redirectUrl = optional(req.body, "redirectUrl");
    const rawLinkedFormId = optional(req.body, "linkedFormId");
    const linkedFormId =
      rawLinkedFormId === "" ||
      rawLinkedFormId === null ||
      rawLinkedFormId === undefined ||
      Number.isNaN(Number(rawLinkedFormId))
        ? null
        : Number(rawLinkedFormId);

    let applicationCreatedLang = lang.applications.applicationCreated;

    try {
      await new Promise((resolve, reject) => {
        db.query(
          `INSERT INTO applications
              (displayName, description, displayIcon, requirementsMarkdown, redirectUrl, position, applicationStatus, applicationType, linkedFormId)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            displayName,
            description,
            displayIcon,
            requirementsMarkdown,
            redirectUrl,
            position,
            applicationStatus,
            applicationType,
            linkedFormId,
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
        "APPLICATION",
        `Created ${displayName}`
      );

      return res.send({
        success: true,
        message: applicationCreatedLang.replace(
          "%DISPLAYNAME%",
          displayName
        ),
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
    if (!isFeatureEnabled(features.applications, res, lang)) return;

    const actioningUser = required(req.body, "actioningUser", res);
    if (res.sent) return;
    const applicationId = required(req.body, "applicationId", res);
    if (res.sent) return;
    const displayName = required(req.body, "displayName", res);
    if (res.sent) return;
    const description = required(req.body, "description", res);
    if (res.sent) return;
    const displayIcon = required(req.body, "displayIcon", res);
    if (res.sent) return;
    const requirementsMarkdown = required(
      req.body,
      "requirementsMarkdown",
      res
    );
    if (res.sent) return;
    const position = required(req.body, "position", res);
    if (res.sent) return;
    const applicationStatus = required(req.body, "applicationStatus", res);
    if (res.sent) return;

    const applicationType = optional(req.body, "applicationType") || "external";
    const redirectUrl = optional(req.body, "redirectUrl");
    const rawLinkedFormId = optional(req.body, "linkedFormId");
    const linkedFormId =
      rawLinkedFormId === "" ||
      rawLinkedFormId === null ||
      rawLinkedFormId === undefined ||
      Number.isNaN(Number(rawLinkedFormId))
        ? null
        : Number(rawLinkedFormId);

    let applicationEditedLang = lang.applications.applicationEdited;

    try {
      await new Promise((resolve, reject) => {
        db.query(
          `
                  UPDATE
                      applications
                  SET
                      displayName=?,
                      displayIcon=?,
                      description=?,
                      requirementsMarkdown=?,
                      redirectUrl=?,
                      position=?,
                      applicationStatus=?,
                      applicationType=?,
                      linkedFormId=?
                  WHERE applicationId=?;`,
          [
            displayName,
            displayIcon,
            description,
            requirementsMarkdown,
            redirectUrl,
            position,
            applicationStatus,
            applicationType,
            linkedFormId,
            applicationId,
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
        "APPLICATION",
        `Edited ${displayName}`
      );

      return res.send({
        success: true,
        message: applicationEditedLang.replace(
          "%DISPLAYNAME%",
          displayName
        ),
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
    if (!isFeatureEnabled(features.applications, res, lang)) return;

    const actioningUser = required(req.body, "actioningUser", res);
    if (res.sent) return;
    const applicationId = required(req.body, "applicationId", res);
    if (res.sent) return;

    try {
      await new Promise((resolve, reject) => {
        db.query(
          `DELETE FROM applications WHERE applicationId=?;`,
          [applicationId],
          (error, results) => {
            if (error) return reject(error);
            resolve(results);
          }
        );
      });

      await generateLog(
        actioningUser,
        "WARNING",
        "APPLICATION",
        `Deleted ${applicationId}`
      );

      return res.send({
        success: true,
        message: `Deletion of application with the id ${applicationId} has been successful`,
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
