/**
 * routes/dashboard/credentials.js
 *
 * Credential Vault: dashboard pages and the two session-authenticated JSON
 * endpoints behind the reauthentication modal.
 *
 *   POST /dashboard/credentials/api/challenges         issue a one-time challenge
 *   POST /dashboard/credentials/api/challenges/verify  verify identity, perform that one action
 *
 * No page ever renders a secret. The only response that carries a secret
 * value is a successful challenge verification, sent with no-store headers.
 *
 * Gates on every request:
 *   features.credentialVault  module switch
 *   zander.web.credentials    LuckPerms entry node (shows the module; grants nothing)
 *   vault grants              loaded fresh from the database by the service
 *
 * The cross-site write guard in app.js applies to every POST here.
 */

import {
  getGlobalImage,
  hasPermission,
  hasSpecificPermission,
  isFeatureWebRouteEnabled,
  setBannerCookie,
} from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import { checkRateLimit } from "../../lib/rateLimiter.mjs";
import * as svc from "../../services/credentialVaultService.js";
import * as store from "../../controllers/credentialVaultController.js";
import {
  AUDIT_EVENT_VALUES,
  CAPABILITIES,
  CAPABILITY_LABELS,
  CREDENTIAL_TYPES,
  CREDENTIAL_TYPE_KEYS,
  ENTRY_PERMISSION_NODE,
  REQUESTABLE_CAPABILITIES,
  capabilitiesForScope,
  secretFieldsFor,
  metadataFieldsFor,
} from "../../lib/credentialVault/constants.mjs";
import { parseCredentialForm, validateCollectionForm, displayHost } from "../../lib/credentialVault/input.mjs";
import { SETTING_DEFINITIONS, normaliseSettingsForm } from "../../lib/credentialVault/settings.mjs";

const BASE = "/dashboard/credentials";

/** Headers for every vault response, page or JSON. */
function noStore(res) {
  res.header("cache-control", "no-store, no-cache, must-revalidate, private, max-age=0");
  res.header("pragma", "no-cache");
  res.header("expires", "0");
  res.header("x-robots-tag", "noindex, nofollow");
  res.header("referrer-policy", "no-referrer");
}

function reqInfo(req) {
  return {
    ip: req.ip,
    userAgent: req.headers["user-agent"] || null,
    sessionId: req.session?.sessionId || null,
  };
}

function intParam(value) {
  const n = Number.parseInt(value, 10);
  return n > 0 ? n : null;
}

function safeReturnPath(value, fallback) {
  const v = typeof value === "string" ? value : "";
  return v.startsWith(`${BASE}`) && !v.includes("//") && !v.includes("\\") ? v : fallback;
}

