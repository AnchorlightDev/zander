/**
 * services/credentialVaultService.js
 *
 * Business rules for the Credential Vault: permission checks, envelope
 * encryption, the one-time reauthentication flow, access requests,
 * offboarding and notifications. Routes call this; this calls the controller
 * for SQL and lib/credentialVault/* for pure logic.
 *
 * Every function that returns or acts on a secret re-reads permissions from
 * the database at the moment of use. Nothing is cached per session.
 */

import crypto from "node:crypto";
import bcrypt from "bcrypt";
import * as store from "../controllers/credentialVaultController.js";
import {
  AUDIT_EVENTS,
  CAPABILITIES,
  CHALLENGE_ACTION_KEYS,
  DEFAULT_VAULT_ID,
  REQUESTABLE_CAPABILITIES,
  isSecretFieldName,
  secretFieldsFor,
} from "../lib/credentialVault/constants.mjs";
import {
  capabilitiesRestoredByLiftingDeny,
  checkGrantAuthority,
  effectiveCapabilities,
  holdsAnywhere,
  parseCapabilities,
  validateGrantInput,
  vaultCapabilities,
} from "../lib/credentialVault/permissions.mjs";
import {
  decryptSecretPayload,
  dekAad,
  encryptSecretPayload,
  estimatePasswordStrength,
  fingerprintKeyAad,
  generateDataKey,
  keyProviderFromEnv,
  passwordFingerprint,
} from "../lib/credentialVault/crypto.mjs";
import {
  auditSessionLabel,
  clampChallengeTtl,
  generateChallengeToken,
  hashChallengeToken,
  hashSessionId,
  isVersionAction,
  isWellFormedToken,
  requiredCapabilitiesFor,
} from "../lib/credentialVault/challenge.mjs";
import { resolveSettings } from "../lib/credentialVault/settings.mjs";
import { changedFieldNames, mergeSecretPayload } from "../lib/credentialVault/input.mjs";
import {
  dummyVerifier,
  hashVaultPassword,
  vaultPasswordProblem,
  verifyVaultPassword,
} from "../lib/credentialVault/vaultPassword.mjs";
import { GENESIS_HASH, verifyChain } from "../lib/credentialVault/audit.mjs";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class VaultError extends Error {
  /**
   * code: not_found | invalid | forbidden | locked | enrolment_required |
   *       not_configured | rate_limited | verification_failed | conflict
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "VaultError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Unauthorised and missing look identical, so ids cannot be probed. */
function notFound() {
  return new VaultError("not_found", "That credential does not exist or you do not have access to it.");
}

// ---------------------------------------------------------------------------
// Dependencies that tests replace
// ---------------------------------------------------------------------------

const deps = {
  keyProvider: undefined, // undefined = read env on first use; null = unconfigured
  keyProviderError: null,
  now: () => new Date(),
  notify: null, // async ({ eventKey, recipients, title, message, url }) => void
  destroySessionsForUser: null,
};

export function configureVaultServiceForTests(overrides = {}) {
  Object.assign(deps, overrides);
  fingerprintKeyCache = null;
}

function provider() {
  if (deps.keyProvider === undefined) {
    const { provider: p, error } = keyProviderFromEnv();
    deps.keyProvider = p;
    deps.keyProviderError = error;
  }
  return deps.keyProvider;
}

export function vaultConfigurationStatus() {
  const p = provider();
  return p ? { configured: true, error: null } : { configured: false, error: deps.keyProviderError || "Not configured" };
}

function requireProvider() {
  const p = provider();
  if (!p) throw new VaultError("not_configured", "The credential vault is not configured on this server.");
  return p;
}

// ---------------------------------------------------------------------------
// Settings (cached briefly; security settings are clamped in resolveSettings)
// ---------------------------------------------------------------------------

let settingsCache = { at: 0, value: null };

export async function getSettings({ fresh = false } = {}) {
  if (!fresh && settingsCache.value && Date.now() - settingsCache.at < 15000) return settingsCache.value;
  const value = resolveSettings(await store.getStoredSettings());
  settingsCache = { at: Date.now(), value };
  return value;
}

export function invalidateSettingsCache() {
  settingsCache = { at: 0, value: null };
}

// ---------------------------------------------------------------------------
// Actor context
// ---------------------------------------------------------------------------

/**
 * Load everything needed to authorise one request, fresh from the database.
 * reqInfo: { ip, userAgent, sessionId }
 */
export async function loadActor(userId, reqInfo = {}) {
  const id = Number.parseInt(userId, 10);
  if (!(id > 0)) throw new VaultError("forbidden", "Sign in to use the credential vault.");
  const now = deps.now();
  const [account, grantData] = await Promise.all([store.getUserAccount(id), store.loadGrantsForUser(id, now)]);
  if (!account || account.accountDisabled) throw new VaultError("forbidden", "Your account cannot use the credential vault.");
  return {
    userId: id,
    username: account.username,
    hasAccountPassword: account.hasPassword,
    grants: grantData.grants,
    groupIds: grantData.groupIds,
    vaultCaps: vaultCapabilities(grantData.grants, now.getTime()),
    now,
    reqInfo,
  };
}

export function credentialTarget(cred) {
  return { kind: "credential", collectionId: cred.collectionId, credentialId: cred.credentialId };
}

export function capsFor(actor, target) {
  return effectiveCapabilities(actor.grants, target, actor.now.getTime());
}

function requireVaultCap(actor, cap) {
  if (!actor.vaultCaps.has(cap)) throw new VaultError("forbidden", "You do not have permission to do that.");
}

/** Menu-level summary of what the actor may see. Never used to authorise an action. */
export function navCapabilities(actor) {
  const t = actor.now.getTime();
  return {
    manageVault: actor.vaultCaps.has("manage_vault"),
    manageCollections: actor.vaultCaps.has("manage_collections"),
    viewAudit: holdsAnywhere(actor.grants, "view_audit", t),
    approveRequests: holdsAnywhere(actor.grants, "approve_requests", t),
    create: holdsAnywhere(actor.grants, "create", t),
    manageAccess: holdsAnywhere(actor.grants, "manage_access", t),
  };
}

async function audit(actor, event) {
  try {
    await store.appendAuditEvent({
      actorUserId: actor?.userId ?? null,
      sessionHash: auditSessionLabel(actor?.reqInfo?.sessionId),
      ip: actor?.reqInfo?.ip ?? null,
      userAgent: actor?.reqInfo?.userAgent ?? null,
      outcome: "success",
      ...event,
    });
  } catch (error) {
    // An audit failure must be visible; it must not leak event details.
    console.error("[credential-vault] audit append failed:", error?.code || error?.message);
    throw new VaultError("conflict", "The action could not be recorded in the audit log, so it was not completed.");
  }
}

async function notify(eventKey, payload) {
  try {
    const settings = await getSettings();
    if (eventKey && settings[eventKey] === false) return;
    if (deps.notify) return await deps.notify({ eventKey, ...payload });
    const { sendVaultNotification } = await import("./credentialVaultNotifications.js");
    await sendVaultNotification({ eventKey, ...payload });
  } catch (error) {
    console.error("[credential-vault] notification failed:", error?.message);
  }
}

// ---------------------------------------------------------------------------
// Who holds what (admins, approvers, reach)
// ---------------------------------------------------------------------------

function grantsByUser({ grants, memberships }) {
  const groupsOf = new Map();
  for (const m of memberships) {
    if (!groupsOf.has(m.userId)) groupsOf.set(m.userId, new Set());
    groupsOf.get(m.userId).add(m.groupId);
  }
  const userIds = new Set([...groupsOf.keys()]);
  for (const g of grants) if (g.principalType === "user" && g.userId) userIds.add(g.userId);
  const result = new Map();
  for (const userId of userIds) {
    const groups = groupsOf.get(userId) || new Set();
    result.set(
      userId,
      grants.filter((g) => (g.principalType === "user" && g.userId === userId) || (g.principalType === "group" && groups.has(g.groupId)))
    );
  }
  return result;
}

/** userIds holding `cap` on `target` right now. */
export async function usersWithCapability(target, cap) {
  const now = deps.now().getTime();
  const all = await store.loadAllActiveGrantsAndMemberships(deps.now());
  const out = [];
  for (const [userId, grants] of grantsByUser(all)) {
    if (effectiveCapabilities(grants, target, now).has(cap)) out.push(userId);
  }
  return out;
}

async function vaultAdmins() {
  return usersWithCapability({ kind: "vault" }, "manage_vault");
}

// ---------------------------------------------------------------------------
// Fingerprint key (password reuse detection)
// ---------------------------------------------------------------------------

let fingerprintKeyCache = null;

async function fingerprintKey() {
  const p = requireProvider();
  if (fingerprintKeyCache) return fingerprintKeyCache;
  let vault = await store.getVault(DEFAULT_VAULT_ID);
  if (!vault.wrappedFingerprintKey) {
    const key = generateDataKey();
    const { kekId, wrapped } = await p.wrap(key, (kid) => fingerprintKeyAad({ vaultId: DEFAULT_VAULT_ID, kekId: kid }));
    key.fill(0);
    await store.setVaultFingerprintKeyIfMissing(DEFAULT_VAULT_ID, kekId, wrapped);
    vault = await store.getVault(DEFAULT_VAULT_ID);
  }
  fingerprintKeyCache = await p.unwrap(vault.fingerprintKekId, vault.wrappedFingerprintKey, (kid) =>
    fingerprintKeyAad({ vaultId: DEFAULT_VAULT_ID, kekId: kid })
  );
  return fingerprintKeyCache;
}

async function sealVersion({ dataKey, payload, credentialId, vaultId, version }) {
  const ciphertext = encryptSecretPayload(dataKey, payload, { vaultId, credentialId, version });
  const password = typeof payload.password === "string" ? payload.password : null;
  return {
    ciphertext,
    fieldNames: Object.keys(payload).filter((k) => typeof payload[k] === "string" && payload[k].length > 0).sort(),
    passwordStrength: password ? estimatePasswordStrength(password) : null,
    passwordFingerprint: password ? passwordFingerprint(await fingerprintKey(), password) : null,
  };
}

async function unwrapDataKey(credentialId, kekId, wrappedKey) {
  return requireProvider().unwrap(kekId, wrappedKey, (kid) => dekAad({ credentialId, kekId: kid }));
}

async function decryptMaterial(credentialId, material) {
  const dataKey = await unwrapDataKey(credentialId, material.kekId, material.wrappedKey);
  try {
    return decryptSecretPayload(dataKey, material.ciphertext, {
      vaultId: material.vaultId,
      credentialId,
      version: material.version,
    });
  } finally {
    dataKey.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Listing and reading metadata
// ---------------------------------------------------------------------------

/** Ids of credentials the actor may list, plus their capability sets. */
export async function visibleCredentials(actor) {
  const skeletons = await store.listCredentialSkeletons();
  const visible = new Map();
  for (const s of skeletons) {
    const caps = capsFor(actor, { kind: "credential", collectionId: s.collectionId, credentialId: s.credentialId });
    if (caps.has("list")) visible.set(s.credentialId, caps);
  }
  return visible;
}

export async function listCredentialsForActor(actor, filters = {}) {
  const visible = await visibleCredentials(actor);
  const settings = await getSettings();
  const ids = [...visible.keys()];
  const viewIds = ids.filter((id) => visible.get(id).has("view"));
  const rows = await store.searchCredentials(ids, {
    ...filters,
    viewIds,
    favouritesOf: filters.favourites ? actor.userId : null,
    rotationReminderDays: settings.rotationReminderDays,
  });
  const favourites = await store.listFavouriteIds(actor.userId);
  // "list" alone shows the name, type, collection and site; usernames etc. need "view".
  return rows.map((row) => {
    const caps = visible.get(row.credentialId);
    const canView = caps.has("view");
    return {
      credentialId: row.credentialId,
      name: row.name,
      type: row.type,
      collectionId: row.collectionId,
      collectionName: row.collectionName,
      collectionColour: row.collectionColour,
      collectionIcon: row.collectionIcon,
      url: row.url,
      username: canView ? row.username : null,
      tags: canView ? row.tags : [],
      updatedAt: row.updatedAt,
      expiresAt: row.expiresAt,
      nextRotationAt: row.nextRotationAt,
      favourite: favourites.has(row.credentialId),
      canView,
    };
  });
}

/** Collections the actor can see anything in, or administer. */
export async function collectionsForActor(actor) {
  const all = await store.listCollections();
  const visible = await visibleCredentials(actor);
  const skeletons = await store.listCredentialSkeletons();
  const visibleCounts = new Map();
  for (const s of skeletons) {
    if (visible.has(s.credentialId)) visibleCounts.set(s.collectionId, (visibleCounts.get(s.collectionId) || 0) + 1);
  }
  return all
    .map((c) => {
      const caps = capsFor(actor, { kind: "collection", collectionId: c.collectionId });
      return { ...c, caps, visibleCount: visibleCounts.get(c.collectionId) || 0 };
    })
    .filter((c) => actor.vaultCaps.has("manage_collections") || c.caps.size > 0 || c.visibleCount > 0);
}

/** Collections where the actor may create credentials. */
export async function creatableCollections(actor) {
  const all = await store.listCollections();
  return all.filter((c) => capsFor(actor, { kind: "collection", collectionId: c.collectionId }).has("create"));
}

/** Metadata view of one credential, gated on `view`. */
export async function getCredentialForActor(actor, credentialId) {
  const cred = await store.getCredential(Number.parseInt(credentialId, 10));
  if (!cred) throw notFound();
  const caps = capsFor(actor, credentialTarget(cred));
  if (!caps.has("view")) {
    if (caps.has("list")) throw new VaultError("forbidden", "You can see this credential exists but not its details. Request access to view it.");
    throw notFound();
  }
  const [collection, versionMeta, favourites, names] = await Promise.all([
    store.getCollection(cred.collectionId),
    store.getCurrentVersionMeta(cred.credentialId),
    store.listFavouriteIds(actor.userId),
    store.getUsernames([cred.ownerUserId, cred.createdBy, cred.updatedBy, cred.lastReviewedBy]),
  ]);
  return {
    credential: cred,
    collection,
    caps,
    secretFieldNames: versionMeta?.fieldNames || [],
    passwordStrength: versionMeta?.passwordStrength ?? null,
    favourite: favourites.has(cred.credentialId),
    names,
  };
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

async function resolveOwner(meta) {
  if (meta.ownerUsername && !meta.ownerUserId) {
    const user = await store.findUserByUsername(meta.ownerUsername);
    if (!user) throw new VaultError("invalid", `No user called ${meta.ownerUsername}.`);
    meta.ownerUserId = user.userId;
  }
  return meta;
}

export async function createCredential(actor, parsed) {
  requireProvider();
  const { meta, secretChanges } = parsed;
  const collection = await store.getCollection(meta.collectionId);
  if (!collection) throw new VaultError("invalid", "That collection does not exist.");
  if (!capsFor(actor, { kind: "collection", collectionId: collection.collectionId }).has("create")) {
    throw new VaultError("forbidden", "You cannot create credentials in that collection.");
  }
  await resolveOwner(meta);
  if (!meta.ownerUserId) meta.ownerUserId = actor.userId;
  const payload = mergeSecretPayload({}, secretChanges);
  if (Object.keys(payload).length === 0) throw new VaultError("invalid", "Enter at least one secret value.");

  const p = requireProvider();
  // Resolve the fingerprint key before the transaction: creating it writes
  // the vault row, which the credential insert holds a foreign-key lock on.
  await fingerprintKey();
  const credentialId = await store.insertCredential(meta, actor.userId, async ({ credentialId: id, vaultId, version }) => {
    const dataKey = generateDataKey();
    try {
      const { kekId, wrapped } = await p.wrap(dataKey, (kid) => dekAad({ credentialId: id, kekId: kid }));
      const sealed = await sealVersion({ dataKey, payload, credentialId: id, vaultId, version });
      return { kekId, wrappedKey: wrapped, ...sealed };
    } finally {
      dataKey.fill(0);
    }
  });
  await audit(actor, {
    eventType: AUDIT_EVENTS.CREDENTIAL_CREATED,
    credentialId,
    collectionId: meta.collectionId,
    metadata: { type: meta.type, name: meta.name, fields: Object.keys(payload).sort() },
  });
  return credentialId;
}

export async function updateCredential(actor, credentialId, parsed) {
  const cred = await store.getCredential(Number.parseInt(credentialId, 10));
  if (!cred) throw notFound();
  const caps = capsFor(actor, credentialTarget(cred));
  if (!caps.has("edit")) throw caps.has("view") ? new VaultError("forbidden", "You cannot edit this credential.") : notFound();

  const { meta, secretChanges } = parsed;
  await resolveOwner(meta);
  if (meta.collectionId !== cred.collectionId) {
    const dest = await store.getCollection(meta.collectionId);
    if (!dest) throw new VaultError("invalid", "That collection does not exist.");
    const destCaps = capsFor(actor, { kind: "collection", collectionId: dest.collectionId });
    // Moving changes who inherits access (everyone with rights on the
    // destination gains this credential), so it is an access-management act:
    // manage_access on the credential and on the destination, or manage_vault.
    if (!actor.vaultCaps.has("manage_vault") && !(caps.has("manage_access") && destCaps.has("manage_access") && destCaps.has("create"))) {
      throw new VaultError("forbidden", "Moving a credential needs Manage access on it and on the destination collection.");
    }
    // A move must never widen the mover's own access: otherwise someone with
    // edit (but no reveal) could move a credential into a collection where they
    // hold reveal, or out from under a collection-level deny.
    const after = capsFor(actor, { kind: "credential", collectionId: dest.collectionId, credentialId: cred.credentialId });
    const gained = [...after].filter((c) => !caps.has(c));
    if (gained.length) {
      throw new VaultError(
        "forbidden",
        `Moving it there would give you access you do not have now (${gained.join(", ")}). Ask a vault administrator to move it.`
      );
    }
  }

  const metaChanges = [];
  for (const key of ["collectionId", "name", "url", "username", "email", "description", "ownerUserId", "isRequestable", "rotateEveryDays"]) {
    if (String(meta[key] ?? "") !== String(cred[key] ?? "")) metaChanges.push(key);
  }
  if (JSON.stringify(meta.details || {}) !== JSON.stringify(cred.details || {})) metaChanges.push("details");
  if ((meta.tags || []).join(",") !== (cred.tags || []).join(",")) metaChanges.push("tags");
  for (const key of ["expiresAt", "nextRotationAt"]) {
    const a = meta[key] ? new Date(meta[key]).getTime() : null;
    const b = cred[key] ? new Date(cred[key]).getTime() : null;
    if (a !== b) metaChanges.push(key);
  }

  await store.updateCredentialMetadata(cred.credentialId, meta, actor.userId);

  const hasSecretChange = Object.keys(secretChanges.set).length > 0 || secretChanges.clear.length > 0;
  let changedSecrets = [];
  if (hasSecretChange) {
    changedSecrets = await writeNewSecretVersion(actor, cred, (current) => mergeSecretPayload(current, secretChanges), {
      markRotated: Boolean(parsed.markRotated),
    });
  }

  if (meta.collectionId !== cred.collectionId) {
    await audit(actor, {
      eventType: AUDIT_EVENTS.CREDENTIAL_MOVED,
      credentialId: cred.credentialId,
      collectionId: meta.collectionId,
      metadata: { fromCollectionId: cred.collectionId, toCollectionId: meta.collectionId },
    });
  }
  if (metaChanges.length) {
    await audit(actor, {
      eventType: AUDIT_EVENTS.CREDENTIAL_UPDATED,
      credentialId: cred.credentialId,
      collectionId: meta.collectionId,
      metadata: { changed: metaChanges },
    });
  }
  if (changedSecrets.length) {
    await audit(actor, {
      eventType: parsed.markRotated ? AUDIT_EVENTS.SECRET_ROTATED : AUDIT_EVENTS.SECRET_REPLACED,
      credentialId: cred.credentialId,
      collectionId: meta.collectionId,
      metadata: { fields: changedSecrets },
    });
    if (parsed.markRotated) await store.closeRotationTasksForCredential(cred.credentialId, actor.userId);
  }
  if (metaChanges.length || changedSecrets.length) {
    await notify("notifyCredentialUpdated", {
      recipients: "admins",
      excludeUserIds: [actor.userId],
      title: "Credential updated",
      message: `${actor.username} updated "${meta.name}"${changedSecrets.length ? " (secret replaced)" : ""}.`,
      url: `/dashboard/credentials/${cred.credentialId}`,
    });
  }
  return { metaChanges, changedSecrets };
}

/**
 * Decrypt the current payload server-side, apply `transform`, and store the
 * result as a new version under the same data key. Returns changed field names.
 */
async function writeNewSecretVersion(actor, cred, transform, { markRotated = false, restoredFromVersion = null } = {}) {
  let changed = [];
  await fingerprintKey(); // outside the transaction, see createCredential
  const result = await store.appendSecretVersion(
    cred.credentialId,
    actor.userId,
    async ({ credentialId, vaultId, version, currentKey }) => {
      const current = await store.getSecretMaterial(credentialId, null);
      const before = current ? await decryptMaterial(credentialId, current) : {};
      const after = await transform(before);
      changed = changedFieldNames(before, after);
      if (Object.keys(after).length === 0) throw new VaultError("invalid", "A credential must keep at least one secret value.");
      const p = requireProvider();
      // Reuse the current data key unless its KEK is no longer active.
      let dataKey;
      let keyFields;
      if (currentKey && currentKey.kekId === p.activeKekId) {
        dataKey = await unwrapDataKey(credentialId, currentKey.kekId, currentKey.wrappedKey);
        keyFields = { keyId: currentKey.keyId };
      } else {
        dataKey = generateDataKey();
        const { kekId, wrapped } = await p.wrap(dataKey, (kid) => dekAad({ credentialId, kekId: kid }));
        keyFields = { kekId, wrappedKey: wrapped };
      }
      try {
        const sealed = await sealVersion({ dataKey, payload: after, credentialId, vaultId, version });
        return { ...keyFields, ...sealed, changedFields: changed };
      } finally {
        dataKey.fill(0);
      }
    },
    { restoredFromVersion, markRotated }
  );
  if (!result) throw notFound();
  return changed;
}

export async function deleteCredential(actor, credentialId) {
  const cred = await store.getCredential(Number.parseInt(credentialId, 10));
  if (!cred) throw notFound();
  const caps = capsFor(actor, credentialTarget(cred));
  if (!caps.has("delete")) throw caps.has("view") ? new VaultError("forbidden", "You cannot delete this credential.") : notFound();
  await store.softDeleteCredential(cred.credentialId, actor.userId);
  await store.revokePendingChallenges({ credentialId: cred.credentialId });
  await audit(actor, {
    eventType: AUDIT_EVENTS.CREDENTIAL_DELETED,
    credentialId: cred.credentialId,
    collectionId: cred.collectionId,
    metadata: { name: cred.name },
  });
}

export async function restoreDeletedCredential(actor, credentialId) {
  const cred = await store.getCredential(Number.parseInt(credentialId, 10), { includeDeleted: true });
  if (!cred || !cred.deletedAt) throw notFound();
  if (!capsFor(actor, credentialTarget(cred)).has("delete") && !actor.vaultCaps.has("manage_vault")) throw notFound();
  await store.restoreCredential(cred.credentialId, actor.userId);
  await audit(actor, { eventType: AUDIT_EVENTS.CREDENTIAL_RESTORED, credentialId: cred.credentialId, collectionId: cred.collectionId });
}

export async function deletedCredentialsForActor(actor) {
  const skeletons = await store.listCredentialSkeletons({ includeDeleted: true });
  const ids = skeletons
    .filter((s) => s.deletedAt)
    .filter((s) => {
      const caps = capsFor(actor, { kind: "credential", collectionId: s.collectionId, credentialId: s.credentialId });
      return caps.has("delete") || actor.vaultCaps.has("manage_vault");
    })
    .map((s) => s.credentialId);
  return store.listDeletedCredentials(ids);
}

export async function setFavourite(actor, credentialId, on) {
  const cred = await store.getCredential(Number.parseInt(credentialId, 10));
  if (!cred || !capsFor(actor, credentialTarget(cred)).has("list")) throw notFound();
  await store.setFavourite(actor.userId, cred.credentialId, on);
}

export async function markCredentialReviewed(actor, credentialId) {
  const cred = await store.getCredential(Number.parseInt(credentialId, 10));
  if (!cred) throw notFound();
  const caps = capsFor(actor, credentialTarget(cred));
  if (!caps.has("edit") && !actor.vaultCaps.has("manage_vault")) throw notFound();
  await store.markReviewed(cred.credentialId, actor.userId);
  await audit(actor, { eventType: AUDIT_EVENTS.CREDENTIAL_REVIEWED, credentialId: cred.credentialId, collectionId: cred.collectionId });
}

export async function versionHistory(actor, credentialId) {
  const cred = await store.getCredential(Number.parseInt(credentialId, 10));
  if (!cred) throw notFound();
  const caps = capsFor(actor, credentialTarget(cred));
  if (!caps.has("view_history")) throw caps.has("view") ? new VaultError("forbidden", "You cannot view this credential's history.") : notFound();
  const versions = await store.listSecretVersions(cred.credentialId);
  const names = await store.getUsernames(versions.map((v) => v.createdBy));
  const events = await store.queryAuditEvents({ credentialId: cred.credentialId, limit: 100 });
  return { credential: cred, caps, versions, names, events: events.rows };
}

// ---------------------------------------------------------------------------
// Reauthentication factor
// ---------------------------------------------------------------------------

/**
 * Which factor this user must present. Fails closed: null means none is
 * available and the user must enrol a vault password first.
 */
export async function resolveFactor(userId, settings) {
  const [account, row] = await Promise.all([store.getUserAccount(userId), store.getVaultPasswordRow(userId)]);
  if (!account) return { method: null, account: null, row };
  if (!settings.requireDedicatedVaultPassword && account.hasPassword) return { method: "account_password", account, row };
  if (row?.verifier) return { method: "vault_password", account, row };
  return { method: null, account, row };
}

function lockedUntil(row, now) {
  if (!row?.lockedUntil) return null;
  const t = new Date(row.lockedUntil).getTime();
  return t > now.getTime() ? new Date(t) : null;
}

export async function securityStatus(actor) {
  const settings = await getSettings();
  const factor = await resolveFactor(actor.userId, settings);
  const now = deps.now();
  const codeExpires = factor.row?.enrolmentCodeExpiresAt ? new Date(factor.row.enrolmentCodeExpiresAt) : null;
  return {
    method: factor.method,
    hasAccountPassword: Boolean(factor.account?.hasPassword),
    hasVaultPassword: Boolean(factor.row?.verifier),
    vaultPasswordEnrolledAt: factor.row?.enrolledAt || null,
    lockedUntil: lockedUntil(factor.row, now),
    requireDedicatedVaultPassword: settings.requireDedicatedVaultPassword,
    // How enrolment is proven: the account password if there is one,
    // otherwise a one-time code from a vault administrator.
    enrolmentFactor: factor.account?.hasPassword ? "account_password" : "enrolment_code",
    hasPendingEnrolmentCode: Boolean(factor.row?.enrolmentCodeHash && codeExpires && codeExpires > now),
  };
}

const ENROLMENT_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const ENROLMENT_CODE_TTL_HOURS = 24;

function normaliseEnrolmentCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hashEnrolmentCode(userId, code) {
  return crypto.createHash("sha256").update(`zander-cv/enrol/v1|${Number(userId)}|${normaliseEnrolmentCode(code)}`, "utf8").digest("hex");
}

function generateEnrolmentCode() {
  let out = "";
  for (let i = 0; i < 20; i += 1) out += ENROLMENT_CODE_ALPHABET[crypto.randomInt(ENROLMENT_CODE_ALPHABET.length)];
  return out.match(/.{5}/g).join("-"); // ~98 bits
}

/** Charge one attempt against the lockout before checking any factor. */
async function reserveAttempt(userId, settings) {
  const ok = await store.reserveVerificationAttempt(userId, settings.maxFailedAttempts, deps.now(), settings.lockoutMinutes);
  if (!ok) {
    const row = await store.getVaultPasswordRow(userId);
    throw new VaultError("locked", "Vault verification is temporarily locked after repeated failures. Try again later.", {
      lockedUntil: lockedUntil(row, deps.now()),
    });
  }
}

async function failedAttempt(actorLike, userId, settings, metadata, baseEvent = {}) {
  const state = await store.lockIfExhausted(userId, settings.maxFailedAttempts, settings.lockoutMinutes, deps.now());
  await audit(actorLike, { ...baseEvent, eventType: AUDIT_EVENTS.REAUTH_FAILED, outcome: "failure", subjectUserId: userId, metadata });
  const nowLocked = lockedUntil({ lockedUntil: state.lockedUntil }, deps.now());
  if (nowLocked) {
    await audit(actorLike, { ...baseEvent, eventType: AUDIT_EVENTS.REAUTH_LOCKED, outcome: "denied", subjectUserId: userId, metadata: { minutes: settings.lockoutMinutes } });
    const account = await store.getUserAccount(userId);
    await notify("notifySuspicious", {
      recipients: "admins",
      title: "Vault verification locked",
      message: `${account?.username || `User ${userId}`} was locked out of the credential vault after repeated failed verifications.`,
      url: "/dashboard/credentials/audit?outcome=failure",
    });
  }
  return nowLocked;
}

/**
 * Set a first vault password. Proof of identity is never "being signed in":
 * staff with a Zander password re-enter it; staff without one (Discord-only)
 * enter a one-time code a different vault administrator issued to them.
 */
export async function enrolVaultPassword(actor, { password, confirm, accountPassword, enrolmentCode }) {
  const settings = await getSettings();
  const row = await store.getVaultPasswordRow(actor.userId);
  if (row?.verifier) throw new VaultError("conflict", "You already have a vault password. Change it instead.");
  const account = await store.getUserAccount(actor.userId);
  const usesAccountPassword = Boolean(account?.hasPassword);

  if (!usesAccountPassword) {
    // No account password to compare against, so the policy can be checked
    // before the code is spent (a typo should not burn the code).
    if (password !== confirm) throw new VaultError("invalid", "The passwords do not match.");
    const problem = vaultPasswordProblem(password, { username: actor.username });
    if (problem) throw new VaultError("invalid", problem);
  }

  await reserveAttempt(actor.userId, settings);
  let proven = false;
  if (usesAccountPassword) {
    const hash = await store.getUserPasswordHashForVerification(actor.userId);
    proven = Boolean(hash) && typeof accountPassword === "string" && accountPassword.length > 0 && accountPassword.length <= 256
      ? await bcrypt.compare(accountPassword, hash).catch(() => false)
      : false;
  } else {
    proven = await store.consumeEnrolmentCode(actor.userId, hashEnrolmentCode(actor.userId, enrolmentCode), deps.now());
  }
  if (!proven) {
    const locked = await failedAttempt(actor, actor.userId, settings, { action: "enrol_vault_password", factor: usesAccountPassword ? "account_password" : "enrolment_code" });
    if (locked) throw new VaultError("locked", "Too many failed attempts. Vault verification is locked for a while.", { lockedUntil: locked });
    throw new VaultError(
      "verification_failed",
      usesAccountPassword ? "Your Zander password is incorrect." : "That enrolment code is wrong, expired or already used. Ask a vault administrator for a new one."
    );
  }
  await store.resetFailedVerifications(actor.userId);

  if (usesAccountPassword) {
    // Only now, with the account password proven, may we say whether the new
    // password equals it (otherwise this would be a password-guessing oracle).
    if (password !== confirm) throw new VaultError("invalid", "The passwords do not match.");
    const problem = vaultPasswordProblem(password, { username: actor.username, accountPasswordSame: password === accountPassword });
    if (problem) throw new VaultError("invalid", problem);
  }
  await store.setVaultPasswordVerifier(actor.userId, await hashVaultPassword(password), { isChange: false });
  await store.revokePendingChallenges({ userId: actor.userId });
  await audit(actor, { eventType: AUDIT_EVENTS.VAULT_PASSWORD_ENROLLED, subjectUserId: actor.userId, metadata: { factor: usesAccountPassword ? "account_password" : "enrolment_code" } });
}

export async function changeVaultPassword(actor, { currentPassword, password, confirm }) {
  const settings = await getSettings();
  const row = await store.getVaultPasswordRow(actor.userId);
  if (!row?.verifier) throw new VaultError("invalid", "You do not have a vault password yet.");
  await reserveAttempt(actor.userId, settings);
  const ok = await verifyVaultPassword(row.verifier, currentPassword);
  if (!ok) {
    const locked = await failedAttempt(actor, actor.userId, settings, { action: "change_vault_password" });
    if (locked) throw new VaultError("locked", "Too many failed attempts. Vault verification is locked for a while.", { lockedUntil: locked });
    throw new VaultError("verification_failed", "Your current vault password is incorrect.");
  }
  await store.resetFailedVerifications(actor.userId);
  if (password !== confirm) throw new VaultError("invalid", "The new passwords do not match.");
  const hash = await store.getUserPasswordHashForVerification(actor.userId);
  const accountPasswordSame = hash && typeof password === "string" && password.length <= 256 ? await bcrypt.compare(password, hash).catch(() => false) : false;
  const problem = vaultPasswordProblem(password, { username: actor.username, accountPasswordSame });
  if (problem) throw new VaultError("invalid", problem);
  await store.setVaultPasswordVerifier(actor.userId, await hashVaultPassword(password), { isChange: true });
  await store.revokePendingChallenges({ userId: actor.userId });
  await audit(actor, { eventType: AUDIT_EVENTS.VAULT_PASSWORD_CHANGED, subjectUserId: actor.userId });
}

/**
 * A vault administrator issues a one-time enrolment code for someone else.
 * Returned once for the administrator to pass on out of band (in person,
 * a DM); only its hash is stored. Replaces any earlier code.
 */
export async function issueEnrolmentCode(actor, { username, userId }) {
  requireVaultCap(actor, "manage_vault");
  const user = username ? await store.findUserByUsername(username) : await store.getUserAccount(Number.parseInt(userId, 10));
  if (!user) throw new VaultError("invalid", "That user does not exist.");
  if (user.userId === actor.userId) throw new VaultError("forbidden", "Ask another vault administrator to issue your enrolment code.");
  const row = await store.getVaultPasswordRow(user.userId);
  if (row?.verifier) throw new VaultError("conflict", "They already have a vault password. Reset it first if they have lost it.");
  const code = generateEnrolmentCode();
  const expiresAt = new Date(deps.now().getTime() + ENROLMENT_CODE_TTL_HOURS * 3600000);
  await store.setEnrolmentCode(user.userId, hashEnrolmentCode(user.userId, code), expiresAt, actor.userId);
  await audit(actor, { eventType: AUDIT_EVENTS.VAULT_ENROLMENT_CODE_ISSUED, subjectUserId: user.userId, metadata: { expires: expiresAt.toISOString() } });
  await notify(null, {
    recipients: [user.userId],
    title: "Vault enrolment code issued",
    message: `${actor.username} issued you a credential vault enrolment code. Get it from them directly, then set your vault password.`,
    url: "/dashboard/credentials/security",
  });
  return { code, username: user.username, expiresAt };
}

/** A different vault administrator clears someone's vault password. */
export async function resetVaultPasswordFor(actor, subjectUserId) {
  requireVaultCap(actor, "manage_vault");
  const subject = Number.parseInt(subjectUserId, 10);
  if (subject === actor.userId) throw new VaultError("forbidden", "Ask another vault administrator to reset your vault password.");
  await store.clearVaultPasswordVerifier(subject);
  await store.clearLockout(subject);
  await store.revokePendingChallenges({ userId: subject });
  await audit(actor, { eventType: AUDIT_EVENTS.VAULT_PASSWORD_RESET, subjectUserId: subject });
  await notify(null, {
    recipients: [subject],
    title: "Your vault password was reset",
    message: `${actor.username} reset your credential vault password. Set a new one from the Security tab.`,
    url: "/dashboard/credentials/security",
  });
}

export async function clearLockoutFor(actor, subjectUserId) {
  requireVaultCap(actor, "manage_vault");
  const subject = Number.parseInt(subjectUserId, 10);
  if (subject === actor.userId) throw new VaultError("forbidden", "Ask another vault administrator to clear your lockout.");
  await store.clearLockout(subject);
  await audit(actor, { eventType: AUDIT_EVENTS.SETTINGS_UPDATED, subjectUserId: subject, metadata: { action: "clear_lockout" } });
}

// ---------------------------------------------------------------------------
// One-time challenges
// ---------------------------------------------------------------------------

/**
 * Step 1: ask to perform one protected action. Issues a single-use token bound
 * to this user, session, credential, action, field and version.
 */
export async function startChallenge(actor, { credentialId, action, field, versionId = null }) {
  requireProvider();
  const settings = await getSettings();
  const now = deps.now();
  const reqInfo = actor.reqInfo || {};
  const sessionHash = hashSessionId(reqInfo.sessionId);
  if (!sessionHash) throw new VaultError("forbidden", "Your session could not be verified. Sign in again.");

  if (!CHALLENGE_ACTION_KEYS.includes(action)) throw new VaultError("invalid", "Unknown action.");
  const cred = await store.getCredential(Number.parseInt(credentialId, 10));
  if (!cred) throw notFound();
  const caps = capsFor(actor, credentialTarget(cred));
  const needed = requiredCapabilitiesFor(action);
  if (!needed.every((c) => caps.has(c))) {
    await audit(actor, {
      eventType: AUDIT_EVENTS.CHALLENGE_REJECTED,
      outcome: "denied",
      credentialId: cred.credentialId,
      collectionId: cred.collectionId,
      metadata: { action, reason: "permission" },
    });
    throw caps.has("view") ? new VaultError("forbidden", "You do not have permission to do that with this credential.") : notFound();
  }

  let version = null;
  if (isVersionAction(action)) {
    version = Number.parseInt(versionId, 10);
    if (!(version > 0)) throw new VaultError("invalid", "Choose a version.");
  }
  const material = await store.getSecretMaterial(cred.credentialId, version);
  if (!material) throw notFound();
  if (action !== "restore_version") {
    if (!isSecretFieldName(cred.type, field) || !material.fieldNames.includes(field)) {
      throw new VaultError("invalid", "That field has no stored value.");
    }
  }

  const factor = await resolveFactor(actor.userId, settings);
  if (!factor.method) {
    throw new VaultError("enrolment_required", "Set a vault password before accessing secrets.");
  }
  const locked = lockedUntil(factor.row, now);
  if (locked) {
    throw new VaultError("locked", "Vault verification is temporarily locked after repeated failures. Try again later.", { lockedUntil: locked });
  }
  const recent = await store.countRecentChallenges(actor.userId, new Date(now.getTime() - 60000));
  if (recent >= 30) throw new VaultError("rate_limited", "Too many verification requests. Wait a minute and try again.");

  const token = generateChallengeToken();
  const ttl = clampChallengeTtl(settings.challengeTtlSeconds);
  const expiresAt = new Date(now.getTime() + ttl * 1000);
  await store.insertChallenge({
    tokenHash: hashChallengeToken(token),
    userId: actor.userId,
    sessionHash,
    credentialId: cred.credentialId,
    action,
    field: action === "restore_version" ? "*" : field,
    versionId: material.versionId,
    method: factor.method,
    ip: reqInfo.ip,
    createdAt: now,
    expiresAt,
  });
  return {
    challengeToken: token,
    method: factor.method,
    expiresInSeconds: ttl,
    credentialName: cred.name,
    action,
    fieldLabel: fieldLabel(cred.type, field),
  };
}

function fieldLabel(type, field) {
  if (typeof field === "string" && field.startsWith("custom:")) return "Custom field";
  return secretFieldsFor(type).find((f) => f.key === field)?.label || "Secret";
}

async function checkFactor(method, userId, password) {
  if (typeof password !== "string" || password.length === 0 || password.length > 256) {
    await dummyVerifier().then((v) => verifyVaultPassword(v, "x"));
    return false;
  }
  if (method === "account_password") {
    const hash = await store.getUserPasswordHashForVerification(userId);
    if (!hash) return false;
    try {
      return await bcrypt.compare(password, hash);
    } catch {
      return false;
    }
  }
  if (method === "vault_password") {
    const row = await store.getVaultPasswordRow(userId);
    if (!row?.verifier) {
      await verifyVaultPassword(await dummyVerifier(), password);
      return false;
    }
    return verifyVaultPassword(row.verifier, password);
  }
  return false;
}

/**
 * Step 2: verify identity and perform exactly the action the challenge was
 * issued for. The challenge is consumed before the password is checked, so a
 * token allows one attempt, and two concurrent requests cannot both succeed.
 *
 * Returns { action, value?, field?, revealSeconds, clipboardClearSeconds }.
 */
export async function verifyChallenge(actorUserId, { challengeToken, password }, reqInfo = {}) {
  const settings = await getSettings();
  const now = deps.now();
  const sessionHash = hashSessionId(reqInfo.sessionId);
  const fail = (code, message, extra) => new VaultError(code, message, extra);
  const userId = Number.parseInt(actorUserId, 10);
  const pseudoActor = { userId, reqInfo };

  if (!sessionHash || !isWellFormedToken(challengeToken) || !(userId > 0)) {
    throw fail("verification_failed", "This verification has expired. Please try again.");
  }
  const tokenHash = hashChallengeToken(challengeToken);
  const challenge = await store.claimChallenge({ tokenHash, userId, sessionHash, now });
  if (!challenge) {
    const peek = await store.peekChallenge(tokenHash);
    await audit(pseudoActor, {
      eventType: AUDIT_EVENTS.CHALLENGE_REJECTED,
      outcome: "denied",
      credentialId: peek?.credentialId ?? null,
      metadata: {
        reason: !peek ? "unknown" : peek.userId !== userId ? "wrong_user" : peek.status !== "pending" ? `already_${peek.status}` : "expired_or_session",
      },
    });
    if (peek && peek.userId !== userId) {
      await audit(pseudoActor, { eventType: AUDIT_EVENTS.SUSPICIOUS_ACTIVITY, outcome: "denied", credentialId: peek.credentialId, metadata: { reason: "challenge_used_by_other_user" } });
    }
    throw fail("verification_failed", "This verification has expired or was already used. Please try again.");
  }

  const credential = await store.getCredential(challenge.credentialId);
  const collectionId = credential?.collectionId ?? null;
  const baseEvent = { credentialId: challenge.credentialId, collectionId };

  // One attempt is reserved atomically before the password is checked, so
  // parallel guesses cannot exceed the limit. A locked user still burns the token.
  const reserved = await store.reserveVerificationAttempt(userId, settings.maxFailedAttempts, now, settings.lockoutMinutes);
  if (!reserved) {
    await store.setChallengeOutcome(challenge.challengeId, "failed");
    await audit(pseudoActor, { ...baseEvent, eventType: AUDIT_EVENTS.REAUTH_FAILED, outcome: "denied", metadata: { action: challenge.action, reason: "locked" } });
    const row = await store.getVaultPasswordRow(userId);
    throw fail("locked", "Vault verification is temporarily locked after repeated failures. Try again later.", { lockedUntil: lockedUntil(row, now) });
  }

  // The factor must still be the one the challenge was issued for.
  const factor = await resolveFactor(userId, settings);
  const passwordOk = factor.method === challenge.method ? await checkFactor(challenge.method, userId, password) : false;
  if (!passwordOk) {
    await store.setChallengeOutcome(challenge.challengeId, "failed");
    const nowLocked = await failedAttempt(pseudoActor, userId, settings, { action: challenge.action, method: challenge.method }, baseEvent);
    if (nowLocked) throw fail("locked", "Too many failed attempts. Vault verification is locked for a while.", { lockedUntil: nowLocked });
    throw fail("verification_failed", "Verification failed. Check your password and try again.");
  }

  // Identity confirmed. Everything else is re-read now.
  await store.resetFailedVerifications(userId);
  const actor = await loadActor(userId, reqInfo).catch(() => null);
  if (!actor) {
    await store.setChallengeOutcome(challenge.challengeId, "failed");
    await audit(pseudoActor, { ...baseEvent, eventType: AUDIT_EVENTS.ACCESS_DENIED, outcome: "denied", metadata: { action: challenge.action, reason: "account" } });
    throw fail("forbidden", "Your account cannot use the credential vault.");
  }
  if (!credential) {
    await store.setChallengeOutcome(challenge.challengeId, "failed");
    throw notFound();
  }
  const caps = capsFor(actor, credentialTarget(credential));
  if (!requiredCapabilitiesFor(challenge.action).every((c) => caps.has(c))) {
    await store.setChallengeOutcome(challenge.challengeId, "failed");
    await audit(actor, { ...baseEvent, eventType: AUDIT_EVENTS.ACCESS_DENIED, outcome: "denied", metadata: { action: challenge.action, reason: "permission_revoked" } });
    throw notFound();
  }
  await audit(actor, { ...baseEvent, eventType: AUDIT_EVENTS.REAUTH_SUCCEEDED, metadata: { action: challenge.action, method: challenge.method } });

  const versionId = isVersionAction(challenge.action) ? challenge.versionId : null;
  const material = await store.getSecretMaterial(credential.credentialId, versionId);
  if (!material) {
    await store.setChallengeOutcome(challenge.challengeId, "failed");
    throw notFound();
  }

  if (challenge.action === "restore_version") {
    const old = await decryptMaterial(credential.credentialId, material);
    try {
      const changed = await writeNewSecretVersion(actor, credential, () => ({ ...old }), { restoredFromVersion: material.version });
      await store.setChallengeOutcome(challenge.challengeId, "succeeded");
      await audit(actor, { ...baseEvent, eventType: AUDIT_EVENTS.SECRET_VERSION_RESTORED, metadata: { version: material.version, fields: changed } });
    } finally {
      for (const k of Object.keys(old)) old[k] = null;
    }
    return { action: "restore_version", restoredVersion: material.version };
  }

  const payload = await decryptMaterial(credential.credentialId, material);
  const value = payload[challenge.field];
  for (const k of Object.keys(payload)) if (k !== challenge.field) payload[k] = null;
  if (typeof value !== "string") {
    await store.setChallengeOutcome(challenge.challengeId, "failed");
    throw new VaultError("invalid", "That field has no stored value.");
  }
  await store.setChallengeOutcome(challenge.challengeId, "succeeded");
  const eventType =
    challenge.action === "copy" ? AUDIT_EVENTS.SECRET_COPIED : challenge.action === "reveal_version" ? AUDIT_EVENTS.SECRET_VERSION_REVEALED : AUDIT_EVENTS.SECRET_REVEALED;
  await audit(actor, { ...baseEvent, eventType, metadata: { field: challenge.field, version: material.version } });
  await notify("notifySecretRevealed", {
    recipients: "admins",
    excludeUserIds: [actor.userId],
    title: challenge.action === "copy" ? "Credential secret copied" : "Credential secret revealed",
    message: `${actor.username} ${challenge.action === "copy" ? "copied" : "revealed"} a secret on "${credential.name}".`,
    url: `/dashboard/credentials/${credential.credentialId}/history`,
  });
  return {
    action: challenge.action,
    field: challenge.field,
    value,
    revealSeconds: settings.revealSeconds,
    clipboardClearSeconds: settings.clipboardClearSeconds,
  };
}

// ---------------------------------------------------------------------------
// Access control management
// ---------------------------------------------------------------------------

async function targetForGrant(grant) {
  if (grant.scope === "vault") return { kind: "vault" };
  if (grant.scope === "collection") {
    const c = await store.getCollection(grant.collectionId);
    if (!c) throw new VaultError("invalid", "That collection does not exist.");
    return { kind: "collection", collectionId: c.collectionId };
  }
  const cred = await store.getCredential(grant.credentialId);
  if (!cred) throw notFound();
  return credentialTarget(cred);
}

export async function grantAccess(actor, input) {
  const validated = validateGrantInput(input);
  if (!validated.ok) throw new VaultError("invalid", validated.error);
  const grant = validated.grant;
  if (grant.principalType === "user") {
    const user = input.username ? await store.findUserByUsername(input.username) : await store.getUserAccount(grant.userId);
    if (!user) throw new VaultError("invalid", "That user does not exist.");
    grant.userId = user.userId;
  } else {
    const group = await store.getGroup(grant.groupId);
    if (!group) throw new VaultError("invalid", "That group does not exist.");
  }
  const target = await targetForGrant(grant);
  const authority = checkGrantAuthority({
    actorUserId: actor.userId,
    actorGrants: actor.grants,
    actorGroupIds: actor.groupIds,
    target,
    grant,
    now: actor.now.getTime(),
  });
  if (!authority.ok) throw new VaultError("forbidden", authority.error);

  const grantId = await store.insertGrant(grant, actor.userId);
  await audit(actor, {
    eventType: AUDIT_EVENTS.PERMISSION_GRANTED,
    subjectUserId: grant.userId,
    credentialId: grant.credentialId,
    collectionId: grant.collectionId ?? target.collectionId ?? null,
    metadata: {
      grantId,
      scope: grant.scope,
      principal: grant.principalType,
      groupId: grant.groupId,
      effect: grant.effect,
      capabilities: grant.capabilities,
      expires: grant.expiresAt ? grant.expiresAt.toISOString() : null,
    },
  });
  await notify("notifyPermissionChanged", {
    recipients: grant.principalType === "user" ? [grant.userId] : "admins",
    excludeUserIds: [actor.userId],
    title: "Vault permissions changed",
    message: `${actor.username} ${grant.effect === "deny" ? "restricted" : "granted"} ${grant.capabilities.join(", ")} on the credential vault.`,
    url: "/dashboard/credentials",
  });
  return grantId;
}

export async function revokeAccess(actor, grantId) {
  const grant = await store.getGrant(Number.parseInt(grantId, 10));
  if (!grant || grant.revokedAt) throw new VaultError("not_found", "That permission no longer exists.");
  const target = await targetForGrant(grant).catch(() => ({ kind: "vault" }));
  // Revoking an allow only narrows access, so manage_access is enough.
  // Revoking a deny widens it, so it needs the same authority as granting
  // those capabilities (including holding them yourself).
  const authority = checkGrantAuthority({
    actorUserId: actor.userId,
    actorGrants: actor.grants,
    actorGroupIds: actor.groupIds,
    target,
    grant:
      grant.effect === "deny"
        ? { ...grant, effect: "allow", capabilities: capabilitiesRestoredByLiftingDeny(grant.capabilities) }
        : { ...grant, effect: "deny" },
    now: actor.now.getTime(),
  });
  if (!authority.ok) throw new VaultError("forbidden", authority.error);
  await store.revokeGrant(grant.grantId, actor.userId, "revoked");
  if (grant.principalType === "user") await store.revokePendingChallenges({ userId: grant.userId });
  else await store.revokePendingChallenges({});
  await audit(actor, {
    eventType: AUDIT_EVENTS.PERMISSION_REVOKED,
    subjectUserId: grant.userId,
    credentialId: grant.credentialId,
    collectionId: grant.collectionId,
    metadata: { grantId: grant.grantId, scope: grant.scope, principal: grant.principalType, groupId: grant.groupId, capabilities: grant.capabilities },
  });
  if (grant.principalType === "user") {
    await notify("notifyPermissionChanged", {
      recipients: [grant.userId],
      title: "Vault permissions changed",
      message: `${actor.username} removed some of your credential vault access.`,
      url: "/dashboard/credentials",
    });
  }
}

/** Grants on a target with display names, for access-management screens. */
export async function grantsForTarget(actor, target) {
  const caps = target.kind === "vault" ? actor.vaultCaps : capsFor(actor, target);
  if (!caps.has("manage_access") && !actor.vaultCaps.has("manage_vault")) throw new VaultError("forbidden", "You cannot manage access here.");
  const scope = target.kind;
  const grants = await store.listGrants({ scope, collectionId: target.collectionId, credentialId: target.credentialId });
  const names = await store.getUsernames([...grants.map((g) => g.userId), ...grants.map((g) => g.grantedBy)]);
  const groups = new Map((await store.listGroups()).map((g) => [g.groupId, g.name]));
  return grants.map((g) => ({
    ...g,
    principalName: g.principalType === "user" ? names.get(g.userId) || `User ${g.userId}` : groups.get(g.groupId) || `Group ${g.groupId}`,
    grantedByName: names.get(g.grantedBy) || null,
  }));
}

// Groups ---------------------------------------------------------------------

export async function createGroup(actor, { name, description }) {
  requireVaultCap(actor, "manage_vault");
  const n = String(name || "").trim().slice(0, 100);
  if (!n) throw new VaultError("invalid", "Name is required.");
  const groupId = await store.createGroup({ name: n, description: String(description || "").trim().slice(0, 500) }, actor.userId);
  await audit(actor, { eventType: AUDIT_EVENTS.GROUP_CREATED, metadata: { groupId, name: n } });
  return groupId;
}

export async function updateGroup(actor, groupId, { name, description }) {
  requireVaultCap(actor, "manage_vault");
  const group = await store.getGroup(Number.parseInt(groupId, 10));
  if (!group) throw new VaultError("not_found", "That group does not exist.");
  const n = String(name || "").trim().slice(0, 100);
  if (!n) throw new VaultError("invalid", "Name is required.");
  await store.updateGroup(group.groupId, { name: n, description: String(description || "").trim().slice(0, 500) });
  await audit(actor, { eventType: AUDIT_EVENTS.GROUP_UPDATED, metadata: { groupId: group.groupId, name: n } });
}

export async function deleteGroup(actor, groupId) {
  requireVaultCap(actor, "manage_vault");
  const group = await store.getGroup(Number.parseInt(groupId, 10));
  if (!group) throw new VaultError("not_found", "That group does not exist.");
  if (actor.groupIds.includes(group.groupId)) throw new VaultError("forbidden", "You cannot delete a group you belong to.");
  await store.deleteGroup(group.groupId, actor.userId);
  await store.revokePendingChallenges({});
  await audit(actor, { eventType: AUDIT_EVENTS.GROUP_DELETED, metadata: { groupId: group.groupId, name: group.name } });
}

export async function addGroupMember(actor, groupId, { username, expiresAt }) {
  requireVaultCap(actor, "manage_vault");
  const group = await store.getGroup(Number.parseInt(groupId, 10));
  if (!group) throw new VaultError("not_found", "That group does not exist.");
  const user = await store.findUserByUsername(username);
  if (!user) throw new VaultError("invalid", "That user does not exist.");
  if (user.userId === actor.userId) throw new VaultError("forbidden", "You cannot change your own group memberships.");
  let expiry = null;
  if (expiresAt) {
    expiry = new Date(expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry <= deps.now()) throw new VaultError("invalid", "Expiry must be a future date.");
  }
  await store.addGroupMember(group.groupId, user.userId, actor.userId, expiry);
  await audit(actor, {
    eventType: AUDIT_EVENTS.GROUP_MEMBER_ADDED,
    subjectUserId: user.userId,
    metadata: { groupId: group.groupId, group: group.name, expires: expiry ? expiry.toISOString() : null },
  });
  await notify("notifyPermissionChanged", {
    recipients: [user.userId],
    title: "Added to a vault group",
    message: `${actor.username} added you to the "${group.name}" credential vault group.`,
    url: "/dashboard/credentials",
  });
}

export async function removeGroupMember(actor, groupId, userId) {
  requireVaultCap(actor, "manage_vault");
  const subject = Number.parseInt(userId, 10);
  if (subject === actor.userId) throw new VaultError("forbidden", "You cannot change your own group memberships.");
  const group = await store.getGroup(Number.parseInt(groupId, 10));
  if (!group) throw new VaultError("not_found", "That group does not exist.");
  await store.removeGroupMember(group.groupId, subject);
  await store.revokePendingChallenges({ userId: subject });
  await audit(actor, { eventType: AUDIT_EVENTS.GROUP_MEMBER_REMOVED, subjectUserId: subject, metadata: { groupId: group.groupId, group: group.name } });
}

// Collections ----------------------------------------------------------------

export async function createCollection(actor, collection) {
  requireVaultCap(actor, "manage_collections");
  const id = await store.createCollection(collection, actor.userId);
  await audit(actor, { eventType: AUDIT_EVENTS.COLLECTION_CREATED, collectionId: id, metadata: { name: collection.name } });
  return id;
}

export async function updateCollection(actor, collectionId, collection) {
  requireVaultCap(actor, "manage_collections");
  const existing = await store.getCollection(Number.parseInt(collectionId, 10));
  if (!existing) throw new VaultError("not_found", "That collection does not exist.");
  await store.updateCollection(existing.collectionId, collection, actor.userId);
  await audit(actor, { eventType: AUDIT_EVENTS.COLLECTION_UPDATED, collectionId: existing.collectionId, metadata: { name: collection.name, requestable: collection.isRequestable } });
}

export async function deleteCollection(actor, collectionId) {
  requireVaultCap(actor, "manage_collections");
  const existing = await store.getCollection(Number.parseInt(collectionId, 10));
  if (!existing) throw new VaultError("not_found", "That collection does not exist.");
  const result = await store.deleteCollection(existing.collectionId, actor.userId);
  if (!result.ok) throw new VaultError("conflict", result.error);
  await audit(actor, { eventType: AUDIT_EVENTS.COLLECTION_DELETED, collectionId: existing.collectionId, metadata: { name: existing.name } });
}

// ---------------------------------------------------------------------------
// Access requests
// ---------------------------------------------------------------------------

export const REQUEST_DURATIONS_HOURS = Object.freeze([1, 4, 24, 72, 168, 720]);

export async function requestableTargets(actor) {
  const targets = await store.listRequestableTargets();
  // Only offer things the person does not already fully see; requestable
  // items are, by an administrator's choice, visible by name to every vault user.
  return {
    collections: targets.collections,
    credentials: targets.credentials.filter((c) => !capsFor(actor, { kind: "credential", collectionId: c.collectionId, credentialId: c.credentialId }).has("reveal")),
  };
}

export async function submitAccessRequest(actor, input) {
  const scope = input.scope === "collection" ? "collection" : "credential";
  const targetId = Number.parseInt(input.targetId, 10);
  const reason = String(input.reason || "").trim();
  if (reason.length < 10) throw new VaultError("invalid", "Explain why you need access (at least 10 characters).");
  const capabilities = parseCapabilities(input.capabilities).filter((c) => REQUESTABLE_CAPABILITIES.includes(c));
  if (!capabilities.length) throw new VaultError("invalid", "Choose the access you need.");
  const durationHours = input.durationHours ? Number.parseInt(input.durationHours, 10) : null;
  if (durationHours !== null && !REQUEST_DURATIONS_HOURS.includes(durationHours)) throw new VaultError("invalid", "Choose a valid duration.");

  let target;
  let label;
  if (scope === "collection") {
    const c = await store.getCollection(targetId);
    if (!c || !c.isRequestable) throw new VaultError("not_found", "That collection is not open to requests.");
    target = { kind: "collection", collectionId: c.collectionId };
    label = c.name;
  } else {
    const cred = await store.getCredential(targetId);
    const collection = cred ? await store.getCollection(cred.collectionId) : null;
    const listable = cred ? capsFor(actor, credentialTarget(cred)).has("list") : false;
    // Only credentials flagged requestable, or ones the person can already
    // see listed, so ids cannot be enumerated to learn names.
    if (!cred || !(cred.isRequestable || (collection?.isRequestable && listable))) {
      throw new VaultError("not_found", "That credential is not open to requests.");
    }
    target = credentialTarget(cred);
    label = cred.name;
  }

  const existing = await store.listAccessRequests({ requesterId: actor.userId, status: "pending" });
  if (existing.some((r) => r.scope === scope && Number(scope === "collection" ? r.collectionId : r.credentialId) === targetId)) {
    throw new VaultError("conflict", "You already have a pending request for that.");
  }

  const requestId = await store.insertAccessRequest({
    requesterId: actor.userId,
    scope,
    collectionId: target.collectionId,
    credentialId: scope === "credential" ? target.credentialId : null,
    capabilities,
    reason: reason.slice(0, 1000),
    durationHours,
  });
  await audit(actor, {
    eventType: AUDIT_EVENTS.ACCESS_REQUESTED,
    credentialId: scope === "credential" ? target.credentialId : null,
    collectionId: target.collectionId,
    metadata: { requestId, capabilities, durationHours },
  });
  const approvers = (await usersWithCapability(target, "approve_requests")).filter((id) => id !== actor.userId);
  await notify("notifyAccessRequested", {
    recipients: approvers.length ? approvers : "admins",
    excludeUserIds: [actor.userId],
    title: "Credential access requested",
    message: `${actor.username} requested ${capabilities.join(", ")} access to "${label}".`,
    url: "/dashboard/credentials/requests",
  });
  return requestId;
}

function requestTarget(request) {
  return request.scope === "collection"
    ? { kind: "collection", collectionId: request.collectionId }
    : { kind: "credential", collectionId: request.collectionId, credentialId: request.credentialId };
}

/** Requests the actor may decide: pending, not their own, approve_requests on the target. */
export async function approvalQueue(actor) {
  const pending = await store.listAccessRequests({ status: "pending" });
  const out = [];
  for (const r of pending) {
    if (r.requesterId === actor.userId) continue;
    let target = requestTarget(r);
    if (r.scope === "credential") {
      const cred = await store.getCredential(r.credentialId);
      if (!cred) continue;
      target = credentialTarget(cred);
      r.targetName = cred.name;
    } else {
      r.targetName = (await store.getCollection(r.collectionId))?.name || "Deleted collection";
    }
    if (capsFor(actor, target).has("approve_requests")) out.push(r);
  }
  return out;
}

export async function myRequests(actor) {
  const rows = await store.listAccessRequests({ requesterId: actor.userId, limit: 100 });
  for (const r of rows) {
    if (r.scope === "credential") {
      const cred = await store.getCredential(r.credentialId);
      // Names are shown only while still requestable or visible to the person.
      const visible = cred && (cred.isRequestable || capsFor(actor, credentialTarget(cred)).has("list"));
      r.targetName = visible ? cred.name : "Unavailable";
    } else {
      const col = await store.getCollection(r.collectionId);
      r.targetName = col && (col.isRequestable || capsFor(actor, { kind: "collection", collectionId: col.collectionId }).size) ? col.name : "Unavailable";
    }
  }
  return rows;
}

export async function decideAccessRequest(actor, requestId, { approve, note, durationHours }) {
  const request = await store.getAccessRequest(Number.parseInt(requestId, 10));
  if (!request || request.status !== "pending") throw new VaultError("not_found", "That request is no longer pending.");
  if (request.requesterId === actor.userId) throw new VaultError("forbidden", "You cannot decide your own access request.");
  let target = requestTarget(request);
  if (request.scope === "credential") {
    const cred = await store.getCredential(request.credentialId);
    if (!cred) throw new VaultError("not_found", "That credential no longer exists.");
    target = credentialTarget(cred);
  }
  if (!capsFor(actor, target).has("approve_requests")) throw new VaultError("forbidden", "You cannot decide this request.");
  const cleanNote = note ? String(note).trim().slice(0, 1000) : null;

  if (!approve) {
    const ok = await store.decideAccessRequest(request.requestId, { status: "rejected", decidedBy: actor.userId, note: cleanNote });
    if (!ok) throw new VaultError("conflict", "Someone else already decided this request.");
    await audit(actor, {
      eventType: AUDIT_EVENTS.ACCESS_REQUEST_REJECTED,
      subjectUserId: request.requesterId,
      credentialId: request.credentialId,
      collectionId: request.collectionId,
      metadata: { requestId: request.requestId },
    });
    await notify("notifyAccessDecided", {
      recipients: [request.requesterId],
      title: "Access request rejected",
      message: `Your credential access request was rejected${cleanNote ? `: ${cleanNote}` : "."}`,
      url: "/dashboard/credentials/requests",
    });
    return;
  }

  let hours = durationHours !== undefined && durationHours !== "" ? Number.parseInt(durationHours, 10) : request.durationHours;
  if (hours === 0 || Number.isNaN(hours)) hours = null; // 0 = no expiry, chosen explicitly by the approver
  if (hours !== null && !REQUEST_DURATIONS_HOURS.includes(hours)) throw new VaultError("invalid", "Choose a valid duration.");
  // An approver may shorten a request, never lengthen it.
  if (request.durationHours && (hours === null || hours > request.durationHours)) {
    throw new VaultError("invalid", "You can shorten the requested duration but not extend it.");
  }
  // Approvers hand out only what they hold themselves (vault administrators excepted).
  if (!actor.vaultCaps.has("manage_vault")) {
    const approverCaps = capsFor(actor, target);
    const missing = request.capabilities.filter((c) => !approverCaps.has(c));
    if (missing.length) throw new VaultError("forbidden", `You cannot approve capabilities you do not hold: ${missing.join(", ")}.`);
  }
  const expiresAt = hours ? new Date(deps.now().getTime() + hours * 3600000) : null;
  const grant = {
    scope: request.scope,
    collectionId: request.scope === "collection" ? request.collectionId : null,
    credentialId: request.scope === "credential" ? request.credentialId : null,
    principalType: "user",
    userId: request.requesterId,
    effect: "allow",
    capabilities: request.capabilities,
    expiresAt,
    reason: `Access request #${request.requestId}`,
    requestId: request.requestId,
  };
  const authority = checkGrantAuthority({ actorUserId: actor.userId, actorGrants: actor.grants, actorGroupIds: actor.groupIds, target, grant, now: actor.now.getTime() });
  // Approvers need approve_requests, not manage_access; the self/own-group guard still applies.
  if (!authority.ok && /yourself|own vault|belong to/.test(authority.error)) throw new VaultError("forbidden", authority.error);

  const grantId = await store.withTransaction(async (conn) => {
    const id = await store.insertGrant(grant, actor.userId, conn);
    const ok = await store.decideAccessRequest(request.requestId, { status: "approved", decidedBy: actor.userId, note: cleanNote, grantId: id }, conn);
    if (!ok) throw new VaultError("conflict", "Someone else already decided this request.");
    return id;
  });
  await audit(actor, {
    eventType: AUDIT_EVENTS.ACCESS_REQUEST_APPROVED,
    subjectUserId: request.requesterId,
    credentialId: request.credentialId,
    collectionId: request.collectionId,
    metadata: { requestId: request.requestId, grantId, capabilities: request.capabilities, expires: expiresAt ? expiresAt.toISOString() : null },
  });
  await audit(actor, {
    eventType: AUDIT_EVENTS.PERMISSION_GRANTED,
    subjectUserId: request.requesterId,
    credentialId: request.credentialId,
    collectionId: request.collectionId,
    metadata: { grantId, scope: grant.scope, principal: "user", capabilities: grant.capabilities, viaRequest: request.requestId },
  });
  await notify("notifyAccessDecided", {
    recipients: [request.requesterId],
    title: "Access request approved",
    message: `Your credential access request was approved${expiresAt ? ` until ${expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}.`,
    url: "/dashboard/credentials",
  });
}

export async function cancelAccessRequest(actor, requestId) {
  const request = await store.getAccessRequest(Number.parseInt(requestId, 10));
  if (!request || request.requesterId !== actor.userId) throw new VaultError("not_found", "That request does not exist.");
  const ok = await store.decideAccessRequest(request.requestId, { status: "cancelled", decidedBy: actor.userId });
  if (!ok) throw new VaultError("conflict", "That request is no longer pending.");
  await audit(actor, { eventType: AUDIT_EVENTS.ACCESS_REQUEST_CANCELLED, credentialId: request.credentialId, collectionId: request.collectionId, metadata: { requestId: request.requestId } });
}

// ---------------------------------------------------------------------------
// Offboarding and rotation
// ---------------------------------------------------------------------------

/** What offboarding `subjectUserId` would touch. */
export async function offboardingPreview(actor, subjectUserId) {
  requireVaultCap(actor, "manage_vault");
  const subject = await store.getUserAccount(Number.parseInt(subjectUserId, 10));
  if (!subject) throw new VaultError("not_found", "That user does not exist.");
  const now = deps.now();
  const { grants } = await store.loadGrantsForUser(subject.userId, now);
  const memberships = await store.listMembershipsForUser(subject.userId);
  const directGrants = await store.listGrantsForPrincipalUser(subject.userId);
  const skeletons = await store.listCredentialSkeletons();
  const accessed = new Set(await store.listCredentialIdsAccessedBy(subject.userId));
  const reachable = [];
  for (const s of skeletons) {
    const caps = effectiveCapabilities(grants, { kind: "credential", collectionId: s.collectionId, credentialId: s.credentialId }, now.getTime());
    const couldRead = caps.has("reveal") || caps.has("copy");
    if (couldRead || accessed.has(s.credentialId)) {
      reachable.push({ credentialId: s.credentialId, couldRead, didAccess: accessed.has(s.credentialId) });
    }
  }
  const creds = reachable.length ? await store.searchCredentials(reachable.map((r) => r.credentialId), { limit: 1000 }) : [];
  const byId = new Map(creds.map((c) => [c.credentialId, c]));
  return {
    subject,
    memberships,
    directGrants,
    credentials: reachable.map((r) => ({ ...r, name: byId.get(r.credentialId)?.name || `#${r.credentialId}` })),
  };
}

export async function offboardStaff(actor, subjectUserId, { endSessions = true } = {}) {
  requireVaultCap(actor, "manage_vault");
  const subjectId = Number.parseInt(subjectUserId, 10);
  if (subjectId === actor.userId) throw new VaultError("forbidden", "Another vault administrator must offboard you.");
  const preview = await offboardingPreview(actor, subjectId);

  const result = await store.withTransaction(async (conn) => {
    let grantsRevoked = 0;
    for (const g of preview.directGrants) {
      if (await store.revokeGrant(g.grantId, actor.userId, "offboarded", conn)) grantsRevoked += 1;
    }
    let membershipsRemoved = 0;
    for (const m of preview.memberships) {
      if (await store.removeGroupMember(m.groupId, subjectId, conn)) membershipsRemoved += 1;
    }
    const challengesRevoked = await store.revokePendingChallenges({ userId: subjectId }, conn);
    let tasksOpened = 0;
    for (const c of preview.credentials) {
      const { created } = await store.openRotationTask(
        {
          credentialId: c.credentialId,
          reason: "offboarding",
          details: `${preview.subject.username} ${c.didAccess ? "revealed or copied" : "could reveal or copy"} this credential.`,
          relatedUserId: subjectId,
          createdBy: actor.userId,
        },
        conn
      );
      if (created) tasksOpened += 1;
    }
    return { grantsRevoked, membershipsRemoved, challengesRevoked, tasksOpened };
  });
  await store.clearVaultPasswordVerifier(subjectId);

  let sessionsEnded = 0;
  if (endSessions) {
    try {
      const destroy = deps.destroySessionsForUser || (await import("../lib/fastifyPrismaSessionStore.js")).destroySessionsForUser;
      sessionsEnded = Number(await destroy(subjectId)) || 0;
    } catch (error) {
      console.error("[credential-vault] ending sessions during offboarding failed:", error?.message);
    }
  }

  await audit(actor, {
    eventType: AUDIT_EVENTS.STAFF_OFFBOARDED,
    subjectUserId: subjectId,
    metadata: { ...result, sessionsEnded, credentialsFlagged: preview.credentials.length },
  });
  for (const c of preview.credentials) {
    await audit(actor, {
      eventType: AUDIT_EVENTS.ROTATION_TASK_OPENED,
      subjectUserId: subjectId,
      credentialId: c.credentialId,
      metadata: { reason: "offboarding" },
    });
  }
  await notify("notifyRotationDue", {
    recipients: "admins",
    title: "Staff offboarded from the vault",
    message: `${actor.username} offboarded ${preview.subject.username}. ${preview.credentials.length} credential(s) should be rotated at their services.`,
    url: "/dashboard/credentials/admin/rotation",
  });
  return { ...result, sessionsEnded, credentials: preview.credentials };
}

export async function rotationTasks(actor) {
  if (actor.vaultCaps.has("manage_vault")) return store.listRotationTasks({ status: "open" });
  const visible = await visibleCredentials(actor);
  const editable = [...visible.entries()].filter(([, caps]) => caps.has("edit")).map(([id]) => id);
  return store.listRotationTasks({ status: "open", credentialIds: editable });
}

export async function closeRotationTask(actor, taskId, status) {
  const task = await store.getRotationTask(Number.parseInt(taskId, 10));
  if (!task || task.status !== "open") throw new VaultError("not_found", "That task is no longer open.");
  const cred = await store.getCredential(task.credentialId);
  const caps = cred ? capsFor(actor, credentialTarget(cred)) : new Set();
  if (!caps.has("edit") && !actor.vaultCaps.has("manage_vault")) throw new VaultError("forbidden", "You cannot close this task.");
  const final = status === "dismissed" ? "dismissed" : "done";
  await store.closeRotationTask(task.taskId, final, actor.userId);
  await audit(actor, { eventType: AUDIT_EVENTS.ROTATION_TASK_CLOSED, credentialId: task.credentialId, metadata: { taskId: task.taskId, status: final } });
}

// ---------------------------------------------------------------------------
// Health, audit, overview, settings
// ---------------------------------------------------------------------------

export async function credentialHealth(actor) {
  if (!actor.vaultCaps.has("manage_vault") && !actor.vaultCaps.has("view_audit")) {
    throw new VaultError("forbidden", "Credential health is available to vault administrators and auditors.");
  }
  const settings = await getSettings();
  const now = deps.now().getTime();
  const soon = now + settings.rotationReminderDays * 86400000;
  const reviewCutoff = now - settings.reviewIntervalDays * 86400000;
  const rows = await store.listHealthRows();
  const all = await store.loadAllActiveGrantsAndMemberships(deps.now());
  const byUser = grantsByUser(all);
  const activeVaultUsers = new Set(byUser.keys());

  const reach = new Map();
  for (const r of rows) {
    const target = { kind: "credential", collectionId: r.collectionId, credentialId: r.credentialId };
    let n = 0;
    for (const grants of byUser.values()) {
      const caps = effectiveCapabilities(grants, target, now);
      if (caps.has("reveal") || caps.has("copy")) n += 1;
    }
    reach.set(r.credentialId, n);
  }
  const fpCounts = new Map();
  for (const r of rows) if (r.passwordFingerprint) fpCounts.set(r.passwordFingerprint, (fpCounts.get(r.passwordFingerprint) || 0) + 1);
  const dupKey = (r) => (r.url && r.username ? `${(() => { try { return new URL(r.url).host.toLowerCase(); } catch { return r.url.toLowerCase(); } })()}|${r.username.toLowerCase()}` : null);
  const dupCounts = new Map();
  for (const r of rows) {
    const k = dupKey(r);
    if (k) dupCounts.set(k, (dupCounts.get(k) || 0) + 1);
  }

  const t = (d) => (d ? new Date(d).getTime() : null);
  const sections = {
    rotation: rows.filter((r) => r.openTasks > 0 || (t(r.nextRotationAt) !== null && t(r.nextRotationAt) <= soon)),
    expired: rows.filter((r) => t(r.expiresAt) !== null && t(r.expiresAt) <= now),
    expiring: rows.filter((r) => t(r.expiresAt) !== null && t(r.expiresAt) > now && t(r.expiresAt) <= soon),
    duplicates: rows.filter((r) => dupKey(r) && dupCounts.get(dupKey(r)) > 1),
    weak: rows.filter((r) => r.passwordStrength !== null && r.passwordStrength !== undefined && r.passwordStrength <= 1),
    reused: rows.filter((r) => r.passwordFingerprint && fpCounts.get(r.passwordFingerprint) > 1),
    broad: rows.filter((r) => reach.get(r.credentialId) > settings.broadAccessThreshold),
    noOwner: rows.filter((r) => !r.ownerUserId),
    inactiveOwner: rows.filter((r) => r.ownerUserId && (r.ownerDisabled || !activeVaultUsers.has(r.ownerUserId))),
    unreviewed: rows.filter((r) => (t(r.lastReviewedAt) ?? t(r.createdAt)) < reviewCutoff),
  };
  // Never send fingerprints to the view.
  const strip = (list) =>
    list.map(({ passwordFingerprint: _fp, ...rest }) => ({ ...rest, reach: reach.get(rest.credentialId) || 0 }));
  return Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, strip(v)]));
}

export async function auditLog(actor, filters) {
  if (actor.vaultCaps.has("view_audit") || actor.vaultCaps.has("manage_vault")) {
    return store.queryAuditEvents(filters);
  }
  // Collection/credential-scoped auditors only see events about those credentials.
  const visible = await visibleCredentials(actor);
  const skeletons = await store.listCredentialSkeletons({ includeDeleted: true });
  const allowed = skeletons
    .filter((s) => capsFor(actor, { kind: "credential", collectionId: s.collectionId, credentialId: s.credentialId }).has("view_audit"))
    .map((s) => s.credentialId);
  if (!allowed.length && !visible.size) throw new VaultError("forbidden", "You cannot view audit logs.");
  if (!allowed.length) throw new VaultError("forbidden", "You cannot view audit logs.");
  return store.queryAuditEvents({ ...filters, credentialIds: allowed });
}

export async function verifyAuditChain(actor) {
  if (!actor.vaultCaps.has("view_audit") && !actor.vaultCaps.has("manage_vault")) throw new VaultError("forbidden", "You cannot verify the audit log.");
  // Snapshot the head first and verify up to it, so events appended while the
  // scan runs are not mistaken for tampering.
  const head = await store.getAuditHead();
  const headId = head && head.lastEventId !== null && head.lastEventId !== undefined ? Number(head.lastEventId) : null;
  let after = Number(head?.anchorEventId || 0);
  let checked = 0;
  // The first retained event must follow the retention anchor (or genesis).
  let lastHash = head?.anchorHash || GENESIS_HASH;
  let lastId = null;
  if (headId !== null) {
    for (;;) {
      const rows = await store.listAuditChain({ afterEventId: after, upToEventId: headId, limit: 5000 });
      if (!rows.length) break;
      if (rows[0].prevHash !== lastHash) return { ok: false, checked, brokenAtEventId: rows[0].eventId };
      const result = verifyChain(rows);
      if (!result.ok) return { ok: false, checked: checked + result.checked, brokenAtEventId: result.brokenAtEventId };
      checked += result.checked;
      lastHash = rows[rows.length - 1].hash;
      lastId = rows[rows.length - 1].eventId;
      after = lastId;
    }
    // The newest event must be the one the head recorded: catches deleted tail rows.
    if (Number(lastId) !== headId || head.lastHash !== lastHash) {
      return { ok: false, checked, brokenAtEventId: headId, reason: "newest events missing" };
    }
  }
  return { ok: true, checked, brokenAtEventId: null };
}

export async function adminOverview(actor) {
  requireVaultCap(actor, "manage_vault");
  const settings = await getSettings();
  const now = deps.now();
  const [counts, users, recent, locked, failures] = await Promise.all([
    store.getOverviewCounts(now, settings.rotationReminderDays),
    store.listUsersWithVaultAccess(now),
    store.queryAuditEvents({ limit: 15 }),
    store.listLockedUsers(now),
    store.countAuditEventsSince([AUDIT_EVENTS.REAUTH_FAILED, AUDIT_EVENTS.SUSPICIOUS_ACTIVITY, AUDIT_EVENTS.CHALLENGE_REJECTED], new Date(now.getTime() - 7 * 86400000)),
  ]);
  return { counts: { ...counts, staffWithAccess: users.length, failedVerifications7d: failures }, recent: recent.rows, locked, settings };
}

export async function vaultUsers(actor) {
  requireVaultCap(actor, "manage_vault");
  const ids = await store.listUsersWithVaultAccess(deps.now());
  return store.listVaultPasswordStatus(ids);
}

export async function updateSettings(actor, rows) {
  requireVaultCap(actor, "manage_vault");
  await store.saveSettings(rows, actor.userId);
  invalidateSettingsCache();
  await audit(actor, { eventType: AUDIT_EVENTS.SETTINGS_UPDATED, metadata: { keys: Object.keys(rows) } });
}

export async function listGroupsWithMembers(actor) {
  requireVaultCap(actor, "manage_vault");
  const groups = await store.listGroups();
  for (const g of groups) g.members = await store.listGroupMembers(g.groupId);
  return groups;
}

// ---------------------------------------------------------------------------
// KEK rotation (admin script: admin/credential-vault-rewrap.mjs)
// ---------------------------------------------------------------------------

/**
 * Re-wrap every data key (and the fingerprint key) under the active KEK.
 * Ciphertexts are untouched: only the small wrapped keys change. Safe to
 * re-run; each row is updated only if it still has the old KEK id.
 */
export async function rewrapAllKeys() {
  const p = requireProvider();
  const active = p.activeKekId;
  let rewrapped = 0;
  for (;;) {
    const rows = await store.listKeysNotWrappedWith(active, 200);
    if (!rows.length) break;
    let progress = 0;
    for (const row of rows) {
      const key = await p.unwrap(row.kekId, row.wrappedKey, (kid) => dekAad({ credentialId: row.credentialId, kekId: kid }));
      try {
        const { kekId, wrapped } = await p.wrap(key, (kid) => dekAad({ credentialId: row.credentialId, kekId: kid }));
        if (await store.rewrapKey(row.keyId, row.kekId, kekId, wrapped)) {
          rewrapped += 1;
          progress += 1;
        }
      } finally {
        key.fill(0);
      }
    }
    if (progress === 0) break;
  }
  const vault = await store.getVault(DEFAULT_VAULT_ID);
  let fingerprintRewrapped = false;
  if (vault?.wrappedFingerprintKey && vault.fingerprintKekId !== active) {
    const aad = (kid) => fingerprintKeyAad({ vaultId: DEFAULT_VAULT_ID, kekId: kid });
    const key = await p.unwrap(vault.fingerprintKekId, vault.wrappedFingerprintKey, aad);
    try {
      const { kekId, wrapped } = await p.wrap(key, aad);
      await store.updateVaultFingerprintKey(DEFAULT_VAULT_ID, kekId, wrapped);
      fingerprintRewrapped = true;
    } finally {
      key.fill(0);
    }
  }
  fingerprintKeyCache = null;
  return { rewrapped, fingerprintRewrapped, activeKekId: active };
}

// ---------------------------------------------------------------------------
// Scheduled maintenance (cron/credentialVaultCron.js)
// ---------------------------------------------------------------------------

/**
 * Expired grants are already ignored at evaluation time; this marks them,
 * audits the expiry and tells the person. Also closes stale requests, purges
 * old challenges, opens rotation tasks that have come due, and trims the
 * audit log to the retention window.
 */
export async function runMaintenance({ purgeAudit = false } = {}) {
  const settings = await getSettings({ fresh: true });
  const now = deps.now();
  const summary = { grantsExpired: 0, requestsExpired: 0, challengesPurged: 0, rotationTasksOpened: 0, auditPurged: 0 };

  for (const grant of await store.listNewlyExpiredGrants(now)) {
    if (!(await store.revokeGrant(grant.grantId, null, "expired"))) continue;
    summary.grantsExpired += 1;
    if (grant.principalType === "user") await store.revokePendingChallenges({ userId: grant.userId });
    await audit(null, {
      eventType: AUDIT_EVENTS.PERMISSION_EXPIRED,
      subjectUserId: grant.userId,
      credentialId: grant.credentialId,
      collectionId: grant.collectionId,
      metadata: { grantId: grant.grantId, scope: grant.scope, capabilities: grant.capabilities },
    });
    if (grant.principalType === "user") {
      await notify("notifyPermissionChanged", {
        recipients: [grant.userId],
        title: "Temporary vault access ended",
        message: "A temporary credential vault permission of yours has expired.",
        url: "/dashboard/credentials",
      });
    }
  }

  const stale = await store.expireOldRequests(new Date(now.getTime() - settings.requestExpiryDays * 86400000));
  summary.requestsExpired = stale.length;

  summary.challengesPurged = await store.purgeOldChallenges(new Date(now.getTime() - 86400000));

  const due = await store.listCredentialsDueForRotation(new Date(now.getTime() + settings.rotationReminderDays * 86400000));
  const opened = [];
  for (const c of due) {
    const isExpiry = c.expiresAt && (!c.nextRotationAt || new Date(c.expiresAt) <= new Date(c.nextRotationAt));
    const when = isExpiry ? c.expiresAt : c.nextRotationAt;
    const { created } = await store.openRotationTask({
      credentialId: c.credentialId,
      reason: isExpiry ? "expiry" : "schedule",
      details: `${isExpiry ? "Expires" : "Rotation due"} ${new Date(when).toISOString().slice(0, 10)}`,
    });
    if (created) {
      opened.push(c);
      await audit(null, { eventType: AUDIT_EVENTS.ROTATION_TASK_OPENED, credentialId: c.credentialId, metadata: { reason: isExpiry ? "expiry" : "schedule" } });
    }
  }
  summary.rotationTasksOpened = opened.length;
  if (opened.length) {
    await notify("notifyRotationDue", {
      recipients: "admins",
      title: "Credentials need rotation",
      message: `${opened.length} credential(s) are due for rotation or expiring soon: ${opened.slice(0, 5).map((c) => c.name).join(", ")}${opened.length > 5 ? "…" : ""}`,
      url: "/dashboard/credentials/admin/rotation",
    });
  }

  if (purgeAudit) {
    const cutoff = new Date(now.getTime() - settings.auditRetentionDays * 86400000);
    let removed;
    do {
      removed = await store.purgeAuditBefore(cutoff);
      summary.auditPurged += removed;
    } while (removed === 5000);
  }
  return summary;
}

/** First vault administrator. Used by admin/credential-vault-bootstrap.mjs only. */
export async function bootstrapAdministrator(username) {
  const user = await store.findUserByUsername(username);
  if (!user) throw new VaultError("invalid", `No user called ${username}.`);
  const grantId = await store.insertGrant(
    { scope: "vault", principalType: "user", userId: user.userId, effect: "allow", capabilities: ["manage_vault", "manage_collections", "view_audit", "approve_requests", "create"], reason: "Bootstrap (server console)" },
    null
  );
  await store.appendAuditEvent({
    eventType: AUDIT_EVENTS.PERMISSION_GRANTED,
    outcome: "success",
    subjectUserId: user.userId,
    metadata: { grantId, scope: "vault", via: "bootstrap script", capabilities: ["manage_vault", "manage_collections", "view_audit", "approve_requests", "create"] },
  });
  return { userId: user.userId, grantId };
}

export { CAPABILITIES };
