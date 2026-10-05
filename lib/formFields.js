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
 *  display    - renders as page furniture and collects no answer at all; never
 *               required, never stored, never shown as a row to reviewers
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
  { value: "images",      label: "Image upload (multiple)", hasOptions: false, multiple: true,  autoFill: false },
  { value: "scale",       label: "Linear scale",      hasOptions: false, multiple: false, autoFill: false },
  { value: "section",     label: "Section break (new page)", hasOptions: false, multiple: false, autoFill: false, display: true },
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
 * True for types that are page furniture rather than a question.
 *
 * A display field collects nothing, so it is skipped by the validator and the
 * draft collector, and never appears as an answer row in the dashboard, the
 * Discord embed or the ticket body.
 */
export function isDisplayType(fieldType) {
  return Boolean(getFieldType(fieldType)?.display);
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

/* ───────────────────────────── field config ────────────────────────────────
 *
 * `formFields.config` carries per-type settings, plus (for any type) the
 * condition under which the field is shown at all. Everything below treats the
 * stored value as untrusted: the dashboard editor posts it, but so could
 * anything else, so unknown keys are dropped and numbers are clamped rather
 * than rejected -- a field with a nonsense config still works, at the safe end
 * of its range, instead of breaking the whole form.
 */

/** Hard ceiling on a multi-image field, whatever the builder asks for. */
export const MAX_IMAGES_PER_FIELD = 10;

/** Linear-scale end points: scaleMin lives in [0,1], scaleMax in [2,10]. */
export const SCALE_BOUNDS = { minLow: 0, minHigh: 1, maxLow: 2, maxHigh: 10 };

/** The only field types a showIf condition is allowed to read. */
export const SHOW_IF_SOURCE_TYPES = ["select", "radio", "checkbox", "boolean"];

function clampInt(value, low, high, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(high, Math.max(low, Math.round(n)));
}

/** Parse a config blob (object, JSON string or junk) into a plain object. */
function parseConfig(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function normaliseShowIf(raw) {
  const source = parseConfig(raw);
  const fieldKey = String(source.fieldKey ?? "").trim();
  if (!fieldKey) return null;

  const equalsRaw = Array.isArray(source.equals)
    ? source.equals
    : source.equals === undefined || source.equals === null || source.equals === ""
      ? []
      : [source.equals];

  const equals = [...new Set(equalsRaw.map((v) => String(v).trim()).filter(Boolean))].slice(0, 50);
  if (!equals.length) return null;

  return { fieldKey: fieldKey.slice(0, 64), equals };
}

/**
 * Clamp and strip a posted config down to what its field type understands.
 *
 * Returns null when nothing survives, so an unconfigured field stores SQL NULL
 * rather than an empty object.
 */
export function normaliseFieldConfig(fieldType, raw) {
  const source = parseConfig(raw);
  const out = {};

  if (fieldType === "images") {
    out.maxImages = clampInt(source.maxImages, 1, MAX_IMAGES_PER_FIELD, MAX_IMAGES_PER_FIELD);
  }

  if (fieldType === "scale") {
    out.scaleMin = clampInt(source.scaleMin, SCALE_BOUNDS.minLow, SCALE_BOUNDS.minHigh, 1);
    out.scaleMax = clampInt(source.scaleMax, SCALE_BOUNDS.maxLow, SCALE_BOUNDS.maxHigh, 10);
    // The two ranges cannot currently overlap, so this is belt and braces --
    // but widening either bound later must not be able to invert the scale.
    if (out.scaleMax <= out.scaleMin) out.scaleMax = out.scaleMin + 1;

    const minLabel = String(source.scaleMinLabel ?? "").trim().slice(0, 40);
    const maxLabel = String(source.scaleMaxLabel ?? "").trim().slice(0, 40);
    if (minLabel) out.scaleMinLabel = minLabel;
    if (maxLabel) out.scaleMaxLabel = maxLabel;
  }

  const showIf = normaliseShowIf(source.showIf);
  if (showIf) out.showIf = showIf;

  return Object.keys(out).length ? out : null;
}

/** A field's effective settings, with its type's defaults filled in. */
export function getFieldConfig(field) {
  return normaliseFieldConfig(field?.fieldType, field?.config) ?? {};
}

/** How many images this field accepts. Never above MAX_IMAGES_PER_FIELD. */
export function getMaxImages(field) {
  return clampInt(getFieldConfig(field).maxImages, 1, MAX_IMAGES_PER_FIELD, MAX_IMAGES_PER_FIELD);
}

/** { min, max, minLabel, maxLabel } for a linear-scale field. */
export function getScaleRange(field) {
  const config = getFieldConfig(field);
  return {
    min: clampInt(config.scaleMin, SCALE_BOUNDS.minLow, SCALE_BOUNDS.minHigh, 1),
    max: clampInt(config.scaleMax, SCALE_BOUNDS.maxLow, SCALE_BOUNDS.maxHigh, 10),
    minLabel: config.scaleMinLabel ?? "",
    maxLabel: config.scaleMaxLabel ?? "",
  };
}

/**
 * Drop any showIf that cannot be satisfied, rather than rejecting the save.
 *
 * A condition may only read a field *earlier* in the form, and only one of the
 * choice types. Restricting edges to point backwards is what makes cycles
 * impossible rather than something to go looking for: a graph whose every edge
 * points at an already-seen node cannot contain one. Self-references, forward
 * references, unknown keys and unsupported source types are all the same
 * mistake and all handled the same way -- the condition is dropped and the
 * field simply always shows, which is the safe direction to fail.
 *
 * Takes fields in position order and returns them with `config` rewritten.
 */
export function sanitiseShowIfGraph(fields = []) {
  const seen = new Map();

  return fields.map((field) => {
    const config = parseConfig(field.config);
    const showIf = normaliseShowIf(config.showIf);

    let kept = null;
    if (showIf) {
      const source = seen.get(showIf.fieldKey);
      if (source && SHOW_IF_SOURCE_TYPES.includes(source.fieldType)) kept = showIf;
    }

    // Recorded after the lookup, so a field cannot point at itself.
    seen.set(field.fieldKey, field);

    const next = { ...config };
    if (kept) next.showIf = kept;
    else delete next.showIf;

    return { ...field, config: Object.keys(next).length ? next : null };
  });
}

/** True when `answer` (scalar or array) matches one of `equals`. */
function answerMatches(answer, equals) {
  const wanted = new Set(equals.map((v) => String(v)));
  if (Array.isArray(answer)) return answer.some((v) => wanted.has(String(v)));
  if (answer === undefined || answer === null) return false;
  return wanted.has(String(answer));
}

/**
 * Whether a field is shown, given the answers gathered so far.
 *
 * Conditions only ever point backwards, so walking fields in position order
 * means the controlling answer is already settled by the time it is read --
 * and a field whose controller was itself hidden has no answer at all, so a
 * whole dependent chain collapses without needing a second pass.
 */
export function isFieldVisible(field, answers = {}) {
  const showIf = getFieldConfig(field).showIf;
  if (!showIf) return true;
  return answerMatches(answers[showIf.fieldKey], showIf.equals);
}

/**
 * Split an ordered field list into pages.
 *
 * A `section` field is a marker, not a container: everything after it belongs
 * to that page until the next marker. Keeping the flat, position-ordered list
 * is what lets sections exist without a migration, and means the display
 * conditions keep working unchanged -- they only ever look backwards, and the
 * ordering they look back through is the same one.
 *
 * Fields appearing before any marker form an untitled first page, so a form
 * that has never heard of sections yields exactly one page and renders the way
 * it always did.
 *
 * Returns [{ title, description, showIf, fieldKey, fields }].
 */
export function groupIntoSections(fields = []) {
  const list = Array.isArray(fields)
    ? [...fields].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    : [];

  const sections = [];
  let current = null;

  const open = (marker) => {
    current = {
      title: marker ? String(marker.label ?? "") : "",
      description: marker ? String(marker.helpText ?? "") : "",
      showIf: marker ? getFieldConfig(marker).showIf ?? null : null,
      fieldKey: marker ? marker.fieldKey : null,
      fields: [],
    };
    sections.push(current);
  };

  for (const field of list) {
    if (getFieldType(field.fieldType)?.value === "section") {
      open(field);
      continue;
    }
    if (!current) open(null);
    current.fields.push(field);
  }

  return sections;
}

/** True when a form has no section markers, so the wizard stays out of the way. */
export function isSinglePage(fields = []) {
  const sections = groupIntoSections(fields);
  return sections.length <= 1 && !sections[0]?.title;
}

/**
 * Is this one of our own Cloudinary delivery URLs?
 *
 * Image answers are posted back by the browser as metadata rather than bytes,
 * so without this a submitter could hand-craft an answer pointing anywhere and
 * have the dashboard and the Discord embed render it for staff. `cloudName` is
 * passed in rather than read from the environment, to keep this module
 * import-free; with it absent the host check still applies.
 */
export function isCloudinaryUrl(url, cloudName = null) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname !== "res.cloudinary.com") return false;
  if (!cloudName) return true;
  return parsed.pathname.startsWith(`/${cloudName}/`);
}

