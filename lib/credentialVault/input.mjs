/**
 * lib/credentialVault/input.mjs
 *
 * Validation and normalisation of credential forms. Splits a submitted form
 * into plaintext metadata and the secret fields that must be encrypted.
 * Pure functions: unit-testable.
 */

import {
  CREDENTIAL_TYPES,
  CUSTOM_SECRET_PREFIX,
  MAX_CUSTOM_FIELDS,
  MAX_SECRET_LENGTH,
  metadataFieldsFor,
  secretFieldsFor,
} from "./constants.mjs";

const MAX = { name: 150, url: 500, username: 255, email: 254, description: 5000, tag: 40, tags: 20, detail: 300 };

function str(value, max) {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, max);
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Only http(s) URLs are kept, so a stored link can never be javascript: or data:. */
export function normaliseUrl(value) {
  const raw = str(value, MAX.url);
  if (!raw) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "Website must be an http(s) address." };
    return url.toString();
  } catch {
    return { error: "Website is not a valid address." };
  }
}

export function displayHost(url) {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function parseDate(value) {
  const raw = str(value, 40);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : { error: "Invalid date." };
}

function slugifyCustomKey(label, index) {
  const base = String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return `${base || "field"}_${index}`;
}

/**
 * Parse the credential form.
 *
 * Secret handling on edit (`existingFieldNames` given):
 *   - an empty secret input means "keep the stored value";
 *   - `clear_<field>` checked means "remove that value";
 *   - a non-empty input replaces it.
 * The form never receives stored secret values, so there is nothing to echo.
 *
 * Returns { ok, errors, meta, secretChanges: { set: {k: v}, clear: [k] }, customFields }
 */
export function parseCredentialForm(body = {}, { existingType = null, existingFieldNames = null } = {}) {
  const errors = [];
  const type = existingType || str(body.type, 20);
  if (!CREDENTIAL_TYPES[type]) {
    return { ok: false, errors: ["Choose a credential type."] };
  }

  const name = str(body.name, MAX.name);
  if (!name) errors.push("Name is required.");

  const collectionId = Number.parseInt(body.collectionId, 10);
  if (!(collectionId > 0)) errors.push("Choose a collection.");

  let url = normaliseUrl(body.url);
  if (url && typeof url === "object") {
    errors.push(url.error);
    url = null;
  }

  const email = str(body.email, MAX.email) || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Associated email address is not valid.");

  const tags = [
    ...new Set(
      str(body.tags, 1000)
        .split(",")
        .map((t) => t.trim().slice(0, MAX.tag))
        .filter(Boolean)
    ),
  ].slice(0, MAX.tags);

  const details = {};
  for (const field of metadataFieldsFor(type)) {
    const value = str(body[`detail_${field.key}`], MAX.detail);
    if (value) details[field.key] = value;
  }

  // Custom fields: arrays custom_label[], custom_value[], custom_secret[] (index list)
  const labels = asArray(body["custom_label"]).map((l) => str(l, 60));
  const values = asArray(body["custom_value"]);
  const keys = asArray(body["custom_key"]).map((k) => str(k, 50));
  const secretFlags = new Set(asArray(body["custom_secret"]).map((v) => String(v)));
  const customFields = [];
  const set = {};
  const clear = [];
  const usedKeys = new Set();
  for (let i = 0; i < labels.length && customFields.length < MAX_CUSTOM_FIELDS; i += 1) {
    const label = labels[i];
    const rawValue = values[i] === undefined || values[i] === null ? "" : String(values[i]);
    let key = /^[a-z0-9_-]{1,40}$/.test(keys[i] || "") ? keys[i] : slugifyCustomKey(label, i);
    while (usedKeys.has(key)) key = `${key}_x`.slice(0, 40);
    if (!label && !rawValue && !existingFieldNames?.includes(`${CUSTOM_SECRET_PREFIX}${key}`)) continue;
    usedKeys.add(key);
    const isSecret = secretFlags.has(String(i));
    if (isSecret) {
      customFields.push({ key, label: label || "Secret", secret: true });
      if (rawValue) {
        if (rawValue.length > MAX_SECRET_LENGTH) errors.push(`Custom field "${label}" is too long.`);
        else set[`${CUSTOM_SECRET_PREFIX}${key}`] = rawValue;
      }
    } else {
      customFields.push({ key, label: label || "Field", secret: false, value: rawValue.trim().slice(0, MAX.detail) });
    }
  }
  details.customFields = customFields;

  for (const field of secretFieldsFor(type)) {
    const raw = body[`secret_${field.key}`];
    const value = raw === undefined || raw === null ? "" : String(raw);
    if (value.length > MAX_SECRET_LENGTH) {
      errors.push(`${field.label} is too long.`);
      continue;
    }
    if (body[`clear_${field.key}`]) clear.push(field.key);
    else if (value.length > 0) set[field.key] = field.multiline ? value.replace(/\r\n/g, "\n") : value;
  }
  // Secret custom fields that disappeared from the form are cleared.
  if (existingFieldNames) {
    for (const existing of existingFieldNames) {
      if (!existing.startsWith(CUSTOM_SECRET_PREFIX)) continue;
      const key = existing.slice(CUSTOM_SECRET_PREFIX.length);
      if (!customFields.some((f) => f.secret && f.key === key)) clear.push(existing);
    }
  }

  const expiresAt = parseDate(body.expiresAt);
  if (expiresAt && expiresAt.error) errors.push("Expiry date is not valid.");
  const rotateEveryDaysRaw = str(body.rotateEveryDays, 6);
  const rotateEveryDays = rotateEveryDaysRaw ? Number.parseInt(rotateEveryDaysRaw, 10) : null;
  if (rotateEveryDaysRaw && !(rotateEveryDays >= 1 && rotateEveryDays <= 3650)) errors.push("Rotation schedule must be 1-3650 days.");
  const nextRotationAt = parseDate(body.nextRotationAt);
  if (nextRotationAt && nextRotationAt.error) errors.push("Next rotation date is not valid.");

  const ownerUserId = Number.parseInt(body.ownerUserId, 10);

  if (!existingFieldNames && Object.keys(set).length === 0) {
    errors.push("Enter at least one secret value.");
  }

  return {
    ok: errors.length === 0,
    errors,
    meta: {
      type,
      name,
      collectionId,
      url,
      username: str(body.username, MAX.username) || null,
      email,
      description: str(body.description, MAX.description) || null,
      details,
      tags,
      ownerUserId: ownerUserId > 0 ? ownerUserId : null,
      ownerUsername: str(body.ownerUsername, 32) || null,
      isRequestable: Boolean(body.isRequestable),
      expiresAt: expiresAt && !expiresAt.error ? expiresAt : null,
      rotateEveryDays: rotateEveryDays >= 1 ? rotateEveryDays : null,
      nextRotationAt:
        nextRotationAt && !nextRotationAt.error
          ? nextRotationAt
          : rotateEveryDays >= 1 && !existingFieldNames
            ? new Date(Date.now() + rotateEveryDays * 86400000)
            : null,
    },
    secretChanges: { set, clear },
  };
}

/** Apply secret changes to a decrypted payload (server side only). */
export function mergeSecretPayload(current, { set = {}, clear = [] }) {
  const next = { ...(current || {}) };
  for (const key of clear) delete next[key];
  for (const [key, value] of Object.entries(set)) next[key] = value;
  return next;
}

/** Field names that differ between two payloads (names only). */
export function changedFieldNames(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => before[k] !== after[k]).sort();
}

export function validateCollectionForm(body = {}) {
  const errors = [];
  const name = str(body.name, 100);
  if (!name) errors.push("Name is required.");
  const colour = str(body.colour, 7);
  if (colour && !/^#[0-9a-fA-F]{6}$/.test(colour)) errors.push("Colour must look like #1a2b3c.");
  const icon = str(body.icon, 64);
  if (icon && !/^(fa-(solid|regular|brands)|fas|far|fab)( fa-[a-z0-9-]+)+$/.test(icon)) errors.push("Icon must be a Font Awesome class.");
  return {
    ok: errors.length === 0,
    errors,
    collection: {
      name,
      description: str(body.description, 500) || null,
      colour: colour || null,
      icon: icon || null,
      isRequestable: Boolean(body.isRequestable),
    },
  };
}
