/**
 * lib/mcp/userContext.mjs
 *
 * Builds the same `user` object a dashboard login puts in the session
 * (routes/sessionRoutes.js hydrateUserSession), for the staff member an MCP
 * token belongs to. Permissions are re-read from LuckPerms, cached for a short
 * time so a burst of tool calls does not re-query on every one.
 */

import { prisma } from "../../controllers/databaseController.js";
import { getUserPermissions } from "../../controllers/userController.js";
import { hasStaffFlag } from "../permissions/staffFlag.mjs";

const CACHE_MS = 30 * 1000;
const cache = new Map();

export async function loadMcpUser(userId) {
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit.user;

  const row = await prisma.users.findUnique({
    where: { userId },
    select: { userId: true, uuid: true, username: true, discordId: true, account_disabled: true },
  });
  if (!row || row.account_disabled) {
    cache.delete(userId);
    return null;
  }

  const permissions = await getUserPermissions(row);
  const rankSlugs = permissions.userRanks || [];

  const user = {
    userId: row.userId,
    username: row.username,
    uuid: row.uuid,
    discordID: row.discordId,
    discordId: row.discordId,
    ranks: rankSlugs.map((rankSlug) => ({ rankSlug })),
    permissions,
    permissionsRefreshedAt: Date.now(),
    isStaff: hasStaffFlag(permissions),
    viaMcp: true,
  };

  cache.set(userId, { user, expiresAt: Date.now() + CACHE_MS });
  return user;
}
