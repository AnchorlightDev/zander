import dotenv from "dotenv";
dotenv.config();
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import path from "path";
const config = require(path.join(process.cwd(), "config.json"));
import fetch from "node-fetch";
import { readdirSync } from "fs";
import crypto from "crypto";
import db from "../controllers/databaseController.js";
import { getWebAnnouncement } from "../controllers/announcementController.js";

/*
    Check if a specific feature is enabled.

    @param isFeatureEnabled The feature to check if enabled.
    @param res Passing through res.
    @param lang Passing through lang.
*/
export function isFeatureEnabled(isFeatureEnabled, res, lang) {
  if (isFeatureEnabled) return true;

  res.send({
    success: false,
    message: `${lang.api.featureDisabled}`,
  });
  return false;
}

/*
    Ensure that a required field is present and has a non-null value,
    and to return an error message if this is not the case.

    @param body Passing through the req.body
    @param field The name of the field.
    @param res Passing through res.
*/
export function required(body, field, res) {
  // Prematurely exits an API request if a required field has not been
  // defined or null. If the body is not defined then we error as well.
  // This can happen when no parameters exist.
  if (!body || !(field in body))
    return res.send({
      success: false,
      message: `Body requires field '${field}'`,
    });

  if (body[field] === null)
    return res.send({
      success: false,
      message: `Field ${field} cannot be null`,
    });

  return body[field];
}

/*
    Check if an optional field is present in the body object, and return its value if it is.

    @param body Passing through the req.body
    @param field The name of the field.
*/
export function optional(body, field) {
  // Jaedan: I am aware that this is pretty much default behaviour, however
  // this takes into consideration times where no body is included. Without
  // this check requests with only optional fields (that are all unused) will
  // cause a null object to be referenced, causing an error.
  if (!body || !(field in body) || body[field] === null) return null;

  return body[field];
}

/*
    Check if a specific web feature is enabled.

    @param isFeatureEnabled The feature to check if enabled.
    @param req Passing through req
    @param res Passing through res
    @param features Passing through features
*/
export async function isFeatureWebRouteEnabled(app, isFeatureEnabled, req, res, features) {
  if (!isFeatureEnabled) {
    const [globalImage, announcementWeb] = await Promise.all([getGlobalImage(), getWebAnnouncement()]);
    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("session/featureDisabled", {
        pageTitle: "Feature Disabled",
        config,
        req,
        res,
        features,
        globalImage,
        announcementWeb,
      })
    );
    return false;
  }
  return true;
}

/*
    Check if a user is logged in or not.

    @param req Passing through req
*/
export function isLoggedIn(req) {
  if (req.session.user) return true;
  else return false;
}

/*
    Check if the user has a specific permission.

    @param permissionNode The permission node to check permission of.
    @param req Passing through req
    @param res Passing through res
    @param features Passing through features
*/
function normalisePermissionNode(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim().toLowerCase();
}

function hasSpecificPermission(permissionArray, node) {
  if (!node) {
    return true;
  }

  if (!Array.isArray(permissionArray) || permissionArray.length === 0) {
    return false;
  }

  const target = normalisePermissionNode(node);
  if (!target) {
    return true;
  }

  return permissionArray.some((permission) => {
    if (!permission) {
      return false;
    }

    const candidate = normalisePermissionNode(permission);
    if (!candidate) {
      return false;
    }

    if (candidate === "*") {
      return true;
    }

    if (candidate === target) {
      return true;
    }

    if (candidate.endsWith(".*")) {
      const base = candidate.slice(0, -2);
      return target === base || target.startsWith(base + ".");
    }

    return false;
  });
}

async function renderNoPermission(req, res, features) {
  await res.view("session/noPermission", {
    pageTitle: `Access Restricted`,
    config: config,
    req: req,
    res: res,
    features: features,
    globalImage: await getGlobalImage(),
    announcementWeb: await getWebAnnouncement(),
  });
}

export async function hasPermission(permissionNode, req, res, features) {
  const userPermissions = req.session?.user?.permissions;

  if (!isLoggedIn(req) || !Array.isArray(userPermissions)) {
    await renderNoPermission(req, res, features);
    return false;
  }

  if (!hasSpecificPermission(userPermissions, permissionNode)) {
    await renderNoPermission(req, res, features);
    return false;
  }

  return true;
}

/*
    Makes a POST API request to the specified postURL with the provided apiPostBody.
    It includes a header with the x-access-token value taken from an environment variable named apiKey.
    If the request is successful, it logs the response data.
    If the request fails, it sets a cookie with a "danger" alert type and an error message,
    then redirects the user to the specified failureRedirectURL.

    @param postURL The POST url that the apiPostBody will go to in the API.
    @param apiPostBody The request body for the postURL.
    @param failureRedirectURL If the request returns false, where the API will redirect the user to.
    @param res Passing through res.
*/
export async function postAPIRequest(
  postURL,
  apiPostBody,
  failureRedirectURL,
  res
) {
  const response = await fetch(postURL, {
    method: "POST",
    body: JSON.stringify(apiPostBody),
    headers: {
      "Content-Type": "application/json",
      "x-access-token": process.env.apiKey,
    },
  });

  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    const fallbackMessage =
      "Unexpected response from the server. Please try again.";
    setBannerCookie("danger", fallbackMessage, res);
    return res.redirect(failureRedirectURL);
  }

  console.log(data);

  if (data.alertType) {
    setBannerCookie(`${data.alertType}`, `${data.alertContent}`, res);
  }

  if (!data.success) {
    return res.redirect(failureRedirectURL);
  }

  return console.log(data);
}

