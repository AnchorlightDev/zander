/**
 * Shared asset helpers for the Wrapped deck page — used by both the public
 * routes (routes/wrappedRoutes.js) and the admin preview
 * (routes/dashboard/wrapped.js) so they render identically.
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import crypto from "crypto";

// Same hashing the profile / staff pages use for Gravatar (md5 of the raw
// stored email), so the Wrapped avatar matches what the user set.
function gravatarHash(email) {
  return crypto.createHash("md5").update(String(email)).digest("hex");
}

/**
 * A random site "global" background image as an absolute asset path, so it
 * resolves the same from /wrapped, /wrapped/s/:id and /dashboard/wrapped/preview.
 * Returns null when the folder is missing or empty.
 */
function globalImageFiles() {
  try {
    return readdirSync("./assets/images/globalImages/").filter((f) =>
      /\.(png|jpe?g|webp|gif|avif)$/i.test(f)
    );
  } catch {
    return [];
  }
}

export function pickGlobalBackground() {
  const files = globalImageFiles();
  if (!files.length) return null;
  return "/images/globalImages/" + files[Math.floor(Math.random() * files.length)];
}

/**
 * A shuffled list of up to `count` distinct global background images (absolute
 * asset paths) — one per Wrapped slide. Repeats only if the folder has fewer
 * images than slides. Empty array when none.
 */
export function pickGlobalBackgrounds(count = 20) {
  const files = globalImageFiles();
  if (!files.length) return [];
  for (let i = files.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [files[i], files[j]] = [files[j], files[i]];
  }
  const out = [];
  for (let i = 0; i < count; i++) out.push("/images/globalImages/" + files[i % files.length]);
  return out;
}

/**
 * A random global background image as a base64 data URI, for the downloadable
 * SVG cards (an external `<image href>` would taint the canvas and block PNG
 * export, so it must be embedded). Bigger files are skipped so the SVG stays
 * small enough for the browser to rasterise to PNG. Returns null when the
 * folder is empty / everything is too big.
 */
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif" };
const MAX_BG_BYTES = 450 * 1024;
export function globalBackgroundDataUri() {
  const files = globalImageFiles();
  for (let i = files.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [files[i], files[j]] = [files[j], files[i]];
  }
  for (const f of files) {
    try {
      const buf = readFileSync("./assets/images/globalImages/" + f);
      if (buf.length > MAX_BG_BYTES) continue;
      const ext = f.split(".").pop().toLowerCase();
      return `data:${MIME[ext] || "image/png"};base64,` + buf.toString("base64");
    } catch {
      /* next file */
    }
  }
  return null;
}

/** /audio path of a deployed Wrapped music bed, or null (page uses the generative bed). */
let musicUrlCache;
export function musicUrl() {
  if (musicUrlCache !== undefined) return musicUrlCache;
  if (existsSync("./assets/audio/wrapped-bed.mp3")) musicUrlCache = "/audio/wrapped-bed.mp3";
  else if (existsSync("./assets/audio/wrapped-bed.ogg")) musicUrlCache = "/audio/wrapped-bed.ogg";
  else musicUrlCache = null;
  return musicUrlCache;
}

/** The site logo as a base64 data URI, so the summary-card SVG stays self-contained. */
let logoDataUriCache;
export function logoDataUri() {
  if (logoDataUriCache !== undefined) return logoDataUriCache;
  try {
    logoDataUriCache =
      "data:image/png;base64," + readFileSync("./assets/images/siteLogo.png").toString("base64");
  } catch {
    logoDataUriCache = null;
  }
  return logoDataUriCache;
}

/**
 * Resolve a user's avatar URL honouring their profile-picture preference —
 * the same rules the player profile / staff pages use:
 *   CRAFTATAR -> crafthead skin head (with hat overlay)
 *   GRAVATAR  -> gravatar by email hash
 *   else      -> crafthead by uuid, then mc-heads by username
 * @param {{ uuid?: string, username?: string, profilePicture_type?: string, profilePicture_email?: string }} row
 */
export async function resolveAvatarUrl(row = {}) {
  const type = row.profilePicture_type;
  if (type === "CRAFTATAR" && row.uuid) {
    return `https://crafthead.net/avatar/${encodeURIComponent(row.uuid)}`;
  }
  if (type === "GRAVATAR" && row.profilePicture_email) {
    return `https://gravatar.com/avatar/${gravatarHash(row.profilePicture_email)}?size=300`;
  }
  if (row.uuid) return `https://crafthead.net/avatar/${encodeURIComponent(row.uuid)}`;
  if (row.username) return `https://mc-heads.net/avatar/${encodeURIComponent(row.username)}/128`;
  return null;
}

/** Fetch an avatar URL and return it as a base64 data URI (cached per URL; null on failure). */
const avatarCache = new Map();
export async function avatarDataUri(url, fetchImpl) {
  if (!url) return null;
  if (avatarCache.has(url)) return avatarCache.get(url);
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  let out = null;
  if (doFetch) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 3500);
      const r = await doFetch(url, { signal: ctl.signal });
      clearTimeout(timer);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        const type = r.headers.get("content-type") || "image/png";
        out = `data:${type};base64,` + buf.toString("base64");
      }
    } catch {
      out = null;
    }
  }
  avatarCache.set(url, out);
  return out;
}
