/**
 * server_access action: let ranks onto a server, or take them off it.
 * payload: { server: <Velocity name>, mode: 'grant' | 'revoke', ranks: [rank, ...] }
 *
 * Built for timed openings: schedule a grant to supporters when a dev test
 * starts and a revoke when it ends. It queues the same LuckPerms commands the
 * servers dashboard's Access page does (`lp group <rank> permission set|unset
 * serverpermissions.server.<server>`), which are idempotent, so a re-run or a
 * retry does no harm. Ranks are checked against LuckPerms at run time.
 */
import { isValidRankName, isValidVelocityName, accessNode } from "../../servers/serverAccess.mjs";

function ranksOf(payload) {
  const raw = payload.ranks;
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  return [...new Set(list.map((r) => String(r).trim().toLowerCase()).filter(Boolean))];
}

export function validate(payload = {}) {
  const errors = [];
  if (!isValidVelocityName(String(payload.server ?? "").trim())) errors.push("server_access: choose a server (its Velocity name).");
  if (!["grant", "revoke"].includes(payload.mode)) errors.push("server_access: mode must be 'grant' or 'revoke'.");
  const ranks = ranksOf(payload);
  if (!ranks.length) errors.push("server_access: choose at least one rank.");
  const bad = ranks.filter((r) => !isValidRankName(r));
  if (bad.length) errors.push(`server_access: invalid rank name${bad.length === 1 ? "" : "s"}: ${bad.join(", ")}.`);
  return errors;
}

export function describe(payload = {}) {
  const ranks = ranksOf(payload).join(", ") || "(no ranks)";
  return payload.mode === "revoke"
    ? `Remove ${ranks} from server ${payload.server}`
    : `Let ${ranks} join server ${payload.server}`;
}

export function preview(payload = {}) {
  let node = "";
  try {
    node = accessNode(String(payload.server ?? "").trim());
  } catch {
    node = "(invalid server)";
  }
  return {
    summary: describe(payload),
    sideEffects: [`Queues LuckPerms commands that ${payload.mode === "revoke" ? "unset" : "set"} ${node} on each rank.`],
  };
}

export async function run(payload = {}) {
  const { changeRankAccess } = await import("../../../controllers/serverAccessController.js");
  const ranks = ranksOf(payload);
  const result = await changeRankAccess(String(payload.server).trim(), ranks, payload.mode, "scheduler");
  return { status: "queued", message: `${describe(payload)} (${result.queued} command${result.queued === 1 ? "" : "s"} queued)`, refs: { ranks } };
}
