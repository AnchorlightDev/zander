/**
 * lib/formFields.js
 *
 * Field-type catalogue and submission validation for the form builder.
 *
 * Deliberately imports nothing: no database, no config, no Fastify. The
 * dashboard editor, the public renderer and the submit handler all read their
 * notion of "what is a field" from here, so a type added below shows up in all
 * three, and the whole module is unit-testable in isolation (same reasoning as
 * lib/apiKeys.js).
 */

/**
 * Every supported field type.
 *
 *  value      - stored in formFields.fieldType
 *  label      - shown in the dashboard field editor
 *  hasOptions - needs a caller-supplied choice list (formFields.options)
 *  multiple   - answer is an array rather than a scalar
 *  autoFill   - server fills the answer from the session; never trusted from
 *               the request body, so a submitter cannot claim someone else's
 *               UUID or a rank they do not hold
 *  sessionKey - for autoFill types, where to read the value from the session user
 */
export const FIELD_TYPES = [
  { value: "text",        label: "Short text",        hasOptions: false, multiple: false, autoFill: false },
  { value: "textarea",    label: "Paragraph",         hasOptions: false, multiple: false, autoFill: false },
  { value: "number",      label: "Number",            hasOptions: false, multiple: false, autoFill: false },
  { value: "date",        label: "Date",              hasOptions: false, multiple: false, autoFill: false },
  { value: "select",      label: "Dropdown",          hasOptions: true,  multiple: false, autoFill: false },
  { value: "radio",       label: "Multiple choice",   hasOptions: true,  multiple: false, autoFill: false },
  { value: "checkbox",    label: "Checkboxes",        hasOptions: true,  multiple: true,  autoFill: false },
  { value: "boolean",     label: "Confirmation tick", hasOptions: false, multiple: false, autoFill: false },
  { value: "file",        label: "Image upload",      hasOptions: false, multiple: false, autoFill: false },
  { value: "mc_username", label: "Minecraft username (auto)", hasOptions: false, multiple: false, autoFill: true, sessionKey: "username" },
  { value: "mc_uuid",     label: "Minecraft UUID (auto)",     hasOptions: false, multiple: false, autoFill: true, sessionKey: "uuid" },
  { value: "discord_tag", label: "Discord tag (auto)",        hasOptions: false, multiple: false, autoFill: true, sessionKey: "discordTag" },
  { value: "rank",        label: "Primary rank (auto)",       hasOptions: false, multiple: false, autoFill: true, sessionKey: "primaryRank" },
];

const TYPE_MAP = new Map(FIELD_TYPES.map((t) => [t.value, t]));

/** Field-type descriptor, or null when the type is not one we support. */
export function getFieldType(fieldType) {
  return TYPE_MAP.get(String(fieldType || "")) || null;
}

export function isValidFieldType(fieldType) {
  return TYPE_MAP.has(String(fieldType || ""));
}

/** True for types the server fills in from the session rather than rendering. */
export function isAutoFillType(fieldType) {
  return Boolean(getFieldType(fieldType)?.autoFill);
}

/**
 * Derive a stable, JSON-safe key from a human label.
 *
 * The key is what answers are stored under, so it is generated once at field
 * creation and then left alone -- relabelling "Why do you want to join?" must
 * not orphan the answers already filed under `why_do_you_want_to_join`.
 */
export function slugifyKey(label) {
  const base = String(label || "")
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return base || "field";
}