function normaliseImageEntry(entry, cloudName) {
  const source = entry && typeof entry === "object" ? entry : { url: entry };
  const url = String(source.url ?? "").trim();
  if (!isCloudinaryUrl(url, cloudName)) return null;

  const out = { url, publicId: String(source.publicId ?? "").slice(0, 255) };
  const width = Number(source.width);
  const height = Number(source.height);
  if (Number.isFinite(width) && width > 0) out.width = Math.round(width);
  if (Number.isFinite(height) && height > 0) out.height = Math.round(height);
  return out;
}

/**
 * Parse whatever the browser posted for an `images` field.
 *
 * Returns { images, rejected }. `rejected` counts entries dropped for not
 * being one of our Cloudinary URLs, so the caller can say so rather than
 * silently storing fewer images than the submitter picked.
 */
export function parseImagesAnswer(raw, { cloudName = null } = {}) {
  let list = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { images: [], rejected: 0 };
    try {
      list = JSON.parse(trimmed);
    } catch {
      list = [trimmed];
    }
  }
  if (!Array.isArray(list)) list = list === undefined || list === null ? [] : [list];

  const seen = new Set();
  const images = [];
  let rejected = 0;

  for (const entry of list) {
    const parsed = normaliseImageEntry(entry, cloudName);
    if (!parsed) {
      rejected += 1;
      continue;
    }
    if (seen.has(parsed.url)) continue;
    seen.add(parsed.url);
    images.push(parsed);
  }

  return { images, rejected };
}

