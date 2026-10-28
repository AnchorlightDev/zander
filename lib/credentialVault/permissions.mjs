/**
 * lib/credentialVault/permissions.mjs
 *
 * Pure evaluation of Credential Vault grants. The database layer loads the
 * grants that apply to one user (direct grants plus grants to groups the user
 * is an active member of); everything here decides what they add up to.
 *
 * Rules
 *   - Deny by default: no applicable allow grant, no capability.
 *   - A grant applies if it is not revoked, not expired, and its scope covers
 *     the target (vault covers everything in the vault; collection covers
 *     credentials in that collection; credential covers that credential).
 *   - Deny wins, at any scope and through any group.
 *   - Holding any of IMPLIES_VIEW on a credential implies list + view.
 *   - Denying `list` hides the target entirely; denying `view` removes view
 *     and everything that implies it.
 *   - manage_vault does NOT imply reveal or copy. Nobody, however senior,
 *     gets secret access without an explicit grant.
 *
 * Imports nothing that touches the database: unit-testable.
 */

import {
  CAPABILITIES,
  IMPLIES_VIEW,
  capabilitiesForScope,
  SCOPES,
  EFFECTS,
  PRINCIPAL_TYPES,
} from "./constants.mjs";

const CAPABILITY_SET = new Set(CAPABILITIES);

export function parseCapabilities(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(list.map((c) => String(c).trim()).filter((c) => CAPABILITY_SET.has(c)))];
}

export function serialiseCapabilities(list) {
  return parseCapabilities(list).join(",");
}

