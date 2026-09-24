/**
 * routes/dashboard/forms.js
 *
 * Admin UI for the form builder: build forms and their fields, and review the
 * submissions they collect.
 *
 * Follows the newer dashboard convention (see rankCatalog.js) of posting
 * straight back to /dashboard/... and calling the controller in-process,
 * rather than the older /redirect/... -> /api/... self-call round trip.
 */

import { hasPermission, isFeatureWebRouteEnabled, setBannerCookie } from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import { getSupportCategories } from "../../controllers/supportTicketController.js";
import { prisma } from "../../controllers/databaseController.js";
import {
  countPendingByForm,
  createForm,
  deleteForm,
  deleteSubmission,
  duplicateForm,
  getFormById,
  getSubmission,
  listForms,
  listSubmissions,
  replaceFields,
  reviewSubmission,
  updateForm,
} from "../../controllers/formController.js";
import {
  notifySubmissionReviewed,
  postReviewToThread,
} from "../../services/formDiscordService.js";
import { formatDiscordIds } from "../../lib/discordIds.mjs";
import { csvFilename, toCsv } from "../../lib/csv.mjs";
import { buildSubmissionExport } from "../../lib/formExport.mjs";
import {
  getDefaultFormRequirements,
  setDefaultFormRequirements,
} from "../../controllers/siteSettingsController.js";
import { postReviewToTicket } from "../../services/formTicketService.js";
import {
  REQUIREMENT_DEFS,
  WINDOW_DEFS,
  normaliseRequirements,
  summariseRequirements,
} from "../../lib/formRequirements.mjs";
import {
  FIELD_TYPES,
  SHOW_IF_SOURCE_TYPES,
  formatAnswer,
  getAnswerImages,
  isDisplayType,
  isValidSubmissionStatus,
  optionsToText,
} from "../../lib/formFields.js";

const PERMISSION = "zander.web.forms";

/**
 * The field editor posts its rows as a single JSON string, because the row
 * count is dynamic and PHP-style `fields[0][label]` names are painful to parse
 * consistently across Fastify's body parsers.
 */
function parseFieldsPayload(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The requirement inputs, posted flat as `req_<key>`.
 *
 * Flat names rather than `requirements[key]` because Fastify's formbody parser
 * does not turn bracket notation into nested objects -- it would arrive as a
 * key literally called "requirements[minPlaytimeHours]".
 *
 * Blank means "do not apply this check", which is the same as absent; the
 * controller hands the result to normaliseRequirements, so nothing here is
 * relied on for range checking.
 */
const REQUIREMENT_KEYS = [...REQUIREMENT_DEFS, ...WINDOW_DEFS].map((def) => def.key);

function parseRequirementsPayload(body = {}) {
  const out = {};
  for (const key of REQUIREMENT_KEYS) {
    const raw = body[`req_${key}`];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    out[key] = Number(raw);
  }
  return out;
}

/** userId -> username for everyone named on these submissions, in one query. */
async function usernameMap(submissions) {
  const userIds = [...new Set(submissions.flatMap((s) => [s.userId, s.reviewedBy]).filter(Boolean))];
  if (!userIds.length) return new Map();

  const users = await prisma.users.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, username: true },
  });
  return new Map(users.map((u) => [u.userId, u.username]));
}

/** Attach usernames to submissions without an N+1 lookup per row. */
async function withSubmitterNames(submissions) {
  const names = await usernameMap(submissions);
  if (!names.size) return submissions.map((s) => ({ ...s, submitterName: null, reviewerName: null }));

  return submissions.map((s) => ({
    ...s,
    submitterName: names.get(s.userId) ?? `User #${s.userId}`,
    reviewerName: s.reviewedBy ? names.get(s.reviewedBy) ?? `User #${s.reviewedBy}` : null,
  }));
}

