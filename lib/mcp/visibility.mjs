/**
 * lib/mcp/visibility.mjs
 *
 * Which tools a caller sees: the tool's module must be switched on and the
 * caller must hold one of its permission nodes. Pure, so it is unit-tested
 * without loading the tool modules (which import the database layer).
 */

import { hasPermission } from "../discord/permissions.mjs";

function featureOn(features, flag) {
  if (!flag) return true;
  return flag.split(".").reduce((node, key) => (node == null ? node : node[key]), features) !== false;
}

export function filterVisibleTools(tools, { user, features } = {}) {
  const permissions = user?.permissions || [];
  return tools.filter(
    (tool) =>
      featureOn(features || {}, tool.feature) &&
      (!tool.permission || tool.permission.some((node) => hasPermission(permissions, node)))
  );
}
