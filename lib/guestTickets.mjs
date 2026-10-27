/**
 * lib/guestTickets.mjs
 *
 * Private links for support tickets opened from the contact form by people
 * without an account (supportTickets.guestEmail).
 *
 * The link carries an HMAC of the ticket number and the guest's email, keyed
 * with the server's cookie secret -- nothing extra is stored, a link opens only
 * its own ticket, and it stops working if the ticket's email is changed. The
 * guest gets it by email (controllers/supportTicketController.js) and uses it
 * to read the conversation and reply (routes/pagesRoutes.js).
 */

import crypto from "crypto";

const PURPOSE = "guest-ticket:v1";

function secret(env = process.env) {
  const value = env.sessionCookieSecret;
  if (!value) throw new Error("sessionCookieSecret is not set; guest ticket links cannot be signed.");
  return value;
}

/** The token for one guest ticket. */
export function guestTicketToken(ticketId, email, env = process.env) {
  return crypto
    .createHmac("sha256", secret(env))
    .update(`${PURPOSE}:${Number(ticketId)}:${String(email).trim().toLowerCase()}`)
    .digest("base64url");
}

/** True when `token` is the one for this ticket and email. Constant-time. */
export function isValidGuestTicketToken(ticketId, email, token, env = process.env) {
  if (!email || typeof token !== "string" || !token) return false;
  const expected = Buffer.from(guestTicketToken(ticketId, email, env));
  const given = Buffer.from(token);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** The full private link for a guest ticket. */
export function guestTicketUrl(siteUrl, ticketId, email, env = process.env) {
  const base = String(siteUrl || "").replace(/\/+$/, "");
  return `${base}/contact/ticket/${Number(ticketId)}/${guestTicketToken(ticketId, email, env)}`;
}

/** How a guest is named wherever a username would appear. */
export function guestDisplayName(ticket) {
  const name = String(ticket?.guestName || "").trim();
  return name ? `${name} (guest)` : "Guest";
}
