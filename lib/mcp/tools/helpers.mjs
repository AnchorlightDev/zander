/**
 * lib/mcp/tools/helpers.mjs
 *
 * Small helpers shared by the MCP tool modules.
 */

import { hasPermission } from "../../discord/permissions.mjs";
import { ToolError } from "../protocol.mjs";
import { callApi } from "../principal.mjs";

/** True if the caller holds any of `nodes`. */
export function holdsAny(user, nodes) {
  const permissions = user?.permissions || [];
  return [].concat(nodes).some((node) => hasPermission(permissions, node));
}

/** Throw a ToolError unless the caller holds any of `nodes`. */
export function requireAny(user, nodes, what = "do that") {
  if (!holdsAny(user, nodes)) {
    throw new ToolError(`You don't have permission to ${what} (needs ${[].concat(nodes).join(" or ")}).`);
  }
}

/**
 * Call an API route and unwrap Zander's `{ success, message, data }` shape,
 * turning a refusal into a ToolError the model can read and relay.
 */
export async function api(ctx, opts) {
  const { status, data } = await callApi(ctx.app, opts);
  if (status === 401 || status === 403 || !data || data.success === false) {
    throw new ToolError(data?.message || data?.content || `Zander refused the request (HTTP ${status}).`);
  }
  return data;
}

/** Remove undefined keys so partial updates only send what was given. */
export function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** Absolute URL on the public site. */
export function siteUrl(path) {
  const base = (process.env.siteAddress || "").replace(/\/+$/, "");
  return `${base}${path}`;
}

/** Parse an ISO-8601 date-time, rejecting anything Date cannot read. */
export function parseDateTime(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ToolError(`"${name}" must be an ISO 8601 date-time, e.g. 2026-11-20T19:30:00+11:00.`);
  }
  return date;
}