/**
 * The image entries stored against an `images` field.
 *
 * For callers that render them rather than describe them -- dashboard
 * thumbnails, and the Discord embed's image -- where formatAnswer's text is no
 * use.
 */
export function getAnswerImages(field, value) {
  if (getFieldType(field?.fieldType)?.value !== "images") return [];
  if (Array.isArray(value)) {
    return value.filter((v) => v && typeof v === "object" && typeof v.url === "string" && v.url);
  }
  return parseImagesAnswer(value).images;
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
 * Returns { ok, errors, errorKeys, answers }. `errorKeys` names the fields that
 * failed, so the page can reopen on the section holding the first of them
 * rather than dumping the applicant back at step one. `answers` is keyed by
 * fieldKey and is what
 * gets written to formSubmissions.answers -- built only from recognised
 * fields, so extra keys posted by a client are dropped rather than stored.
 *
 * `cloudName` is the Cloudinary cloud image answers must live on; the caller
 * supplies it because this module reads no environment of its own.
 */
export function validateSubmission(fields, body = {}, { user = null, cloudName = null } = {}) {
  const errors = [];
  const errorKeys = [];
  const answers = {};
  const list = Array.isArray(fields)
    ? [...fields].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    : [];

  const fail = (field, message) => {
    errors.push(message);
    if (!errorKeys.includes(field.fieldKey)) errorKeys.push(field.fieldKey);
  };

  // Set while walking through a section whose own condition was not met.
  let sectionHidden = false;

  for (const field of list) {
    const type = getFieldType(field.fieldType);
    const label = field.label || field.fieldKey;

    // An unknown type means the catalogue shrank under stored data. Skip it
    // rather than rejecting every submission to an otherwise-working form.
    if (!type) continue;

    if (type.display) {
      // A section marker carries its page's condition. Everything after it
      // belongs to that page, so a hidden marker takes the whole page with it
      // -- the applicant was never shown any of those questions.
      if (type.value === "section") sectionHidden = !isFieldVisible(field, answers);
      continue;
    }

    if (sectionHidden) continue;

    // A field whose condition was not met was never shown, so it cannot be
    // required and anything posted for it is discarded rather than stored --
    // the key is left out of `answers` entirely, which also collapses any
    // fields conditional on this one.
    if (!isFieldVisible(field, answers)) continue;

    if (type.autoFill) {
      const filled = autoFillValue(field, user);
      if (!filled && field.isRequired) {
        fail(field, `${label} could not be read from your account.`);
      }
      answers[field.fieldKey] = filled;
      continue;
    }

    const raw = body[field.fieldKey];

    if (type.value === "images") {
      // The client caps the picker too, but a client-side limit is not a
      // limit: the count is enforced again here against the clamped config.
      const limit = getMaxImages(field);
      const { images, rejected } = parseImagesAnswer(raw, { cloudName });

      if (rejected > 0) {
        fail(field, `${label} contains a file that was not uploaded through this site.`);
      }
      if (images.length > limit) {
        fail(field, `${label} accepts at most ${limit} image${limit === 1 ? "" : "s"}.`);
      }
      if (field.isRequired && images.length === 0) {
        fail(field, `${label} is required.`);
      }

      answers[field.fieldKey] = images.slice(0, limit);
      continue;
    }

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
        fail(field, `${label} is required.`);
      }
      answers[field.fieldKey] = picked;
      continue;
    }

    if (type.value === "boolean") {
      const ticked =
        raw === true || raw === "true" || raw === "on" || raw === "1" || raw === 1;
      if (field.isRequired && !ticked) {
        fail(field, `${label} must be ticked.`);
      }
      answers[field.fieldKey] = ticked;
      continue;
    }

    if (type.value === "scale") {
      const { min, max } = getScaleRange(field);
      const picked = String(raw ?? "").trim();

      if (!picked) {
        if (field.isRequired) fail(field, `${label} is required.`);
        answers[field.fieldKey] = null;
        continue;
      }

      const point = Number(picked);
      if (!Number.isInteger(point) || point < min || point > max) {
        fail(field, `${label} must be a whole number between ${min} and ${max}.`);
        answers[field.fieldKey] = null;
        continue;
      }

      answers[field.fieldKey] = point;
      continue;
    }

    const value = String(raw ?? "").trim();

    if (!value) {
      if (field.isRequired) fail(field, `${label} is required.`);
      answers[field.fieldKey] = "";
      continue;
    }

    if (type.hasOptions) {
      const allowed = new Set(normaliseOptions(field.options).map((o) => o.value));
      if (!allowed.has(value)) {
        fail(field, `${label} is not one of the available choices.`);
        answers[field.fieldKey] = "";
        continue;
      }
    }

    if (type.value === "number" && !Number.isFinite(Number(value))) {
      fail(field, `${label} must be a number.`);
      answers[field.fieldKey] = "";
      continue;
    }

    if (type.value === "date" && Number.isNaN(Date.parse(value))) {
      fail(field, `${label} must be a valid date.`);
      answers[field.fieldKey] = "";
      continue;
    }

    // The browser uploads to /api/upload/image first and posts back the URL,
    // so what arrives here is a link, not file bytes.
    if (type.value === "file" && !URL_RE.test(value)) {
      fail(field, `${label} must be an uploaded file.`);
      answers[field.fieldKey] = "";
      continue;
    }

    const limit = Number(field.maxLength) > 0 ? Number(field.maxLength) : null;
    if (limit && value.length > limit) {
      fail(field, `${label} must be ${limit} characters or fewer.`);
      answers[field.fieldKey] = value.slice(0, limit);
      continue;
    }

    answers[field.fieldKey] = value;
  }

  return { ok: errors.length === 0, errors, errorKeys, answers };
}

