/**
 * lib/credentialVault/constants.mjs
 *
 * Vocabulary of the Credential Vault: capabilities, credential types and their
 * fields, challenge actions and audit event types.
 *
 * Imports nothing, so it is safe to load anywhere and unit-testable.
 * Design record: docs/credential-vault-architecture.md
 */

/** LuckPerms node that shows the vault menu and lets someone open it. Grants no credential. */
export const ENTRY_PERMISSION_NODE = "zander.web.credentials";

export const DEFAULT_VAULT_ID = 1;

export const SCOPES = Object.freeze(["vault", "collection", "credential"]);
export const PRINCIPAL_TYPES = Object.freeze(["user", "group"]);
export const EFFECTS = Object.freeze(["allow", "deny"]);

/**
 * Every vault capability. Order is the order they are shown in the UI.
 * `export` is deliberately absent: there is no export path in this release.
 */
export const CAPABILITIES = Object.freeze([
  "list",
  "view",
  "reveal",
  "copy",
  "create",
  "edit",
  "delete",
  "view_history",
  "manage_access",
  "manage_collections",
  "view_audit",
  "approve_requests",
  "manage_vault",
]);

export const CAPABILITY_LABELS = Object.freeze({
  list: "List",
  view: "View details",
  reveal: "Reveal secret",
  copy: "Copy secret",
  create: "Create",
  edit: "Edit",
  delete: "Delete",
  view_history: "View history",
  manage_access: "Manage access",
  manage_collections: "Manage collections",
  view_audit: "View audit logs",
  approve_requests: "Approve requests",
  manage_vault: "Manage vault",
});

/** Capabilities that act on credentials and may be granted at any scope. */
export const CREDENTIAL_CAPABILITIES = Object.freeze([
  "list",
  "view",
  "reveal",
  "copy",
  "edit",
  "delete",
  "view_history",
  "manage_access",
]);

/** Capabilities that only make sense at collection or vault scope. */
export const CONTAINER_CAPABILITIES = Object.freeze(["create", "approve_requests", "view_audit"]);

/** Vault-scope only. */
export const VAULT_ONLY_CAPABILITIES = Object.freeze(["manage_collections", "manage_vault"]);

/** Capabilities a member of staff may ask for through an access request. */
export const REQUESTABLE_CAPABILITIES = Object.freeze(["list", "view", "reveal", "copy", "edit"]);

/** Holding any of these on a credential implies list + view of its metadata. */
export const IMPLIES_VIEW = Object.freeze([
  "view",
  "reveal",
  "copy",
  "edit",
  "delete",
  "view_history",
  "manage_access",
]);

export function capabilitiesForScope(scope) {
  if (scope === "vault") return [...CAPABILITIES];
  if (scope === "collection") return [...CREDENTIAL_CAPABILITIES, ...CONTAINER_CAPABILITIES];
  if (scope === "credential") return [...CREDENTIAL_CAPABILITIES];
  return [];
}

/**
 * Credential types. `metadata` fields are stored in plaintext columns or the
 * `details` JSON and are visible to anyone with `view`. `secrets` are only ever
 * stored encrypted and only ever leave the server through a verified challenge.
 */
export const CREDENTIAL_TYPES = Object.freeze({
  login: {
    label: "Login",
    icon: "fa-solid fa-right-to-bracket",
    metadata: [],
    secrets: [
      { key: "password", label: "Password", multiline: false, generator: true },
      { key: "totpSecret", label: "Authenticator (TOTP) secret", multiline: false },
    ],
  },
  api: {
    label: "API credential",
    icon: "fa-solid fa-plug",
    metadata: [
      { key: "clientId", label: "Client ID" },
      { key: "environment", label: "Scope / environment" },
    ],
    secrets: [
      { key: "apiKey", label: "API key", multiline: false },
      { key: "clientSecret", label: "Client secret", multiline: false },
      { key: "accessToken", label: "Access token", multiline: true },
      { key: "refreshToken", label: "Refresh token", multiline: true },
    ],
  },
  dev_secret: {
    label: "Development secret",
    icon: "fa-solid fa-terminal",
    metadata: [
      { key: "host", label: "Host" },
      { key: "port", label: "Port" },
      { key: "database", label: "Database / service" },
      { key: "environment", label: "Environment" },
    ],
    secrets: [
      { key: "password", label: "Password", multiline: false, generator: true },
      { key: "privateKey", label: "SSH / private key", multiline: true },
      { key: "passphrase", label: "Key passphrase", multiline: false },
      { key: "connectionString", label: "Connection string", multiline: true },
      { key: "token", label: "Deployment / CI token", multiline: true },
      { key: "secretValue", label: "Application secret", multiline: true },
    ],
  },
  recovery: {
    label: "Recovery information",
    icon: "fa-solid fa-life-ring",
    metadata: [{ key: "recoveryEmail", label: "Recovery email" }],
    secrets: [
      { key: "recoveryCodes", label: "Backup recovery codes", multiline: true },
      { key: "recoveryInstructions", label: "Recovery instructions", multiline: true },
      { key: "recoveryNotes", label: "Account recovery notes", multiline: true },
    ],
  },
  secure_note: {
    label: "Secure note",
    icon: "fa-solid fa-note-sticky",
    metadata: [],
    secrets: [{ key: "note", label: "Note", multiline: true }],
  },
});