/*
    Returns the path of a randomly chosen image file from a specified directory.
    The function first reads the names of the files in the directory using the readdirSync function and
    then selects a random file from the list using the Math.random() function.
    Finally, the function returns the path of the chosen file by concatenating the file name with the relative path to the directory.
*/
export function getGlobalImage() {
  try {
    const files = readdirSync("./assets/images/globalImages/");
    if (!files.length) return null;
    const chosenFile = files[Math.floor(Math.random() * files.length)];
    return "../../../images/globalImages/" + chosenFile;
  } catch {
    return null;
  }
}

export function getJumboVideo() {
  try {
    const files = readdirSync("./assets/videos/").filter((f) =>
      /\.(mp4|webm|ogg)$/i.test(f)
    );
    if (files.length === 0) return null;
    return "/videos/" + files[Math.floor(Math.random() * files.length)];
  } catch {
    return null;
  }
}

/*
    Sets two cookies (alertType and alertContent) with specified values and an expiration time of one second.
    These cookies are set on the root path and are returned by the function.

    @param alertType The alert content type and colour according to https://getbootstrap.com/docs/4.0/components/alerts/#examples
    @param alertContent The alert content text.
    @param res Passing through res
*/
export function setBannerCookie(alertType, alertContent, res) {
  try {
    var expiryTime = new Date();
    expiryTime.setSeconds(expiryTime.getSeconds() + 2);

    res.setCookie("alertType", alertType, {
      path: "/",
      expires: expiryTime,
      httpOnly: true,
    });

    res.setCookie("alertContent", alertContent, {
      path: "/",
      expires: expiryTime,
      httpOnly: true,
    });
  } catch (error) {
    console.log(error);
  }
}


/*
    Sets two cookies (alertType and alertContent) with specified values and an expiration time of one second.
    These cookies are set on the root path and are returned by the function.

    @param email The email address to hash.
*/
export async function hashEmail(email) {
  // Create a new MD5 hash object
  const md5Hash = crypto.createHash("md5");

  // Update the hash object with the email address
  md5Hash.update(email);

  // Get the hexadecimal representation of the hash and return it
  return md5Hash.digest("hex");
}

/*
    Sets two cookies (alertType and alertContent) with specified values and an expiration time of one second.
    These cookies are set on the root path and are returned by the function.

    @param userId The ID of the user that actioned the log.
    @param logType The type of log.
    @param description A short description of the log.
*/
export async function generateLog(
  userId,
  logType,
  logFeature,
  description
) {
  return new Promise((resolve, reject) => {
    db.query(
      `INSERT INTO logs (creatorId, logType, logFeature, description) VALUES (?, ?, ?, ?)`,
      [userId, logType, logFeature, description],
      function (error, results) {
        if (error) {
          console.error("Failed to generate log:", error);
          return reject(error);
        }
        resolve(results);
      }
    );
  });
}

/*
    Sets

    @param string The string of text
    @param filter the JSON output of the filter.json file
*/
export async function expandString(string, filter) {
  var regexString = "";
  for (var i = 0; i < string.length; i++) {
    // If the character does not have any aliases then just
    // use the character. Note, this is a regex character.
    if (string[i] in filter.alias)
      regexString += "[" + filter.alias[string[i]] + "]";
    else regexString += string[i];
  }
  regexString = regexString.replace(".", "\\.");
  return regexString;
}

/*
    Sets

    @param string The string of text
    @param filter the JSON output of the filter.json file
*/
export function removeHtmlTags(html) {
  return html.replace(/<(?!\/?(a)\b)[^<]*?>/gi, "");
}

function verifyCodeIsActive(code) {
  return new Promise((resolve, reject) => {
    db.query(
      `SELECT 1 FROM userVerifyLink WHERE linkCode = ? AND codeExpiry > NOW() LIMIT 1`,
      [String(code)],
      (error, results) => {
        if (error) return reject(error);
        resolve(Array.isArray(results) && results.length > 0);
      }
    );
  });
}

export async function generateVerifyCode() {
  // 6-digit code space is 900,000 wide and only a handful are ever active
  // at once, so a collision is very unlikely — but an active duplicate would
  // let one player's code verify another's account, so retry a few times if
  // the generated code is already in use.
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = Math.floor(Math.random() * 900000) + 100000;

    try {
      if (!(await verifyCodeIsActive(code))) {
        return code;
      }
    } catch (error) {
      // If we can't check for collisions, fall back to the raw code rather
      // than failing the whole verification request.
      console.error("generateVerifyCode: collision check failed", error);
      return code;
    }
  }

  // Extremely unlikely: 10 straight collisions. Return a fresh code anyway.
  return Math.floor(Math.random() * 900000) + 100000;
}
