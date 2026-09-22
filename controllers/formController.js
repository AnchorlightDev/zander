/**
 * controllers/formController.js
 *
 * Data access for the form builder (forms, their fields, and submissions).
 *
 * Uses Prisma Client rather than the raw mysql2 pool: this is new code, and
 * the field/submission writes are multi-row, so the transaction support is
 * worth having. Field ordering is normalised here so every caller -- dashboard
 * editor, public renderer, validator -- sees the same list in the same order.
 */

import { prisma } from "./databaseController.js";
import {
  isValidFieldType,
  normaliseFieldConfig,
  normaliseOptions,
  sanitiseShowIfGraph,
  slugifyKey,
  uniqueKey,
} from "../lib/formFields.js";
import { normaliseRequirements } from "../lib/formRequirements.mjs";

/**
 * Build a URL-safe, unique form slug.
 *
 * `excludeFormId` lets an edit keep its own slug instead of colliding with
 * itself and drifting to "staff-application-2" on every save.
 */
export async function buildUniqueSlug(desired, excludeFormId = null) {
  const base = slugifyKey(desired).replace(/_/g, "-").slice(0, 90) || "form";
  let candidate = base;
  for (let n = 2; n < 500; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    const clash = await prisma.forms.findUnique({
      where: { slug: candidate },
      select: { formId: true },
    });
    if (!clash || (excludeFormId && clash.formId === Number(excludeFormId))) {
      return candidate;
    }
    candidate = `${base.slice(0, 90)}-${n}`;
  }
  return `${base.slice(0, 80)}-${Date.now() % 100000}`;
}

const fieldOrder = [{ position: "asc" }, { fieldId: "asc" }];

/** Every form, with a submission count for the dashboard list. */
export async function listForms() {
  const forms = await prisma.forms.findMany({
    orderBy: [{ name: "asc" }],
    include: {
      _count: { select: { submissions: true, fields: true, applications: true } },
      // Named, not just counted: the delete confirmation needs to say which
      // applications would be left without a destination.
      applications: { select: { applicationId: true, displayName: true } },
    },
  });

  return forms.map((form) => ({
    ...form,
    fieldCount: form._count.fields,
    submissionCount: form._count.submissions,
    applicationCount: form._count.applications,
  }));
}

/** Forms that an application can link to (the editor's picker). */
export async function listFormsForPicker() {
  return prisma.forms.findMany({
    orderBy: [{ name: "asc" }],
    select: { formId: true, name: true, slug: true, status: true, createTicket: true },
  });
}

export async function getFormById(formId) {
  const id = Number(formId);
  if (!Number.isInteger(id)) return null;
  return prisma.forms.findUnique({
    where: { formId: id },
    include: { fields: { orderBy: fieldOrder } },
  });
}

export async function getFormBySlug(slug) {
  if (!slug) return null;
  return prisma.forms.findUnique({
    where: { slug: String(slug) },
    include: { fields: { orderBy: fieldOrder } },
  });
}

function formWriteData(data) {
  return {
    name: String(data.name).slice(0, 100),
    description: data.description ? String(data.description) : null,
    status: Boolean(data.status),
    successMessage: data.successMessage ? String(data.successMessage) : null,
    discordChannelId: data.discordChannelId ? String(data.discordChannelId).slice(0, 255) : null,
    allowMultiple: Boolean(data.allowMultiple),
    // Blank clears the gate rather than storing "", so requiresAccessCode has
    // one thing to test for.
    accessCode: String(data.accessCode ?? "").trim().slice(0, 190) || null,
    requirements: normaliseRequirements(data.requirements),
    reapplyCooldownDays:
      Number.isFinite(Number(data.reapplyCooldownDays)) && Number(data.reapplyCooldownDays) > 0
        ? Math.min(3650, Math.round(Number(data.reapplyCooldownDays)))
        : null,
    createTicket: Boolean(data.createTicket),
    ticketPendingMessage: String(data.ticketPendingMessage ?? "").trim() || null,
    ticketApprovedMessage: String(data.ticketApprovedMessage ?? "").trim() || null,
    ticketDeniedMessage: String(data.ticketDeniedMessage ?? "").trim() || null,
    ticketCategoryId: Number.isInteger(Number(data.ticketCategoryId)) && Number(data.ticketCategoryId) > 0
      ? Number(data.ticketCategoryId)
      : null,
  };
}

export async function createForm(data) {
  const slug = await buildUniqueSlug(data.slug || data.name);
  return prisma.forms.create({
    data: { ...formWriteData(data), slug },
  });
}

export async function updateForm(formId, data) {
  const id = Number(formId);
  const slug = await buildUniqueSlug(data.slug || data.name, id);
  return prisma.forms.update({
    where: { formId: id },
    data: { ...formWriteData(data), slug },
  });
}

export async function deleteForm(formId) {
  return prisma.forms.delete({ where: { formId: Number(formId) } });
}

/**
 * Replace a form's whole field list in one transaction.
 *
 * The editor posts the complete set every save, so reconciling row-by-row
 * would be more code for the same result. Existing `fieldKey`s are preserved
 * when the client sends them back, which is what keeps already-stored answers
 * addressable after a relabel.
 */