export const CREDENTIAL_TYPE_KEYS = Object.freeze(Object.keys(CREDENTIAL_TYPES));

/** Prefix for user-defined secret custom fields inside the encrypted payload. */
export const CUSTOM_SECRET_PREFIX = "custom:";
export const MAX_CUSTOM_FIELDS = 20;
export const MAX_SECRET_LENGTH = 32 * 1024;

/** Every built-in secret field key across all types. */
export const ALL_SECRET_FIELD_KEYS = Object.freeze(
  [...new Set(Object.values(CREDENTIAL_TYPES).flatMap((t) => t.secrets.map((s) => s.key)))]
);

export function secretFieldsFor(type) {
  return CREDENTIAL_TYPES[type]?.secrets ?? [];
}

export function metadataFieldsFor(type) {
  return CREDENTIAL_TYPES[type]?.metadata ?? [];
}

/** Is `field` a valid secret field name for this credential type? (custom:* allowed) */
export function isSecretFieldName(type, field) {
  if (typeof field !== "string" || !field) return false;
  if (field.startsWith(CUSTOM_SECRET_PREFIX)) {
    return /^custom:[a-z0-9_-]{1,40}$/.test(field);
  }
  return secretFieldsFor(type).some((s) => s.key === field);
}

/**
 * Challenge actions and the capabilities each requires.
 * Every action needs its own verified challenge; none is reusable.
 */
export const CHALLENGE_ACTIONS = Object.freeze({
  reveal: ["reveal"],
  copy: ["copy"],
  reveal_version: ["reveal", "view_history"],
  restore_version: ["edit", "view_history"],
});

export const CHALLENGE_ACTION_KEYS = Object.freeze(Object.keys(CHALLENGE_ACTIONS));

/** Hard ceiling on challenge lifetime regardless of settings. */
export const MAX_CHALLENGE_TTL_SECONDS = 30;

export const AUDIT_EVENTS = Object.freeze({
  CREDENTIAL_CREATED: "credential_created",
  CREDENTIAL_UPDATED: "credential_updated",
  CREDENTIAL_MOVED: "credential_moved",
  CREDENTIAL_DELETED: "credential_deleted",
  CREDENTIAL_RESTORED: "credential_restored",
  SECRET_REPLACED: "secret_replaced",
  SECRET_REVEALED: "secret_revealed",
  SECRET_COPIED: "secret_copied",
  SECRET_VERSION_REVEALED: "secret_version_revealed",
  SECRET_VERSION_RESTORED: "secret_version_restored",
  SECRET_ROTATED: "secret_rotated",
  CHALLENGE_ISSUED: "challenge_issued",
  CHALLENGE_REJECTED: "challenge_rejected",
  REAUTH_SUCCEEDED: "reauth_succeeded",
  REAUTH_FAILED: "reauth_failed",
  REAUTH_LOCKED: "reauth_locked",
  VAULT_PASSWORD_ENROLLED: "vault_password_enrolled",
  VAULT_PASSWORD_CHANGED: "vault_password_changed",
  VAULT_PASSWORD_RESET: "vault_password_reset",
  VAULT_ENROLMENT_CODE_ISSUED: "vault_enrolment_code_issued",
  ACCESS_REQUESTED: "access_requested",
  ACCESS_REQUEST_APPROVED: "access_request_approved",
  ACCESS_REQUEST_REJECTED: "access_request_rejected",
  ACCESS_REQUEST_CANCELLED: "access_request_cancelled",
  PERMISSION_GRANTED: "permission_granted",
  PERMISSION_REVOKED: "permission_revoked",
  PERMISSION_EXPIRED: "permission_expired",
  GROUP_CREATED: "group_created",
  GROUP_UPDATED: "group_updated",
  GROUP_DELETED: "group_deleted",
  GROUP_MEMBER_ADDED: "group_member_added",
  GROUP_MEMBER_REMOVED: "group_member_removed",
  COLLECTION_CREATED: "collection_created",
  COLLECTION_UPDATED: "collection_updated",
  COLLECTION_DELETED: "collection_deleted",
  ROTATION_TASK_OPENED: "rotation_task_opened",
  ROTATION_TASK_CLOSED: "rotation_task_closed",
  CREDENTIAL_REVIEWED: "credential_reviewed",
  STAFF_OFFBOARDED: "staff_offboarded",
  SETTINGS_UPDATED: "settings_updated",
  SUSPICIOUS_ACTIVITY: "suspicious_activity",
  ACCESS_DENIED: "access_denied",
});

export const AUDIT_EVENT_VALUES = Object.freeze(Object.values(AUDIT_EVENTS));

export const ROTATION_REASONS = Object.freeze(["offboarding", "schedule", "expiry", "manual", "revocation"]);
