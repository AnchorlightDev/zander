import { createRequire } from "module";
import { hasPermission } from "../../lib/discord/permissions.mjs";
import { parseKey, resolveScope, verifyKeyHash } from "../../lib/apiKeys.js";
import {
  getClientByPrefixCached,
  touchLastUsed,
} from "../../controllers/apiClientController.js";

const require = createRequire(import.meta.url);
const lang = require("../../lang.json");

/*
    Endpoints that a logged-in dashboard user may call using their session
    cookie instead of an API client key.

    The dashboard previously shipped the app-wide API key into page source so
    the browser could call these, which handed every viewer the token guarding
    *all* /api routes.  Browsers now authenticate with their session and are
    held to the same permission node the corresponding dashboard page enforces.

    Fail-closed: anything not listed here requires a client key.  Keys are
    `METHOD /path`; the required nodes are OR-ed.  `zander.web.*` and `*` are
    honoured by hasPermission() itself.
*/
const EVENTS_WRITE = ["zander.web.events.edit", "zander.web.events.review"];
const EVENTS_REVIEW = ["zander.web.events.review"];
// Read-only access, matching the node the dashboard events pages themselves
// require (routes/dashboard/events.js).
const EVENTS_VIEW = ["zander.web.events", ...EVENTS_WRITE];

export const SESSION_ALLOWED_ROUTES = new Map([
  // Reads
  ["GET /api/events/pending-review", EVENTS_REVIEW],
  ["GET /api/events/discord/text-channels", EVENTS_WRITE],
  ["GET /api/events/discord/voice-channels", EVENTS_WRITE],
  ["GET /api/events/users/search", EVENTS_WRITE],
  ["GET /api/server/get", [...EVENTS_WRITE, "zander.web.server"]],
  ["GET /api/events/calendar", EVENTS_VIEW],

  /*
      Event lifecycle.

      Every entry below is reached from the dashboard by a fetch() whose URL is
      built from a variable rather than written inline — `apiEndpoint` in
      events-editor.ejs, `endpoint` in events-template-editor.ejs, and the
      eventAction() helper in events-view.ejs.  That is why they were missed
      when the shared API key was retired and the literal fetch URLs were swept
      into this map: a grep for "/api/..." in the views does not find them.
      Creating, editing and cancelling events all 401'd as a result.

      /api/events/cancel performs no permission check of its own, so this entry
      is its only gate — it must stay on EVENTS_WRITE.
  */
  ["POST /api/events/create", EVENTS_WRITE],
  ["POST /api/events/update", EVENTS_WRITE],
  ["POST /api/events/update-published", EVENTS_WRITE],
  ["POST /api/events/cancel", EVENTS_WRITE],
  ["POST /api/events/revert-to-draft", EVENTS_REVIEW],
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
  ["POST /api/events/templates/create", EVENTS_WRITE],
  ["POST /api/events/templates/update", EVENTS_WRITE],
  ["POST /api/events/templates/delete", EVENTS_WRITE],
  ["POST /api/events/templates/generate-draft", EVENTS_WRITE],
  ["POST /api/events/templates/announcements/update", EVENTS_WRITE],
]);

/** Client address for audit lines, preferring the proxied original. */
function clientIp(req) {
  const forwarded = req.headers?.["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.ip || "unknown";
}

/**
 * Audit an auth failure.  Logs the key prefix — the non-secret lookup handle —
 * never the presented key itself.
 */
function logDenial(reason, { req, keyPrefix, scope }) {
  console.warn(
    `[apiAuth] ${reason}` +
      ` path=${req.method} ${String(req.url).split("?")[0]}` +
      ` prefix=${keyPrefix ?? "none"}` +
      (scope ? ` scope=${scope}` : "") +
      ` ip=${clientIp(req)}`
  );
}

function deny(res, status, message) {
  // 401 for bad or missing credentials, 403 for scope denial.  The body keeps
  // the { success, message } shape so existing callers still parse it — the
  // previous implementation returned 200 OK on failure.
  return res.status(status).send({ success: false, message });
}

export default async function verifyToken(req, res) {
  const token = req.headers["x-access-token"];
  const path = String(req.url).split("?")[0];

  // ── No token: fall back to a dashboard session ───────────────────────────
  if (!token) {
    const user = req.session?.user;

    if (user) {
      const routeKey = `${req.method} ${path}`;
      const requiredNodes = SESSION_ALLOWED_ROUTES.get(routeKey);

      if (requiredNodes) {
        const permissions = Array.isArray(user.permissions) ? user.permissions : [];
        if (requiredNodes.some((node) => hasPermission(permissions, node))) return;

        logDenial("session lacks permission", { req });
        return deny(res, 403, "You do not have permission to perform this action.");
      }
    }

    logDenial("no token", { req });
    return deny(res, 401, lang.api.noToken);
  }

  // ── Per-client key ───────────────────────────────────────────────────────
  const parsed = parseKey(token);

  if (parsed) {
    let client;
    try {
      client = await getClientByPrefixCached(parsed.keyPrefix);
    } catch (error) {
      console.error("[apiAuth] client lookup failed:", error?.message ?? error);
      return deny(res, 503, lang.api.databaseError);
    }

    if (!client) {
      logDenial("unknown key prefix", { req, keyPrefix: parsed.keyPrefix });
      return deny(res, 401, lang.api.invalidToken);
    }

    if (!verifyKeyHash(token, client.keyHash)) {
      logDenial("key hash mismatch", { req, keyPrefix: parsed.keyPrefix });
      return deny(res, 401, lang.api.invalidToken);
    }

    if (client.isRevoked) {
      logDenial("revoked key", { req, keyPrefix: parsed.keyPrefix });
      return deny(res, 401, lang.api.invalidToken);
    }

    const scope = resolveScope(path);

    // An unmapped path fails closed: a new route is unreachable until it is
    // given a scope, rather than silently accepting every key.
    if (!scope) {
      logDenial("no scope mapped for path", { req, keyPrefix: parsed.keyPrefix });
      return deny(res, 403, "This endpoint is not available to API clients.");
    }

    if (!client.scopes.includes(scope)) {
      logDenial("scope not granted", { req, keyPrefix: parsed.keyPrefix, scope });
      return deny(res, 403, `This API client is not scoped for "${scope}".`);
    }

    req.apiClient = {
      clientId: client.clientId,
      name: client.name,
      scopes: client.scopes,
    };

    // Fire-and-forget and internally throttled; never awaited on the hot path.
    touchLastUsed(client.clientId, clientIp(req));
    return;
  }

  // Anything that is not a well-formed per-client key is rejected outright.
  // The old app-wide shared key is gone; there is no fallback.
  logDenial("invalid token", { req });
  return deny(res, 401, lang.api.invalidToken);
}
