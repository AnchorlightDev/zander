import { sanitizeForumHtml } from "../../lib/htmlSanitize.js";
import { isAllowedUrl } from "../../lib/navigation/menus.mjs";
import {
  isFeatureEnabled,
  required,
  optional,
  generateLog,
} from "../common.js";

export default function vaultApiRoute(app, config, db, features, lang) {
  const baseEndpoint = "/api/vault";

  app.get(baseEndpoint + "/get", async function (req, res) {
    if (!isFeatureEnabled(features.vault, res, lang)) return;
    const vaultId = optional(req.query, "id");

    try {
      const results = await new Promise((resolve, reject) => {
        let dbQuery;
        let params = [];
        if (vaultId) {
          dbQuery = "SELECT * FROM vault WHERE vaultId=?;";
          params = [vaultId];
        } else {
          dbQuery = "SELECT * FROM vault ORDER BY position ASC;";
        }

        db.query(dbQuery, params, (error, results) => {
          if (error) return reject(error);
          resolve(results);
        });
      });

      if (!results || !results.length) {
        return res.send({
          success: false,
          message: `No vault items found.`,
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
    if (!isFeatureEnabled(features.vault, res, lang)) return;

    const actioningUser = required(req.body, "actioningUser", res);
    if (res.sent) return;
    const displayName = required(req.body, "displayName", res);
    if (res.sent) return;
    const rawDescription = required(req.body, "description", res);
    if (res.sent) return;
    // Rendered unescaped on the public /vault page: strip scripts/handlers.
    const description = sanitizeForumHtml(String(rawDescription));
    const redirectUrl = required(req.body, "redirectUrl", res);
    if (res.sent) return;
    if (!isAllowedUrl(redirectUrl)) {
      return res.send({ success: false, message: "Redirect URL must start with /, https://, http:// or mailto:." });
    }
    const position = required(req.body, "position", res);
    if (res.sent) return;

    try {
      await new Promise((resolve, reject) => {
        db.query(
          `INSERT INTO vault
              (displayName, description, redirectUrl, position)
          VALUES (?, ?, ?, ?)`,
          [
            displayName,
            description,
            redirectUrl,
            position
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
        "VAULT",
        `Created ${displayName}`
      );

      return res.send({
        success: true,
        message: `Created ${displayName} vault.`,
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
    if (!isFeatureEnabled(features.vault, res, lang)) return;

    const actioningUser = required(req.body, "actioningUser", res);
    if (res.sent) return;
    const vaultId = required(req.body, "vaultId", res);
    if (res.sent) return;
    const displayName = required(req.body, "displayName", res);
    if (res.sent) return;
    const rawDescription = required(req.body, "description", res);
    if (res.sent) return;
    // Rendered unescaped on the public /vault page: strip scripts/handlers.
    const description = sanitizeForumHtml(String(rawDescription));
    const redirectUrl = required(req.body, "redirectUrl", res);
    if (res.sent) return;
    if (!isAllowedUrl(redirectUrl)) {
      return res.send({ success: false, message: "Redirect URL must start with /, https://, http:// or mailto:." });
    }
    const position = required(req.body, "position", res);
    if (res.sent) return;

    try {
      await new Promise((resolve, reject) => {
        db.query(
          `
                  UPDATE
                      vault
                  SET
                      displayName=?,
                      description=?,
                      redirectUrl=?,
                      position=?
                  WHERE vaultId=?;`,
          [
            displayName,
            description,
            redirectUrl,
            position,
            vaultId,
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
        "VAULT",
        `Edited ${displayName}`
      );

      return res.send({
        success: true,
        message: `${displayName} has been edited.`,
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
    if (!isFeatureEnabled(features.vault, res, lang)) return;

    const actioningUser = required(req.body, "actioningUser", res);
    if (res.sent) return;
    const vaultId = required(req.body, "vaultId", res);
    if (res.sent) return;

    try {
      await new Promise((resolve, reject) => {
        db.query(
          `DELETE FROM vault WHERE vaultId=?;`,
          [vaultId],
          (error, results) => {
            if (error) return reject(error);
            resolve(results);
          }
        );
      });

      await generateLog(
        actioningUser,
        "WARNING",
        "VAULT",
        `Deleted ${vaultId}`
      );

      return res.send({
        success: true,
        message: `Deletion of vault with the id ${vaultId} has been successful.`,
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
