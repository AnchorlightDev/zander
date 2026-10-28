/**
 * lib/notificationScope.mjs
 *
 * Which requests need the notifications summary (the navbar bell).
 *
 * The preHandler that loads it is a root hook, and Fastify runs root hooks
 * for every route -- @fastify/static's asset route included. A logged-in page
 * view pulls ~25 stylesheets, scripts, images and fonts, so without this
 * filter each page cost ~25 notification queries instead of one.
 *
 * Only rendered pages show the bell: skip the JSON API and anything whose
 * path ends in a file extension.
 */

// A name before the dot, so a Bedrock profile like /profile/.Steve is a page.
const FILE_EXTENSION = /[^/]\.[a-z0-9]{1,12}$/i;

export function wantsNotificationSummary(url) {
  const path = String(url ?? "").split("?", 1)[0];
  if (path === "/api" || path.startsWith("/api/")) return false;
  return !FILE_EXTENSION.test(path);
}