function toTime(value) {
  if (value === null || value === undefined) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

export function isGrantActive(grant, now = Date.now()) {
  if (!grant) return false;
  if (grant.revokedAt) return false;
  const expires = toTime(grant.expiresAt);
  if (expires !== null && expires <= now) return false;
  return true;
}

/**
 * Does `grant` cover `target`?
 * target: { kind: "vault" } | { kind: "collection", collectionId } |
 *         { kind: "credential", collectionId, credentialId }
 */
export function grantCovers(grant, target) {
  if (!grant || !target) return false;
  if (grant.scope === "vault") return true;
  if (grant.scope === "collection") {
    return (
      (target.kind === "collection" || target.kind === "credential") &&
      Number(grant.collectionId) === Number(target.collectionId)
    );
  }
  if (grant.scope === "credential") {
    return target.kind === "credential" && Number(grant.credentialId) === Number(target.credentialId);
  }
  return false;
}

/** Effective capabilities for one target. Returns a Set. */
export function effectiveCapabilities(grants, target, now = Date.now()) {
  const allow = new Set();
  const deny = new Set();
  for (const grant of grants || []) {
    if (!isGrantActive(grant, now) || !grantCovers(grant, target)) continue;
    const caps = parseCapabilities(grant.capabilities);
    const into = grant.effect === "deny" ? deny : allow;
    for (const cap of caps) into.add(cap);
  }

  // Implications are applied before deny so that a deny on view also strips
  // the implied view a reveal grant would have produced.
  if (target.kind === "credential" || target.kind === "collection") {
    if (IMPLIES_VIEW.some((cap) => allow.has(cap))) {
      allow.add("view");
      allow.add("list");
    }
    if (allow.has("view")) allow.add("list");
  }

  if (deny.has("list")) return new Set();
  if (deny.has("view")) {
    for (const cap of IMPLIES_VIEW) allow.delete(cap);
  }
  for (const cap of deny) allow.delete(cap);
  return allow;
}

export function hasCapability(grants, target, capability, now = Date.now()) {
  return effectiveCapabilities(grants, target, now).has(capability);
}

export function hasAllCapabilities(grants, target, capabilities, now = Date.now()) {
  const caps = effectiveCapabilities(grants, target, now);
  return capabilities.every((c) => caps.has(c));
}

/** Vault-wide capabilities (vault-scope grants only). */
export function vaultCapabilities(grants, now = Date.now()) {
  return effectiveCapabilities(grants, { kind: "vault" }, now);
}

/**
 * Does the user hold `capability` anywhere — vault scope or any collection /
 * credential? Used for menu decisions only, never for authorising an action.
 */
export function holdsAnywhere(grants, capability, now = Date.now()) {
  const denied = (grants || []).some(
    (g) => isGrantActive(g, now) && g.effect === "deny" && g.scope === "vault" && parseCapabilities(g.capabilities).includes(capability)
  );
  if (denied) return false;
  return (grants || []).some(
    (g) => isGrantActive(g, now) && g.effect !== "deny" && parseCapabilities(g.capabilities).includes(capability)
  );
}

/**
 * What lifting a deny would give back. A deny on `view` also removed every
 * capability that implies it, and a deny on `list` removed everything, so
 * whoever lifts such a deny must hold all of those.
 */
export function capabilitiesRestoredByLiftingDeny(capabilities) {
  const caps = new Set(parseCapabilities(capabilities));
  if (caps.has("list")) for (const c of CAPABILITIES) caps.add(c);
  if (caps.has("view")) for (const c of IMPLIES_VIEW) caps.add(c);
  return [...caps];
}

/**
 * Validate a grant before it is written. Returns { ok, error, grant } where
 * grant is normalised. Does not check who is granting — see checkGrantAuthority.
 */
export function validateGrantInput(input) {
  const scope = String(input?.scope ?? "");
  if (!SCOPES.includes(scope)) return { ok: false, error: "Unknown scope." };
  const principalType = String(input?.principalType ?? "");
  if (!PRINCIPAL_TYPES.includes(principalType)) return { ok: false, error: "Unknown principal type." };
  const effect = String(input?.effect ?? "allow");
  if (!EFFECTS.includes(effect)) return { ok: false, error: "Unknown effect." };

  const allowedCaps = new Set(capabilitiesForScope(scope));
  const requested = Array.isArray(input?.capabilities)
    ? input.capabilities.map(String)
    : String(input?.capabilities ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  if (requested.length === 0) return { ok: false, error: "Choose at least one capability." };
  const unknown = requested.filter((c) => !allowedCaps.has(c));
  if (unknown.length) return { ok: false, error: `Not valid at ${scope} scope: ${unknown.join(", ")}.` };

  const userId = principalType === "user" ? Number.parseInt(input.userId, 10) : null;
  const groupId = principalType === "group" ? Number.parseInt(input.groupId, 10) : null;
  if (principalType === "user" && !(userId > 0)) return { ok: false, error: "Choose a user." };
  if (principalType === "group" && !(groupId > 0)) return { ok: false, error: "Choose a group." };

  const collectionId = scope === "collection" ? Number.parseInt(input.collectionId, 10) : null;
  const credentialId = scope === "credential" ? Number.parseInt(input.credentialId, 10) : null;
  if (scope === "collection" && !(collectionId > 0)) return { ok: false, error: "Missing collection." };
  if (scope === "credential" && !(credentialId > 0)) return { ok: false, error: "Missing credential." };

  let expiresAt = null;
  if (input?.expiresAt) {
    const t = toTime(input.expiresAt);
    if (t === null) return { ok: false, error: "Invalid expiry date." };
    if (t <= Date.now()) return { ok: false, error: "Expiry must be in the future." };
    expiresAt = new Date(t);
  }

  return {
    ok: true,
    grant: {
      scope,
      principalType,
      userId,
      groupId,
      effect,
      capabilities: parseCapabilities(requested),
      collectionId,
      credentialId,
      expiresAt,
      reason: input?.reason ? String(input.reason).slice(0, 500) : null,
    },
  };
}

/**
 * May `actor` write `grant`? Pure part of the self-escalation guard.
 *
 *   actorUserId          the person granting
 *   actorGrants          grants that apply to the actor
 *   actorGroupIds        groups the actor is an active member of
 *   target               what the grant covers (vault / collection / credential)
 *   grant                validated grant (validateGrantInput().grant)
 *
 * Rules: you never grant to yourself or to a group you are in; you need
 * manage_access on the target (or manage_vault); without manage_vault you can
 * only hand out capabilities you yourself hold on that target, and never
 * vault-scope grants.
 */
export function checkGrantAuthority({ actorUserId, actorGrants, actorGroupIds = [], target, grant, now = Date.now() }) {
  if (grant.principalType === "user" && Number(grant.userId) === Number(actorUserId)) {
    return { ok: false, error: "You cannot change your own vault permissions." };
  }
  if (grant.principalType === "group" && actorGroupIds.map(Number).includes(Number(grant.groupId))) {
    return { ok: false, error: "You cannot change permissions for a group you belong to." };
  }

  const vaultCaps = vaultCapabilities(actorGrants, now);
  if (vaultCaps.has("manage_vault")) return { ok: true };

  if (grant.scope === "vault") {
    return { ok: false, error: "Only vault administrators can create vault-wide permissions." };
  }

  const actorCaps = effectiveCapabilities(actorGrants, target, now);
  if (!actorCaps.has("manage_access")) {
    return { ok: false, error: "You do not have permission to manage access here." };
  }
  if (grant.effect === "allow") {
    const missing = grant.capabilities.filter((c) => !actorCaps.has(c));
    if (missing.length) {
      return { ok: false, error: `You cannot grant capabilities you do not hold: ${missing.join(", ")}.` };
    }
  }
  return { ok: true };
}
