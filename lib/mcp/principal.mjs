/**
 * lib/mcp/principal.mjs
 *
 * Lets an MCP tool call one of Zander's own API routes *as the signed-in staff
 * member*, so the route's existing permission checks, validation, audit
 * logging and Discord side effects all apply exactly as they do when the same
 * person clicks the button on the dashboard.
 *
 * How: the tool calls app.inject() with a one-time ticket header. A
 * preValidation hook on the API plugin (registered in app.js ahead of
 * verifyToken) swaps the request's session for `{ user }` when the ticket
 * matches. The swapped-in object has no session id, so @fastify/session never
 * writes it to the database.
 *
 * Tickets are random, single-use, live only in this process's memory for the
 * length of one in-process call, and are never sent over the network, so a
 * request arriving from outside cannot present a valid one.
 */

import crypto from "crypto";

export const PRINCIPAL_HEADER = "x-zander-mcp-principal";

const tickets = new Map();

/** Issue a single-use ticket for `user`. */
export function issueTicket(user) {
  const ticket = crypto.randomBytes(32).toString("base64url");
  tickets.set(ticket, user);
  return ticket;
}

/** Consume a ticket, returning its user once; undefined if unknown or used. */
export function redeemTicket(ticket) {
  if (typeof ticket !== "string" || !ticket) return undefined;
  const user = tickets.get(ticket);
  tickets.delete(ticket);
  return user;
}

/** Drop a ticket that was never redeemed (e.g. the route 404'd first). */
export function revokeTicket(ticket) {
  tickets.delete(ticket);
}

/** preValidation hook: adopt the ticket's user as this request's session. */
export async function mcpPrincipalHook(req) {
  const ticket = req.headers[PRINCIPAL_HEADER];
  if (!ticket) return;
  delete req.headers[PRINCIPAL_HEADER];

  const user = redeemTicket(ticket);
  // An unknown ticket is simply ignored: the request carries on unauthenticated
  // and verifyToken rejects it as it would any other.
  if (user) req.session = { user };
}

/**
 * Call an API route in-process.
 *
 * @param {import("fastify").FastifyInstance} app  root instance
 * @param {object} opts
 * @param {"GET"|"POST"} opts.method
 * @param {string} opts.url
 * @param {object} [opts.body]
 * @param {object} [opts.user]      act as this session user (session-authenticated routes)
 * @param {boolean} [opts.internal] authenticate with this app's own API client key instead
 * @returns {Promise<{ status: number, data: any }>}
 */
export async function callApi(app, { method = "GET", url, body, user, internal = false }) {
  const headers = {
    // Same-origin for the CSRF guards: this call never left the process.
    "sec-fetch-site": "same-origin",
  };
  let ticket = null;

  if (user) {
    ticket = issueTicket(user);
    headers[PRINCIPAL_HEADER] = ticket;
  } else if (internal) {
    headers["x-access-token"] = process.env.INTERNAL_API_KEY || "";
  }

  if (body !== undefined) headers["content-type"] = "application/json";

  try {
    const res = await app.inject({
      method,
      url,
      headers,
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let data;
    try {
      data = res.json();
    } catch {
      data = { success: false, message: `Unexpected ${res.statusCode} response from ${url}` };
    }
    return { status: res.statusCode, data };
  } finally {
    if (ticket) revokeTicket(ticket);
  }
}
