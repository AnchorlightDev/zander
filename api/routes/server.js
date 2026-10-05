import {
  isFeatureEnabled,
  required,
  optional,
  generateLog,
} from "../common.js";

/**
 * Optional Bedrock (Geyser) address: "host" or "host:port". Blank clears it.
 * Returns undefined for a malformed value so the caller can reject it.
 */
function parseBedrockAddress(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  return /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(text) ? text : undefined;
}

export default function serverApiRoute(app, config, db, features, lang) {
  const baseEndpoint = "/api/server";

  // TODO: Update docs
  app.get(baseEndpoint + "/get", async function (req, res) {
    if (!isFeatureEnabled(features.server, res, lang)) return;
    const id = optional(req.query, "id");
    const type = optional(req.query, "type");

    try {
      const getServersFromDB = (dbQuery, params = []) => {
        return new Promise((resolve, reject) => {
          db.query(dbQuery, params, (error, results) => {
            if (error) return reject(error);
            resolve(results);
          });
        });
      };

      let dbQuery;
      let params = [];

      if (id) {
        dbQuery = "SELECT * FROM servers WHERE serverId = ?";
        params = [id];
      } else if (type) {
        dbQuery = "SELECT * FROM servers WHERE serverType = ?";
        params = [type];
      } else {
        dbQuery = "SELECT * FROM servers ORDER BY position ASC";
      }

      const results = await getServersFromDB(dbQuery, params);

      if (!results || !results.length) {
        return res.send({
          success: false,
          message: `There are no servers available.`,
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
    if (!isFeatureEnabled(features.server, res, lang)) return;

    const actioningUser = required(req.body, "actioningUser", res);
    if (res.sent) return;
    const displayName = required(req.body, "displayName", res);
    if (res.sent) return;
    const serverType = required(req.body, "serverType", res);
    if (res.sent) return;
    const serverConnectionAddress = required(req.body, "serverConnectionAddress", res);
    if (res.sent) return;
    const position = required(req.body, "position", res);
    if (res.sent) return;
    const bedrockAddress = parseBedrockAddress(req.body.bedrockAddress);
    if (bedrockAddress === undefined) {
      return res.send({ success: false, message: "Bedrock address must look like host or host:port." });
    }

    const serverCreatedLang = lang.server.serverCreated;

    try {
      await new Promise((resolve, reject) => {
        db.query(
          `
          INSERT INTO
              servers
          (
              displayName,
              serverType,
              serverConnectionAddress,
              bedrockAddress,
              position
          ) VALUES (?, ?, ?, ?, ?)`,
          [displayName, serverType, serverConnectionAddress, bedrockAddress, position],
          (error, results) => {
            if (error) return reject(error);
            resolve(results);
          }
        );
      });

      await generateLog(
        actioningUser,
        "SUCCESS",
        "SERVER",
        `Created ${displayName} (${serverConnectionAddress})`
      );

      return res.send({
        success: true,
        message: serverCreatedLang.replace("%NAME%", displayName),
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
    if (!isFeatureEnabled(features.server, res, lang)) return;

    const actioningUser = required(req.body, "actioningUser", res);
    if (res.sent) return;
    const serverId = required(req.body, "serverId", res);
    if (res.sent) return;
    const displayName = required(req.body, "displayName", res);
    if (res.sent) return;
    const serverType = required(req.body, "serverType", res);
    if (res.sent) return;
    const serverConnectionAddress = required(
      req.body,
      "serverConnectionAddress",
      res
    );
    if (res.sent) return;
    const position = required(req.body, "position", res);
    if (res.sent) return;
    const bedrockAddress = parseBedrockAddress(req.body.bedrockAddress);
    if (bedrockAddress === undefined) {
      return res.send({ success: false, message: "Bedrock address must look like host or host:port." });
    }

    try {
      await new Promise((resolve, reject) => {
        db.query(
          `
              UPDATE
                  servers
              SET
                  displayName=?,
                  serverType=?,
                  serverConnectionAddress=?,
                  bedrockAddress=?,
                  position=?
              WHERE
                  serverId=?`,
          [displayName, serverType, serverConnectionAddress, bedrockAddress, position, serverId],
          (error, results) => {
            if (error) return reject(error);
            resolve(results);
          }
        );
      });

      await generateLog(
        actioningUser,
        "SUCCESS",
        "SERVER",
        `Edited ${displayName} (${serverConnectionAddress})`
      );

      return res.send({
        success: true,
        message: lang.server.serverEdited,
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
    if (!isFeatureEnabled(features.server, res, lang)) return;

    const actioningUser = required(req.body, "actioningUser", res);
    if (res.sent) return;
    const serverId = required(req.body, "serverId", res);
    if (res.sent) return;

    try {
      await new Promise((resolve, reject) => {
        db.query(
          `DELETE FROM servers WHERE serverId=?;`,
          [serverId],
          (error, results) => {
            if (error) return reject(error);
            resolve(results);
          }
        );
      });

      await generateLog(
        actioningUser,
        "SUCCESS",
        "SERVER",
        `Deleted ${serverId}`
      );

      return res.send({
        success: true,
        message: lang.server.serverDeleted,
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