/** Append _2, _3 ... until the key is unique within the form. */
export function uniqueKey(label, takenKeys = []) {
  const taken = new Set(takenKeys);
  const base = slugifyKey(label);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base.slice(0, 60)}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 55)}_${Date.now() % 100000}`;
}

/**
 * Normalise an options list into [{ label, value }].
 *
 * Accepts the newline-separated textarea the dashboard editor posts, a JSON
 * string (what round-trips out of the `options` column), or an already-parsed
 * array. Lines may be "Label" or "Label|value".
 */
export function normaliseOptions(raw) {
  if (raw === null || raw === undefined || raw === "") return [];

  let list = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        list = JSON.parse(trimmed);
      } catch {
        list = trimmed.split(/\r?\n/);
      }
    } else {
      list = trimmed.split(/\r?\n/);
    }
  }
  if (!Array.isArray(list)) return [];

  const seen = new Set();
  const out = [];
  for (const entry of list) {
    let label;
    let value;
    if (entry && typeof entry === "object") {
      label = String(entry.label ?? entry.value ?? "").trim();
      value = String(entry.value ?? entry.label ?? "").trim();
    } else {
      const line = String(entry ?? "").trim();
      if (!line) continue;
      const pipe = line.indexOf("|");
      if (pipe === -1) {
        label = line;
        value = line;
      } else {
        label = line.slice(0, pipe).trim();
        value = line.slice(pipe + 1).trim() || label;
      }
    }
    if (!label || !value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ label, value });
  }
  return out;
}

/** Turn a stored options list back into the newline form the editor shows. */
export function optionsToText(raw) {
  return normaliseOptions(raw)
    .map((o) => (o.label === o.value ? o.label : `${o.label}|${o.value}`))
    .join("\n");
}

/** Session-derived value for an autofill field, or "" when unavailable. */
function autoFillValue(field, user) {
  if (!user) return "";
  const key = getFieldType(field.fieldType)?.sessionKey;
  if (!key) return "";
  if (key === "primaryRank") {
    const rank = Array.isArray(user.ranks) ? user.ranks[0] : null;
    return String(rank?.rankSlug ?? user.primaryRank ?? "").trim();
  }
  return String(user[key] ?? "").trim();
}

const URL_RE = /^https?:\/\/\S+$/i;

/**
 * Validate a submitted body against a form's field list.
 *
 * Returns { ok, errors, answers }. `answers` is keyed by fieldKey and is what
 * gets written to formSubmissions.answers -- built only from recognised
 * fields, so extra keys posted by a client are dropped rather than stored.
 */
export function validateSubmission(fields, body = {}, { user = null } = {}) {
  const errors = [];
  const answers = {};
  const list = Array.isArray(fields)
    ? [...fields].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    : [];

  for (const field of list) {
    const type = getFieldType(field.fieldType);
    const label = field.label || field.fieldKey;

    // An unknown type means the catalogue shrank under stored data. Skip it
    // rather than rejecting every submission to an otherwise-working form.
    if (!type) continue;

    if (type.autoFill) {
      const filled = autoFillValue(field, user);
      if (!filled && field.isRequired) {
        errors.push(`${label} could not be read from your account.`);
      }
      answers[field.fieldKey] = filled;
      continue;
    }

    const raw = body[field.fieldKey];

    if (type.multiple) {
      const submitted =
        raw === undefined || raw === null || raw === ""
          ? []
          : Array.isArray(raw)
            ? raw
            : [raw];
      const allowed = new Set(normaliseOptions(field.options).map((o) => o.value));
      const picked = submitted.map((v) => String(v)).filter((v) => allowed.has(v));
      if (field.isRequired && picked.length === 0) {
        errors.push(`${label} is required.`);
      }
      answers[field.fieldKey] = picked;
      continue;
    }

    if (type.value === "boolean") {
      const ticked =
        raw === true || raw === "true" || raw === "on" || raw === "1" || raw === 1;
      if (field.isRequired && !ticked) {
        errors.push(`${label} must be ticked.`);
      }
      answers[field.fieldKey] = ticked;
      continue;
    }

    const value = String(raw ?? "").trim();

    if (!value) {
      if (field.isRequired) errors.push(`${label} is required.`);
      answers[field.fieldKey] = "";
      continue;
    }

    if (type.hasOptions) {
      const allowed = new Set(normaliseOptions(field.options).map((o) => o.value));
      if (!allowed.has(value)) {
        errors.push(`${label} is not one of the available choices.`);
        answers[field.fieldKey] = "";
        continue;
      }
    }

    if (type.value === "number" && !Number.isFinite(Number(value))) {
      errors.push(`${label} must be a number.`);
      answers[field.fieldKey] = "";
      continue;
    }

    if (type.value === "date" && Number.isNaN(Date.parse(value))) {
      errors.push(`${label} must be a valid date.`);
      answers[field.fieldKey] = "";
      continue;
    }

    // The browser uploads to /api/upload/image first and posts back the URL,
    // so what arrives here is a link, not file bytes.
    if (type.value === "file" && !URL_RE.test(value)) {
      errors.push(`${label} must be an uploaded file.`);
      answers[field.fieldKey] = "";
      continue;
    }

    const limit = Number(field.maxLength) > 0 ? Number(field.maxLength) : null;
    if (limit && value.length > limit) {
      errors.push(`${label} must be ${limit} characters or fewer.`);
      answers[field.fieldKey] = value.slice(0, limit);
      continue;
    }

    answers[field.fieldKey] = value;
  }

  return { ok: errors.length === 0, errors, answers };
}

/** Submission statuses the dashboard can set. */
export const SUBMISSION_STATUSES = ["pending", "approved", "denied"];

export function isValidSubmissionStatus(status) {
  return SUBMISSION_STATUSES.includes(String(status || ""));
}

/**
 * Render one stored answer as display text.
 *
 * Shared by the dashboard submission view and the Discord embed so a reviewer
 * reading either sees the same thing -- option *labels* rather than the stored
 * values, and "Yes"/"No" rather than a raw boolean.
 */
export function formatAnswer(field, value) {
  const type = getFieldType(field.fieldType);

  if (type?.multiple || Array.isArray(value)) {
    const chosen = Array.isArray(value) ? value : value === "" || value == null ? [] : [value];
    if (!chosen.length) return "";
    const labels = new Map(normaliseOptions(field.options).map((o) => [o.value, o.label]));
    return chosen.map((v) => labels.get(v) ?? v).join(", ");
  }

  if (type?.value === "boolean") return value ? "Yes" : "No";

  if (value === null || value === undefined || value === "") return "";

  if (type?.hasOptions) {
    const labels = new Map(normaliseOptions(field.options).map((o) => [o.value, o.label]));
    return labels.get(value) ?? String(value);
  }

  return String(value);
}
