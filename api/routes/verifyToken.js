import crypto from "crypto";
import { createRequire } from "module";
import { hasPermission } from "../../lib/discord/permissions.mjs";

const require = createRequire(import.meta.url);
const lang = require("../../lang.json");

/*
    Endpoints that a logged-in dashboard user may call using their session
    cookie instead of the machine API key.

    Previously the dashboard shipped `process.env.apiKey` into page source so
    the browser could call these, which handed every viewer the app-wide token
    that guards *all* /api routes (finance, vault, punishments, admin users).
    The key is now server-only; browsers authenticate with their session and
    are held to the same permission node the corresponding dashboard page
    already enforces.

    Fail-closed: anything not listed here still requires the machine token.
    Keys are `METHOD /path`; the required nodes are OR-ed.  `zander.web.*` and
    `*` are honoured by hasPermission() itself.
*/
const EVENTS_WRITE = ["zander.web.events.edit", "zander.web.events.review"];
const EVENTS_REVIEW = ["zander.web.events.review"];

const SESSION_ALLOWED_ROUTES = new Map([
  // Reads
  ["GET /api/events/pending-review", EVENTS_REVIEW],
  ["GET /api/events/discord/text-channels", EVENTS_WRITE],
  ["GET /api/events/discord/voice-channels", EVENTS_WRITE],
  ["GET /api/events/users/search", EVENTS_WRITE],
  ["GET /api/server/get", [...EVENTS_WRITE, "zander.web.server"]],

  // Event lifecycle
  ["POST /api/events/submit-review", EVENTS_WRITE],
  ["POST /api/events/publish", EVENTS_WRITE],
  ["POST /api/events/actions/update", EVENTS_WRITE],
  ["POST /api/events/announcements/update", EVENTS_WRITE],
  ["POST /api/events/delete", EVENTS_WRITE],
  ["POST /api/events/duplicate", EVENTS_WRITE],
  ["POST /api/events/resync-discord", EVENTS_WRITE],
  ["POST /api/events/approve", EVENTS_REVIEW],
  ["POST /api/events/reject", EVENTS_REVIEW],

  // Templates
  ["POST /api/events/templates/delete", EVENTS_WRITE],
  ["POST /api/events/templates/generate-draft", EVENTS_WRITE],
  ["POST /api/events/templates/announcements/update", EVENTS_WRITE],
]);

/*
    Constant-time string comparison.  Returns false for length mismatches
    without leaking the expected length through early return timing.
*/
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;

  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  // timingSafeEqual throws on differing lengths, so compare digests of equal
  // width instead — the digest of a wrong-length token still differs.
  const leftHash = crypto.createHash("sha256").update(left).digest();
  const rightHash = crypto.createHash("sha256").update(right).digest();

  return crypto.timingSafeEqual(leftHash, rightHash);
}

export default function verifyToken(req, res, done) {
  const token = req.headers["x-access-token"];
  const expected = process.env.apiKey;

  // Machine token — full API access, used by the Minecraft plugin ecosystem.
  if (token) {
    if (typeof expected === "string" && expected.length > 0 && safeEqual(token, expected)) {
      return done();
    }

    return res.status(401).send({
      success: false,
      message: lang.api.invalidToken,
    });
  }

  // Browser fallback — session cookie plus the dashboard permission node.
  const user = req.session?.user;

  if (user) {
    const routeKey = `${req.method} ${req.url.split("?")[0]}`;
    const requiredNodes = SESSION_ALLOWED_ROUTES.get(routeKey);

    if (requiredNodes) {
      const permissions = Array.isArray(user.permissions) ? user.permissions : [];

      if (requiredNodes.some((node) => hasPermission(permissions, node))) {
        return done();
      }

      return res.status(403).send({
        success: false,
        message: "You do not have permission to perform this action.",
      });
    }
  }

  return res.status(401).send({
    success: false,
    message: lang.api.noToken,
  });
}