function asArray(value) {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

/** HTTP status for a service error. */
function statusFor(error) {
  switch (error?.code) {
    case "not_found":
      return 404;
    case "forbidden":
      return 403;
    case "invalid":
    case "enrolment_required":
      return 400;
    case "verification_failed":
      return 401;
    case "locked":
    case "rate_limited":
      return 429;
    case "not_configured":
      return 503;
    case "conflict":
      return 409;
    default:
      return 500;
  }
}

export default function dashboardCredentialVaultRoute(app, config, features, lang) {
  // ---------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------

  async function render(req, res, view, data = {}) {
    const [globalImage, announcementWeb] = await Promise.all([getGlobalImage(), getWebAnnouncement()]);
    noStore(res);
    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view(`dashboard/credentials/${view}`, {
        config,
        req,
        features,
        globalImage,
        announcementWeb,
        BASE,
        CREDENTIAL_TYPES,
        CAPABILITY_LABELS,
        displayHost,
        notices: [],
        ...data,
      })
    );
  }

  /**
   * Page gate. Returns the actor or null (a response has been sent).
   * Order matters: module switch, then login + entry node, then the vault's
   * own configuration, then the fresh actor context.
   */
  async function pageGuard(req, res) {
    noStore(res);
    if (!(await isFeatureWebRouteEnabled(app, features.credentialVault, req, res, features))) return null;
    if (!(await hasPermission(ENTRY_PERMISSION_NODE, req, res, features))) return null;
    const status = svc.vaultConfigurationStatus();
    if (!status.configured) {
      await render(req, res, "unavailable", { pageTitle: "Credential Vault", reason: status.error });
      return null;
    }
    try {
      const actor = await svc.loadActor(req.session.user.userId, reqInfo(req));
      actor.nav = svc.navCapabilities(actor);
      return actor;
    } catch (error) {
      await renderError(req, res, error);
      return null;
    }
  }

  /** JSON gate: same checks, JSON answers. */
  async function apiGuard(req, res) {
    noStore(res);
    if (!features.credentialVault) {
      res.status(404).send({ success: false, message: "Not found." });
      return null;
    }
    const permissions = req.session?.user?.permissions;
    if (!req.session?.user?.userId || !hasSpecificPermission(permissions, ENTRY_PERMISSION_NODE)) {
      res.status(403).send({ success: false, message: "Sign in to use the credential vault." });
      return null;
    }
    if (!svc.vaultConfigurationStatus().configured) {
      res.status(503).send({ success: false, code: "not_configured", message: "The credential vault is not configured." });
      return null;
    }
    return true;
  }

  async function renderError(req, res, error) {
    const known = error instanceof svc.VaultError;
    if (!known) console.error("[credential-vault] unexpected error:", error?.message);
    res.status(known ? statusFor(error) : 500);
    return render(req, res, "error", {
      pageTitle: "Credential Vault",
      message: known ? error.message : "Something went wrong. Nothing was changed.",
    });
  }

  /** Redirect after a POST, carrying the outcome in the banner cookie. */
  function back(res, path, type, message) {
    if (message) setBannerCookie(type, message, res);
    return res.redirect(path);
  }

  function errorMessage(error) {
    if (error instanceof svc.VaultError) return error.message;
    console.error("[credential-vault] unexpected error:", error?.message);
    return "Something went wrong. Nothing was changed.";
  }

  async function sidebarData(actor) {
    const collections = await svc.collectionsForActor(actor);
    return { collections };
  }

  // ---------------------------------------------------------------------
  // Credential list
  // ---------------------------------------------------------------------

  app.get(BASE, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const filters = {
        q: String(req.query.q || "").slice(0, 100),
        type: CREDENTIAL_TYPE_KEYS.includes(req.query.type) ? req.query.type : null,
        collectionId: intParam(req.query.collection),
        filter: ["expiring", "rotation", "recent"].includes(req.query.filter) ? req.query.filter : null,
        favourites: req.query.favourites === "1",
        sort: ["name", "updated", "type"].includes(req.query.sort) ? req.query.sort : "name",
      };
      const [credentials, side, creatable, security] = await Promise.all([
        svc.listCredentialsForActor(actor, filters),
        sidebarData(actor),
        svc.creatableCollections(actor),
        svc.securityStatus(actor),
      ]);
      return render(req, res, "index", {
        pageTitle: "Credential Vault",
        actor,
        credentials,
        filters,
        canCreate: creatable.length > 0,
        security,
        activeTab: filters.favourites ? "favourites" : "all",
        ...side,
      });
    } catch (error) {
      return renderError(req, res, error);
    }
  });

  // ---------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------

  app.get(`${BASE}/new`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const collections = await svc.creatableCollections(actor);
      if (!collections.length) throw new svc.VaultError("forbidden", "You cannot create credentials in any collection.");
      const type = CREDENTIAL_TYPE_KEYS.includes(req.query.type) ? req.query.type : null;
      return render(req, res, type ? "form" : "new-type", {
        pageTitle: type ? `New ${CREDENTIAL_TYPES[type].label}` : "New credential",
        actor,
        mode: "create",
        type,
        collections,
        selectedCollectionId: intParam(req.query.collection),
        credential: null,
        secretFields: type ? secretFieldsFor(type) : [],
        metadataFields: type ? metadataFieldsFor(type) : [],
        storedFieldNames: [],
        errors: [],
        values: {},
        activeTab: "all",
      });
    } catch (error) {
      return renderError(req, res, error);
    }
  });

  app.post(BASE, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    const parsed = parseCredentialForm(req.body || {});
    if (!parsed.ok) {
      const collections = await svc.creatableCollections(actor);
      const type = CREDENTIAL_TYPE_KEYS.includes(req.body?.type) ? req.body.type : "login";
      res.status(400);
      return render(req, res, "form", {
        pageTitle: `New ${CREDENTIAL_TYPES[type].label}`,
        actor,
        mode: "create",
        type,
        collections,
        selectedCollectionId: intParam(req.body?.collectionId),
        credential: null,
        secretFields: secretFieldsFor(type),
        metadataFields: metadataFieldsFor(type),
        storedFieldNames: [],
        errors: parsed.errors,
        // Re-fill only non-secret inputs. Secret inputs are never echoed back.
        values: { ...parsed.meta, tags: (parsed.meta?.tags || []).join(", ") },
        activeTab: "all",
      });
    }
    try {
      const id = await svc.createCredential(actor, parsed);
      return back(res, `${BASE}/${id}`, "success", "Credential saved. Its secrets are encrypted and hidden.");
    } catch (error) {
      return back(res, `${BASE}/new?type=${encodeURIComponent(parsed.meta.type)}`, "danger", errorMessage(error));
    }
  });

  // ---------------------------------------------------------------------
  // Fixed sub-pages (registered before /:id so they are not captured by it)
  // ---------------------------------------------------------------------

  // Security: vault password ------------------------------------------------

  app.get(`${BASE}/security`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const security = await svc.securityStatus(actor);
      return render(req, res, "security", { pageTitle: "Vault security", actor, security, activeTab: "security" });
    } catch (error) {
      return renderError(req, res, error);
    }
  });

  app.post(`${BASE}/security/enrol`, async (req, res) => {
    if (!checkRateLimit(req, res, { windowMs: 15 * 60 * 1000, max: 10 })) return;
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      await svc.enrolVaultPassword(actor, {
        password: String(req.body?.password ?? ""),
        confirm: String(req.body?.confirm ?? ""),
        accountPassword: typeof req.body?.accountPassword === "string" ? req.body.accountPassword : "",
        enrolmentCode: typeof req.body?.enrolmentCode === "string" ? req.body.enrolmentCode : "",
      });
      return back(res, `${BASE}/security`, "success", "Your vault password is set. You will use it every time you access a secret.");
    } catch (error) {
      return back(res, `${BASE}/security`, "danger", errorMessage(error));
    }
  });

  app.post(`${BASE}/security/change`, async (req, res) => {
    if (!checkRateLimit(req, res, { windowMs: 15 * 60 * 1000, max: 10 })) return;
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      await svc.changeVaultPassword(actor, {
        currentPassword: String(req.body?.currentPassword ?? ""),
        password: String(req.body?.password ?? ""),
        confirm: String(req.body?.confirm ?? ""),
      });
      return back(res, `${BASE}/security`, "success", "Your vault password was changed.");
    } catch (error) {
      return back(res, `${BASE}/security`, "danger", errorMessage(error));
    }
  });

  // Collections -------------------------------------------------------------

  app.get(`${BASE}/collections`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const collections = await svc.collectionsForActor(actor);
      return render(req, res, "collections", { pageTitle: "Collections", actor, collections, activeTab: "collections" });
    } catch (error) {
      return renderError(req, res, error);
    }
  });

  app.post(`${BASE}/collections`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    const v = validateCollectionForm(req.body);
    if (!v.ok) return back(res, `${BASE}/collections`, "danger", v.errors.join(" "));
    try {
      const id = await svc.createCollection(actor, v.collection);
      return back(res, `${BASE}/collections/${id}`, "success", "Collection created. Assign access below.");
    } catch (error) {
      return back(res, `${BASE}/collections`, "danger", errorMessage(error));
    }
  });

  app.get(`${BASE}/collections/:id`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const collection = await store.getCollection(intParam(req.params.id));
      if (!collection) throw new svc.VaultError("not_found", "That collection does not exist.");
      const target = { kind: "collection", collectionId: collection.collectionId };
      const caps = svc.capsFor(actor, target);
      const canManage = caps.has("manage_access") || actor.vaultCaps.has("manage_vault");
      if (!canManage && !actor.vaultCaps.has("manage_collections") && caps.size === 0) {
        throw new svc.VaultError("not_found", "That collection does not exist.");
      }
      const [grants, groups] = await Promise.all([
        canManage ? svc.grantsForTarget(actor, target) : [],
        canManage ? store.listGroups() : [],
      ]);
      return render(req, res, "collection", {
        pageTitle: collection.name,
        actor,
        collection,
        caps,
        canManage,
        grants,
        groups,
        scopeCapabilities: capabilitiesForScope("collection"),
        activeTab: "collections",
      });
    } catch (error) {
      return renderError(req, res, error);
    }
  });

  app.post(`${BASE}/collections/:id`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    const id = intParam(req.params.id);
    const v = validateCollectionForm(req.body);
    if (!v.ok) return back(res, `${BASE}/collections/${id}`, "danger", v.errors.join(" "));
    try {
      await svc.updateCollection(actor, id, v.collection);
      return back(res, `${BASE}/collections/${id}`, "success", "Collection saved.");
    } catch (error) {
      return back(res, `${BASE}/collections/${id}`, "danger", errorMessage(error));
    }
  });

  app.post(`${BASE}/collections/:id/delete`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      await svc.deleteCollection(actor, intParam(req.params.id));
      return back(res, `${BASE}/collections`, "success", "Collection deleted.");
    } catch (error) {
      return back(res, `${BASE}/collections/${intParam(req.params.id)}`, "danger", errorMessage(error));
    }
  });

  // Grants (shared by collection, credential and vault-wide screens) --------

  app.post(`${BASE}/grants`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    const returnTo = safeReturnPath(req.body?.returnTo, BASE);
    try {
      const expiresAt = req.body?.expiresInHours ? new Date(Date.now() + Number.parseInt(req.body.expiresInHours, 10) * 3600000) : req.body?.expiresAt || null;
      await svc.grantAccess(actor, {
        scope: req.body?.scope,
        collectionId: req.body?.collectionId,
        credentialId: req.body?.credentialId,
        principalType: req.body?.principalType,
        username: req.body?.principalType === "user" ? String(req.body?.username || "").trim() : undefined,
        userId: req.body?.userId,
        groupId: req.body?.groupId,
        effect: req.body?.effect === "deny" ? "deny" : "allow",
        capabilities: asArray(req.body?.capabilities),
        expiresAt,
        reason: req.body?.reason,
      });
      return back(res, returnTo, "success", "Permission saved.");
    } catch (error) {
      return back(res, returnTo, "danger", errorMessage(error));
    }
  });

  app.post(`${BASE}/grants/:grantId/revoke`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    const returnTo = safeReturnPath(req.body?.returnTo, BASE);
    try {
      await svc.revokeAccess(actor, intParam(req.params.grantId));
      return back(res, returnTo, "success", "Permission revoked. Any pending verifications were cancelled.");
    } catch (error) {
      return back(res, returnTo, "danger", errorMessage(error));
    }
  });

  // Groups ------------------------------------------------------------------

  app.get(`${BASE}/groups`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const groups = await svc.listGroupsWithMembers(actor);
      return render(req, res, "groups", { pageTitle: "Permission groups", actor, groups, activeTab: "admin" });
    } catch (error) {
      return renderError(req, res, error);
    }
  });

  app.post(`${BASE}/groups`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      await svc.createGroup(actor, req.body || {});
      return back(res, `${BASE}/groups`, "success", "Group created.");
    } catch (error) {
      return back(res, `${BASE}/groups`, "danger", errorMessage(error));
    }
  });

  app.post(`${BASE}/groups/:id`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      await svc.updateGroup(actor, intParam(req.params.id), req.body || {});
      return back(res, `${BASE}/groups`, "success", "Group saved.");
    } catch (error) {
      return back(res, `${BASE}/groups`, "danger", errorMessage(error));
    }
  });

  app.post(`${BASE}/groups/:id/delete`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      await svc.deleteGroup(actor, intParam(req.params.id));
      return back(res, `${BASE}/groups`, "success", "Group deleted and its permissions revoked.");
    } catch (error) {
      return back(res, `${BASE}/groups`, "danger", errorMessage(error));
    }
  });

  app.post(`${BASE}/groups/:id/members`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      await svc.addGroupMember(actor, intParam(req.params.id), {
        username: String(req.body?.username || "").trim(),
        expiresAt: req.body?.expiresAt || null,
      });
      return back(res, `${BASE}/groups`, "success", "Member added.");
    } catch (error) {
      return back(res, `${BASE}/groups`, "danger", errorMessage(error));
    }
  });

  app.post(`${BASE}/groups/:id/members/:userId/remove`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      await svc.removeGroupMember(actor, intParam(req.params.id), intParam(req.params.userId));
      return back(res, `${BASE}/groups`, "success", "Member removed. Their pending verifications were cancelled.");
    } catch (error) {
      return back(res, `${BASE}/groups`, "danger", errorMessage(error));
    }
  });

  // Access requests -----------------------------------------------------------

  app.get(`${BASE}/requests`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const [mine, queue, targets] = await Promise.all([svc.myRequests(actor), svc.approvalQueue(actor), svc.requestableTargets(actor)]);
      return render(req, res, "requests", {
        pageTitle: "Access requests",
        actor,
        mine,
        queue,
        targets,
        requestableCapabilities: REQUESTABLE_CAPABILITIES,
        durations: svc.REQUEST_DURATIONS_HOURS,
        preselect: { scope: req.query.scope === "collection" ? "collection" : "credential", targetId: intParam(req.query.target) },
        activeTab: "requests",
      });
    } catch (error) {
      return renderError(req, res, error);
    }
  });

  app.post(`${BASE}/requests`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const [scope, targetId] = String(req.body?.target || "").split(":");
      await svc.submitAccessRequest(actor, {
        scope,
        targetId,
        capabilities: asArray(req.body?.capabilities),
        reason: req.body?.reason,
        durationHours: req.body?.durationHours || null,
      });
      return back(res, `${BASE}/requests`, "success", "Request sent. You will be notified when it is decided.");
    } catch (error) {
      return back(res, `${BASE}/requests`, "danger", errorMessage(error));
    }
  });

  app.post(`${BASE}/requests/:id/decide`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      await svc.decideAccessRequest(actor, intParam(req.params.id), {
        approve: req.body?.decision === "approve",
        note: req.body?.note,
        durationHours: req.body?.durationHours,
      });
      return back(res, `${BASE}/requests`, "success", req.body?.decision === "approve" ? "Request approved." : "Request rejected.");
    } catch (error) {
      return back(res, `${BASE}/requests`, "danger", errorMessage(error));
    }
  });

  app.post(`${BASE}/requests/:id/cancel`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      await svc.cancelAccessRequest(actor, intParam(req.params.id));
      return back(res, `${BASE}/requests`, "success", "Request cancelled.");
    } catch (error) {
      return back(res, `${BASE}/requests`, "danger", errorMessage(error));
    }
  });

  // Health ------------------------------------------------------------------

  app.get(`${BASE}/health`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const health = await svc.credentialHealth(actor);
      const settings = await svc.getSettings();
      return render(req, res, "health", { pageTitle: "Credential health", actor, health, settings, activeTab: "health" });
    } catch (error) {
      return renderError(req, res, error);
    }
  });

  // Audit -------------------------------------------------------------------

  app.get(`${BASE}/audit`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const page = Math.max(1, intParam(req.query.page) || 1);
      let actorUserId = null;
      // Only resolve usernames for people who may read the audit log at all.
      if (req.query.user && actor.nav.viewAudit) {
        const u = await store.findUserByUsername(String(req.query.user));
        actorUserId = u ? u.userId : -1;
      }
      const filters = {
        actorUserId,
        credentialId: intParam(req.query.credential),
        collectionId: intParam(req.query.collection),
        eventType: AUDIT_EVENT_VALUES.includes(req.query.event) ? req.query.event : null,
        outcome: ["success", "failure", "denied"].includes(req.query.outcome) ? req.query.outcome : null,
        from: req.query.from ? new Date(`${req.query.from}T00:00:00Z`) : null,
        to: req.query.to ? new Date(`${req.query.to}T23:59:59Z`) : null,
        limit: 50,
        offset: (page - 1) * 50,
      };
      for (const k of ["from", "to"]) if (filters[k] && !Number.isFinite(filters[k].getTime())) filters[k] = null;
      const result = await svc.auditLog(actor, filters);
      const collections = await svc.collectionsForActor(actor);
      return render(req, res, "audit", {
        pageTitle: "Vault audit log",
        actor,
        events: result.rows,
        total: result.total,
        page,
        query: req.query,
        eventTypes: AUDIT_EVENT_VALUES,
        collections,
        verification: null,
        activeTab: "audit",
      });
    } catch (error) {
      return renderError(req, res, error);
    }
  });

  app.post(`${BASE}/audit/verify`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const result = await svc.verifyAuditChain(actor);
      return back(
        res,
        `${BASE}/audit`,
        result.ok ? "success" : "danger",
        result.ok ? `Audit chain verified: ${result.checked} events, no tampering detected.` : `Audit chain broken at event #${result.brokenAtEventId}. Investigate immediately.`
      );
    } catch (error) {
      return back(res, `${BASE}/audit`, "danger", errorMessage(error));
    }
  });

  // Administration ------------------------------------------------------------

  app.get(`${BASE}/admin`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const [overview, users, vaultGrants, groups] = await Promise.all([
        svc.adminOverview(actor),
        svc.vaultUsers(actor),
        svc.grantsForTarget(actor, { kind: "vault" }),
        store.listGroups(),
      ]);
      return render(req, res, "admin", {
        pageTitle: "Vault administration",
        actor,
        overview,
        users,
        vaultGrants,
        groups,
        settingDefinitions: SETTING_DEFINITIONS,
        scopeCapabilities: capabilitiesForScope("vault"),
        activeTab: "admin",
      });
    } catch (error) {
      return renderError(req, res, error);
    }
  });

  app.post(`${BASE}/admin/settings`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      await svc.updateSettings(actor, normaliseSettingsForm(req.body || {}));
      return back(res, `${BASE}/admin`, "success", "Vault settings saved.");
    } catch (error) {
      return back(res, `${BASE}/admin`, "danger", errorMessage(error));
    }
  });

  app.post(`${BASE}/admin/enrolment-code`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const issued = await svc.issueEnrolmentCode(actor, {
        username: req.body?.username ? String(req.body.username).trim() : null,
        userId: req.body?.userId,
      });
      // Shown in this response only; it is never stored in plaintext or re-rendered.
      return render(req, res, "enrolment-code", { pageTitle: "Enrolment code", actor, issued, activeTab: "admin" });
    } catch (error) {
      return back(res, `${BASE}/admin`, "danger", errorMessage(error));
    }
  });

  app.post(`${BASE}/admin/users/:id/reset-password`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      await svc.resetVaultPasswordFor(actor, intParam(req.params.id));
      return back(res, `${BASE}/admin`, "success", "Vault password cleared. Staff without a Zander password need a new enrolment code to set another.");
    } catch (error) {
      return back(res, `${BASE}/admin`, "danger", errorMessage(error));
    }
  });

  app.post(`${BASE}/admin/users/:id/clear-lockout`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      await svc.clearLockoutFor(actor, intParam(req.params.id));
      return back(res, `${BASE}/admin`, "success", "Lockout cleared.");
    } catch (error) {
      return back(res, `${BASE}/admin`, "danger", errorMessage(error));
    }
  });

  app.get(`${BASE}/admin/rotation`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const tasks = await svc.rotationTasks(actor);
      return render(req, res, "rotation", { pageTitle: "Rotation tasks", actor, tasks, activeTab: "health" });
    } catch (error) {
      return renderError(req, res, error);
    }
  });

  app.post(`${BASE}/admin/rotation/:taskId/close`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      await svc.closeRotationTask(actor, intParam(req.params.taskId), req.body?.status);
      return back(res, `${BASE}/admin/rotation`, "success", "Task closed.");
    } catch (error) {
      return back(res, `${BASE}/admin/rotation`, "danger", errorMessage(error));
    }
  });

  app.get(`${BASE}/admin/offboard`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      if (!actor.vaultCaps.has("manage_vault")) {
        throw new svc.VaultError("forbidden", "Only vault administrators can offboard staff.");
      }
      let preview = null;
      if (req.query.user) {
        const user = await store.findUserByUsername(String(req.query.user));
        if (!user) throw new svc.VaultError("invalid", "No user with that username.");
        preview = await svc.offboardingPreview(actor, user.userId);
      }
      return render(req, res, "offboard", { pageTitle: "Offboard staff", actor, preview, result: null, activeTab: "admin" });
    } catch (error) {
      return renderError(req, res, error);
    }
  });

  app.post(`${BASE}/admin/offboard`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      if (req.body?.confirm !== "yes") throw new svc.VaultError("invalid", "Tick the confirmation box to offboard.");
      const result = await svc.offboardStaff(actor, intParam(req.body?.userId), { endSessions: Boolean(req.body?.endSessions) });
      return render(req, res, "offboard", { pageTitle: "Offboard staff", actor, preview: null, result, activeTab: "admin" });
    } catch (error) {
      return back(res, `${BASE}/admin/offboard`, "danger", errorMessage(error));
    }
  });

  app.get(`${BASE}/trash`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const deleted = await svc.deletedCredentialsForActor(actor);
      return render(req, res, "trash", { pageTitle: "Deleted credentials", actor, deleted, activeTab: "all" });
    } catch (error) {
      return renderError(req, res, error);
    }
  });

  // ---------------------------------------------------------------------
  // Reauthentication API
  // ---------------------------------------------------------------------

  app.post(`${BASE}/api/challenges`, async (req, res) => {
    if (!checkRateLimit(req, res, { windowMs: 60_000, max: 30 })) return;
    if (!(await apiGuard(req, res))) return;
    try {
      const actor = await svc.loadActor(req.session.user.userId, reqInfo(req));
      const challenge = await svc.startChallenge(actor, {
        credentialId: req.body?.credentialId,
        action: String(req.body?.action || ""),
        field: String(req.body?.field || ""),
        versionId: req.body?.versionId || null,
      });
      return res.send({ success: true, ...challenge });
    } catch (error) {
      const known = error instanceof svc.VaultError;
      if (!known) console.error("[credential-vault] challenge error:", error?.message);
      return res.status(known ? statusFor(error) : 500).send({
        success: false,
        code: known ? error.code : "error",
        message: known ? error.message : "Something went wrong.",
        lockedUntil: error?.lockedUntil || undefined,
      });
    }
  });

  app.post(`${BASE}/api/challenges/verify`, async (req, res) => {
    if (!checkRateLimit(req, res, { windowMs: 60_000, max: 10 })) return;
    if (!(await apiGuard(req, res))) return;
    // Take the password out of the request body straight away so nothing
    // later in the pipeline (an error handler, a log line) can see it.
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const challengeToken = typeof req.body?.challengeToken === "string" ? req.body.challengeToken : "";
    if (req.body) {
      delete req.body.password;
      delete req.body.challengeToken;
    }
    try {
      const result = await svc.verifyChallenge(req.session.user.userId, { challengeToken, password }, reqInfo(req));
      return res.send({ success: true, ...result });
    } catch (error) {
      const known = error instanceof svc.VaultError;
      if (!known) console.error("[credential-vault] verify error:", error?.code || error?.name);
      return res.status(known ? statusFor(error) : 500).send({
        success: false,
        code: known ? error.code : "error",
        message: known ? error.message : "Something went wrong.",
        lockedUntil: error?.lockedUntil || undefined,
      });
    }
  });

  // ---------------------------------------------------------------------
  // One credential (parameterised routes last)
  // ---------------------------------------------------------------------

  app.get(`${BASE}/:id`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const id = intParam(req.params.id);
      if (!id) throw new svc.VaultError("not_found", "That credential does not exist or you do not have access to it.");
      const detail = await svc.getCredentialForActor(actor, id);
      const security = await svc.securityStatus(actor);
      return render(req, res, "detail", {
        pageTitle: detail.credential.name,
        actor,
        ...detail,
        security,
        secretFields: secretFieldsFor(detail.credential.type),
        metadataFields: metadataFieldsFor(detail.credential.type),
        activeTab: "all",
      });
    } catch (error) {
      return renderError(req, res, error);
    }
  });

  app.get(`${BASE}/:id/edit`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const detail = await svc.getCredentialForActor(actor, intParam(req.params.id));
      if (!detail.caps.has("edit")) throw new svc.VaultError("forbidden", "You cannot edit this credential.");
      const collections = await store.listCollections();
      const names = detail.names;
      return render(req, res, "form", {
        pageTitle: `Edit ${detail.credential.name}`,
        actor,
        mode: "edit",
        type: detail.credential.type,
        collections: collections.filter(
          (c) => c.collectionId === detail.credential.collectionId || svc.capsFor(actor, { kind: "collection", collectionId: c.collectionId }).has("create") || actor.vaultCaps.has("manage_collections")
        ),
        selectedCollectionId: detail.credential.collectionId,
        credential: detail.credential,
        secretFields: secretFieldsFor(detail.credential.type),
        metadataFields: metadataFieldsFor(detail.credential.type),
        // Names only: the form shows which secrets exist, never their values.
        storedFieldNames: detail.secretFieldNames,
        errors: [],
        values: {
          ...detail.credential,
          tags: detail.credential.tags.join(", "),
          ownerUsername: names.get(detail.credential.ownerUserId) || "",
        },
        activeTab: "all",
      });
    } catch (error) {
      return renderError(req, res, error);
    }
  });

  app.post(`${BASE}/:id`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    const id = intParam(req.params.id);
    try {
      const detail = await svc.getCredentialForActor(actor, id);
      const parsed = parseCredentialForm(req.body || {}, {
        existingType: detail.credential.type,
        existingFieldNames: detail.secretFieldNames,
      });
      if (!parsed.ok) return back(res, `${BASE}/${id}/edit`, "danger", parsed.errors.join(" "));
      parsed.markRotated = Boolean(req.body?.markRotated);
      const result = await svc.updateCredential(actor, id, parsed);
      const msg = result.changedSecrets.length
        ? `Saved. Secret ${parsed.markRotated ? "rotated" : "replaced"}: ${result.changedSecrets.length} field(s).`
        : "Saved.";
      return back(res, `${BASE}/${id}`, "success", msg);
    } catch (error) {
      return back(res, `${BASE}/${id}/edit`, "danger", errorMessage(error));
    }
  });

  app.post(`${BASE}/:id/delete`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      await svc.deleteCredential(actor, intParam(req.params.id));
      return back(res, BASE, "success", "Credential deleted. A vault administrator can restore it from Deleted credentials.");
    } catch (error) {
      return back(res, `${BASE}/${intParam(req.params.id)}`, "danger", errorMessage(error));
    }
  });

  app.post(`${BASE}/:id/restore`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      await svc.restoreDeletedCredential(actor, intParam(req.params.id));
      return back(res, `${BASE}/${intParam(req.params.id)}`, "success", "Credential restored.");
    } catch (error) {
      return back(res, `${BASE}/trash`, "danger", errorMessage(error));
    }
  });

  app.post(`${BASE}/:id/favourite`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    const id = intParam(req.params.id);
    try {
      await svc.setFavourite(actor, id, req.body?.on === "1");
      return back(res, safeReturnPath(req.body?.returnTo, `${BASE}/${id}`));
    } catch (error) {
      return back(res, BASE, "danger", errorMessage(error));
    }
  });

  app.post(`${BASE}/:id/review`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    const id = intParam(req.params.id);
    try {
      await svc.markCredentialReviewed(actor, id);
      return back(res, safeReturnPath(req.body?.returnTo, `${BASE}/${id}`), "success", "Marked as reviewed.");
    } catch (error) {
      return back(res, `${BASE}/${id}`, "danger", errorMessage(error));
    }
  });

  app.get(`${BASE}/:id/history`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const history = await svc.versionHistory(actor, intParam(req.params.id));
      return render(req, res, "history", { pageTitle: `History: ${history.credential.name}`, actor, ...history, activeTab: "all" });
    } catch (error) {
      return renderError(req, res, error);
    }
  });

  app.get(`${BASE}/:id/access`, async (req, res) => {
    const actor = await pageGuard(req, res);
    if (!actor) return;
    try {
      const detail = await svc.getCredentialForActor(actor, intParam(req.params.id));
      const target = svc.credentialTarget(detail.credential);
      const [grants, groups, inherited] = await Promise.all([
        svc.grantsForTarget(actor, target),
        store.listGroups(),
        svc.grantsForTarget(actor, { kind: "collection", collectionId: detail.credential.collectionId }).catch(() => []),
      ]);
      return render(req, res, "access", {
        pageTitle: `Access: ${detail.credential.name}`,
        actor,
        ...detail,
        grants,
        inherited,
        groups,
        scopeCapabilities: capabilitiesForScope("credential"),
        activeTab: "all",
      });
    } catch (error) {
      return renderError(req, res, error);
    }
  });
}

export { CAPABILITIES };