export async function replaceFields(formId, rawFields = []) {
  const id = Number(formId);
  const taken = [];
  const rows = [];

  rawFields.forEach((raw, index) => {
    const label = String(raw.label ?? "").trim();
    if (!label) return;
    if (!isValidFieldType(raw.fieldType)) return;

    const supplied = String(raw.fieldKey ?? "").trim();
    const key = supplied && !taken.includes(supplied) ? supplied : uniqueKey(label, taken);
    taken.push(key);

    const options = normaliseOptions(raw.options);
    const maxLength = Number(raw.maxLength);

    rows.push({
      formId: id,
      label: label.slice(0, 255),
      fieldKey: key,
      fieldType: String(raw.fieldType),
      placeholder: raw.placeholder ? String(raw.placeholder).slice(0, 255) : null,
      helpText: raw.helpText ? String(raw.helpText) : null,
      options: options.length ? options : null,
      isRequired: Boolean(raw.isRequired),
      maxLength: Number.isInteger(maxLength) && maxLength > 0 ? maxLength : null,
      config: normaliseFieldConfig(String(raw.fieldType), raw.config),
      position: index,
    });
  });

  // Display conditions are pruned only once the whole list exists: whether a
  // showIf is usable depends on the fields before it, and their final
  // fieldKeys are not settled until every row has been through the loop above.
  const sanitised = sanitiseShowIfGraph(rows);

  await prisma.$transaction([
    prisma.formFields.deleteMany({ where: { formId: id } }),
    ...(sanitised.length ? [prisma.formFields.createMany({ data: sanitised })] : []),
  ]);

  return sanitised.length;
}

/** How many times this user has already submitted (for allowMultiple). */
export async function countUserSubmissions(formId, userId) {
  return prisma.formSubmissions.count({
    where: { formId: Number(formId), userId: Number(userId) },
  });
}

/**
 * The user's most recent denial on this form, for the reapply cooldown.
 *
 * Only denials: an approval or a still-pending submission is `allowMultiple`'s
 * business, not the cooldown's.
 */
export async function getLastDenial(formId, userId) {
  return prisma.formSubmissions.findFirst({
    where: { formId: Number(formId), userId: Number(userId), status: "denied" },
    orderBy: [{ reviewedAt: "desc" }, { submissionId: "desc" }],
    select: { submissionId: true, reviewedAt: true },
  });
}

/* ────────────────────────────── drafts ─────────────────────────────────── */

/** This user's saved draft for this form, or null. */
export async function getDraft(formId, userId) {
  return prisma.formDrafts.findUnique({
    where: { formId_userId: { formId: Number(formId), userId: Number(userId) } },
  });
}

/**
 * Overwrite this user's draft for this form.
 *
 * One row per person per form, upserted: the only draft anyone wants back is
 * the latest one, so there is nothing to version.
 */
export async function saveDraft(formId, userId, answers) {
  const where = { formId_userId: { formId: Number(formId), userId: Number(userId) } };
  return prisma.formDrafts.upsert({
    where,
    create: { formId: Number(formId), userId: Number(userId), answers },
    update: { answers },
  });
}

/**
 * Throw the draft away.
 *
 * Called on a successful submission and when the applicant asks to discard.
 * Missing is success: this runs after the submission is already committed, and
 * a draft that was never saved is not a failure to report.
 */
export async function deleteDraft(formId, userId) {
  try {
    await prisma.formDrafts.delete({
      where: { formId_userId: { formId: Number(formId), userId: Number(userId) } },
    });
    return true;
  } catch {
    return false;
  }
}

export async function createSubmission({ formId, userId, answers }) {
  return prisma.formSubmissions.create({
    data: {
      formId: Number(formId),
      userId: Number(userId),
      answers,
      status: "pending",
    },
  });
}

export async function listSubmissions({ formId = null, status = null, limit = 200 } = {}) {
  const where = {};
  if (formId) where.formId = Number(formId);
  if (status) where.status = String(status);

  return prisma.formSubmissions.findMany({
    where,
    orderBy: [{ createdAt: "desc" }],
    take: Number(limit) || 200,
    include: { form: { select: { formId: true, name: true, slug: true } } },
  });
}

export async function getSubmission(submissionId) {
  const id = Number(submissionId);
  if (!Number.isInteger(id)) return null;
  return prisma.formSubmissions.findUnique({
    where: { submissionId: id },
    include: { form: { include: { fields: { orderBy: fieldOrder } } } },
  });
}

/**
 * Record a decision.
 *
 * `commentIsPublic` is set true here and only here. The comment field used to
 * be labelled as internal staff notes and was never forwarded to the
 * applicant; it now is, so rows decided before this shipped keep the column at
 * its false default and their notes stay internal. Nothing backfills it -- see
 * migration 0053_form_ticket_messages.
 */
export async function reviewSubmission({ submissionId, status, reviewNotes, reviewedBy }) {
  return prisma.formSubmissions.update({
    where: { submissionId: Number(submissionId) },
    data: {
      status: String(status),
      reviewNotes: reviewNotes ? String(reviewNotes) : null,
      commentIsPublic: true,
      reviewedBy: reviewedBy ? Number(reviewedBy) : null,
      reviewedAt: new Date(),
    },
  });
}

export async function setSubmissionTicket(submissionId, ticketId) {
  return prisma.formSubmissions.update({
    where: { submissionId: Number(submissionId) },
    data: { ticketId: Number(ticketId) },
  });
}

export async function setSubmissionDiscordMessage(submissionId, discordMessageId) {
  return prisma.formSubmissions.update({
    where: { submissionId: Number(submissionId) },
    data: { discordMessageId: String(discordMessageId) },
  });
}

export async function deleteSubmission(submissionId) {
  return prisma.formSubmissions.delete({
    where: { submissionId: Number(submissionId) },
  });
}

/** Pending-count badge for the dashboard forms list. */
export async function countPendingByForm() {
  const rows = await prisma.formSubmissions.groupBy({
    by: ["formId"],
    where: { status: "pending" },
    _count: { submissionId: true },
  });
  return new Map(rows.map((r) => [r.formId, r._count.submissionId]));
}