export default function dashboardFormsRoute(app, config, db, features, lang) {
  const guard = async (req, res) => {
    if (!(await isFeatureWebRouteEnabled(app, features.forms, req, res, features))) return false;
    if (!(await hasPermission(PERMISSION, req, res, features))) return false;
    return true;
  };

  // ── Forms list ────────────────────────────────────────────────────────────
  app.get("/dashboard/forms", async (req, res) => {
    if (!(await guard(req, res))) return;

    const [forms, pendingCounts, announcementWeb, defaults] = await Promise.all([
      listForms(),
      countPendingByForm(),
      getWebAnnouncement(),
      getDefaultFormRequirements(),
    ]);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/forms/form-list", {
        pageTitle: "Dashboard - Forms",
        config, features, req, announcementWeb,
        forms: forms.map((f) => ({ ...f, pendingCount: pendingCounts.get(f.formId) || 0 })),
        // Normalised on the way out so the editor shows what is actually
        // enforced rather than whatever was typed.
        defaultRequirements: normaliseRequirements(defaults) ?? {},
      })
    );
  });

  /**
   * Save the site-wide eligibility defaults.
   *
   * Lives on the forms list rather than a settings area of its own: it is
   * about forms, it is the only site-wide setting there is so far, and it
   * reuses this page's permission instead of inventing another node.
   */
  app.post("/dashboard/forms/defaults", async (req, res) => {
    if (!(await guard(req, res))) return;

    try {
      const requirements = parseRequirementsPayload(req.body || {});
      await setDefaultFormRequirements(
        Object.keys(requirements).length ? requirements : null
      );
      setBannerCookie("success", "Default eligibility requirements saved.", res);
    } catch (error) {
      console.error("[forms] default requirements error:", error);
      setBannerCookie("danger", "The defaults could not be saved.", res);
    }
    return res.redirect("/dashboard/forms");
  });

  // ── Create ────────────────────────────────────────────────────────────────
  app.get("/dashboard/forms/create", async (req, res) => {
    if (!(await guard(req, res))) return;

    const [announcementWeb, supportCategories] = await Promise.all([
      getWebAnnouncement(),
      getSupportCategories().catch(() => []),
    ]);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/forms/form-editor", {
        pageTitle: "Dashboard - Create Form",
        config, features, req, announcementWeb,
        form: null,
        fields: [],
        fieldTypes: FIELD_TYPES,
        showIfSourceTypes: SHOW_IF_SOURCE_TYPES,
        requirements: {},
        globalRequirementsSummary: summariseRequirements(await getDefaultFormRequirements()),
        notifyDiscordUserIdsText: "",
        supportCategories,
        formAction: "/dashboard/forms/create",
      })
    );
  });

  app.post("/dashboard/forms/create", async (req, res) => {
    if (!(await guard(req, res))) return;

    const body = req.body || {};
    if (!String(body.name || "").trim()) {
      setBannerCookie("danger", "A form name is required.", res);
      return res.redirect("/dashboard/forms/create");
    }

    try {
      const form = await createForm({
        name: String(body.name).trim(),
        slug: body.slug,
        description: body.description,
        status: body.status === "1" || body.status === "on",
        successMessage: body.successMessage,
        discordChannelId: body.discordChannelId,
        discordForumChannelId: body.discordForumChannelId,
        notifyDiscordUserIds: body.notifyDiscordUserIds,
        allowMultiple: body.allowMultiple === "1" || body.allowMultiple === "on",
        // An unticked checkbox posts nothing, so absence means "no review".
        requiresReview: body.requiresReview === "1" || body.requiresReview === "on",
        accessCode: body.accessCode,
        requirements: parseRequirementsPayload(body),
        useGlobalRequirements:
          body.useGlobalRequirements === "1" || body.useGlobalRequirements === "on",
        reapplyCooldownDays: body.reapplyCooldownDays,
        createTicket: body.createTicket === "1" || body.createTicket === "on",
        ticketCategoryId: body.ticketCategoryId,
        ticketPendingMessage: body.ticketPendingMessage,
        ticketApprovedMessage: body.ticketApprovedMessage,
        ticketDeniedMessage: body.ticketDeniedMessage,
      });
      await replaceFields(form.formId, parseFieldsPayload(body.fields));

      setBannerCookie("success", `Form "${form.name}" has been created.`, res);
      return res.redirect(`/dashboard/forms/${form.formId}/edit`);
    } catch (error) {
      console.error("[forms] create error:", error);
      setBannerCookie("danger", "The form could not be created.", res);
      return res.redirect("/dashboard/forms/create");
    }
  });

  // ── Edit ──────────────────────────────────────────────────────────────────
  app.get("/dashboard/forms/:formId/edit", async (req, res) => {
    if (!(await guard(req, res))) return;

    const form = await getFormById(req.params.formId);
    if (!form) {
      setBannerCookie("danger", "Form not found.", res);
      return res.redirect("/dashboard/forms");
    }

    const [announcementWeb, supportCategories] = await Promise.all([
      getWebAnnouncement(),
      getSupportCategories().catch(() => []),
    ]);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/forms/form-editor", {
        pageTitle: `Dashboard - Edit ${form.name}`,
        config, features, req, announcementWeb,
        supportCategories,
        form,
        // The editor works in the newline-per-option text form, not JSON.
        fields: form.fields.map((f) => ({ ...f, optionsText: optionsToText(f.options) })),
        fieldTypes: FIELD_TYPES,
        showIfSourceTypes: SHOW_IF_SOURCE_TYPES,
        // Normalised on the way out too, so the editor shows the values that
        // are actually enforced rather than whatever was typed.
        requirements: normaliseRequirements(form.requirements) ?? {},
        globalRequirementsSummary: summariseRequirements(await getDefaultFormRequirements()),
        // The editor works in one-id-per-line text, not JSON.
        notifyDiscordUserIdsText: formatDiscordIds(form.notifyDiscordUserIds),
        formAction: `/dashboard/forms/${form.formId}/edit`,
      })
    );
  });

  app.post("/dashboard/forms/:formId/edit", async (req, res) => {
    if (!(await guard(req, res))) return;

    const formId = req.params.formId;
    const body = req.body || {};
    if (!String(body.name || "").trim()) {
      setBannerCookie("danger", "A form name is required.", res);
      return res.redirect(`/dashboard/forms/${formId}/edit`);
    }

    try {
      await updateForm(formId, {
        name: String(body.name).trim(),
        slug: body.slug,
        description: body.description,
        status: body.status === "1" || body.status === "on",
        successMessage: body.successMessage,
        discordChannelId: body.discordChannelId,
        discordForumChannelId: body.discordForumChannelId,
        notifyDiscordUserIds: body.notifyDiscordUserIds,
        allowMultiple: body.allowMultiple === "1" || body.allowMultiple === "on",
        // An unticked checkbox posts nothing, so absence means "no review".
        requiresReview: body.requiresReview === "1" || body.requiresReview === "on",
        accessCode: body.accessCode,
        requirements: parseRequirementsPayload(body),
        useGlobalRequirements:
          body.useGlobalRequirements === "1" || body.useGlobalRequirements === "on",
        reapplyCooldownDays: body.reapplyCooldownDays,
        createTicket: body.createTicket === "1" || body.createTicket === "on",
        ticketCategoryId: body.ticketCategoryId,
        ticketPendingMessage: body.ticketPendingMessage,
        ticketApprovedMessage: body.ticketApprovedMessage,
        ticketDeniedMessage: body.ticketDeniedMessage,
      });
      await replaceFields(formId, parseFieldsPayload(body.fields));

      setBannerCookie("success", "The form has been updated.", res);
    } catch (error) {
      console.error("[forms] edit error:", error);
      setBannerCookie("danger", "The form could not be updated.", res);
    }
    return res.redirect(`/dashboard/forms/${formId}/edit`);
  });

  /**
   * Download one form's submissions as CSV.
   *
   * One column per question, in the order the form asks them. Honours the
   * status filter from the submissions list so "export the denied ones" works.
   *
   * Per form rather than across all of them: the columns are that form's
   * questions, and there is no sensible way to put two different forms'
   * questions in one table.
   */
  app.get("/dashboard/forms/:formId/export.csv", async (req, res) => {
    if (!(await guard(req, res))) return;

    const form = await getFormById(req.params.formId);
    if (!form) {
      setBannerCookie("danger", "Form not found.", res);
      return res.redirect("/dashboard/forms");
    }

    const status = isValidSubmissionStatus(req.query?.status) ? String(req.query.status) : null;

    try {
      // A high ceiling rather than the list view's 200: an export that silently
      // stopped short would be worse than a slow one.
      const submissions = await listSubmissions({ formId: form.formId, status, limit: 100000 });
      const usernames = await usernameMap(submissions);
      const csv = toCsv(buildSubmissionExport(form, submissions, { usernames }));

      return res
        .header("content-type", "text/csv; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="${csvFilename(form.slug, status, "submissions")}"`
        )
        .send(csv);
    } catch (error) {
      console.error("[forms] export error:", error);
      setBannerCookie("danger", "The export could not be generated.", res);
      return res.redirect(`/dashboard/forms/submissions?formId=${form.formId}`);
    }
  });

  app.post("/dashboard/forms/:formId/duplicate", async (req, res) => {
    if (!(await guard(req, res))) return;

    try {
      const copy = await duplicateForm(req.params.formId);
      if (!copy) {
        setBannerCookie("danger", "Form not found.", res);
        return res.redirect("/dashboard/forms");
      }
      setBannerCookie("success", `Created "${copy.name}" with all its fields. It is closed until you open it.`, res);
      return res.redirect(`/dashboard/forms/${copy.formId}/edit`);
    } catch (error) {
      console.error("[forms] duplicate error:", error);
      setBannerCookie("danger", "The form could not be duplicated.", res);
      return res.redirect("/dashboard/forms");
    }
  });

  app.post("/dashboard/forms/:formId/delete", async (req, res) => {
    if (!(await guard(req, res))) return;

    try {
      await deleteForm(req.params.formId);
      setBannerCookie("success", "The form and its submissions have been deleted.", res);
    } catch (error) {
      console.error("[forms] delete error:", error);
      setBannerCookie("danger", "The form could not be deleted.", res);
    }
    return res.redirect("/dashboard/forms");
  });

  // ── Submissions ───────────────────────────────────────────────────────────
  app.get("/dashboard/forms/submissions", async (req, res) => {
    if (!(await guard(req, res))) return;

    const { formId = null, status = null } = req.query || {};

    const [rows, forms, announcementWeb] = await Promise.all([
      listSubmissions({
        formId: formId || null,
        status: isValidSubmissionStatus(status) ? status : null,
      }),
      listForms(),
      getWebAnnouncement(),
    ]);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/forms/submission-list", {
        pageTitle: "Dashboard - Form Submissions",
        config, features, req, announcementWeb,
        submissions: await withSubmitterNames(rows),
        forms,
        activeFormId: formId ? String(formId) : "",
        activeStatus: isValidSubmissionStatus(status) ? String(status) : "",
      })
    );
  });

  app.get("/dashboard/forms/submissions/view", async (req, res) => {
    if (!(await guard(req, res))) return;

    const submission = await getSubmission(req.query?.submissionId);
    if (!submission) {
      setBannerCookie("danger", "Submission not found.", res);
      return res.redirect("/dashboard/forms/submissions");
    }

    const [decorated] = await withSubmitterNames([submission]);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/forms/submission-view", {
        pageTitle: `Dashboard - Submission #${submission.submissionId}`,
        config, features, req,
        announcementWeb: await getWebAnnouncement(),
        submission: decorated,
        // Pre-rendered so the template stays presentational -- the same
        // formatter the Discord embed uses, so both read identically.
        answerRows: submission.form.fields
          .filter((field) => !isDisplayType(field.fieldType))
          .map((field) => ({
          label: field.label,
          fieldType: field.fieldType,
          value: formatAnswer(field, submission.answers?.[field.fieldKey]),
          // Images are rendered as thumbnails rather than as the markdown
          // links formatAnswer produces for the Discord embed.
          images: getAnswerImages(field, submission.answers?.[field.fieldKey]),
          })),
      })
    );
  });

  app.post("/dashboard/forms/submissions/review", async (req, res) => {
    if (!(await guard(req, res))) return;

    const body = req.body || {};
    const submissionId = body.submissionId;
    const status = String(body.status || "");

    if (!isValidSubmissionStatus(status)) {
      setBannerCookie("danger", "That is not a valid submission status.", res);
      return res.redirect("/dashboard/forms/submissions");
    }

    try {
      // The decision UI is hidden for forms with approvals off, but a hidden
      // control is not a check -- posting here directly would otherwise DM the
      // applicant and post an approval into their ticket.
      const existing = await getSubmission(submissionId);
      if (!existing) {
        setBannerCookie("danger", "Submission not found.", res);
        return res.redirect("/dashboard/forms/submissions");
      }
      if (existing.form?.requiresReview === false) {
        setBannerCookie("danger", "This form does not use approvals.", res);
        return res.redirect(`/dashboard/forms/submissions/view?submissionId=${submissionId}`);
      }

      await reviewSubmission({
        submissionId,
        status,
        reviewNotes: body.reviewNotes,
        reviewedBy: req.session?.user?.userId ?? null,
      });

      // Best-effort: the review is already saved, so a Discord failure here
      // must not surface as a failed review.
      const submission = await getSubmission(submissionId);
      if (submission?.form?.discordChannelId) {
        await notifySubmissionReviewed({
          form: submission.form,
          submissionId: submission.submissionId,
          status,
          reviewer: req.session?.user?.username ?? null,
        });
      }

      // And into the submission's own forum thread, so it does not stop at
      // "here is the application" and never say what happened to it.
      if (submission?.discordThreadId) {
        await postReviewToThread({
          submission,
          status,
          reviewer: req.session?.user?.username ?? null,
        });
      }

      // Tell the submitter directly, in the ticket opened for them. Internal
      // review notes are deliberately not forwarded -- only the decision.
      if (submission?.ticketId) {
        await postReviewToTicket({
          submission,
          status,
          reviewer: req.session?.user?.username ?? null,
        });
      }

      setBannerCookie("success", `Submission #${submissionId} marked as ${status}.`, res);
    } catch (error) {
      console.error("[forms] review error:", error);
      setBannerCookie("danger", "The submission could not be updated.", res);
    }
    return res.redirect(`/dashboard/forms/submissions/view?submissionId=${submissionId}`);
  });

  app.post("/dashboard/forms/submissions/delete", async (req, res) => {
    if (!(await guard(req, res))) return;

    try {
      await deleteSubmission(req.body?.submissionId);
      setBannerCookie("success", "The submission has been deleted.", res);
    } catch (error) {
      console.error("[forms] submission delete error:", error);
      setBannerCookie("danger", "The submission could not be deleted.", res);
    }
    return res.redirect("/dashboard/forms/submissions");
  });
}
