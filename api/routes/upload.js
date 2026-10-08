import { isCloudinaryConfigured, uploadImage } from "../../services/cloudinaryService.js";
import { checkRateLimit } from "../../lib/rateLimiter.mjs";
import { hasPermission } from "../../lib/discord/permissions.mjs";

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 MB (also enforced by @fastify/multipart limits)
const ALLOWED_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * Where an upload may land, and who may put it there.
 *
 * The folder used to be whatever the browser sent, so any logged-in player
 * could write into the announcement or finance asset folders. Each folder is
 * now tied to the dashboard node that owns the feature; the forms folder is
 * the only one open to every signed-in user, because public forms accept
 * image answers.
 */
const FOLDER_RULES = [
  { match: /^zander\/forms\/[a-z0-9-]{1,80}$/, nodes: null },
  { match: /^announcements$/, nodes: ["zander.web.announcements"] },
  { match: /^(zander\/)?events(\/[a-z0-9-]{1,80})?$/, nodes: ["zander.web.events.edit", "zander.web.events.review"] },
  { match: /^finance-budget-icons$/, nodes: ["zander.web.finance.manage"] },
  { match: /^rank-catalog$/, nodes: ["zander.web.webstore"] },
  { match: /^zander$/, nodes: ["zander.web.dashboard"] },
];

function resolveFolder(requested, permissions) {
  const folder = String(requested || "zander").trim();
  if (folder.length > 120 || folder.includes("..")) return null;
  for (const rule of FOLDER_RULES) {
    if (!rule.match.test(folder)) continue;
    if (!rule.nodes) return folder;
    return rule.nodes.some((node) => hasPermission(permissions, node)) ? folder : null;
  }
  return null;
}

/** Sniff the first bytes so a renamed SVG or HTML file is not stored as an image. */
function looksLikeAllowedImage(buffer) {
  if (buffer.length < 12) return false;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true; // PNG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true; // JPEG
  if (buffer.toString("ascii", 0, 4) === "GIF8") return true; // GIF
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return true; // WebP
  return false;
}

async function handleUpload(req, res) {
  if (!req.session?.user) {
    return res.status(401).send({ success: false, message: "Authentication required." });
  }

  // Uploads cost Cloudinary credits; one person should not be able to burn
  // through them in a loop.
  if (!checkRateLimit(req, res, { windowMs: 60_000, max: 10 })) return;

  if (!isCloudinaryConfigured()) {
    return res.status(503).send({ success: false, message: "Image uploads are not configured." });
  }

  let data;
  try {
    data = await req.file();
  } catch {
    return res.status(400).send({ success: false, message: "No file provided." });
  }

  if (!data || !data.file) {
    return res.status(400).send({ success: false, message: "No file provided." });
  }

  if (!ALLOWED_MIME.includes(data.mimetype)) {
    // Drain so the request can finish cleanly.
    data.file.resume();
    return res.status(400).send({
      success: false,
      message: "Invalid file type. Allowed: PNG, JPG, GIF, WebP.",
    });
  }

  const folder = resolveFolder(data.fields?.folder?.value, req.session.user.permissions);
  if (!folder) {
    data.file.resume();
    return res.status(403).send({ success: false, message: "You cannot upload to that location." });
  }

  try {
    const chunks = [];
    let totalSize = 0;
    for await (const chunk of data.file) {
      totalSize += chunk.length;
      if (totalSize > MAX_FILE_SIZE) {
        return res.status(413).send({ success: false, message: "File too large. Maximum 8 MB." });
      }
      chunks.push(chunk);
    }
    if (data.file.truncated) {
      return res.status(413).send({ success: false, message: "File too large. Maximum 8 MB." });
    }
    const buffer = Buffer.concat(chunks);

    if (!looksLikeAllowedImage(buffer)) {
      return res.status(400).send({
        success: false,
        message: "That file does not look like a PNG, JPG, GIF or WebP image.",
      });
    }

    const result = await uploadImage(buffer, { folder });

    return res.send({
      success: true,
      data: {
        url: result.url,
        publicId: result.publicId,
        width: result.width,
        height: result.height,
      },
    });
  } catch (error) {
    if (error?.code === "FST_REQ_FILE_TOO_LARGE") {
      return res.status(413).send({ success: false, message: "File too large. Maximum 8 MB." });
    }
    console.error("[upload] Cloudinary upload failed:", error);
    return res.status(500).send({ success: false, message: "Upload failed. Please try again." });
  }
}

export default function uploadApiRoute(app, config, db, features, lang) {
  // Both paths were separate copies of the same handler; the dashboard one is
  // kept for the pages that still post to it.
  app.post("/api/upload/image", handleUpload);
  app.post("/dashboard/upload/image", handleUpload);
}
