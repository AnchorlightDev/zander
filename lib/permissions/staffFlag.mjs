/**
 * lib/permissions/staffFlag.mjs
 *
 * Whether a resolved LuckPerms permission list marks someone as staff.
 *
 * The rank editor writes `meta.staff.1` on staff groups and `meta.staff.0` on
 * every other group it saves, so the node's presence means nothing -- only its
 * value does. Checking `startsWith("meta.staff.")` made every member of a
 * non-staff rank count as staff.
 *
 * Imports nothing, so it is unit-testable.
 */

export function hasStaffFlag(permissions) {
  if (!Array.isArray(permissions)) return false;
  return permissions.some((p) => p && String(p).trim().toLowerCase() === "meta.staff.1");
}