/** Longest single text answer a draft will store. */
export const DRAFT_MAX_ANSWER_LENGTH = 10000;

/**
 * Gather a partial answer set for a draft.
 *
 * Unlike validateSubmission this enforces nothing: a draft is half-finished by
 * definition, so required fields, ranges and display conditions are all
 * ignored, and only submitting checks them. What it does do is keep the stored
 * blob to recognised fields and sane sizes, so the autosave endpoint cannot be
 * used to stash arbitrary data under someone's user id.
 *
 * Auto-filled fields are skipped: they come from the session at submit time,
 * so a draft has nothing useful to remember about them.
 */
export function collectDraftAnswers(fields, body = {}, { cloudName = null } = {}) {
  const out = {};
  const list = Array.isArray(fields) ? fields : [];

  for (const field of list) {
    const type = getFieldType(field.fieldType);
    if (!type || type.autoFill || type.display) continue;

    const raw = body[field.fieldKey];
    if (raw === undefined) continue;

    if (type.value === "images") {
      // Only the Cloudinary metadata, exactly as a submission stores it -- the
      // files are already durable, so there is nothing else to keep.
      out[field.fieldKey] = parseImagesAnswer(raw, { cloudName }).images.slice(0, getMaxImages(field));
      continue;
    }

    if (type.multiple) {
      const submitted =
        raw === null || raw === "" ? [] : Array.isArray(raw) ? raw : [raw];
      const allowed = new Set(normaliseOptions(field.options).map((o) => o.value));
      out[field.fieldKey] = submitted.map((v) => String(v)).filter((v) => allowed.has(v));
      continue;
    }

    if (type.value === "boolean") {
      out[field.fieldKey] =
        raw === true || raw === "true" || raw === "on" || raw === "1" || raw === 1;
      continue;
    }

    out[field.fieldKey] = String(raw ?? "").slice(0, DRAFT_MAX_ANSWER_LENGTH);
  }

  return out;
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

  if (type?.value === "images") {
    const images = getAnswerImages(field, value);
    if (!images.length) return "";
    // Markdown links, which the Discord embed renders as clickable. The
    // dashboard ignores this text and renders thumbnails from
    // getAnswerImages instead.
    return images.map((image, index) => `[Image ${index + 1}](${image.url})`).join(" ");
  }

  if (type?.value === "scale") {
    if (value === null || value === undefined || value === "") return "";
    const { min, max, minLabel, maxLabel } = getScaleRange(field);
    const ends =
      minLabel || maxLabel ? ` (${min} = ${minLabel || min}, ${max} = ${maxLabel || max})` : "";
    return `${value} / ${max}${ends}`;
  }

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
